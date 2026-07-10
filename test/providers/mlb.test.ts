import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DetailLevel, Game, League, ProviderContext, ProviderError, RelayLocale } from '../../src/core/contract';
import { createRelayEngine } from '../../src/core/relay';
import { dateInZone } from '../../src/core/util';
import { mlbProvider } from '../../src/providers/mlb';

function load(name: string): any {
  return JSON.parse(readFileSync(join(process.cwd(), 'test', 'fixtures', name), 'utf8'));
}
function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

interface CtxOpts {
  detail?: DetailLevel;
  locale?: RelayLocale;
  gameStateEnabled?: boolean;
}

function makeCtx(payload: unknown, now = 0, opts: CtxOpts = {}): { ctx: ProviderContext; logs: string[]; urls: string[] } {
  const logs: string[] = [];
  const urls: string[] = [];
  const ctx: ProviderContext = {
    locale: opts.locale ?? 'en',
    gameStateEnabled: opts.gameStateEnabled ?? true,
    detail: opts.detail ?? 'summary',
    fetchJson: async (url: string) => {
      urls.push(url);
      return payload;
    },
    getSecret: async () => undefined,
    log: (m: string) => logs.push(m),
    now: () => now,
  };
  return { ctx, logs, urls };
}

function throwingCtx(err: unknown): ProviderContext {
  return {
    locale: 'en',
    gameStateEnabled: true,
    detail: 'summary',
    fetchJson: async () => {
      throw err;
    },
    getSecret: async () => undefined,
    log: () => {},
    now: () => 0,
  };
}

// Pitch lines are composed against the PRODUCTION i18n registry (src/core/i18n.ts,
// CONTRACT §12.7), which is populated as a side effect of importing the provider
// under test. Registering local templates here is exactly what once hid param-name
// drift between the provider and the real registry — so these tests deliberately
// exercise the shipped templates, not a private copy.

const MLB: League = { id: 'mlb', providerId: 'mlb', name: 'MLB', sport: 'baseball' };

function mlbGame(gamePk: string): Game {
  return {
    id: `mlb:mlb:${gamePk}`,
    providerId: 'mlb',
    leagueId: 'mlb',
    leagueName: 'MLB',
    sport: 'baseball',
    startTimeUtc: undefined,
    phase: 'in',
    statusText: 'x',
    statusShort: 'x',
    home: { id: '138', name: 'St. Louis Cardinals', abbrev: 'STL', score: undefined },
    away: { id: '158', name: 'Milwaukee Brewers', abbrev: 'MIL', score: undefined },
  };
}

// --- listGames -------------------------------------------------------------

describe('mlb listGames (schedule)', () => {
  it('parses a doubleheader as two distinct Final games', async () => {
    const { ctx } = makeCtx(load('mlb-schedule.json'));
    const games = await mlbProvider.listGames(ctx, MLB);
    expect(games).toHaveLength(2);
    expect(games[0].id).toBe('mlb:mlb:823062');
    expect(games[1].id).toBe('mlb:mlb:823035');
    expect(games[0].id).not.toBe(games[1].id); // doubleheader ⇒ no special casing needed

    const g0 = games[0];
    expect(g0.phase).toBe('post');
    expect(g0.statusText).toBe('Final');
    expect(g0.statusShort).toBe('F');
    expect(g0.away.name).toBe('Milwaukee Brewers');
    expect(g0.away.abbrev).toBe('MIL'); // derived from name (schedule carries no abbreviation)
    expect(g0.away.score).toBe(4);
    expect(g0.home.score).toBe(3);
    expect(g0.startTimeUtc).toBe('2026-07-07T18:15:00Z');

    expect(games[1].away.score).toBe(10);
    expect(games[1].home.score).toBe(2);
  });

  it('requests the schedule for the America/New_York local date, not the UTC date', async () => {
    // 2026-07-08 02:00 UTC is still 2026-07-07 in ET (a KST user should still see ET-evening games).
    const now = Date.UTC(2026, 6, 8, 2, 0, 0);
    const { ctx, urls } = makeCtx(load('mlb-schedule.json'), now);
    await mlbProvider.listGames(ctx, MLB);
    const expected = dateInZone(now, 'America/New_York');
    expect(expected).toBe('2026-07-07');
    expect(urls[0]).toContain(`date=${expected}`);
    expect(urls[0]).toContain('sportId=1');
  });

  it('maps abstractGameState phases: Preview→pre, Live→in, Final→post, else unknown', async () => {
    const base = load('mlb-schedule.json');
    const cases: Array<[string, string]> = [
      ['Preview', 'pre'],
      ['Live', 'in'],
      ['Final', 'post'],
      ['Suspended', 'unknown'],
    ];
    for (const [abstract, phase] of cases) {
      const mut = clone(base);
      mut.dates[0].games[0].status.abstractGameState = abstract;
      const games = await mlbProvider.listGames(makeCtx(mut).ctx, MLB);
      expect(games[0].phase).toBe(phase);
    }
  });

  it('P5: unparsable gameDate ⇒ startTimeUtc undefined, phase still derived', async () => {
    const mut = clone(load('mlb-schedule.json'));
    mut.dates[0].games[0].gameDate = 'TBD';
    const games = await mlbProvider.listGames(makeCtx(mut).ctx, MLB);
    expect(games[0].startTimeUtc).toBeUndefined();
    expect(games[0].phase).toBe('post');
  });
});

// --- fetchPlays ------------------------------------------------------------

describe('mlb fetchPlays (feed/live)', () => {
  it('emits complete plays sorted by atBatIndex with pinned ids, periods and score kinds', async () => {
    const { ctx } = makeCtx(load('mlb-feed-live.json'));
    const snap = await mlbProvider.fetchPlays(ctx, mlbGame('823062'));
    // fixture allPlays are out of order (7,17,0,1,2,73) ⇒ sorted 0,1,2,7,17,73.
    // Result-line sequence is atBatIndex*1000+999 (§12.3), applied in BOTH detail levels.
    expect(snap.events.map((e) => e.sequence)).toEqual([999, 1999, 2999, 7999, 17999, 73999]);
    expect(snap.events.map((e) => e.id)).toEqual([
      'mlb:823062:0',
      'mlb:823062:1',
      'mlb:823062:2',
      'mlb:823062:7',
      'mlb:823062:17',
      'mlb:823062:73',
    ]);
    // period T{n}/B{n} from halfInning.
    const byId = new Map(snap.events.map((e) => [e.id, e]));
    expect(byId.get('mlb:823062:0')!.period).toBe('T1');
    expect(byId.get('mlb:823062:7')!.period).toBe('B1');
    expect(byId.get('mlb:823062:17')!.period).toBe('T3');
    expect(byId.get('mlb:823062:73')!.period).toBe('B9');
    // scoring plays.
    expect(byId.get('mlb:823062:7')!.kind).toBe('score');
    expect(byId.get('mlb:823062:7')!.scoreAfter).toEqual({ home: 2, away: 0 });
    expect(byId.get('mlb:823062:17')!.kind).toBe('score');
    expect(byId.get('mlb:823062:17')!.scoreAfter).toEqual({ home: 2, away: 1 });
    expect(byId.get('mlb:823062:0')!.kind).toBe('play');
    expect(snap.events.every((e) => e.clock === undefined)).toBe(true);
  });

  it('builds a fresh Final game from gameData + linescore', async () => {
    const snap = await mlbProvider.fetchPlays(makeCtx(load('mlb-feed-live.json')).ctx, mlbGame('823062'));
    expect(snap.game.phase).toBe('post');
    expect(snap.game.statusText).toBe('Final');
    expect(snap.game.statusShort).toBe('F');
    expect(snap.game.home.abbrev).toBe('STL'); // feed carries the abbreviation
    expect(snap.game.away.abbrev).toBe('MIL');
    expect(snap.game.home.score).toBe(3); // from linescore runs
    expect(snap.game.away.score).toBe(4);
  });

  it('only emits plays with isComplete === true AND non-empty description', async () => {
    const base = load('mlb-feed-live.json');
    const mut = clone(base);
    mut.liveData.plays.allPlays[2].about.isComplete = false; // atBatIndex 0 → excluded
    mut.liveData.plays.allPlays[3].result.description = ''; // atBatIndex 1 → excluded
    const snap = await mlbProvider.fetchPlays(makeCtx(mut).ctx, mlbGame('823062'));
    expect(snap.events.map((e) => e.sequence)).toEqual([2999, 7999, 17999, 73999]);
  });

  it('P3: invalid result scores ⇒ scoreAfter undefined, never NaN', async () => {
    const mut = clone(load('mlb-feed-live.json'));
    mut.liveData.plays.allPlays[0].result.homeScore = 'N/A';
    mut.liveData.plays.allPlays[0].result.awayScore = '1e9';
    const snap = await mlbProvider.fetchPlays(makeCtx(mut).ctx, mlbGame('823062'));
    const ev = snap.events.find((e) => e.id === 'mlb:823062:7');
    expect(ev!.scoreAfter).toBeUndefined();
  });

  it('live inningState maps to statusShort/statusText including Middle/End', async () => {
    const base = load('mlb-feed-live.json');
    const cases: Array<[string, string, string]> = [
      ['Top', 'T7', 'Top 7th'],
      ['Bottom', 'B7', 'Bottom 7th'],
      ['Middle', 'M7', 'Middle 7th'],
      ['End', 'E7', 'End 7th'],
    ];
    for (const [state, short, text] of cases) {
      const mut = clone(base);
      mut.gameData.status.abstractGameState = 'Live';
      mut.liveData.linescore.currentInning = 7;
      mut.liveData.linescore.inningState = state;
      const snap = await mlbProvider.fetchPlays(makeCtx(mut).ctx, mlbGame('823062'));
      expect(snap.game.statusShort).toBe(short);
      expect(snap.game.statusText).toBe(text);
    }
  });
});

// --- live current state (§11.3) --------------------------------------------

describe('mlb fetchPlays live state (bases/count/lineups)', () => {
  it('builds baseball state from linescore + boxscore while live', async () => {
    const { ctx } = makeCtx(load('mlb-feed-live-state.json'));
    const snap = await mlbProvider.fetchPlays(ctx, mlbGame('823062'));
    expect(snap.game.phase).toBe('in');
    expect(snap.state).toBeDefined();
    const state = snap.state as any;
    expect(state.kind).toBe('baseball');
    expect(state.balls).toBe(1);
    expect(state.strikes).toBe(0);
    expect(state.outs).toBe(2);
    // occupied bases only; empty (null) third ⇒ undefined.
    expect(state.bases.first).toBe('Adley Rutschman');
    expect(state.bases.second).toBe('Gunnar Henderson');
    expect(state.bases.third).toBeUndefined();
    expect(state.atBat).toBe('Taylor Ward');
    expect(state.onDeck).toBe('Pete Alonso');
    expect(state.pitcher).toBe('Trent Thornton');
    // batting order resolved 1-based via players['ID'+id].
    expect(state.lineups.home).toHaveLength(9);
    expect(state.lineups.away).toHaveLength(9);
    expect(state.lineups.home[0]).toEqual({ order: 1, name: 'Gunnar Henderson', position: 'SS' });
    expect(state.lineups.home[2]).toEqual({ order: 3, name: 'Taylor Ward', position: 'LF' });
  });

  it('missing offense ⇒ bases + atBat/onDeck undefined, no throw, still baseball state', async () => {
    const mut = clone(load('mlb-feed-live-state.json'));
    delete mut.liveData.linescore.offense;
    const snap = await mlbProvider.fetchPlays(makeCtx(mut).ctx, mlbGame('823062'));
    const state = snap.state as any;
    expect(state.kind).toBe('baseball');
    expect(state.bases.first).toBeUndefined();
    expect(state.bases.second).toBeUndefined();
    expect(state.bases.third).toBeUndefined();
    expect(state.atBat).toBeUndefined();
    expect(state.onDeck).toBeUndefined();
    expect(state.lineups.home).toHaveLength(9); // lineups come from boxscore, unaffected
  });

  it('a batting-order id absent from players is skipped, other spots present', async () => {
    const mut = clone(load('mlb-feed-live-state.json'));
    mut.liveData.boxscore.teams.home.battingOrder[4] = 111111; // no ID111111 entry
    const { ctx, logs } = makeCtx(mut);
    const snap = await mlbProvider.fetchPlays(ctx, mlbGame('823062'));
    const state = snap.state as any;
    expect(state.lineups.home).toHaveLength(8);
    expect(state.lineups.away).toHaveLength(9);
    expect(logs.some((l) => l.includes('not in boxscore.players'))).toBe(true);
    // surviving spots keep their real 1-based order (the missing slot 5 just drops out).
    expect(state.lineups.home.map((s: any) => s.order)).toEqual([1, 2, 3, 4, 6, 7, 8, 9]);
  });

  it('non-integer / out-of-range counts are coerced and clamped', async () => {
    const mut = clone(load('mlb-feed-live-state.json'));
    mut.liveData.linescore.balls = '5';
    mut.liveData.linescore.strikes = '-1';
    mut.liveData.linescore.outs = null;
    const snap = await mlbProvider.fetchPlays(makeCtx(mut).ctx, mlbGame('823062'));
    const state = snap.state as any;
    expect(state.balls).toBe(4); // clamp 0–4
    expect(state.strikes).toBe(0); // clamp 0–3
    expect(state.outs).toBe(0); // missing ⇒ 0
  });

  it('phase not in (Final) ⇒ state undefined, game/events still returned', async () => {
    const mut = clone(load('mlb-feed-live-state.json'));
    mut.gameData.status.abstractGameState = 'Final';
    const snap = await mlbProvider.fetchPlays(makeCtx(mut).ctx, mlbGame('823062'));
    expect(snap.game.phase).toBe('post');
    expect(snap.state).toBeUndefined();
    expect(Array.isArray(snap.events)).toBe(true);
  });

  it('P13: a throw while building state ⇒ events + game returned, state undefined', async () => {
    const payload = clone(load('mlb-feed-live-state.json'));
    // Force resolution to throw mid-build (hostile getter, not a shape we sanitize).
    Object.defineProperty(payload.liveData.boxscore.teams.home, 'battingOrder', {
      get() {
        throw new Error('boom');
      },
    });
    const { ctx, logs } = makeCtx(payload);
    const snap = await mlbProvider.fetchPlays(ctx, mlbGame('823062'));
    expect(snap.state).toBeUndefined();
    expect(snap.game.phase).toBe('in'); // fetchPlays did NOT fail
    expect(Array.isArray(snap.events)).toBe(true);
    expect(logs.some((l) => l.includes('state build failed'))).toBe(true);
  });
});

// --- error semantics -------------------------------------------------------

describe('mlb error propagation', () => {
  it('propagates a ProviderError from fetchJson unchanged (rate-limit)', async () => {
    const err = new ProviderError('rate-limit', 'slow down', 120000);
    await expect(mlbProvider.listGames(throwingCtx(err), MLB)).rejects.toBe(err);
  });

  it('propagates a ProviderError not-found from fetchPlays', async () => {
    const err = new ProviderError('not-found', 'gone');
    await expect(mlbProvider.fetchPlays(throwingCtx(err), mlbGame('1'))).rejects.toBe(err);
  });
});

// --- pitch-by-pitch detailed events (§12.3) --------------------------------

describe('mlb fetchPlays detailed (pitch-by-pitch)', () => {
  const PK = '823062';

  it('summary level reproduces exactly the at-bat result lines — no pitch events (regression guard)', async () => {
    const { ctx } = makeCtx(load('mlb-pitch-events.json'), 0, { detail: 'summary' });
    const snap = await mlbProvider.fetchPlays(ctx, mlbGame(PK));
    expect(snap.events.map((e) => e.id)).toEqual(['mlb:823062:0', 'mlb:823062:1', 'mlb:823062:2']);
    expect(snap.events.map((e) => e.sequence)).toEqual([999, 1999, 2999]);
    // API prose passes through verbatim (§12.1) — byte-identical to today.
    expect(snap.events.map((e) => e.text)).toEqual([
      'Ernie Clement singles on a line drive to left fielder Heliot Ramos.',
      'Nathan Lukes singles on a fly ball to left fielder Heliot Ramos. Ernie Clement to 2nd.',
      'Vladimir Guerrero Jr. grounds out softly, catcher Eric Haase to first baseman Rafael Devers. Ernie Clement to 3rd. Nathan Lukes to 2nd.',
    ]);
    expect(snap.events.some((e) => e.id.includes(':p'))).toBe(false);
    expect(snap.events.every((e) => e.period === 'T1')).toBe(true);
  });

  it('detailed level emits one line per pitch, each before its at-bat result, in pinned order', async () => {
    const { ctx } = makeCtx(load('mlb-pitch-events.json'), 0, { detail: 'detailed' });
    const snap = await mlbProvider.fetchPlays(ctx, mlbGame(PK));
    expect(snap.events.map((e) => [e.id, e.sequence])).toEqual([
      ['mlb:823062:0:p3', 3],
      ['mlb:823062:0:p4', 4],
      ['mlb:823062:0:p6', 6],
      ['mlb:823062:0', 999],
      ['mlb:823062:1:p0', 1000],
      ['mlb:823062:1:p1', 1001],
      ['mlb:823062:1:p2', 1002],
      ['mlb:823062:1', 1999],
      ['mlb:823062:2:p0', 2000],
      ['mlb:823062:2:p1', 2001],
      ['mlb:823062:2:p3', 2003],
      ['mlb:823062:2:p4', 2004],
      ['mlb:823062:2:p5', 2005],
      ['mlb:823062:2', 2999],
    ]);
    const pitches = snap.events.filter((e) => e.id.includes(':p'));
    expect(pitches.every((e) => e.kind === 'play')).toBe(true);
    expect(pitches.every((e) => e.scoreAfter === undefined)).toBe(true);
    expect(pitches.every((e) => e.period === 'T1')).toBe(true);
    // Non-pitch (result) lines are identical to the summary level — one scheme, both levels.
    const results = snap.events.filter((e) => !e.id.includes(':p'));
    expect(results.map((e) => [e.id, e.sequence])).toEqual([
      ['mlb:823062:0', 999],
      ['mlb:823062:1', 1999],
      ['mlb:823062:2', 2999],
    ]);
    // Ordering invariant: all pitches of at-bat N precede N's result and N+1's first pitch.
    const seqOf = (id: string) => snap.events.find((e) => e.id === id)!.sequence;
    expect(seqOf('mlb:823062:0:p6')).toBeLessThan(seqOf('mlb:823062:0'));
    expect(seqOf('mlb:823062:0')).toBeLessThan(seqOf('mlb:823062:1:p0'));
    expect(seqOf('mlb:823062:1')).toBeLessThan(seqOf('mlb:823062:2:p0'));
  });

  it('en composes the pitch line from localized structured fields', async () => {
    const { ctx } = makeCtx(load('mlb-pitch-events.json'), 0, { detail: 'detailed', locale: 'en' });
    const snap = await mlbProvider.fetchPlays(ctx, mlbGame(PK));
    const p3 = snap.events.find((e) => e.id === 'mlb:823062:0:p3')!;
    // (0-0): the count BEFORE the pitch (§12.3). The payload's own count says 0-1.
    expect(p3.text).toBe('Sinker 90.8 · zone 6 · Called Strike (0-0)');
  });

  it('ko renders 존/루킹 스트라이크 in the composed pitch line', async () => {
    const { ctx } = makeCtx(load('mlb-pitch-events.json'), 0, { detail: 'detailed', locale: 'ko' });
    const snap = await mlbProvider.fetchPlays(ctx, mlbGame(PK));
    const p3 = snap.events.find((e) => e.id === 'mlb:823062:0:p3')!;
    expect(p3.text).toBe('싱커 90.8 · 존6 · 루킹 스트라이크 (0-0)');
  });

  it('regression guard (defect A): no emitted pitch text renders a raw {placeholder} in either locale', async () => {
    for (const locale of ['en', 'ko'] as const) {
      const { ctx } = makeCtx(load('mlb-pitch-events.json'), 0, { detail: 'detailed', locale });
      const snap = await mlbProvider.fetchPlays(ctx, mlbGame(PK));
      const pitches = snap.events.filter((e) => e.id.includes(':p'));
      expect(pitches.length).toBeGreaterThan(0);
      for (const e of snap.events) expect(e.text).not.toMatch(/\{[a-zA-Z]+\}/);
    }
  });

  it('an unknown pitch type/call passes the API English through — never dropped, no {placeholder}', async () => {
    const mut = clone(load('mlb-pitch-events.json'));
    const pe = mut.liveData.plays.allPlays[0].playEvents[3]; // at-bat 0, pitch p3
    pe.details.type.description = 'Eephus';
    pe.details.description = 'Automatic Ball';
    pe.details.call.description = 'Automatic Ball';
    const snap = await mlbProvider.fetchPlays(makeCtx(mut, 0, { detail: 'detailed', locale: 'ko' }).ctx, mlbGame(PK));
    const p3 = snap.events.find((e) => e.id === 'mlb:823062:0:p3')!;
    expect(p3.text).toBe('Eephus 90.8 · 존6 · Automatic Ball (0-0)');
    expect(p3.text).not.toContain('{');
  });

  it('a pitch with no startSpeed and no zone still renders cleanly — no double separators', async () => {
    const mut = clone(load('mlb-pitch-events.json'));
    mut.liveData.plays.allPlays[0].playEvents[3].pitchData = null; // at-bat 0, pitch p3
    const snap = await mlbProvider.fetchPlays(makeCtx(mut, 0, { detail: 'detailed', locale: 'en' }).ctx, mlbGame(PK));
    const p3 = snap.events.find((e) => e.id === 'mlb:823062:0:p3')!;
    expect(p3.text).toBe('Sinker · Called Strike (0-0)');
    expect(p3.text).not.toMatch(/ {2}/); // no double space
    expect(p3.text).not.toContain('·  ·'); // no dangling separator
  });

  it('a pitch lacking BOTH type and call is skipped and logged; non-pitch entries never emit', async () => {
    const mut = clone(load('mlb-pitch-events.json'));
    const pe = mut.liveData.plays.allPlays[0].playEvents[3]; // at-bat 0, pitch p3
    pe.details.type = null;
    pe.details.call = null;
    pe.details.description = null;
    const { ctx, logs } = makeCtx(mut, 0, { detail: 'detailed' });
    const snap = await mlbProvider.fetchPlays(ctx, mlbGame(PK));
    expect(snap.events.some((e) => e.id === 'mlb:823062:0:p3')).toBe(false);
    expect(snap.events.some((e) => e.id === 'mlb:823062:0:p4')).toBe(true);
    expect(snap.events.some((e) => e.id === 'mlb:823062:0:p6')).toBe(true);
    // p3 was still THROWN, so it still advances the count: p4 renders p3's post-count.
    expect(snap.events.find((e) => e.id === 'mlb:823062:0:p4')!.text).toBe('Sweeper 84.0 · zone 14 · Swinging Strike (0-1)');
    // isPitch === false entries (Status Change, Batter Timeout) are never emitted.
    expect(snap.events.some((e) => e.id === 'mlb:823062:0:p0')).toBe(false);
    expect(snap.events.some((e) => e.id === 'mlb:823062:0:p2')).toBe(false);
    expect(logs.some((l) => l.includes('neither type nor call'))).toBe(true);
  });

  it('P14: the same at-bat polled as its count advances ⇒ each pitch emits once, zero corrections', async () => {
    const base = load('mlb-pitch-events.json');
    // Poll 1: at-bat 0 in progress, first two pitches thrown (playEvents 0..4 ⇒ pitches p3, p4).
    const poll1 = clone(base);
    poll1.liveData.plays.allPlays = [clone(base.liveData.plays.allPlays[0])];
    poll1.liveData.plays.allPlays[0].about.isComplete = false;
    poll1.liveData.plays.allPlays[0].playEvents = base.liveData.plays.allPlays[0].playEvents.slice(0, 5);
    // Poll 2: same at-bat, a third pitch thrown (playEvents 0..6 ⇒ pitches p3, p4, p6).
    const poll2 = clone(base);
    poll2.liveData.plays.allPlays = [clone(base.liveData.plays.allPlays[0])];
    poll2.liveData.plays.allPlays[0].about.isComplete = false;
    poll2.liveData.plays.allPlays[0].playEvents = base.liveData.plays.allPlays[0].playEvents.slice(0, 7);

    const engine = createRelayEngine({ backfillLimit: 100, locale: 'en' });
    const snap1 = await mlbProvider.fetchPlays(makeCtx(poll1, 0, { detail: 'detailed' }).ctx, mlbGame(PK));
    const snap2 = await mlbProvider.fetchPlays(makeCtx(poll2, 0, { detail: 'detailed' }).ctx, mlbGame(PK));

    // The provider produced the advancing pitch sets (poll 1: 2 pitches, poll 2: 3).
    expect(snap1.events.map((e) => e.id)).toEqual(['mlb:823062:0:p3', 'mlb:823062:0:p4']);
    expect(snap2.events.map((e) => e.id)).toEqual(['mlb:823062:0:p3', 'mlb:823062:0:p4', 'mlb:823062:0:p6']);
    // Immutable-text invariant (§12.2): p3 re-derives byte-for-byte across polls.
    expect(snap1.events.find((e) => e.id === 'mlb:823062:0:p3')!.text).toBe(
      snap2.events.find((e) => e.id === 'mlb:823062:0:p3')!.text,
    );

    const emitted = [...engine.ingest(snap1).events, ...engine.ingest(snap2).events];
    expect(emitted.filter((e) => e.kind === 'correction')).toHaveLength(0);
    const pitchIds = emitted.filter((e) => e.id.includes(':p')).map((e) => e.id);
    expect(pitchIds.slice().sort()).toEqual(['mlb:823062:0:p3', 'mlb:823062:0:p4', 'mlb:823062:0:p6']);
  });
});

// --- pre-pitch count (§12.3) -----------------------------------------------

// A playEvent's `count` is the count AFTER the pitch, so on an at-bat's final pitch it
// overflows to a count baseball does not have. Driving the extension against live gamePk
// 824251 showed 13 of 155 pitches (8.4 %) rendering an impossible count — 11 swinging
// strikeouts printed as (x-3) and 2 ball fours as (4-x). §12.3 pins the broadcast
// convention: render the count BEFORE the pitch, carried forward from the previous pitch
// of the same at-bat (0-0 for the first). Clamping the overflow is explicitly forbidden —
// it renders the strikeout as (0-2) and the walk as (3-2), wrong just as silently.

/** A pitch entry shaped like the real payload; `count` is the POST-pitch count (any shape, for probes). */
function pitchEvent(index: number, call: string, count: unknown): any {
  return {
    index,
    isPitch: true,
    details: {
      type: { code: 'FF', description: 'Four-Seam Fastball' },
      call: { code: 'X', description: call },
      description: call,
    },
    pitchData: { startSpeed: 95, zone: 5 },
    count,
  };
}

/** A non-pitch entry (pickoff, timeout, status change) — never emitted, never advances the count. */
function nonPitchEvent(index: number, description: string, count: unknown): any {
  return { index, isPitch: false, details: { type: null, call: null, description }, pitchData: null, count };
}

/** The pitch-events fixture reduced to a single at-bat 0 carrying the given playEvents. */
function singleAtBat(playEvents: any[], description = 'Bo Bichette strikes out swinging.', isComplete = true): any {
  const payload = clone(load('mlb-pitch-events.json'));
  const play = clone(payload.liveData.plays.allPlays[0]);
  play.playEvents = playEvents;
  play.result.description = description;
  play.about.isComplete = isComplete;
  payload.liveData.plays.allPlays = [play];
  return payload;
}

/** The `(b-s)` rendered by each pitch line, in sequence order. */
async function renderedCounts(payload: unknown): Promise<string[]> {
  const { ctx } = makeCtx(payload, 0, { detail: 'detailed', locale: 'en' });
  const snap = await mlbProvider.fetchPlays(ctx, mlbGame('824251'));
  return snap.events.filter((e) => e.id.includes(':p')).map((e) => e.text.slice(e.text.lastIndexOf('(')));
}

/** Every impossible count, in one place: a 4th ball or a 3rd strike can never be a PRE-pitch count. */
function expectNoImpossibleCount(texts: string[]): void {
  for (const text of texts) {
    expect(text).not.toMatch(/\(\d+-3\)/); // no 3-strike count exists
    expect(text).not.toMatch(/\(4-\d+\)/); // no 4-ball count exists
  }
}

describe('mlb pitch lines render the PRE-pitch count (§12.3)', () => {
  it("the first pitch of every at-bat renders (0-0), whatever the payload's own count says", async () => {
    const { ctx } = makeCtx(load('mlb-pitch-events.json'), 0, { detail: 'detailed', locale: 'en' });
    const snap = await mlbProvider.fetchPlays(ctx, mlbGame('823062'));
    // First pitch of at-bats 0, 1 and 2 — payload counts there are 0-1, 0-1 and 0-1.
    for (const id of ['mlb:823062:0:p3', 'mlb:823062:1:p0', 'mlb:823062:2:p0']) {
      expect(snap.events.find((e) => e.id === id)!.text).toContain('(0-0)');
    }
    // The whole fixture, both locales, carries no impossible count.
    for (const locale of ['en', 'ko'] as const) {
      const s = await mlbProvider.fetchPlays(makeCtx(load('mlb-pitch-events.json'), 0, { detail: 'detailed', locale }).ctx, mlbGame('823062'));
      expectNoImpossibleCount(s.events.map((e) => e.text));
    }
  });

  it("a strikeout's final pitch renders the count it was thrown on, not the overflowed (0-3)", async () => {
    const payload = singleAtBat([
      pitchEvent(0, 'Called Strike', { balls: 0, strikes: 1, outs: 0 }),
      pitchEvent(1, 'Swinging Strike', { balls: 0, strikes: 2, outs: 0 }),
      pitchEvent(2, 'Swinging Strike', { balls: 0, strikes: 3, outs: 1 }), // post-count overflows
    ]);
    const { ctx } = makeCtx(payload, 0, { detail: 'detailed', locale: 'en' });
    const snap = await mlbProvider.fetchPlays(ctx, mlbGame('824251'));
    const pitches = snap.events.filter((e) => e.id.includes(':p'));
    expect(pitches.map((e) => e.text)).toEqual([
      'Four-Seam Fastball 95.0 · zone 5 · Called Strike (0-0)',
      'Four-Seam Fastball 95.0 · zone 5 · Swinging Strike (0-1)',
      'Four-Seam Fastball 95.0 · zone 5 · Swinging Strike (0-2)', // NOT (0-3), and NOT clamped from it
    ]);
    expectNoImpossibleCount(snap.events.map((e) => e.text));
  });

  it('a walk\'s final pitch renders (3-0), not the overflowed (4-0)', async () => {
    const payload = singleAtBat(
      [1, 2, 3, 4].map((n) => pitchEvent(n - 1, 'Ball', { balls: n, strikes: 0, outs: 0 })),
      'Bo Bichette walks.',
    );
    expect(await renderedCounts(payload)).toEqual(['(0-0)', '(1-0)', '(2-0)', '(3-0)']);
    const { ctx } = makeCtx(payload, 0, { detail: 'detailed', locale: 'en' });
    expectNoImpossibleCount((await mlbProvider.fetchPlays(ctx, mlbGame('824251'))).events.map((e) => e.text));
  });

  it('a non-pitch entry between two pitches (pickoff) neither emits nor advances the count', async () => {
    const payload = singleAtBat(
      [
        pitchEvent(0, 'Ball', { balls: 1, strikes: 0, outs: 0 }),
        // A poisoned count on the pickoff: if a non-pitch entry advanced, p2 would render (3-3).
        nonPitchEvent(1, 'Pickoff Attempt 1B', { balls: 3, strikes: 3, outs: 0 }),
        pitchEvent(2, 'Called Strike', { balls: 1, strikes: 1, outs: 0 }),
      ],
      'Bo Bichette flies out to center fielder Jung Hoo Lee.',
    );
    const { ctx } = makeCtx(payload, 0, { detail: 'detailed', locale: 'en' });
    const snap = await mlbProvider.fetchPlays(ctx, mlbGame('824251'));
    expect(snap.events.some((e) => e.id === 'mlb:824251:0:p1')).toBe(false); // pickoff never emits
    expect(snap.events.find((e) => e.id === 'mlb:824251:0:p0')!.text).toContain('(0-0)');
    expect(snap.events.find((e) => e.id === 'mlb:824251:0:p2')!.text).toContain('(1-0)'); // p0's post-count
  });

  it('an unreadable count renders at the running value and never poisons the rest of the at-bat', async () => {
    const bad: unknown[] = [undefined, null, {}, { balls: '1', strikes: 1 }, { balls: 1 }, { balls: -1, strikes: 0 }, { balls: 0, strikes: 9 }];
    for (const count of bad) {
      const payload = singleAtBat([
        pitchEvent(0, 'Called Strike', { balls: 0, strikes: 1, outs: 0 }),
        pitchEvent(1, 'Ball', count), // count unreadable ⇒ running value stays 0-1
        pitchEvent(2, 'Foul', { balls: 1, strikes: 2, outs: 0 }),
        pitchEvent(3, 'Swinging Strike', { balls: 1, strikes: 3, outs: 1 }),
      ]);
      // p1 renders the running 0-1 (stale, not garbage); p2 renders it too (p1 did not advance);
      // p3 recovers from p2's OWN count. No negative, no NaN, no impossible count anywhere.
      expect(await renderedCounts(payload)).toEqual(['(0-0)', '(0-1)', '(0-1)', '(1-2)']);
    }
  });

  it('P14: the pre-pitch count is stable across polls of a live at-bat ⇒ zero corrections', async () => {
    const events = [
      pitchEvent(0, 'Called Strike', { balls: 0, strikes: 1, outs: 0 }),
      pitchEvent(1, 'Swinging Strike', { balls: 0, strikes: 2, outs: 0 }),
      pitchEvent(2, 'Swinging Strike', { balls: 0, strikes: 3, outs: 1 }),
    ];
    // Poll 1: two pitches thrown, at-bat live. Poll 2: the strikeout lands, at-bat complete.
    const poll1 = singleAtBat(events.slice(0, 2), 'Bo Bichette strikes out swinging.', false);
    const poll2 = singleAtBat(events, 'Bo Bichette strikes out swinging.', true);

    const engine = createRelayEngine({ backfillLimit: 100, locale: 'en' });
    const snap1 = await mlbProvider.fetchPlays(makeCtx(poll1, 0, { detail: 'detailed' }).ctx, mlbGame('824251'));
    const snap2 = await mlbProvider.fetchPlays(makeCtx(poll2, 0, { detail: 'detailed' }).ctx, mlbGame('824251'));

    // A pitch's pre-count is fixed the moment it is thrown: p0/p1 re-derive byte-for-byte
    // even though the at-bat's count advanced between the polls (§12.2 immutable text).
    for (const id of ['mlb:824251:0:p0', 'mlb:824251:0:p1']) {
      expect(snap1.events.find((e) => e.id === id)!.text).toBe(snap2.events.find((e) => e.id === id)!.text);
    }
    const emitted = [...engine.ingest(snap1).events, ...engine.ingest(snap2).events];
    expect(emitted.filter((e) => e.kind === 'correction')).toHaveLength(0);
    expect(emitted.filter((e) => e.id.includes(':p'))).toHaveLength(3); // each pitch emitted exactly once
    expectNoImpossibleCount(emitted.map((e) => e.text));
  });
});

// --- logos (§13) -----------------------------------------------------------

describe('mlb logos (§13)', () => {
  it('derives team logos from teamId — schedule (138 home / 158 away)', async () => {
    const games = await mlbProvider.listGames(makeCtx(load('mlb-schedule.json')).ctx, MLB);
    expect(games[0].home.logo).toEqual({ light: 'https://www.mlbstatic.com/team-logos/138.svg' });
    expect(games[0].away.logo).toEqual({ light: 'https://www.mlbstatic.com/team-logos/158.svg' });
  });

  it('derives team logos from teamId — feed/live fresh game', async () => {
    const snap = await mlbProvider.fetchPlays(makeCtx(load('mlb-feed-live.json')).ctx, mlbGame('823062'));
    expect(snap.game.home.logo).toEqual({ light: 'https://www.mlbstatic.com/team-logos/138.svg' });
    expect(snap.game.away.logo).toEqual({ light: 'https://www.mlbstatic.com/team-logos/158.svg' });
  });

  it('missing teamId ⇒ no logo (the other side still resolves)', async () => {
    const mut = clone(load('mlb-schedule.json'));
    delete mut.dates[0].games[0].teams.home.team.id;
    const games = await mlbProvider.listGames(makeCtx(mut).ctx, MLB);
    expect(games[0].home.logo).toBeUndefined();
    expect(games[0].away.logo).toEqual({ light: 'https://www.mlbstatic.com/team-logos/158.svg' });
  });

  it('garbage/non-numeric teamId ⇒ no logo, no throw', async () => {
    for (const bad of ['abc', '1e9', '13.5', '', 0, -5]) {
      const mut = clone(load('mlb-schedule.json'));
      mut.dates[0].games[0].teams.home.team.id = bad;
      const games = await mlbProvider.listGames(makeCtx(mut).ctx, MLB);
      expect(games[0].home.logo).toBeUndefined();
    }
  });
});
