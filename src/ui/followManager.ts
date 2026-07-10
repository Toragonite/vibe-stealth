/**
 * Follow lifecycle: the persisted follow list, one RelayEngine + one GamePoller per
 * followed game, and the relay lines they produce.
 *
 * CONTRACT pins implemented here:
 *  §3  fresh engine per follow (and per restore — no cross-reload dedup state).
 *  §4  clamped settings, auth-block bookkeeping, quiet auto-unfollow.
 *  §6  array order IS follow order; re-follow moves the entry to the end; cap
 *      `maxFollowedGames` refuses with a status-bar message (never a modal);
 *      workspaceState persistence saved on follow/unfollow and debounced 5 s on
 *      `lastKnown` advance; restore drops entries > 36 h old and quietly
 *      auto-unfollows entries with `postObservedAt > 0`.
 *  §7  every poller callback runs inside a catch-all that writes to diagnostics.
 *  §9  the seam asymmetry: engine system lines arrive already localized inside
 *      `RelayEmission.events`; poller system lines arrive as i18n KEYS.
 */

import * as vscode from 'vscode';
import {
  IDS,
  type FollowedGameState,
  type FormatOptions,
  type Game,
  type GamePhase,
  type GamePoller,
  type GameState,
  type League,
  type PlayEvent,
  type ProviderContext,
  type RelayEmission,
  type RelayEngine,
  type SchedulerTimers,
  type Semaphore,
  type SportKind,
  type SportProvider,
} from '../core/contract';
import { coerceScore } from '../core/util';
import { t } from '../core/i18n';
import { createRelayEngine } from '../core/relay';
import { createGamePoller } from '../core/poller';
import { formatEventLine } from '../core/format';
import { getProvider } from '../providers';
import { readSettings } from './settings';
import { Diagnostics } from './diagnostics';
import { RelayChannel } from './relayChannel';
import { gameTitle } from './display';
import { K } from './uiText';

/** CONTRACT §4/§6: restored follows older than this are dropped at activation. */
const MAX_FOLLOW_AGE_MS = 36 * 60 * 60 * 1000;
/** CONTRACT §6: `lastKnown` advances are persisted on a 5 s debounce. */
const SAVE_DEBOUNCE_MS = 5_000;
const STATUS_MESSAGE_MS = 6_000;
/** Guard against an absurd persisted array (hand-edited / corrupted state). */
const MAX_PERSISTED_ENTRIES = 100;

/** CONTRACT §4: real clock wrapper — the poller's only source of time. */
const REAL_TIMERS: SchedulerTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

export interface FollowEntry {
  readonly state: FollowedGameState;
  readonly provider: SportProvider;
  /**
   * Best-known snapshot. Real `Game` once the first fetch lands; before that (after a
   * reload) a synthesized game built from `state.lastKnown` so the tree and status bar
   * can render immediately.
   */
  game: Game;
  /**
   * Live "current state" SNAPSHOT (bases/count, lineups, draft) from the latest emission,
   * rendered ONLY as tree child rows (CONTRACT §11) — never the relay. Replaced wholesale
   * each emission; undefined when the snapshot had none (pre/post, wrong sport, feature off).
   * Named `liveState` to avoid colliding with `state: FollowedGameState` above.
   */
  liveState: GameState | undefined;
  readonly engine: RelayEngine;
  poller: GamePoller | undefined;
}

export class FollowManager implements vscode.Disposable {
  private readonly entries: FollowEntry[] = [];
  /** Providers in auth-failure state (CONTRACT §4 — keyed providers only). */
  private readonly blocked = new Set<string>();
  private readonly emitter = new vscode.EventEmitter<void>();
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private systemSeq = 0;
  private disposed = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly relay: RelayChannel,
    private readonly diag: Diagnostics,
    private readonly ctx: ProviderContext,
    private readonly semaphore: Semaphore,
  ) {}

  /** Fires on follow, unfollow, auto-unfollow and every emission. */
  get onDidChange(): vscode.Event<void> {
    return this.emitter.event;
  }

  /** Follow order, oldest first (CONTRACT §6). */
  list(): readonly FollowEntry[] {
    return this.entries;
  }

  get(gameId: string): FollowEntry | undefined {
    return this.entries.find((e) => e.state.gameId === gameId);
  }

  isFollowed(gameId: string): boolean {
    return this.get(gameId) !== undefined;
  }

  /** Called when the PandaScore secret changes — credentials changed, so unblock. */
  clearProviderBlocks(): void {
    this.blocked.clear();
  }

  // -------------------------------------------------------------------------
  // Follow / unfollow
  // -------------------------------------------------------------------------

  async follow(game: Game): Promise<void> {
    if (this.disposed) return;

    // CONTRACT §6: re-following is a no-op that moves the entry to the end of the
    // follow order (which is what the status bar scans backwards from).
    const index = this.entries.findIndex((e) => e.state.gameId === game.id);
    if (index >= 0) {
      const [existing] = this.entries.splice(index, 1);
      if (existing) {
        existing.game = game;
        Object.assign(existing.state.lastKnown, snapshotOf(game));
        this.entries.push(existing);
      }
      await this.persist();
      this.changed();
      this.statusMessage(this.t(K.alreadyFollowing, { game: gameTitle(game) }));
      return;
    }

    const settings = readSettings();
    if (this.entries.length >= settings.maxFollowedGames) {
      this.statusMessage(this.t(K.followLimit, { n: settings.maxFollowedGames }));
      return;
    }

    const provider = getProvider(game.providerId);
    if (!provider) {
      this.diag.log(`follow: unknown provider '${game.providerId}' for game ${game.id}`);
      return;
    }

    const state: FollowedGameState = {
      gameId: game.id,
      providerId: game.providerId,
      leagueId: game.leagueId,
      followedAt: Date.now(),
      postObservedAt: 0,
      lastKnown: snapshotOf(game),
    };

    const entry = this.createEntry(state, game, provider);
    this.entries.push(entry);
    this.relay.append(this.systemLine(entry, this.t('followed', { game: gameTitle(game) })));
    entry.poller?.start();
    await this.persist();
    this.changed();
  }

  async unfollow(gameId: string, opts: { quiet?: boolean } = {}): Promise<void> {
    const index = this.entries.findIndex((e) => e.state.gameId === gameId);
    if (index < 0) return;
    const entry = this.entries[index];
    if (!entry) return;

    this.entries.splice(index, 1);
    this.stopPoller(entry);
    if (!opts.quiet) {
      this.relay.append(this.systemLine(entry, this.t('unfollowed', { game: gameTitle(entry.game) })));
    }
    await this.persist();
    this.changed();
  }

  // -------------------------------------------------------------------------
  // Activation restore (CONTRACT §4 / §6)
  // -------------------------------------------------------------------------

  async restore(): Promise<void> {
    if (this.disposed) return;

    const states = sanitizeStates(this.context.workspaceState.get(IDS.state.followedGames));
    if (states.length === 0) return;

    const now = Date.now();
    const settings = readSettings();
    const survivors: Array<{ state: FollowedGameState; provider: SportProvider }> = [];

    for (const state of states) {
      const provider = getProvider(state.providerId);
      if (!provider) {
        this.diag.log(`restore: dropping ${state.gameId} — unknown provider '${state.providerId}'`);
        continue;
      }
      // `followedAt === 0` means the persisted value was unusable — age unknown, keep it.
      if (state.followedAt > 0 && now - state.followedAt > MAX_FOLLOW_AGE_MS) {
        this.diag.log(`restore: dropping ${state.gameId} — followed more than 36h ago`);
        continue;
      }
      if (state.postObservedAt > 0) {
        this.diag.log(`restore: quiet auto-unfollow of finished game ${state.gameId}`);
        continue;
      }
      survivors.push({ state, provider });
    }

    // A lowered `maxFollowedGames` must not be exceeded by a restore; keep the newest.
    const kept = survivors.slice(-settings.maxFollowedGames);
    const created: FollowEntry[] = [];
    const leagueCache = new Map<string, League[]>();

    for (const { state, provider } of kept) {
      if (this.disposed) return;
      // `restore` is fire-and-forget and awaits `listLeagues`; the user may have
      // followed this very game in the meantime. Never create a second poller for it.
      if (this.isFollowed(state.gameId)) continue;
      let leagues = leagueCache.get(provider.id);
      if (!leagues) {
        leagues = await this.listLeagues(provider);
        leagueCache.set(provider.id, leagues);
      }
      const league = leagues.find((l) => l.id === state.leagueId);
      const game = synthesizeGame(state, league?.name ?? state.leagueId, league?.sport ?? 'other');
      const entry = this.createEntry(state, game, provider);
      this.entries.push(entry);
      created.push(entry);
    }

    // Emitted after every entry exists so the `multiGame` tag is correct on line one.
    for (const entry of created) {
      this.relay.append(this.systemLine(entry, this.t('restoredFollow', { game: gameTitle(entry.game) })));
      entry.poller?.start();
    }

    await this.persist();
    this.changed();
  }

  /** Only used to recover `leagueName`/`sport` for a restored follow — failure is benign. */
  private async listLeagues(provider: SportProvider): Promise<League[]> {
    try {
      return await provider.listLeagues(this.ctx);
    } catch (err) {
      this.diag.error(`restore.listLeagues:${provider.id}`, err);
      return [];
    }
  }

  // -------------------------------------------------------------------------
  // Engine + poller wiring
  // -------------------------------------------------------------------------

  private createEntry(state: FollowedGameState, game: Game, provider: SportProvider): FollowEntry {
    const settings = readSettings();
    const engine = createRelayEngine({
      backfillLimit: settings.backfillLimit,
      locale: settings.locale,
    });
    const entry: FollowEntry = { state, provider, game, liveState: undefined, engine, poller: undefined };

    entry.poller = createGamePoller({
      engine,
      initialPhase: game.phase,
      startTimeUtc: game.startTimeUtc,
      liveSeconds: settings.pollSecondsLive,
      timers: REAL_TIMERS,
      semaphore: this.semaphore,
      // CONTRACT §4 + contract.ts seam pin: the poller reads the PRESENCE of this option
      // as "provider is keyed". Key-free providers (ESPN 403s, Riot key rotation, Naver
      // 4xx) must reach the poller's network-backoff path, so they get `undefined`.
      isProviderBlocked: provider.requiresSecret ? () => this.blocked.has(provider.id) : undefined,
      callbacks: {
        // Do not destructure — `fetchPlays` may rely on `this`. Always the freshest game.
        fetchSnapshot: () => provider.fetchPlays(this.ctx, entry.game),
        onEmission: (emission) => this.safely('onEmission', () => this.handleEmission(entry, emission)),
        onSystemLine: (key, params) =>
          this.safely('onSystemLine', () => this.handleSystemLine(entry, key, params)),
        onAutoUnfollow: () =>
          this.safely('onAutoUnfollow', () => {
            void this.unfollow(entry.state.gameId, { quiet: true }).catch((err) =>
              this.diag.error('autoUnfollow', err),
            );
          }),
        onDiagnostic: (message) => this.diag.log(`[${entry.state.gameId}] ${message}`),
      },
    });

    return entry;
  }

  private handleEmission(entry: FollowEntry, emission: RelayEmission): void {
    try {
      entry.game = emission.game;
      // CONTRACT §11.1: the engine passes state through unchanged; stash it for the tree.
      // undefined here (pre/post, wrong sport, feature off) reverts the row to a leaf.
      entry.liveState = emission.state;
      Object.assign(entry.state.lastKnown, snapshotOf(emission.game));

      // The poller owns its own `postObservedAt`; the UI owns the persisted copy that
      // drives the status-bar lame-duck window and the restore-time auto-unfollow.
      if (emission.game.phase === 'post' && entry.state.postObservedAt === 0) {
        entry.state.postObservedAt = Date.now();
        void this.persist();
      }

      if (emission.events.length > 0) {
        const options = this.formatOptions();
        for (const event of emission.events) {
          this.relay.append(formatEventLine(event, emission.game, options));
        }
      }
    } finally {
      this.scheduleSave();
      this.changed();
    }
  }

  private handleSystemLine(entry: FollowEntry, key: string, params?: Record<string, string | number>): void {
    // CONTRACT §4: an auth failure on a keyed provider blocks the whole provider until
    // its credentials change. `authRequired` is the only signal the seam gives us.
    // CONTRACT §9: the poller cannot know the provider name or the fix command — the UI
    // substitutes them here, otherwise the line renders its raw {placeholders}.
    let lineParams = params;
    if (key === 'authRequired' && entry.provider.requiresSecret) {
      this.blocked.add(entry.provider.id);
      lineParams = {
        provider: entry.provider.displayName,
        command: this.t(K.commandSetToken),
        ...params,
      };
    }
    this.relay.append(this.systemLine(entry, this.t(key, lineParams)));
  }

  /** Renders a poller/UI system line through the same formatter as real events. */
  private systemLine(entry: FollowEntry, text: string): string {
    const event: PlayEvent = {
      id: `system:${++this.systemSeq}`,
      gameId: entry.state.gameId,
      sequence: 0,
      clock: undefined,
      period: undefined,
      text,
      kind: 'system',
      scoreAfter: undefined,
    };
    return formatEventLine(event, entry.game, this.formatOptions());
  }

  private formatOptions(): FormatOptions {
    const settings = readSettings();
    return {
      locale: settings.locale,
      showEmoji: settings.showEmoji,
      multiGame: this.entries.length > 1,
      now: () => Date.now(),
    };
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  private scheduleSave(): void {
    if (this.saveTimer !== undefined || this.disposed) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      void this.persist();
    }, SAVE_DEBOUNCE_MS);
  }

  private clearSaveTimer(): void {
    if (this.saveTimer === undefined) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
  }

  private async persist(): Promise<void> {
    this.clearSaveTimer();
    const data = this.entries.map((e) => cloneState(e.state));
    try {
      await this.context.workspaceState.update(IDS.state.followedGames, data);
    } catch (err) {
      this.diag.error('persist', err);
    }
  }

  /** Called from `deactivate` — flushes any debounced `lastKnown` advance. */
  async flush(): Promise<void> {
    await this.persist();
  }

  // -------------------------------------------------------------------------
  // Shutdown & plumbing
  // -------------------------------------------------------------------------

  stopAll(): void {
    for (const entry of this.entries) this.stopPoller(entry);
  }

  dispose(): void {
    this.disposed = true;
    this.clearSaveTimer();
    this.stopAll();
    this.emitter.dispose();
  }

  private stopPoller(entry: FollowEntry): void {
    try {
      entry.poller?.stop();
    } catch (err) {
      this.diag.error('poller.stop', err);
    }
  }

  /** CONTRACT §7: a throw inside a poller callback must never reach the poll loop. */
  private safely(scope: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.diag.error(scope, err);
    }
  }

  private changed(): void {
    if (this.disposed) return;
    this.emitter.fire();
  }

  private t(key: string, params?: Record<string, string | number>): string {
    return t(readSettings().locale, key, params);
  }

  private statusMessage(message: string): void {
    vscode.window.setStatusBarMessage(message, STATUS_MESSAGE_MS);
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function snapshotOf(game: Game): FollowedGameState['lastKnown'] {
  return {
    awayAbbrev: game.away.abbrev,
    homeAbbrev: game.home.abbrev,
    awayScore: game.away.score,
    homeScore: game.home.score,
    statusShort: game.statusShort,
    phase: game.phase,
  };
}

function cloneState(state: FollowedGameState): FollowedGameState {
  return {
    gameId: state.gameId,
    providerId: state.providerId,
    leagueId: state.leagueId,
    followedAt: state.followedAt,
    postObservedAt: state.postObservedAt,
    lastKnown: { ...state.lastKnown },
  };
}

/**
 * Renders a restored follow before its first fetch lands. `startTimeUtc` is not part of
 * FollowedGameState, so the poller treats it as unknown (60 s pre-game interval).
 */
function synthesizeGame(state: FollowedGameState, leagueName: string, sport: SportKind): Game {
  const lk = state.lastKnown;
  return {
    id: state.gameId,
    providerId: state.providerId,
    leagueId: state.leagueId,
    leagueName,
    sport,
    startTimeUtc: undefined,
    phase: lk.phase,
    statusText: lk.statusShort,
    statusShort: lk.statusShort,
    home: { id: '', name: lk.homeAbbrev, abbrev: lk.homeAbbrev, score: lk.homeScore },
    away: { id: '', name: lk.awayAbbrev, abbrev: lk.awayAbbrev, score: lk.awayScore },
  };
}

const PHASES: readonly GamePhase[] = ['pre', 'in', 'post', 'unknown'];

function isPhase(v: unknown): v is GamePhase {
  return typeof v === 'string' && (PHASES as readonly string[]).includes(v);
}

function nonEmptyString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

function nonNegativeNumber(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
}

function shortString(v: unknown, fallback: string, max: number): string {
  return typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, max) : fallback;
}

/** workspaceState is user-writable JSON — validate value semantics, not just shape. */
export function sanitizeStates(raw: unknown): FollowedGameState[] {
  if (!Array.isArray(raw)) return [];
  const out: FollowedGameState[] = [];
  for (const item of raw.slice(0, MAX_PERSISTED_ENTRIES)) {
    const state = sanitizeState(item);
    if (!state) continue;
    const duplicate = out.findIndex((e) => e.gameId === state.gameId);
    if (duplicate >= 0) out.splice(duplicate, 1); // last occurrence wins (newest follow order)
    out.push(state);
  }
  return out;
}

function sanitizeState(raw: unknown): FollowedGameState | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;

  const gameId = nonEmptyString(o.gameId);
  const providerId = nonEmptyString(o.providerId);
  const leagueId = nonEmptyString(o.leagueId);
  if (!gameId || !providerId || !leagueId) return undefined;

  const lk = o.lastKnown && typeof o.lastKnown === 'object' ? (o.lastKnown as Record<string, unknown>) : {};

  return {
    gameId,
    providerId,
    leagueId,
    followedAt: nonNegativeNumber(o.followedAt),
    postObservedAt: nonNegativeNumber(o.postObservedAt),
    lastKnown: {
      awayAbbrev: shortString(lk.awayAbbrev, 'TBD', 5),
      homeAbbrev: shortString(lk.homeAbbrev, 'TBD', 5),
      awayScore: coerceScore(lk.awayScore),
      homeScore: coerceScore(lk.homeScore),
      statusShort: shortString(lk.statusShort, '?', 8),
      phase: isPhase(lk.phase) ? lk.phase : 'unknown',
    },
  };
}
