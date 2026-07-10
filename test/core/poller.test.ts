import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Game,
  GamePhase,
  GamePollerCallbacks,
  GamePollerOptions,
  PlaySnapshot,
  RelayEngine,
  SchedulerTimers,
} from '../../src/core/contract';
import { ProviderError } from '../../src/core/contract';
import { createGamePoller, createSemaphore } from '../../src/core/poller';
import { createRelayEngine } from '../../src/core/relay';

/** now % 2001 === 0 ⇒ the pinned jitter is exactly −10%. */
const EPOCH = 0;
const LIVE_MS = 20_000;
const UNKNOWN_MS = 60_000;
/** §4 runaway guard bound — must match RUNAWAY_GUARD_MS in poller.ts. */
const RUNAWAY_MS = 12 * 60 * 60 * 1000;

const timers: SchedulerTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

function game(phase: GamePhase, overrides: Partial<Game> = {}): Game {
  return {
    id: 'mlb:mlb:747000',
    providerId: 'mlb',
    leagueId: 'mlb',
    leagueName: 'MLB',
    sport: 'baseball',
    startTimeUtc: undefined,
    phase,
    statusText: 'Top 7th',
    statusShort: 'T7',
    home: { id: '1', name: 'Cardinals', abbrev: 'STL', score: 2 },
    away: { id: '2', name: 'Cubs', abbrev: 'CHC', score: 3 },
    ...overrides,
  };
}

const snapshot = (phase: GamePhase): PlaySnapshot => ({ game: game(phase), events: [] });

const passThroughEngine = (): RelayEngine => ({
  ingest: (s) => ({ events: [], game: s.game, scoreChanged: false, phaseTransition: undefined }),
});

interface Harness {
  poller: ReturnType<typeof createGamePoller>;
  fetchSnapshot: ReturnType<typeof vi.fn>;
  onEmission: ReturnType<typeof vi.fn>;
  onSystemLine: ReturnType<typeof vi.fn>;
  onAutoUnfollow: ReturnType<typeof vi.fn>;
  onDiagnostic: ReturnType<typeof vi.fn>;
  systemKeys: () => string[];
}

function harness(overrides: Partial<GamePollerOptions> = {}, fetchImpl?: () => Promise<PlaySnapshot>): Harness {
  const initialPhase = overrides.initialPhase ?? 'unknown';
  const fetchSnapshot = vi.fn(fetchImpl ?? (async () => snapshot(initialPhase)));
  const onEmission = vi.fn();
  const onSystemLine = vi.fn();
  const onAutoUnfollow = vi.fn();
  const onDiagnostic = vi.fn();
  const callbacks: GamePollerCallbacks = {
    fetchSnapshot: fetchSnapshot as unknown as GamePollerCallbacks['fetchSnapshot'],
    onEmission,
    onSystemLine,
    onAutoUnfollow,
    onDiagnostic,
  };
  const poller = createGamePoller({
    engine: passThroughEngine(),
    initialPhase,
    startTimeUtc: undefined,
    liveSeconds: 20,
    timers,
    semaphore: createSemaphore(4),
    callbacks,
    ...overrides,
  });
  return {
    poller,
    fetchSnapshot,
    onEmission,
    onSystemLine,
    onAutoUnfollow,
    onDiagnostic,
    systemKeys: () => onSystemLine.mock.calls.map((c) => c[0] as string),
  };
}

const advance = async (ms: number): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms);
  await flush();
};

const rejectWith = (err: unknown) => async (): Promise<PlaySnapshot> => {
  throw err;
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(EPOCH);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('createSemaphore', () => {
  it('grants at most `max` permits and queues the rest FIFO', async () => {
    const sem = createSemaphore(4);
    const releases: Array<() => void> = [];
    const order: number[] = [];
    for (let i = 0; i < 6; i++) {
      void sem.acquire().then((release) => {
        order.push(i);
        releases.push(release);
      });
    }
    await flush();
    expect(order).toEqual([0, 1, 2, 3]);

    releases[0]?.();
    await flush();
    expect(order).toEqual([0, 1, 2, 3, 4]);

    releases[1]?.();
    await flush();
    expect(order).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('never lets more than `max` tasks run concurrently', async () => {
    const sem = createSemaphore(4);
    let active = 0;
    let peak = 0;
    const gates: Array<() => void> = [];
    const tasks = Array.from({ length: 10 }, () =>
      (async () => {
        const release = await sem.acquire();
        active++;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => gates.push(resolve));
        active--;
        release();
      })(),
    );

    await flush();
    expect(peak).toBe(4);
    while (gates.length > 0) {
      gates.shift()?.();
      await flush();
    }
    await Promise.all(tasks);
    expect(peak).toBe(4);
  });

  it('release() is idempotent — a double release cannot over-free a slot', async () => {
    const sem = createSemaphore(1);
    const release = await sem.acquire();
    let second = false;
    void sem.acquire().then(() => {
      second = true;
    });
    await flush();
    expect(second).toBe(false);

    release();
    release();
    await flush();
    expect(second).toBe(true);

    // The extra release must not have handed out a phantom permit.
    let third = false;
    void sem.acquire().then(() => {
      third = true;
    });
    await flush();
    expect(third).toBe(false);
  });

  it('degrades a nonsensical max to 1 rather than deadlocking', async () => {
    for (const max of [0, -3, NaN, Infinity]) {
      const sem = createSemaphore(max);
      const release = await sem.acquire();
      let second = false;
      void sem.acquire().then(() => {
        second = true;
      });
      await flush();
      expect(second, `max=${max}`).toBe(false);
      release();
      await flush();
      expect(second).toBe(true);
    }
  });
});

describe('poll cadence', () => {
  it('fetches immediately on start and never before', async () => {
    const h = harness();
    h.poller.start();
    expect(h.fetchSnapshot).not.toHaveBeenCalled();
    await advance(0);
    expect(h.fetchSnapshot).toHaveBeenCalledTimes(1);
  });

  it('start() and stop() are idempotent, and start() after stop() is a no-op', async () => {
    const h = harness();
    h.poller.start();
    h.poller.start();
    await advance(0);
    expect(h.fetchSnapshot).toHaveBeenCalledTimes(1);

    h.poller.stop();
    h.poller.stop();
    h.poller.start();
    await advance(600_000);
    expect(h.fetchSnapshot).toHaveBeenCalledTimes(1);
  });

  it("polls 'unknown' every 60 s", async () => {
    const h = harness({ initialPhase: 'unknown' });
    h.poller.start();
    await advance(0);
    await advance(UNKNOWN_MS - 1);
    expect(h.fetchSnapshot).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(h.fetchSnapshot).toHaveBeenCalledTimes(2);
  });

  it("polls 'in' at liveSeconds with a deterministic ±10% jitter", async () => {
    const h = harness({ initialPhase: 'in' });
    h.poller.start();
    await advance(0); // t=0 → jitter −10% → 18 000 ms
    await advance(17_999);
    expect(h.fetchSnapshot).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(h.fetchSnapshot).toHaveBeenCalledTimes(2);

    // t=18 000 → 18000 % 2001 = 1992 → +9.84% → 21 984 ms
    await advance(21_983);
    expect(h.fetchSnapshot).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(h.fetchSnapshot).toHaveBeenCalledTimes(3);
  });

  it('clamps liveSeconds and keeps every jitter inside ±10%', async () => {
    for (const [liveSeconds, base] of [
      [20, 20_000],
      [1, 10_000],
      [9999, 120_000],
      [NaN, 20_000],
    ] as const) {
      vi.setSystemTime(EPOCH);
      const h = harness({ initialPhase: 'in', liveSeconds });
      h.poller.start();
      await advance(0);
      await advance(base * 0.9 - 1);
      expect(h.fetchSnapshot, `liveSeconds=${liveSeconds}`).toHaveBeenCalledTimes(1);
      await advance(base * 0.2 + 1);
      expect(h.fetchSnapshot, `liveSeconds=${liveSeconds}`).toHaveBeenCalledTimes(2);
      h.poller.stop();
    }
  });

  it("polls 'pre' every 60 s, tightening to 20 s within 2 min of the start (or past it)", async () => {
    const t0 = Date.parse('2026-07-08T19:00:00Z');
    const cases: Array<[string | undefined, number]> = [
      ['2026-07-08T19:45:00Z', 60_000], // 45 min out
      ['2026-07-08T19:02:01Z', 60_000], // 121 s out — just outside the window
      ['2026-07-08T19:01:00Z', 20_000], // 60 s out
      ['2026-07-08T19:02:00Z', 20_000], // exactly 120 s out
      ['2026-07-08T18:00:00Z', 20_000], // already past
      [undefined, 60_000], // unparsable start
      ['TBD', 60_000],
    ];
    for (const [startTimeUtc, expected] of cases) {
      vi.setSystemTime(t0);
      const h = harness({ initialPhase: 'pre', startTimeUtc }, async () => snapshot('pre'));
      h.poller.start();
      await advance(0);
      await advance(expected - 1);
      expect(h.fetchSnapshot, `${String(startTimeUtc)}`).toHaveBeenCalledTimes(1);
      await advance(1);
      expect(h.fetchSnapshot, `${String(startTimeUtc)}`).toHaveBeenCalledTimes(2);
      h.poller.stop();
    }
  });

  it('never runs two fetches at once for one game — a slow tick is skipped, not queued', async () => {
    let resolveFetch: ((s: PlaySnapshot) => void) | undefined;
    const h = harness({ initialPhase: 'in' }, () => new Promise<PlaySnapshot>((r) => (resolveFetch = r)));
    h.poller.start();
    await advance(0);
    expect(h.fetchSnapshot).toHaveBeenCalledTimes(1);

    // Three tick deadlines pass while the first fetch is still in flight.
    await advance(60_000);
    expect(h.fetchSnapshot).toHaveBeenCalledTimes(1);

    resolveFetch?.(snapshot('in'));
    await advance(0);
    expect(h.fetchSnapshot).toHaveBeenCalledTimes(1);

    await advance(25_000); // the next armed tick now finds the loop idle
    expect(h.fetchSnapshot).toHaveBeenCalledTimes(2);
  });
});

describe('failure policy', () => {
  it('backs off exponentially and surfaces trouble once the streak reaches 3', async () => {
    const h = harness({ initialPhase: 'unknown' }, rejectWith(new ProviderError('network', 'ECONNRESET')));
    h.poller.start();
    await advance(0);
    expect(h.fetchSnapshot).toHaveBeenCalledTimes(1);
    expect(h.systemKeys()).toEqual([]);

    await advance(119_999); // 60 s · 2^1
    expect(h.fetchSnapshot).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(h.fetchSnapshot).toHaveBeenCalledTimes(2);
    expect(h.systemKeys()).toEqual([]);

    await advance(240_000); // 60 s · 2^2
    expect(h.fetchSnapshot).toHaveBeenCalledTimes(3);
    expect(h.systemKeys()).toEqual(['connectionTrouble']);

    await advance(299_999); // 60 s · 2^3 clamped to 300 s
    expect(h.fetchSnapshot).toHaveBeenCalledTimes(3);
    await advance(1);
    expect(h.fetchSnapshot).toHaveBeenCalledTimes(4);
    // Trouble is surfaced once per streak, not once per failure.
    expect(h.systemKeys()).toEqual(['connectionTrouble']);
  });

  it('surfaces recovery exactly once, and only after a surfaced streak', async () => {
    let fail = true;
    const h = harness({ initialPhase: 'unknown' }, async () => {
      if (fail) throw new ProviderError('network', 'down');
      return snapshot('unknown');
    });
    h.poller.start();
    await advance(0);
    await advance(120_000);
    await advance(240_000);
    expect(h.systemKeys()).toEqual(['connectionTrouble']);

    fail = false;
    await advance(300_000);
    expect(h.systemKeys()).toEqual(['connectionTrouble', 'connectionRestored']);

    await advance(60_000); // a further success says nothing
    expect(h.systemKeys()).toEqual(['connectionTrouble', 'connectionRestored']);
  });

  it('a short failure streak that recovers stays silent', async () => {
    let fail = true;
    const h = harness({ initialPhase: 'unknown' }, async () => {
      if (fail) throw new ProviderError('network', 'blip');
      return snapshot('unknown');
    });
    h.poller.start();
    await advance(0);
    await advance(120_000);
    fail = false;
    await advance(240_000);
    expect(h.systemKeys()).toEqual([]);
  });

  it('P6: 429 with Retry-After 120 delays the next poll by at least 120 s', async () => {
    const h = harness(
      { initialPhase: 'unknown' },
      rejectWith(new ProviderError('rate-limit', 'slow down', 120_000)),
    );
    h.poller.start();
    await advance(0);
    expect(h.fetchSnapshot).toHaveBeenCalledTimes(1);
    await advance(119_999);
    expect(h.fetchSnapshot).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(h.fetchSnapshot).toHaveBeenCalledTimes(2);
  });

  it('a 429 without Retry-After still waits the 60 s floor, and counts as a failure', async () => {
    const h = harness({ initialPhase: 'in' }, rejectWith(new ProviderError('rate-limit', 'slow down')));
    h.poller.start();
    await advance(0);
    await advance(59_999);
    expect(h.fetchSnapshot).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(h.fetchSnapshot).toHaveBeenCalledTimes(2);

    await advance(120_000); // third failure
    expect(h.systemKeys()).toEqual(['connectionTrouble']);
  });

  it("'unavailable' follows the network policy", async () => {
    const h = harness({ initialPhase: 'unknown' }, rejectWith(new ProviderError('unavailable', 'oversize')));
    h.poller.start();
    await advance(0);
    await advance(120_000);
    await advance(240_000);
    expect(h.fetchSnapshot).toHaveBeenCalledTimes(3);
    expect(h.systemKeys()).toEqual(['connectionTrouble']);
  });

  it("'parse' logs the payload head and follows the network policy (P1)", async () => {
    const err = new ProviderError('parse', 'invalid JSON', undefined, '<html>504 Gateway');
    const h = harness({ initialPhase: 'unknown' }, rejectWith(err));
    h.poller.start();
    await advance(0);
    expect(h.onDiagnostic).toHaveBeenCalledWith('<html>504 Gateway');
    await advance(119_999);
    expect(h.fetchSnapshot).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(h.fetchSnapshot).toHaveBeenCalledTimes(2);
  });

  it('wraps a non-ProviderError as parse, logs a stack, and keeps polling', async () => {
    const h = harness({ initialPhase: 'unknown' }, rejectWith(new TypeError('cannot read x of undefined')));
    h.poller.start();
    await advance(0);
    expect(h.onDiagnostic).toHaveBeenCalledTimes(2); // stack, then payload-head fallback
    expect(h.onDiagnostic.mock.calls[0]?.[0]).toContain('cannot read x of undefined');
    await advance(120_000);
    expect(h.fetchSnapshot).toHaveBeenCalledTimes(2);
  });

  it('3 consecutive not-founds unfollow the game, quietly and only once', async () => {
    const h = harness({ initialPhase: 'unknown' }, rejectWith(new ProviderError('not-found', 'gone')));
    h.poller.start();
    await advance(0);
    await advance(120_000);
    expect(h.onAutoUnfollow).not.toHaveBeenCalled();
    await advance(240_000);

    expect(h.fetchSnapshot).toHaveBeenCalledTimes(3);
    expect(h.systemKeys()).toEqual(['gameVanished']); // no connectionTrouble noise
    expect(h.onAutoUnfollow).toHaveBeenCalledTimes(1);

    await advance(1_000_000);
    expect(h.fetchSnapshot).toHaveBeenCalledTimes(3);
    expect(h.onAutoUnfollow).toHaveBeenCalledTimes(1);
  });

  it('a not-found streak is broken by any other outcome', async () => {
    let kind: 'not-found' | 'network' = 'not-found';
    const h = harness({ initialPhase: 'unknown' }, async () => {
      throw new ProviderError(kind, 'x');
    });
    h.poller.start();
    await advance(0);
    await advance(120_000);
    kind = 'network';
    await advance(240_000); // streak broken here
    kind = 'not-found';
    await advance(300_000);
    await advance(300_000);
    expect(h.onAutoUnfollow).not.toHaveBeenCalled();
  });
});

describe('auth handling', () => {
  it('key-free provider (no isProviderBlocked): auth behaves exactly like network', async () => {
    const h = harness({ initialPhase: 'unknown' }, rejectWith(new ProviderError('auth', 'HTTP 403')));
    h.poller.start();
    await advance(0);
    await advance(120_000);
    await advance(240_000);
    expect(h.fetchSnapshot).toHaveBeenCalledTimes(3);
    expect(h.systemKeys()).toEqual(['connectionTrouble']);
    expect(h.systemKeys()).not.toContain('authRequired');
  });

  it('keyed provider: reports authRequired once, then idles while blocked and resumes when unblocked', async () => {
    let blocked = false;
    let fail = true;
    const h = harness(
      { initialPhase: 'unknown', isProviderBlocked: () => blocked },
      async () => {
        if (fail) throw new ProviderError('auth', 'HTTP 401');
        return snapshot('unknown');
      },
    );
    h.poller.start();
    await advance(0);
    expect(h.systemKeys()).toEqual(['authRequired']);
    expect(h.fetchSnapshot).toHaveBeenCalledTimes(1);

    blocked = true; // the UI marks the provider blocked on hearing authRequired
    await advance(60_000);
    await advance(60_000);
    expect(h.fetchSnapshot).toHaveBeenCalledTimes(1);
    expect(h.systemKeys()).toEqual(['authRequired']);

    blocked = false;
    fail = false;
    await advance(60_000);
    expect(h.fetchSnapshot).toHaveBeenCalledTimes(2);
    expect(h.systemKeys()).toEqual(['authRequired']);
  });

  it('never polls while the provider is blocked', async () => {
    const h = harness({ initialPhase: 'in', isProviderBlocked: () => true });
    h.poller.start();
    await advance(600_000);
    expect(h.fetchSnapshot).not.toHaveBeenCalled();
  });

  it('re-arms authRequired after a successful poll intervenes', async () => {
    let fail = true;
    const h = harness({ initialPhase: 'unknown', isProviderBlocked: () => false }, async () => {
      if (fail) throw new ProviderError('auth', 'HTTP 401');
      return snapshot('unknown');
    });
    h.poller.start();
    await advance(0);
    fail = false;
    await advance(60_000);
    fail = true;
    await advance(60_000);
    expect(h.systemKeys()).toEqual(['authRequired', 'authRequired']);
  });
});

describe('post phase and auto-unfollow', () => {
  it('stops the loop on the first post ingest and unfollows 10 min later', async () => {
    const h = harness({ initialPhase: 'in' }, async () => snapshot('post'));
    h.poller.start();
    await advance(0);
    expect(h.fetchSnapshot).toHaveBeenCalledTimes(1);
    expect(h.onEmission).toHaveBeenCalledTimes(1);

    await advance(599_999);
    expect(h.fetchSnapshot).toHaveBeenCalledTimes(1); // loop is dead
    expect(h.onAutoUnfollow).not.toHaveBeenCalled();

    await advance(1);
    expect(h.systemKeys()).toEqual(['autoUnfollowed']);
    expect(h.onAutoUnfollow).toHaveBeenCalledTimes(1);

    await advance(1_000_000);
    expect(h.onAutoUnfollow).toHaveBeenCalledTimes(1);
  });

  it('the auto-unfollow one-shot does not depend on future ticks and is armed once', async () => {
    let phase: GamePhase = 'in';
    const h = harness({ initialPhase: 'in' }, async () => snapshot(phase));
    h.poller.start();
    await advance(0);
    phase = 'post';
    await advance(18_000); // second poll observes post at t = 18 000
    expect(h.fetchSnapshot).toHaveBeenCalledTimes(2);

    await advance(599_999);
    expect(h.onAutoUnfollow).not.toHaveBeenCalled();
    await advance(1);
    expect(h.onAutoUnfollow).toHaveBeenCalledTimes(1);
  });

  it('stop() cancels the pending auto-unfollow one-shot', async () => {
    const h = harness({ initialPhase: 'in' }, async () => snapshot('post'));
    h.poller.start();
    await advance(0);
    h.poller.stop();
    await advance(1_000_000);
    expect(h.onAutoUnfollow).not.toHaveBeenCalled();
    expect(h.systemKeys()).toEqual([]);
  });

  it('a game born in post emits its final line exactly once and never polls again', async () => {
    const engine = createRelayEngine({ backfillLimit: 10, locale: 'en' });
    const h = harness({ initialPhase: 'post', engine }, async () => ({
      game: game('post'),
      events: [
        {
          id: 'p1',
          gameId: 'mlb:mlb:747000',
          sequence: 1,
          clock: undefined,
          period: 'B9',
          text: 'Flyout to center.',
          kind: 'play',
          scoreAfter: undefined,
        },
      ],
    }));

    h.poller.start();
    await advance(0);
    expect(h.fetchSnapshot).toHaveBeenCalledTimes(1);
    expect(h.onEmission).toHaveBeenCalledTimes(1);

    const emission = h.onEmission.mock.calls[0]?.[0] as { events: Array<{ kind: string; text: string }> };
    expect(emission.events.map((e) => e.kind)).toEqual(['play', 'system']);
    expect(emission.events[1]?.text).toBe('Final — CHC 3 : 2 STL');

    await advance(599_999);
    expect(h.fetchSnapshot).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(h.onAutoUnfollow).toHaveBeenCalledTimes(1);
  });
});

describe('boundary hardening (§7)', () => {
  it('an ingest that throws is logged as a diagnostic, not counted as a connection failure', async () => {
    const engine: RelayEngine = {
      ingest: () => {
        throw new Error('engine bug');
      },
    };
    const h = harness({ initialPhase: 'unknown', engine });
    h.poller.start();
    await advance(0);
    expect(h.onDiagnostic.mock.calls[0]?.[0]).toContain('engine bug');
    expect(h.systemKeys()).toEqual([]);

    // Normal interval, not a backoff: the connection is fine.
    await advance(60_000);
    expect(h.fetchSnapshot).toHaveBeenCalledTimes(2);
  });

  it('a throwing onSystemLine cannot kill the loop', async () => {
    const h = harness({ initialPhase: 'unknown' }, rejectWith(new ProviderError('network', 'down')));
    h.onSystemLine.mockImplementation(() => {
      throw new Error('channel disposed');
    });
    h.poller.start();
    await advance(0);
    await advance(120_000);
    await advance(240_000); // trouble line throws here
    await advance(300_000);
    expect(h.fetchSnapshot).toHaveBeenCalledTimes(4);
  });

  it('a throwing onDiagnostic cannot kill the loop', async () => {
    const h = harness({ initialPhase: 'unknown' }, rejectWith(new TypeError('boom')));
    h.onDiagnostic.mockImplementation(() => {
      throw new Error('channel disposed');
    });
    h.poller.start();
    await advance(0);
    await advance(120_000);
    expect(h.fetchSnapshot).toHaveBeenCalledTimes(2);
  });

  it('a fetch that settles after stop() changes nothing', async () => {
    let resolveFetch: ((s: PlaySnapshot) => void) | undefined;
    const h = harness({ initialPhase: 'in' }, () => new Promise<PlaySnapshot>((r) => (resolveFetch = r)));
    h.poller.start();
    await advance(0);
    h.poller.stop();
    resolveFetch?.(snapshot('post'));
    await advance(1_000_000);
    expect(h.onEmission).not.toHaveBeenCalled();
    expect(h.onAutoUnfollow).not.toHaveBeenCalled();
  });
});

describe('runaway guard (§4, P10)', () => {
  const staleCount = (h: Harness): number => h.systemKeys().filter((k) => k === 'staleGame').length;

  it('P10: a provider stuck at phase "in" is force-stopped by the 12 h guard', async () => {
    // Upstream shape regression: fetchPlays never advances phase to 'post'.
    // At liveSeconds 120 the loop ticks ≈ every 2 min, so ≈ 360 ticks reach 12 h.
    const h = harness({ initialPhase: 'in', liveSeconds: 120 }, async () => snapshot('in'));
    h.poller.start();
    await advance(0);
    expect(h.fetchSnapshot).toHaveBeenCalledTimes(1);

    // Poll live right up to (but not across) the deadline — the guard is silent.
    await advance(RUNAWAY_MS - 1);
    expect(staleCount(h)).toBe(0);
    expect(h.onAutoUnfollow).not.toHaveBeenCalled();
    const fetchesBeforeDeadline = h.fetchSnapshot.mock.calls.length;

    // Cross the deadline: the next scheduled tick trips the guard instead of fetching.
    await advance(60_000);
    // (a) the fetch tick count stops growing after the deadline …
    expect(h.fetchSnapshot.mock.calls.length).toBe(fetchesBeforeDeadline);
    // (b) staleGame fired exactly once …
    expect(staleCount(h)).toBe(1);
    // (c) auto-unfollow fired exactly once …
    expect(h.onAutoUnfollow).toHaveBeenCalledTimes(1);
    // (d) no timers remain armed afterwards.
    expect(vi.getTimerCount()).toBe(0);

    // The loop is dead for good — nothing more fires or fetches.
    await advance(1_000_000);
    expect(h.fetchSnapshot.mock.calls.length).toBe(fetchesBeforeDeadline);
    expect(staleCount(h)).toBe(1);
    expect(h.onAutoUnfollow).toHaveBeenCalledTimes(1);
  });

  it('control: a game that reaches post before 12 h stops at the post ingest — the guard never fires', async () => {
    let ticks = 0;
    const h = harness({ initialPhase: 'in', liveSeconds: 120 }, async () => {
      ticks++;
      return snapshot(ticks >= 3 ? 'post' : 'in');
    });
    h.poller.start();
    await advance(0);
    expect(h.fetchSnapshot).toHaveBeenCalledTimes(1);

    // Ticks 2 and 3 land inside 500 s; the 3rd ingests 'post' and the loop stops.
    await advance(500_000);
    expect(h.fetchSnapshot).toHaveBeenCalledTimes(3);

    // Drive well past 12 h of simulated time: the guard must stay silent, the
    // loop must remain dead, and only the post path's +10 min auto-unfollow fires.
    await advance(RUNAWAY_MS + 1_000_000);
    expect(staleCount(h)).toBe(0);
    expect(h.fetchSnapshot).toHaveBeenCalledTimes(3);
    expect(h.onAutoUnfollow).toHaveBeenCalledTimes(1);
    expect(h.systemKeys()).toEqual(['autoUnfollowed']);
  });

  it('the guard fires at ~12 h even when the deadline falls mid-backoff, not at the backoff wake', async () => {
    // Perpetual network failures ⇒ exponential backoff clamped to 300 s. From
    // t=660 000 ms ticks land every 300 s; the last pre-deadline tick is at
    // 42 960 000 ms, whose natural 300 s wake would be 43 260 000 ms — 60 s PAST
    // the 43 200 000 ms deadline. The armTick clamp must pull that tick back to
    // the deadline so the guard fires on time.
    const h = harness({ initialPhase: 'unknown' }, rejectWith(new ProviderError('network', 'ECONNRESET')));
    h.poller.start();
    await advance(0);

    await advance(RUNAWAY_MS - 1); // t = 43 199 999, one ms shy of the deadline
    expect(staleCount(h)).toBe(0);
    const fetchesBeforeDeadline = h.fetchSnapshot.mock.calls.length;

    await advance(1); // t = 43 200 000 — the clamped guard tick fires here
    expect(staleCount(h)).toBe(1);
    expect(h.onAutoUnfollow).toHaveBeenCalledTimes(1);
    // The guard tick issued no fetch, and it fired at the deadline, not the wake.
    expect(h.fetchSnapshot.mock.calls.length).toBe(fetchesBeforeDeadline);
    expect(vi.getTimerCount()).toBe(0);

    // Advancing to and beyond the backoff's natural wake produces nothing new.
    await advance(120_000);
    expect(h.fetchSnapshot.mock.calls.length).toBe(fetchesBeforeDeadline);
    expect(staleCount(h)).toBe(1);
    expect(h.onAutoUnfollow).toHaveBeenCalledTimes(1);
  });
});
