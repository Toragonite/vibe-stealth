/**
 * Per-game poll loop + the global fetch gate (docs/CONTRACT.md §4, §9).
 *
 * Every timer goes through the injected `SchedulerTimers`; this file never
 * touches a global timer or clock. System lines leave as i18n KEYS — the UI
 * translates them (§9 seam note).
 */

import { ProviderError } from './contract';
import type {
  GamePhase,
  GamePoller,
  GamePollerOptions,
  PlaySnapshot,
  Semaphore,
} from './contract';
import { clampInt, parseIsoUtc } from './util';

const PRE_INTERVAL_MS = 60_000;
const PRE_IMMINENT_INTERVAL_MS = 20_000;
/** 'pre' polls tighten this close to (or past) the scheduled start. */
const IMMINENT_WINDOW_MS = 120_000;
const UNKNOWN_INTERVAL_MS = 60_000;
const MAX_BACKOFF_MS = 300_000;
const RATE_LIMIT_FLOOR_MS = 60_000;
const AUTO_UNFOLLOW_MS = 10 * 60 * 1000;
/**
 * Runaway guard bound (docs/CONTRACT.md §4 "Runaway guard" — defense in depth,
 * added after breaker finding B1). A game polled this long without ever
 * ingesting phase 'post' is force-stopped independently of any provider. 12 h
 * exceeds any real match (longest MLB extra-innings ≈ 7 h; a BO5 esports series
 * ≈ 6 h), so it never fires on a healthy game — it only catches an upstream
 * shape regression that silently drops the fresh-game 'post' transition (§2).
 */
const RUNAWAY_GUARD_MS = 12 * 60 * 60 * 1000;
const NOT_FOUND_LIMIT = 3;
const TROUBLE_STREAK = 3;
/** 2 ** 32 already saturates MAX_BACKOFF_MS; keeps the exponent finite. */
const MAX_BACKOFF_EXPONENT = 32;

export function createSemaphore(max: number): Semaphore {
  const limit = Number.isFinite(max) && max >= 1 ? Math.trunc(max) : 1;
  const waiting: Array<() => void> = [];
  let active = 0;

  function grant(resolve: (release: () => void) => void): void {
    active++;
    let released = false;
    resolve(() => {
      if (released) return; // release() is idempotent — a double `finally` must not free a slot twice
      released = true;
      active--;
      const next = waiting.shift();
      if (next !== undefined) next();
    });
  }

  return {
    acquire(): Promise<() => void> {
      return new Promise((resolve) => {
        if (active < limit) grant(resolve);
        else waiting.push(() => grant(resolve));
      });
    },
  };
}

export function createGamePoller(options: GamePollerOptions): GamePoller {
  const { engine, timers, semaphore, callbacks, isProviderBlocked } = options;
  const liveMs = clampInt(options.liveSeconds, 10, 120, 20) * 1000;
  const startMs = startEpochMs(options.startTimeUtc);

  let phase: GamePhase = options.initialPhase;
  let started = false;
  let stopped = false;
  let inFlight = false;

  let tickHandle: unknown;
  let tickArmed = false;
  let unfollowHandle: unknown;
  let unfollowArmed = false;

  let failStreak = 0;
  let notFoundStreak = 0;
  let troubleSurfaced = false;
  let authNotified = false;
  let postObservedAt = 0;
  let firstPollAt = 0;

  /**
   * ±10% jitter derived from the injected clock rather than Math.random, so a
   * fake clock makes the whole loop reproducible. `now % 2001` spreads the
   * offset uniformly over [-1000, 1000] ms of "randomness" per millisecond.
   */
  function jitter(base: number): number {
    const now = timers.now();
    if (!Number.isFinite(now)) return base;
    const spread = ((Math.trunc(now) % 2001) + 2001) % 2001; // 0..2000
    return base + ((spread - 1000) / 1000) * 0.1 * base;
  }

  function intervalMs(): number {
    switch (phase) {
      case 'in':
        return Math.max(1, Math.round(jitter(liveMs)));
      case 'pre': {
        const now = timers.now();
        if (startMs !== undefined && Number.isFinite(now) && startMs - now <= IMMINENT_WINDOW_MS) {
          return PRE_IMMINENT_INTERVAL_MS;
        }
        return PRE_INTERVAL_MS;
      }
      case 'post':
        return liveMs; // unreachable: the loop stops on the first 'post' ingest
      default:
        return UNKNOWN_INTERVAL_MS;
    }
  }

  function backoffMs(): number {
    const exponent = Math.min(failStreak, MAX_BACKOFF_EXPONENT);
    return Math.min(intervalMs() * 2 ** exponent, MAX_BACKOFF_MS);
  }

  function clearTick(): void {
    if (!tickArmed) return;
    tickArmed = false;
    timers.clearTimeout(tickHandle);
    tickHandle = undefined;
  }

  function armTick(delayMs: number): void {
    clearTick();
    if (stopped) return;
    let delay = Number.isFinite(delayMs) ? Math.max(0, Math.round(delayMs)) : UNKNOWN_INTERVAL_MS;
    // §4 runaway guard: never let a backoff/rate-limit delay carry the next tick
    // past the 12 h deadline — clamp to the deadline so the guard is evaluated on
    // time. This is the single choke point for every armed tick, so no delay
    // path (interval, backoff, rate-limit, auth-idle, in-flight/blocked re-arm)
    // can outlive the bound.
    const now = timers.now();
    if (Number.isFinite(now)) {
      const untilDeadline = firstPollAt + RUNAWAY_GUARD_MS - now;
      if (untilDeadline < delay) delay = Math.max(0, untilDeadline);
    }
    tickArmed = true;
    tickHandle = timers.setTimeout(() => {
      runTick().catch((err: unknown) => safeDiagnostic(`poll tick crashed: ${describe(err)}`));
    }, delay);
  }

  function stopInternal(): void {
    stopped = true;
    clearTick();
    if (unfollowArmed) {
      unfollowArmed = false;
      timers.clearTimeout(unfollowHandle);
      unfollowHandle = undefined;
    }
  }

  /**
   * §4: auto-unfollow must not depend on future poll ticks — the loop is dead by
   * now, so this one-shot is the only thing keeping the follow alive.
   */
  function scheduleAutoUnfollow(): void {
    if (unfollowArmed || stopped) return;
    const now = timers.now();
    const due = postObservedAt + AUTO_UNFOLLOW_MS;
    const delay = Number.isFinite(now) && Number.isFinite(due) ? Math.max(0, due - now) : AUTO_UNFOLLOW_MS;
    unfollowArmed = true;
    unfollowHandle = timers.setTimeout(() => {
      unfollowArmed = false;
      if (stopped) return;
      stopInternal();
      safeSystemLine('autoUnfollowed');
      safeAutoUnfollow();
    }, delay);
  }

  function onSuccess(snapshot: PlaySnapshot): void {
    if (troubleSurfaced) {
      troubleSurfaced = false;
      safeSystemLine('connectionRestored');
    }
    failStreak = 0;
    notFoundStreak = 0;
    authNotified = false;

    const emission = engine.ingest(snapshot);
    phase = snapshot.game.phase;
    callbacks.onEmission(emission);

    if (phase === 'post') {
      if (postObservedAt === 0) postObservedAt = timers.now();
      clearTick();
      scheduleAutoUnfollow();
      return;
    }
    armTick(intervalMs());
  }

  function handleFailure(err: unknown): void {
    let error: ProviderError;
    if (err instanceof ProviderError) {
      error = err;
    } else {
      // §7: a provider throwing a non-ProviderError is wrapped as 'parse'.
      error = new ProviderError('parse', `unexpected error: ${describe(err)}`);
      safeDiagnostic(`poll tick error: ${stackOf(err)}`);
    }

    switch (error.kind) {
      case 'not-found': {
        notFoundStreak++;
        if (notFoundStreak >= NOT_FOUND_LIMIT) {
          stopInternal();
          safeSystemLine('gameVanished');
          safeAutoUnfollow();
          return;
        }
        failStreak++;
        maybeSurfaceTrouble();
        armTick(backoffMs());
        return;
      }

      case 'auth': {
        notFoundStreak = 0;
        if (isProviderBlocked === undefined) {
          // Key-free provider (ESPN serves transient 403s, Riot may rotate its
          // gateway key): never a permanent block — behave exactly like 'network'.
          networkPolicy();
          return;
        }
        // Keyed provider: report once and idle. The UI owns the blocked flag;
        // `isProviderBlocked()` gates every subsequent tick, so the loop resumes
        // by itself once the user supplies a token. The poller does not know the
        // provider name or the fix command — the UI fills those in when it
        // translates the key (§9 seam note).
        if (!authNotified) {
          authNotified = true;
          safeSystemLine('authRequired');
        }
        armTick(Math.max(intervalMs(), RATE_LIMIT_FLOOR_MS));
        return;
      }

      case 'rate-limit': {
        notFoundStreak = 0;
        failStreak++;
        maybeSurfaceTrouble();
        const retryAfter = Number.isFinite(error.retryAfterMs) ? (error.retryAfterMs as number) : 0;
        armTick(Math.max(retryAfter, RATE_LIMIT_FLOOR_MS));
        return;
      }

      case 'parse': {
        safeDiagnostic(error.payloadHead ?? error.message);
        networkPolicy();
        return;
      }

      case 'network':
      case 'unavailable':
      default:
        networkPolicy();
        return;
    }
  }

  function networkPolicy(): void {
    notFoundStreak = 0;
    failStreak++;
    maybeSurfaceTrouble();
    armTick(backoffMs());
  }

  function maybeSurfaceTrouble(): void {
    if (failStreak >= TROUBLE_STREAK && !troubleSurfaced) {
      troubleSurfaced = true;
      safeSystemLine('connectionTrouble');
    }
  }

  async function runTick(): Promise<void> {
    tickArmed = false;
    tickHandle = undefined;
    if (stopped) return;

    // §4 runaway guard (defense in depth): evaluated on EVERY tick BEFORE the
    // semaphore and the fetch, so a wedged or slow in-flight fetch cannot
    // postpone it — the very next scheduled tick trips it regardless of fetch
    // state. Fires at the 12 h deadline (armTick clamps any longer delay down to
    // it). Stop first — mirroring the post/gameVanished paths — so a re-entrant
    // stop() from inside the UI's onAutoUnfollow handler is a no-op.
    const now = timers.now();
    if (Number.isFinite(now) && now - firstPollAt >= RUNAWAY_GUARD_MS) {
      stopInternal();
      safeSystemLine('staleGame');
      safeAutoUnfollow();
      return;
    }

    // §4: never poll a game whose provider is in auth-failure state.
    if (isProviderBlocked?.() === true) {
      armTick(intervalMs());
      return;
    }
    // §4: never two in-flight fetches per game. Reachable when a fetch outlives
    // its interval — e.g. blocked behind the 4-slot semaphore.
    if (inFlight) {
      armTick(intervalMs());
      return;
    }

    inFlight = true;
    armTick(intervalMs()); // steady cadence; replaced the moment this fetch settles

    let release: (() => void) | undefined;
    try {
      release = await semaphore.acquire();
      if (stopped) return;
      const snapshot = await callbacks.fetchSnapshot();
      if (stopped) return;
      try {
        onSuccess(snapshot);
      } catch (err) {
        // An ingest/emission bug must not be mistaken for a connection failure.
        safeDiagnostic(`ingest failed: ${stackOf(err)}`);
        armTick(intervalMs());
      }
    } catch (err) {
      if (stopped) return;
      handleFailure(err);
    } finally {
      inFlight = false;
      release?.();
    }
  }

  function safeSystemLine(key: string, params?: Record<string, string | number>): void {
    try {
      callbacks.onSystemLine(key, params);
    } catch (err) {
      safeDiagnostic(`onSystemLine threw: ${describe(err)}`);
    }
  }

  function safeAutoUnfollow(): void {
    try {
      callbacks.onAutoUnfollow();
    } catch (err) {
      safeDiagnostic(`onAutoUnfollow threw: ${describe(err)}`);
    }
  }

  function safeDiagnostic(message: string): void {
    try {
      callbacks.onDiagnostic(message);
    } catch {
      /* a broken diagnostics sink must never kill the loop (§7) */
    }
  }

  return {
    start(): void {
      if (started || stopped) return;
      started = true;
      firstPollAt = timers.now();
      armTick(0);
    },
    stop(): void {
      stopInternal();
    },
  };
}

function startEpochMs(startTimeUtc: string | undefined): number | undefined {
  const iso = parseIsoUtc(startTimeUtc);
  if (iso === undefined) return undefined;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : undefined;
}

function describe(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

function stackOf(err: unknown): string {
  return err instanceof Error ? (err.stack ?? `${err.name}: ${err.message}`) : String(err);
}
