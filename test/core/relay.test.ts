import { describe, expect, it } from 'vitest';
import type { Game, GamePhase, PlayEvent, PlaySnapshot } from '../../src/core/contract';
import { createRelayEngine } from '../../src/core/relay';

const GAME_ID = 'mlb:mlb:747000';

function game(overrides: Partial<Game> = {}): Game {
  return {
    id: GAME_ID,
    providerId: 'mlb',
    leagueId: 'mlb',
    leagueName: 'MLB',
    sport: 'baseball',
    startTimeUtc: '2026-07-08T19:45:00Z',
    phase: 'in',
    statusText: 'Top 7th',
    statusShort: 'T7',
    home: { id: '1', name: 'Cardinals', abbrev: 'STL', score: 2 },
    away: { id: '2', name: 'Cubs', abbrev: 'CHC', score: 3 },
    ...overrides,
  };
}

function ev(id: string, sequence: number, text: string, overrides: Partial<PlayEvent> = {}): PlayEvent {
  return {
    id,
    gameId: GAME_ID,
    sequence,
    clock: undefined,
    period: 'T7',
    text,
    kind: 'play',
    scoreAfter: undefined,
    ...overrides,
  };
}

const snap = (events: PlayEvent[], g: Game = game()): PlaySnapshot => ({ game: g, events });
const withScores = (away: number | undefined, home: number | undefined, phase: GamePhase = 'in'): Game =>
  game({
    phase,
    away: { id: '2', name: 'Cubs', abbrev: 'CHC', score: away },
    home: { id: '1', name: 'Cardinals', abbrev: 'STL', score: home },
  });

const texts = (events: PlayEvent[]): string[] => events.map((e) => e.text);
const ids = (events: PlayEvent[]): string[] => events.map((e) => e.id);

describe('backfill', () => {
  it('emits everything when the first snapshot fits under the limit', () => {
    const engine = createRelayEngine({ backfillLimit: 10, locale: 'en' });
    const out = engine.ingest(snap([ev('a', 1, 'one'), ev('b', 2, 'two')]));
    expect(ids(out.events)).toEqual(['a', 'b']);
    expect(out.events.every((e) => e.kind === 'play')).toBe(true);
  });

  it('P7: 5000 events with backfillLimit 10 → exactly 11 lines (1 system + 10 plays)', () => {
    const engine = createRelayEngine({ backfillLimit: 10, locale: 'en' });
    const events = Array.from({ length: 5000 }, (_, i) => ev(`p${i}`, i, `play ${i}`));
    const out = engine.ingest(snap(events));

    expect(out.events).toHaveLength(11);
    const [first, ...plays] = out.events;
    expect(first?.kind).toBe('system');
    expect(first?.text).toBe('(4990 earlier plays skipped)');
    expect(first?.id).toBe(`${GAME_ID}:system:backfill`);
    expect(texts(plays)).toEqual(Array.from({ length: 10 }, (_, i) => `play ${4990 + i}`));

    // Skipped ids are remembered: re-ingesting the same list emits nothing.
    expect(engine.ingest(snap(events)).events).toHaveLength(0);
  });

  it('emits the skip line in ko', () => {
    const engine = createRelayEngine({ backfillLimit: 1, locale: 'ko' });
    const out = engine.ingest(snap([ev('a', 1, 'one'), ev('b', 2, 'two'), ev('c', 3, 'three')]));
    expect(out.events[0]?.text).toBe('(이전 플레이 2개 생략)');
    expect(texts(out.events.slice(1))).toEqual(['three']);
  });

  it('backfillLimit 0 emits only the skip line, and still remembers every id', () => {
    const engine = createRelayEngine({ backfillLimit: 0, locale: 'en' });
    const first = engine.ingest(snap([ev('a', 1, 'one'), ev('b', 2, 'two')]));
    expect(first.events).toHaveLength(1);
    expect(first.events[0]?.text).toBe('(2 earlier plays skipped)');
    expect(engine.ingest(snap([ev('a', 1, 'one'), ev('b', 2, 'two')])).events).toHaveLength(0);
  });

  it('backfillLimit 0 with no events emits nothing at all', () => {
    const engine = createRelayEngine({ backfillLimit: 0, locale: 'en' });
    expect(engine.ingest(snap([])).events).toHaveLength(0);
  });

  it('later ingests are uncapped — a returning API hiccup is backfilled in full', () => {
    const engine = createRelayEngine({ backfillLimit: 2, locale: 'en' });
    engine.ingest(snap([ev('a', 1, 'one')]));
    const late = Array.from({ length: 50 }, (_, i) => ev(`p${i}`, i + 2, `play ${i}`));
    const out = engine.ingest(snap([ev('a', 1, 'one'), ...late]));
    expect(out.events).toHaveLength(50);
    expect(out.events.every((e) => e.kind === 'play')).toBe(true);
  });

  it('a NaN backfillLimit falls back to the pinned default of 10', () => {
    const engine = createRelayEngine({ backfillLimit: NaN, locale: 'en' });
    const out = engine.ingest(snap(Array.from({ length: 30 }, (_, i) => ev(`p${i}`, i, `play ${i}`))));
    expect(out.events).toHaveLength(11);
  });
});

describe('ordering and weird input', () => {
  it('orders by sequence ascending, ties broken by id lexicographically', () => {
    const engine = createRelayEngine({ backfillLimit: 100, locale: 'en' });
    const out = engine.ingest(snap([ev('z', 5, 'z5'), ev('b', 1, 'b1'), ev('a', 5, 'a5'), ev('c', 1, 'c1')]));
    expect(ids(out.events)).toEqual(['b', 'c', 'a', 'z']);
  });

  it('duplicate ids in one snapshot: first wins', () => {
    const engine = createRelayEngine({ backfillLimit: 100, locale: 'en' });
    const out = engine.ingest(snap([ev('a', 1, 'original'), ev('a', 2, 'shadow')]));
    expect(texts(out.events)).toEqual(['original']);
  });

  it('a non-finite sequence becomes previous max + 1', () => {
    const engine = createRelayEngine({ backfillLimit: 100, locale: 'en' });
    const out = engine.ingest(
      snap([ev('a', 10, 'ten'), ev('b', NaN, 'after ten'), ev('c', Infinity, 'after eleven')]),
    );
    expect(out.events.map((e) => e.sequence)).toEqual([10, 11, 12]);
    expect(ids(out.events)).toEqual(['a', 'b', 'c']);
  });

  it('a leading non-finite sequence starts at 0', () => {
    const engine = createRelayEngine({ backfillLimit: 100, locale: 'en' });
    const out = engine.ingest(snap([ev('a', NaN, 'first')]));
    expect(out.events[0]?.sequence).toBe(0);
  });

  it('never throws on empty, absent, or structurally broken events', () => {
    const engine = createRelayEngine({ backfillLimit: 10, locale: 'en' });
    expect(engine.ingest(snap([])).events).toHaveLength(0);
    expect(engine.ingest({ game: game(), events: undefined as unknown as PlayEvent[] }).events).toHaveLength(0);
    const junk = [null, undefined, 42, { id: '' }, { id: 'ok', sequence: 1, text: 'fine' }] as unknown as PlayEvent[];
    const out = engine.ingest(snap(junk));
    expect(ids(out.events)).toEqual(['ok']);
  });

  it('vanished events are ignored — no retraction, no re-emission', () => {
    const engine = createRelayEngine({ backfillLimit: 100, locale: 'en' });
    engine.ingest(snap([ev('a', 1, 'one'), ev('b', 2, 'two'), ev('c', 3, 'three')]));
    expect(engine.ingest(snap([ev('c', 3, 'three')])).events).toHaveLength(0);
    expect(engine.ingest(snap([ev('a', 1, 'one'), ev('b', 2, 'two'), ev('c', 3, 'three')])).events).toHaveLength(0);
  });
});

describe('corrections', () => {
  it('re-emits a changed text once as kind "correction"', () => {
    const engine = createRelayEngine({ backfillLimit: 100, locale: 'en' });
    engine.ingest(snap([ev('a', 1, 'Single to left.')]));
    const out = engine.ingest(snap([ev('a', 1, 'Double to left.')]));
    expect(out.events).toHaveLength(1);
    expect(out.events[0]).toMatchObject({ id: 'a', kind: 'correction', text: 'Double to left.' });
  });

  it('ignores whitespace-only text churn', () => {
    const engine = createRelayEngine({ backfillLimit: 100, locale: 'en' });
    engine.ingest(snap([ev('a', 1, 'Single to left.')]));
    expect(engine.ingest(snap([ev('a', 1, '  Single   to  left.  ')])).events).toHaveLength(0);
  });

  it('P4: shrink then re-grow with changed text ⇒ ≤ 1 correction, no duplicate originals', () => {
    const engine = createRelayEngine({ backfillLimit: 100, locale: 'en' });
    const first = engine.ingest(snap([ev('a', 1, 'A'), ev('b', 2, 'B'), ev('c', 3, 'C')]));
    expect(first.events).toHaveLength(3);

    expect(engine.ingest(snap([ev('a', 1, 'A')])).events).toHaveLength(0); // shrink

    const regrown = engine.ingest(snap([ev('a', 1, 'A revised'), ev('b', 2, 'B'), ev('c', 3, 'C')]));
    expect(regrown.events).toHaveLength(1);
    expect(regrown.events[0]?.kind).toBe('correction');

    // Further flapping on the same id is ignored (one correction per id per game).
    expect(engine.ingest(snap([ev('a', 1, 'A revised again'), ev('b', 2, 'B')])).events).toHaveLength(0);
    expect(engine.ingest(snap([ev('a', 1, 'A')])).events).toHaveLength(0);
  });

  it('a derived id never corrects: a text edit is a new id, i.e. one extra play line', () => {
    const engine = createRelayEngine({ backfillLimit: 100, locale: 'en' });
    engine.ingest(snap([ev('game|Goal!|0', 1, 'Goal!')]));
    const out = engine.ingest(snap([ev('game|Goal, offside|0', 1, 'Goal, offside')]));
    expect(out.events).toHaveLength(1);
    expect(out.events[0]?.kind).toBe('play');
  });

  it('sorts corrections in with new events by (sequence, id)', () => {
    const engine = createRelayEngine({ backfillLimit: 100, locale: 'en' });
    engine.ingest(snap([ev('a', 1, 'A'), ev('c', 3, 'C')]));
    const out = engine.ingest(snap([ev('a', 1, 'A fixed'), ev('b', 2, 'B'), ev('c', 3, 'C'), ev('d', 4, 'D')]));
    expect(ids(out.events)).toEqual(['a', 'b', 'd']);
    expect(out.events.map((e) => e.kind)).toEqual(['correction', 'play', 'play']);
  });

  it('a correction is impossible on the first ingest', () => {
    const engine = createRelayEngine({ backfillLimit: 100, locale: 'en' });
    const out = engine.ingest(snap([ev('a', 1, 'A'), ev('a', 1, 'A changed')]));
    expect(out.events.map((e) => e.kind)).toEqual(['play']);
  });
});

describe('scoreChanged', () => {
  it('is false on the first-ever ingest', () => {
    const engine = createRelayEngine({ backfillLimit: 10, locale: 'en' });
    expect(engine.ingest(snap([], withScores(3, 2))).scoreChanged).toBe(false);
  });

  it('true when a defined score changes, or becomes defined', () => {
    const engine = createRelayEngine({ backfillLimit: 10, locale: 'en' });
    engine.ingest(snap([], withScores(3, 2)));
    expect(engine.ingest(snap([], withScores(4, 2))).scoreChanged).toBe(true);
    expect(engine.ingest(snap([], withScores(4, 3))).scoreChanged).toBe(true);

    const other = createRelayEngine({ backfillLimit: 10, locale: 'en' });
    other.ingest(snap([], withScores(undefined, undefined)));
    expect(other.ingest(snap([], withScores(0, undefined))).scoreChanged).toBe(true);
  });

  it('false when nothing moves, and false when a score goes back to unknown', () => {
    const engine = createRelayEngine({ backfillLimit: 10, locale: 'en' });
    engine.ingest(snap([], withScores(3, 2)));
    expect(engine.ingest(snap([], withScores(3, 2))).scoreChanged).toBe(false);
    expect(engine.ingest(snap([], withScores(undefined, 2))).scoreChanged).toBe(false);
  });

  it('treats a NaN score as unknown, never as a change (P3)', () => {
    const engine = createRelayEngine({ backfillLimit: 10, locale: 'en' });
    engine.ingest(snap([], withScores(NaN, NaN)));
    expect(engine.ingest(snap([], withScores(NaN, NaN))).scoreChanged).toBe(false);
    expect(engine.ingest(snap([], withScores(1, NaN))).scoreChanged).toBe(true);
  });
});

describe('phaseTransition', () => {
  it('is undefined on the first-ever ingest, even for a game born in post', () => {
    const engine = createRelayEngine({ backfillLimit: 10, locale: 'en' });
    expect(engine.ingest(snap([], game({ phase: 'post' }))).phaseTransition).toBeUndefined();
  });

  it('is set on any phase change and cleared when the phase holds', () => {
    const engine = createRelayEngine({ backfillLimit: 10, locale: 'en' });
    engine.ingest(snap([], game({ phase: 'pre' })));
    expect(engine.ingest(snap([], game({ phase: 'in' }))).phaseTransition).toEqual({ from: 'pre', to: 'in' });
    expect(engine.ingest(snap([], game({ phase: 'in' }))).phaseTransition).toBeUndefined();
    expect(engine.ingest(snap([], game({ phase: 'post' }))).phaseTransition).toEqual({ from: 'in', to: 'post' });
  });
});

describe('final line', () => {
  it('fires on the first post ingest even when that is the first-ever ingest', () => {
    const engine = createRelayEngine({ backfillLimit: 10, locale: 'en' });
    const out = engine.ingest(snap([ev('a', 1, 'last play')], withScores(3, 2, 'post')));
    expect(out.events).toHaveLength(2);
    const last = out.events[1];
    expect(last?.kind).toBe('system');
    expect(last?.id).toBe(`${GAME_ID}:system:final`);
    expect(last?.text).toBe('Final — CHC 3 : 2 STL');
  });

  it('fires at most once per engine instance', () => {
    const engine = createRelayEngine({ backfillLimit: 10, locale: 'en' });
    engine.ingest(snap([], withScores(3, 2, 'post')));
    expect(engine.ingest(snap([], withScores(3, 2, 'post'))).events).toHaveLength(0);
    expect(engine.ingest(snap([], withScores(4, 2, 'post'))).events).toHaveLength(0);
  });

  it('fires on unknown → post and on in → post alike', () => {
    const fromUnknown = createRelayEngine({ backfillLimit: 10, locale: 'en' });
    fromUnknown.ingest(snap([], game({ phase: 'unknown' })));
    expect(fromUnknown.ingest(snap([], withScores(3, 2, 'post'))).events).toHaveLength(1);

    const fromIn = createRelayEngine({ backfillLimit: 10, locale: 'en' });
    fromIn.ingest(snap([], withScores(3, 2, 'in')));
    expect(fromIn.ingest(snap([], withScores(3, 2, 'post'))).events).toHaveLength(1);
  });

  it('uses gameEnded when no score is known (postponed / cancelled)', () => {
    const engine = createRelayEngine({ backfillLimit: 10, locale: 'en' });
    const out = engine.ingest(snap([], withScores(undefined, undefined, 'post')));
    expect(out.events[0]?.text).toBe('Game ended.');
  });

  it('uses gameEnded when the only scores are junk (P3)', () => {
    const engine = createRelayEngine({ backfillLimit: 10, locale: 'en' });
    const out = engine.ingest(snap([], withScores(NaN, -1, 'post')));
    expect(out.events[0]?.text).toBe('Game ended.');
  });

  it('renders a dash for a half-known final score', () => {
    const engine = createRelayEngine({ backfillLimit: 10, locale: 'en' });
    const out = engine.ingest(snap([], withScores(3, undefined, 'post')));
    expect(out.events[0]?.text).toBe('Final — CHC 3 : – STL');
  });

  it('localizes the final line', () => {
    const engine = createRelayEngine({ backfillLimit: 10, locale: 'ko' });
    expect(engine.ingest(snap([], withScores(3, 2, 'post'))).events[0]?.text).toBe('경기 종료 — CHC 3 : 2 STL');

    const ended = createRelayEngine({ backfillLimit: 10, locale: 'ko' });
    expect(ended.ingest(snap([], withScores(undefined, undefined, 'post'))).events[0]?.text).toBe(
      '경기가 종료되었습니다',
    );
  });

  it('lands after the backfill skip line and the plays', () => {
    const engine = createRelayEngine({ backfillLimit: 2, locale: 'en' });
    const events = [ev('a', 1, 'A'), ev('b', 2, 'B'), ev('c', 3, 'C'), ev('d', 4, 'D')];
    const out = engine.ingest({ game: withScores(3, 2, 'post'), events });
    expect(out.events.map((e) => e.kind)).toEqual(['system', 'play', 'play', 'system']);
    expect(texts(out.events)).toEqual(['(2 earlier plays skipped)', 'C', 'D', 'Final — CHC 3 : 2 STL']);
  });
});

describe('emission shape', () => {
  it('always returns the fresh game snapshot, even with zero events', () => {
    const engine = createRelayEngine({ backfillLimit: 10, locale: 'en' });
    const g = withScores(5, 4);
    const out = engine.ingest(snap([], g));
    expect(out.game).toBe(g);
    expect(out.events).toEqual([]);
  });

  it('does not mutate the caller-owned events', () => {
    const engine = createRelayEngine({ backfillLimit: 10, locale: 'en' });
    const source = ev('a', NaN, 'A');
    engine.ingest(snap([source]));
    expect(Number.isNaN(source.sequence)).toBe(true);
    expect(source.kind).toBe('play');
  });
});
