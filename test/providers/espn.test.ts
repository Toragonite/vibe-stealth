import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DetailLevel, Game, League, PlaySnapshot, ProviderContext, ProviderError, RelayLocale } from '../../src/core/contract';
import { createRelayEngine } from '../../src/core/relay';
import { espnProvider } from '../../src/providers/espn';

// --- fixtures & mocks ------------------------------------------------------

function load(name: string): any {
  return JSON.parse(readFileSync(join(process.cwd(), 'test', 'fixtures', name), 'utf8'));
}
function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

function makeCtx(
  payload: unknown,
  opts?: { detail?: DetailLevel; locale?: RelayLocale },
): { ctx: ProviderContext; logs: string[]; urls: string[] } {
  const logs: string[] = [];
  const urls: string[] = [];
  const ctx: ProviderContext = {
    locale: opts?.locale ?? 'en',
    gameStateEnabled: true,
    detail: opts?.detail ?? 'summary',
    fetchJson: async (url: string) => {
      urls.push(url);
      return payload;
    },
    getSecret: async () => undefined,
    log: (m: string) => logs.push(m),
    now: () => 0,
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

const SOCCER: League = { id: 'fifa.world', providerId: 'espn', name: 'FIFA World Cup', sport: 'soccer' };
const NBA: League = { id: 'nba', providerId: 'espn', name: 'NBA', sport: 'basketball' };

function soccerGame(eventId: string): Game {
  return {
    id: `espn:fifa.world:${eventId}`,
    providerId: 'espn',
    leagueId: 'fifa.world',
    leagueName: 'FIFA World Cup',
    sport: 'soccer',
    startTimeUtc: undefined,
    phase: 'in',
    statusText: 'x',
    statusShort: 'x',
    format: 'versus',
    home: { id: '448', name: 'England', abbrev: 'ENG', score: undefined },
    away: { id: '2850', name: 'Congo DR', abbrev: 'COD', score: undefined },
    entrants: undefined,
  };
}
function nbaGame(eventId: string): Game {
  return {
    id: `espn:nba:${eventId}`,
    providerId: 'espn',
    leagueId: 'nba',
    leagueName: 'NBA',
    sport: 'basketball',
    startTimeUtc: undefined,
    phase: 'in',
    statusText: 'x',
    statusShort: 'x',
    format: 'versus',
    home: { id: '1', name: 'Home', abbrev: 'HOM', score: undefined },
    away: { id: '2', name: 'Away', abbrev: 'AWY', score: undefined },
    entrants: undefined,
  };
}

function uniqueIds(snap: PlaySnapshot): Set<string> {
  return new Set(snap.events.map((e) => e.id));
}

// --- listLeagues -----------------------------------------------------------

describe('espn listLeagues', () => {
  it('registers the pinned league set with correct sports and no MLB', async () => {
    const leagues = await espnProvider.listLeagues(makeCtx({}).ctx);
    const ids = leagues.map((l) => l.id);
    expect(ids).toEqual([
      'nfl',
      'nba',
      'wnba',
      'fifa.world',
      'eng.1',
      'esp.1',
      'ita.1',
      'ger.1',
      'fra.1',
      'usa.1',
      'uefa.champions',
      'ufc',
      'cricket',
      'college-football',
      'mens-college-basketball',
    ]);
    expect(ids).not.toContain('mlb');
    expect(leagues.find((l) => l.id === 'nfl')?.sport).toBe('football');
    expect(leagues.find((l) => l.id === 'nba')?.sport).toBe('basketball');
    expect(leagues.find((l) => l.id === 'eng.1')?.sport).toBe('soccer');
    expect(leagues.find((l) => l.id === 'ufc')?.sport).toBe('mma');
    expect(leagues.find((l) => l.id === 'cricket')?.sport).toBe('cricket');
    expect(leagues.find((l) => l.id === 'college-football')?.sport).toBe('football');
    expect(leagues.find((l) => l.id === 'mens-college-basketball')?.sport).toBe('basketball');
    // rugby/scrum returns non-JSON and golf/pga is a 156-competitor field: neither fits.
    expect(ids).not.toContain('rugby');
    expect(ids).not.toContain('pga');
  });
});

// --- scoreboard ------------------------------------------------------------

describe('espn listGames (scoreboard)', () => {
  it('parses finished soccer games: string scores coerced, statusShort FT', async () => {
    const { ctx } = makeCtx(load('espn-scoreboard-soccer-post.json'));
    const games = await espnProvider.listGames(ctx, SOCCER);
    expect(games).toHaveLength(2);
    const g0 = games[0];
    expect(g0.id).toBe('espn:fifa.world:760495');
    expect(g0.phase).toBe('post');
    expect(g0.statusShort).toBe('FT');
    expect(g0.statusText).toBe('FT');
    expect(g0.home.abbrev).toBe('ENG');
    expect(g0.home.score).toBe(2);
    expect(g0.away.abbrev).toBe('COD');
    expect(g0.away.score).toBe(1);
    expect(g0.startTimeUtc).toBe('2026-07-01T16:00:00Z');
    // AET carries through as statusText while statusShort stays FT for soccer.
    expect(games[1].statusText).toBe('AET');
    expect(games[1].statusShort).toBe('FT');
  });

  it('parses pre-game soccer with Unicode team name intact (P8) and HH:MM statusShort', async () => {
    const { ctx } = makeCtx(load('espn-scoreboard-soccer-pre.json'));
    const games = await espnProvider.listGames(ctx, SOCCER);
    expect(games).toHaveLength(2);
    const g = games[0];
    expect(g.phase).toBe('pre');
    expect(g.home.name).toBe('CF Montréal'); // accented Unicode preserved as-is
    expect(g.statusText).toBe('Scheduled');
    expect(g.statusShort).toMatch(/^(\d{2}:\d{2}|TBD)$/);
    expect(g.startTimeUtc).toBe('2026-07-16T23:30:00Z');
    // second event: Vancouver @ Chicago Fire FC.
    expect(games[1].home.name).toBe('Chicago Fire FC');
  });

  it('P3: absurd/invalid string scores coerce to undefined, never NaN', async () => {
    const base = load('espn-scoreboard-soccer-post.json');
    const bad = ['N/A', '-1', '3.5', '1e9'];
    for (const v of bad) {
      const mut = clone(base);
      mut.events[0].competitions[0].competitors[0].score = v;
      mut.events[0].competitions[0].competitors[1].score = v;
      const { ctx } = makeCtx(mut);
      const games = await espnProvider.listGames(ctx, SOCCER);
      expect(games[0].home.score).toBeUndefined();
      expect(games[0].away.score).toBeUndefined();
      expect(Number.isNaN(games[0].home.score as any)).toBe(false);
    }
  });

  it('P5: dates without seconds parse; TBD/empty ⇒ undefined + phase unaffected, no crash', async () => {
    const base = load('espn-scoreboard-soccer-post.json');

    const noSeconds = clone(base);
    noSeconds.events[0].date = '2026-07-07T18:15Z';
    let games = await espnProvider.listGames(makeCtx(noSeconds).ctx, SOCCER);
    expect(games[0].startTimeUtc).toBe('2026-07-07T18:15:00Z');

    for (const bad of ['TBD', '']) {
      const mut = clone(base);
      mut.events[0].date = bad;
      mut.events[0].status.type.state = 'garbage';
      games = await espnProvider.listGames(makeCtx(mut).ctx, SOCCER);
      expect(games[0].startTimeUtc).toBeUndefined();
      expect(games[0].phase).toBe('unknown');
    }
  });

  it('in-progress soccer statusShort comes from displayClock', async () => {
    const mut = clone(load('espn-scoreboard-soccer-post.json'));
    mut.events[0].status.type.state = 'in';
    mut.events[0].status.displayClock = "67'";
    const games = await espnProvider.listGames(makeCtx(mut).ctx, SOCCER);
    expect(games[0].phase).toBe('in');
    expect(games[0].statusShort).toBe("67'");
  });

  it('skips a malformed event (logs) without failing the whole response', async () => {
    const mut = clone(load('espn-scoreboard-soccer-post.json'));
    mut.events.unshift(42); // not an object
    const { ctx, logs } = makeCtx(mut);
    const games = await espnProvider.listGames(ctx, SOCCER);
    expect(games).toHaveLength(2);
    expect(logs.some((l) => l.includes('skipped'))).toBe(true);
  });
});

// --- summary: football/basketball plays[] ----------------------------------

describe('espn fetchPlays (football/basketball plays)', () => {
  it('drops null/empty-text plays, keeps native ids, sequence = array index, sorted', async () => {
    const { ctx } = makeCtx(load('espn-summary-plays.json'));
    const snap = await espnProvider.fetchPlays(ctx, nbaGame('401'));
    // 10 entries, 3 without text ⇒ 7 emitted.
    expect(snap.events).toHaveLength(7);
    expect(snap.events.every((e) => e.text.length > 0)).toBe(true);
    // sequence equals the original array index of each kept play (2,3,4,5,6,7,9).
    expect(snap.events.map((e) => e.sequence)).toEqual([2, 3, 4, 5, 6, 7, 9]);
    // native ids preserved.
    expect(snap.events[0].id).toBe('4018717901704010001');
    // period label Q{n}; scoreAfter present on every play.
    expect(snap.events[0].period).toBe('Q9');
    expect(snap.events[0].scoreAfter).toEqual({ home: 3, away: 4 });
    expect(snap.events.every((e) => e.kind === 'play')).toBe(true);
  });

  it('P2: null text + duplicate ids ⇒ no null-text line, one line per unique id', async () => {
    const payload = {
      plays: [
        { id: 'dupe', text: 'First copy', awayScore: 1, homeScore: 0, period: { number: 1 }, scoringPlay: false },
        { id: 'nulltext', text: null, awayScore: 1, homeScore: 0, period: { number: 1 } },
        { id: 'empty', text: '   ', awayScore: 1, homeScore: 0, period: { number: 1 } },
        { id: 'dupe', text: 'Second copy', awayScore: 2, homeScore: 0, period: { number: 1 }, scoringPlay: true },
        { id: 'solo', text: 'Only one', awayScore: 2, homeScore: 1, period: { number: 2 }, scoringPlay: false },
      ],
    };
    const snap = await espnProvider.fetchPlays(makeCtx(payload).ctx, nbaGame('999'));
    // null and whitespace-only text produce no events.
    expect(snap.events.some((e) => e.id === 'nulltext' || e.id === 'empty')).toBe(false);
    // one line per unique id (engine dedups duplicates; provider drops null text).
    expect(uniqueIds(snap)).toEqual(new Set(['dupe', 'solo']));
    // a scoringPlay entry becomes kind 'score'.
    expect(snap.events.some((e) => e.kind === 'score')).toBe(true);
  });
});

// --- summary: soccer commentary[] ------------------------------------------

describe('espn fetchPlays (soccer commentary)', () => {
  it('uses native sequence, derives ids (no native id leak), sorted oldest-first', async () => {
    const snap = await espnProvider.fetchPlays(makeCtx(load('espn-summary-soccer-post.json')).ctx, soccerGame('760495'));
    expect(snap.events).toHaveLength(10);
    expect(snap.events[0].sequence).toBe(0);
    expect(snap.events[snap.events.length - 1].sequence).toBe(103);
    // ids are 32-bit FNV hex — the nested play.id is never used.
    expect(snap.events.every((e) => /^[0-9a-f]{8}$/.test(e.id))).toBe(true);
    expect(snap.events.some((e) => e.id === '49671050')).toBe(false);
    // empty displayValue clock becomes undefined; period undefined for soccer.
    expect(snap.events[0].clock).toBeUndefined();
    expect(snap.events[0].period).toBeUndefined();
    expect(snap.events.every((e) => e.kind === 'play')).toBe(true);
    // sorted ascending by sequence.
    const seqs = snap.events.map((e) => e.sequence);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });

  it('derived ids are stable under front-insertion (index never enters the id)', async () => {
    const base = load('espn-summary-soccer-post.json');
    const before = await espnProvider.fetchPlays(makeCtx(base).ctx, soccerGame('760495'));
    const beforeIds = new Set(before.events.map((e) => e.id));

    const grown = clone(base);
    grown.commentary.unshift({ sequence: -5, time: { displayValue: '' }, text: 'A brand new distinct opening line' });
    const after = await espnProvider.fetchPlays(makeCtx(grown).ctx, soccerGame('760495'));
    const afterIds = new Set(after.events.map((e) => e.id));

    // every original id survives unchanged.
    for (const id of beforeIds) expect(afterIds.has(id)).toBe(true);
    expect(after.events.length).toBe(before.events.length + 1);
  });

  it('repeated identical lines stay distinct via occurrence ordinal', async () => {
    const payload = {
      commentary: [
        { sequence: 0, time: { displayValue: "1'" }, text: 'Corner kick' },
        { sequence: 1, time: { displayValue: "2'" }, text: 'Corner kick' },
      ],
    };
    const snap = await espnProvider.fetchPlays(makeCtx(payload).ctx, soccerGame('111'));
    expect(snap.events).toHaveLength(2);
    expect(snap.events[0].id).not.toBe(snap.events[1].id);
  });

  it('chronological guard reverses a newest-first array before assigning order', async () => {
    const payload = {
      commentary: [
        { sequence: 5, time: { displayValue: "5'" }, text: 'Later event' },
        { sequence: 1, time: { displayValue: "1'" }, text: 'Earlier event' },
      ],
    };
    const snap = await espnProvider.fetchPlays(makeCtx(payload).ctx, soccerGame('222'));
    expect(snap.events.map((e) => e.text)).toEqual(['Earlier event', 'Later event']);
    expect(snap.events.map((e) => e.sequence)).toEqual([1, 5]);
  });
});

// --- summary: soccer keyEvents fallback & empty ----------------------------

describe('espn fetchPlays (soccer keyEvents fallback / empty)', () => {
  it('falls back to keyEvents when commentary absent; drops empty text; native ids', async () => {
    const full = load('espn-summary-soccer-post.json');
    const payload = { keyEvents: full.keyEvents }; // no commentary
    const snap = await espnProvider.fetchPlays(makeCtx(payload).ctx, soccerGame('760495'));
    // 4 keyEvents, 2 with empty/absent text ⇒ 2 emitted, both with native ids.
    expect(snap.events).toHaveLength(2);
    expect(snap.events.map((e) => e.id).sort()).toEqual(['49671136', '49671145']);
  });

  it('both commentary and keyEvents absent (pre-game) ⇒ events: []', async () => {
    const snap = await espnProvider.fetchPlays(makeCtx(load('espn-summary-soccer-pre.json')).ctx, soccerGame('761659'));
    expect(snap.events).toEqual([]);
  });
});

// --- §12.5: soccer detailed keyEvents --------------------------------------

describe('espn soccer detail level (§12.5)', () => {
  const COMMENTARY_MAX_SEQ = 103; // highest commentary sequence in the fixture

  it('summary REGRESSION: commentary prose only, no keyEvent lines', async () => {
    const snap = await espnProvider.fetchPlays(makeCtx(load('espn-summary-soccer-post.json')).ctx, soccerGame('760495'));
    expect(snap.events).toHaveLength(10); // 10 commentary entries, unchanged
    expect(snap.events.every((e) => e.sequence <= COMMENTARY_MAX_SEQ)).toBe(true);
    // native keyEvent ids never leak into the summary list.
    expect(snap.events.some((e) => e.id === '49671136')).toBe(false);
    // commentary text is passed through verbatim.
    expect(snap.events[1].text).toBe('First Half begins.');
  });

  it('detailed APPENDS composed keyEvent lines (native ids, kind, sequence)', async () => {
    const snap = await espnProvider.fetchPlays(
      makeCtx(load('espn-summary-soccer-post.json'), { detail: 'detailed' }).ctx,
      soccerGame('760495'),
    );
    // 10 commentary + 2 emittable keyEvents (Kickoff + one Start Delay are skipped).
    expect(snap.events).toHaveLength(12);
    const goal = snap.events.find((e) => e.id === '49671136')!;
    expect(goal.text).toBe('Goal — Brian Cipenga (Congo DR)'); // composed, not the API prose
    expect(goal.kind).toBe('score'); // scoringPlay === true
    expect(goal.sequence).toBe(100700); // 100000 + 7*100 + 0
    // the two emitted keyEvents are exactly the ones with text and/or participants.
    const keyIds = snap.events.filter((e) => e.sequence >= 100000).map((e) => e.id).sort();
    expect(keyIds).toEqual(['49671136', '49671145']);
    // unknown event type passes through untranslated (start-delay ⇒ API text 'Start Delay').
    expect(snap.events.find((e) => e.id === '49671145')!.text.startsWith('Start Delay')).toBe(true);
  });

  it('every keyEvent sequence exceeds every commentary sequence (no collision)', async () => {
    const snap = await espnProvider.fetchPlays(
      makeCtx(load('espn-summary-soccer-post.json'), { detail: 'detailed' }).ctx,
      soccerGame('760495'),
    );
    const commentarySeqs = snap.events.filter((e) => e.sequence < 100000).map((e) => e.sequence);
    const keyEventSeqs = snap.events.filter((e) => e.sequence >= 100000).map((e) => e.sequence);
    expect(keyEventSeqs.length).toBeGreaterThan(0);
    expect(Math.min(...keyEventSeqs)).toBeGreaterThan(Math.max(...commentarySeqs));
  });

  it('ko: commentary prose is UNTRANSLATED, composed keyEvent line IS localized', async () => {
    const snap = await espnProvider.fetchPlays(
      makeCtx(load('espn-summary-soccer-post.json'), { detail: 'detailed', locale: 'ko' }).ctx,
      soccerGame('760495'),
    );
    // API prose passes through verbatim in ko (§12.1) — never machine-translated.
    expect(snap.events[1].text).toBe('First Half begins.');
    expect(snap.events.find((e) => e.id === '49671136')!.text).toBe('골 — Brian Cipenga (Congo DR)');
  });

  it('stoppage-time minute folds to the leading number ("90\'+7\'" ⇒ 90), n disambiguates', async () => {
    const payload = {
      keyEvents: [
        { id: 'k1', type: { type: 'goal', text: 'Goal' }, clock: { displayValue: "90'+3'" }, scoringPlay: true, team: { displayName: 'A' }, participants: [{ athlete: { displayName: 'P1' } }] },
        { id: 'k2', type: { type: 'goal', text: 'Goal' }, clock: { displayValue: "90'+7'" }, scoringPlay: true, team: { displayName: 'A' }, participants: [{ athlete: { displayName: 'P2' } }] },
      ],
    };
    const snap = await espnProvider.fetchPlays(makeCtx(payload, { detail: 'detailed' }).ctx, soccerGame('900'));
    // both parse to minute 90; n keeps them distinct and ordered.
    expect(snap.events.map((e) => e.sequence)).toEqual([109000, 109001]);
  });

  it('detailed with NO commentary uses composed lines instead of raw keyEvent text', async () => {
    const full = load('espn-summary-soccer-post.json');
    const payload = { keyEvents: full.keyEvents }; // no commentary
    const snap = await espnProvider.fetchPlays(makeCtx(payload, { detail: 'detailed' }).ctx, soccerGame('760495'));
    // same 2 emittable keyEvents, but now composed (sequences in the 100000+ band).
    expect(snap.events).toHaveLength(2);
    expect(snap.events.every((e) => e.sequence >= 100000)).toBe(true);
    expect(snap.events.find((e) => e.id === '49671136')!.text).toBe('Goal — Brian Cipenga (Congo DR)');
  });

  it('a keyEvent with empty text AND no participants is skipped', async () => {
    const payload = {
      keyEvents: [
        { id: 'skip', type: { type: 'kickoff', text: 'Kickoff' }, clock: { displayValue: '' } }, // no text, no participants
        { id: 'keep', type: { type: 'goal', text: 'Goal' }, clock: { displayValue: "5'" }, scoringPlay: true, team: { displayName: 'A' }, participants: [{ athlete: { displayName: 'Scorer' } }] },
      ],
    };
    const snap = await espnProvider.fetchPlays(makeCtx(payload, { detail: 'detailed' }).ctx, soccerGame('901'));
    expect(snap.events.map((e) => e.id)).toEqual(['keep']);
  });
});

// --- P9: fresh game from the summary header --------------------------------

describe('espn fetchPlays fresh game (P9 / §2 pin)', () => {
  it('rebuilds phase/scores/status from the summary header and keeps parsed plays', async () => {
    // Terminal header (state 'post', string scores) combined with real plays so
    // the status refresh is proven NOT to drop play lines. Input game is stale 'in'.
    const header = load('espn-summary-header-post.json').header;
    const payload = {
      header,
      plays: [
        { id: 'p1', text: 'Layup', awayScore: 94, homeScore: 88, period: { number: 4 }, scoringPlay: true },
        { id: 'p2', text: 'Final buzzer', awayScore: 94, homeScore: 90, period: { number: 4 }, scoringPlay: false },
      ],
    };
    const input = nbaGame('401859967');
    input.phase = 'in';
    input.home.score = 88;
    input.away.score = 91;
    const snap = await espnProvider.fetchPlays(makeCtx(payload).ctx, input);

    // freshly derived (the OLD `return { game }` would leave phase 'in', scores 88/91).
    expect(snap.game.phase).toBe('post');
    expect(snap.game.home.score).toBe(90); // San Antonio (home) "90"
    expect(snap.game.away.score).toBe(94); // New York (away) "94"
    expect(snap.game.home.abbrev).toBe('SA');
    expect(snap.game.away.abbrev).toBe('NY');
    expect(snap.game.statusShort).toBe('F'); // basketball post
    expect(snap.game.statusText).toBe('Final');
    // events still parsed — a status refresh must never drop play lines.
    expect(snap.events.map((e) => e.id)).toEqual(['p1', 'p2']);
    expect(snap.events.some((e) => e.kind === 'score')).toBe(true);
  });

  it('P9: input game with NO `format` key (pre-§14 shape) still refreshes both sides', async () => {
    const payload = {
      header: load('espn-summary-header-post.json').header,
      plays: [{ id: 'p1', text: 'Final buzzer', awayScore: 94, homeScore: 90, period: { number: 4 }, scoringPlay: false }],
    };
    const input = nbaGame('401859967');
    input.phase = 'in';
    input.home.score = 1; // stale
    input.away.score = 2; // stale
    // A game persisted before §14 carries no `format` key at all — absent, not
    // `undefined`-valued. `format` is required by the type, so the key is
    // dropped structurally here rather than typed away.
    const { format: _dropped, ...legacy } = input;
    expect('format' in legacy).toBe(false);

    const snap = await espnProvider.fetchPlays(makeCtx(payload).ctx, legacy as Game);
    expect(snap.game.phase).toBe('post');
    expect(snap.game.home.score).toBe(90); // refreshed, NOT frozen at the stale 1
    expect(snap.game.away.score).toBe(94); // refreshed, NOT frozen at the stale 2
    expect(snap.events).toHaveLength(1);
  });

  it("format 'field' ⇒ status refreshed but the two-sided merge is skipped", async () => {
    const payload = { header: load('espn-summary-header-post.json').header, plays: [] };
    const input: Game = {
      ...nbaGame('401859967'),
      format: 'field',
      home: undefined,
      away: undefined,
      entrants: [{ id: '1', position: 1, name: 'Max Verstappen', abbrev: 'VER', detail: undefined }],
    };
    const snap = await espnProvider.fetchPlays(makeCtx(payload).ctx, input);
    expect(snap.game.phase).toBe('post'); // status path is not gated
    expect(snap.game.home).toBeUndefined(); // no sides invented
    expect(snap.game.away).toBeUndefined();
    expect(snap.game.entrants).toEqual(input.entrants);
  });

  it('soccer pre-game summary (no usable header) ⇒ input game carried through unchanged', async () => {
    const input = soccerGame('761659');
    const before = clone(input);
    const snap = await espnProvider.fetchPlays(makeCtx(load('espn-summary-soccer-pre.json')).ctx, input);
    expect(snap.game).toEqual(before); // phase/scores/status all untouched
    expect(snap.events).toEqual([]);
  });
});

// --- live current state (§11.4) --------------------------------------------

describe('espn fetchPlays live state (soccer lineups)', () => {
  it('builds soccer state from rosters while live', async () => {
    const snap = await espnProvider.fetchPlays(makeCtx(load('espn-summary-rosters.json')).ctx, soccerGame('760495'));
    expect(snap.game.phase).toBe('in'); // no header ⇒ input game (in) carried
    expect(snap.state).toBeDefined();
    const state = snap.state as any;
    expect(state.kind).toBe('soccer');
    expect(state.home.formation).toBe('4-2-3-1');
    expect(state.away.formation).toBe('4-3-3');
    expect(state.home.starters).toHaveLength(11);
    expect(state.away.starters).toHaveLength(11);
    expect(state.home.starters[0]).toEqual({ order: 1, name: 'Jordan Pickford', position: 'G', jersey: '1' });
    expect(state.home.bench.length).toBeGreaterThan(0);
    expect(state.away.bench.length).toBeGreaterThan(0);
    // bench is 1-based within its own group.
    expect(state.home.bench[0].order).toBe(1);
  });

  it('absent rosters (pre-game) ⇒ state undefined', async () => {
    const snap = await espnProvider.fetchPlays(makeCtx({}).ctx, soccerGame('760495'));
    expect(snap.state).toBeUndefined();
  });

  it('a roster entry missing athlete is skipped, not thrown', async () => {
    const mut = clone(load('espn-summary-rosters.json'));
    delete mut.rosters[0].roster[0].athlete; // drop Pickford's athlete block
    const { ctx, logs } = makeCtx(mut);
    const snap = await espnProvider.fetchPlays(ctx, soccerGame('760495'));
    const state = snap.state as any;
    expect(state.home.starters).toHaveLength(10);
    // order re-based within the surviving group.
    expect(state.home.starters[0]).toEqual({ order: 1, name: 'Marc Guéhi', position: 'CD-L', jersey: '6' });
    expect(logs.some((l) => l.includes('missing athlete'))).toBe(true);
  });

  it('non-soccer ESPN league ⇒ no state', async () => {
    const snap = await espnProvider.fetchPlays(makeCtx(load('espn-summary-plays.json')).ctx, nbaGame('401'));
    expect(snap.state).toBeUndefined();
  });
});

// --- error semantics -------------------------------------------------------

describe('espn error propagation', () => {
  it('propagates a ProviderError from fetchJson unchanged (network)', async () => {
    const err = new ProviderError('network', 'boom');
    await expect(espnProvider.listGames(throwingCtx(err), SOCCER)).rejects.toBe(err);
  });

  it('propagates a ProviderError parse (P1 truncated body surfaces from http layer)', async () => {
    const err = new ProviderError('parse', 'bad json', undefined, '<<head');
    await expect(espnProvider.fetchPlays(throwingCtx(err), soccerGame('1')).catch((e) => e)).resolves.toBe(err);
  });

  it('a shape surprise (events not an array) is non-fatal ⇒ empty list', async () => {
    const snap = await espnProvider.listGames(makeCtx({ events: 'nope' }).ctx, SOCCER);
    expect(snap).toEqual([]);
  });
});

// --- logos (§13) -----------------------------------------------------------

describe('espn logos (§13)', () => {
  it('populates team logos from competitors[].team.logo, RESIZED to the combiner form (§13.2b)', async () => {
    // The scoreboard serves 500 px `/i/teamlogos/...` masters; the provider rewrites them to a
    // 64 px combiner request before building the LogoRef. `img` keeps its leading `/i/`.
    const { ctx } = makeCtx(load('espn-scoreboard-soccer-post.json'));
    const games = await espnProvider.listGames(ctx, SOCCER);
    expect(games[0].home.logo).toEqual({
      light: 'https://a.espncdn.com/combiner/i?img=/i/teamlogos/countries/500/eng.png&w=64&h=64&transparent=true',
    });
    expect(games[0].away.logo).toEqual({
      light: 'https://a.espncdn.com/combiner/i?img=/i/teamlogos/countries/500/rdc.png&w=64&h=64&transparent=true',
    });
  });

  it('an already-combiner URL has w/h forced to 64 while img and transparent survive', async () => {
    // ESPN could hand back a combiner URL with a different size — force w/h, preserve the rest.
    const mut = clone(load('espn-scoreboard-soccer-post.json'));
    mut.events[0].competitions[0].competitors[0].team.logo =
      'https://a.espncdn.com/combiner/i?img=/i/teamlogos/soccer/500/2673.png&w=200&h=200&transparent=true&scale=crop';
    const games = await espnProvider.listGames(makeCtx(mut).ctx, SOCCER);
    const out = new URL(games[0].home.logo!.light);
    expect(out.hostname).toBe('a.espncdn.com');
    expect(out.pathname).toBe('/combiner/i');
    expect(out.searchParams.get('w')).toBe('64');
    expect(out.searchParams.get('h')).toBe('64');
    // every other param survives unchanged.
    expect(out.searchParams.get('img')).toBe('/i/teamlogos/soccer/500/2673.png');
    expect(out.searchParams.get('transparent')).toBe('true');
    expect(out.searchParams.get('scale')).toBe('crop');
  });

  it('a non-espncdn https logo and an unusual espncdn shape pass through UNRESIZED', async () => {
    const mut = clone(load('espn-scoreboard-soccer-post.json'));
    // home: different host — untouched. away: espncdn but not /i/ or /combiner/i — untouched.
    mut.events[0].competitions[0].competitors[0].team.logo = 'https://cdn.example.com/logo.png';
    mut.events[0].competitions[0].competitors[1].team.logo = 'https://a.espncdn.com/weird.png';
    const games = await espnProvider.listGames(makeCtx(mut).ctx, SOCCER);
    expect(games[0].home.logo).toEqual({ light: 'https://cdn.example.com/logo.png' });
    expect(games[0].away.logo).toEqual({ light: 'https://a.espncdn.com/weird.png' });
  });

  it('league logo undefined — scoreboard carries no leagues[].logos[] and listLeagues is static', async () => {
    const leagues = await espnProvider.listLeagues(makeCtx({}).ctx);
    expect(leagues.every((l) => l.logo === undefined)).toBe(true);
  });

  it('garbage team.logo (number, empty, javascript:, ftp:) ⇒ no logo, and never reaches the rewriter', async () => {
    // normLogoUrl rejects these BEFORE the resize step, so `new URL()` never sees a value that
    // would throw — the logo is simply omitted (P3-style defensive coercion).
    for (const bad of [42, '', 'javascript:alert(1)', 'ftp://x/y.png']) {
      const mut = clone(load('espn-scoreboard-soccer-post.json'));
      mut.events[0].competitions[0].competitors[0].team.logo = bad;
      mut.events[0].competitions[0].competitors[1].team.logo = bad;
      const games = await espnProvider.listGames(makeCtx(mut).ctx, SOCCER);
      expect(games[0].home.logo).toBeUndefined();
      expect(games[0].away.logo).toBeUndefined();
    }
  });
});

// --- new two-sided leagues (§14 versus) ------------------------------------

const UFC: League = { id: 'ufc', providerId: 'espn', name: 'UFC', sport: 'mma' };
const CRICKET: League = { id: 'cricket', providerId: 'espn', name: 'Cricket', sport: 'cricket' };
const CFB: League = { id: 'college-football', providerId: 'espn', name: 'College Football', sport: 'football' };
const CBB: League = {
  id: 'mens-college-basketball',
  providerId: 'espn',
  name: "Men's College Basketball",
  sport: 'basketball',
};

/** A minimal 2-competitor team-sport scoreboard, live in the given numeric period. */
function teamScoreboard(eventId: string, period: number): unknown {
  return {
    events: [
      {
        id: eventId,
        date: '2026-07-20T18:00Z',
        status: {
          period,
          displayClock: '4:12',
          type: { state: 'in', detail: `${period}rd Quarter`, shortDetail: `${period}rd Quarter` },
        },
        competitions: [
          {
            competitors: [
              {
                homeAway: 'home',
                score: '21',
                team: { id: '52', displayName: 'Florida State Seminoles', abbreviation: 'FSU' },
              },
              {
                homeAway: 'away',
                score: '17',
                team: { id: '57', displayName: 'Georgia Bulldogs', abbreviation: 'UGA' },
              },
            ],
          },
        ],
      },
    ],
  };
}

describe('espn UFC (mma)', () => {
  it('parses a live 2-fighter bout: names from athlete, rounds not quarters', async () => {
    const games = await espnProvider.listGames(makeCtx(load('espn-scoreboard-ufc.json')).ctx, UFC);
    expect(games).toHaveLength(2);
    const g = games[0];
    expect(g.id).toBe('espn:ufc:600053622');
    expect(g.sport).toBe('mma');
    expect(g.phase).toBe('in');
    // a combat sport fights ROUNDS — 'Q3' would be simply wrong.
    expect(g.statusShort).toBe('R3');
    expect(g.statusText).toBe('Round 3');
    // the fighter name comes from competitor.athlete (there is no `team` block at all).
    expect(g.home?.name).toBe('Jon Jones');
    expect(g.away?.name).toBe('Tom Aspinall');
    // abbrev derives from the name (§2), never from the truncated shortName 'J. Jones'.
    expect(g.home?.abbrev).toBe('JON');
    expect(g.away?.abbrev).toBe('TOM');
    expect(g.home?.id).toBe('2335639');
    // no competitor.score on an mma card ⇒ undefined, never NaN.
    expect(g.home?.score).toBeUndefined();
  });

  it('a competitor with no athlete name falls back to TBD, never an empty string', async () => {
    const games = await espnProvider.listGames(makeCtx(load('espn-scoreboard-ufc.json')).ctx, UFC);
    const g = games[1];
    expect(g.away?.name).toBe('TBD');
    expect(g.away?.abbrev).toBe('TBD');
    expect(g.away?.name.length).toBeGreaterThan(0);
    // the decided side of the bout is still a real fighter.
    expect(g.home?.name).toBe('Ciryl Gane');
    // pre-fight statusShort is the local kickoff clock, never empty.
    expect(g.statusShort).toMatch(/^(\d{2}:\d{2}|TBD)$/);
  });

  it('a headshot is emitted only from the logo cache allowlist host', async () => {
    const games = await espnProvider.listGames(makeCtx(load('espn-scoreboard-ufc.json')).ctx, UFC);
    // a.espncdn.com — on the allowlist, and rewritten to the 64 px combiner form.
    expect(games[0].home?.logo).toEqual({
      light: 'https://a.espncdn.com/combiner/i?img=/i/headshots/mma/players/full/2335639.png&w=64&h=64&transparent=true',
    });
    // secure.espncdn.com — NOT on the allowlist (src/ui/logoCache.ts) ⇒ no logo at all.
    expect(games[0].away?.logo).toBeUndefined();
  });
});

// --- a league with NO summary endpoint (UFC) -------------------------------

function ufcGame(eventId: string): Game {
  return {
    id: `espn:ufc:${eventId}`,
    providerId: 'espn',
    leagueId: 'ufc',
    leagueName: 'UFC',
    sport: 'mma',
    startTimeUtc: undefined,
    phase: 'in',
    statusText: 'stale',
    statusShort: 'stale',
    format: 'versus',
    home: { id: '1', name: 'Stale Home', abbrev: 'STH', score: undefined },
    away: { id: '2', name: 'Stale Away', abbrev: 'STA', score: undefined },
    entrants: undefined,
  };
}

/**
 * The LIVE shape (probed 2026-07-20): one `event` is a whole fight CARD whose
 * `competitions[]` are the bouts, and a bout's competitors carry `order`, never
 * `homeAway`. Bout 1 is settled, bout 2 is live, bout 3 has not started.
 */
function ufcCard(): any {
  return {
    events: [
      {
        id: '600059599',
        date: '2026-07-18T21:00Z',
        name: 'UFC Fight Night: Du Plessis vs. Usman',
        status: {
          period: 2,
          type: { id: '2', state: 'in', completed: false, detail: 'In Progress', shortDetail: 'In Progress' },
        },
        competitions: [
          {
            id: '401889642',
            status: { period: 1, type: { state: 'post', completed: true, detail: 'Final', shortDetail: 'Final' } },
            competitors: [
              { id: '4801725', order: 2, winner: true, athlete: { id: '4801725', displayName: 'Dione Barbosa' } },
              { id: '5334916', order: 1, winner: false, athlete: { id: '5334916', displayName: 'Anna Melisano' } },
            ],
          },
          {
            id: '401889641',
            status: { period: 2, type: { state: 'in', completed: false, detail: 'Round 2', shortDetail: 'Round 2' } },
            competitors: [
              { id: '5229339', order: 2, winner: false, athlete: { displayName: 'Alvin Hines' } },
              { id: '5369555', order: 1, winner: false, athlete: { displayName: 'RJ Harris' } },
            ],
          },
          {
            id: '401872218',
            status: { type: { state: 'pre' } },
            competitors: [
              { id: '2504', order: 2, athlete: { displayName: 'Kamaru Usman' } },
              { id: '4030', order: 1, athlete: { displayName: 'Dricus Du Plessis' } },
            ],
          },
        ],
      },
    ],
  };
}

describe('espn fetchPlays for a league with no summary endpoint (UFC)', () => {
  it('derives the snapshot from the SCOREBOARD and never calls /summary', async () => {
    // The regression: `mma/ufc/summary?event=…` is HTTP 404 and a 404 is
    // ProviderError('not-found'), which auto-unfollows the fight (§4).
    const { ctx, urls } = makeCtx(ufcCard());
    const snap = await espnProvider.fetchPlays(ctx, ufcGame('600059599'));
    expect(urls).toEqual(['https://site.api.espn.com/apis/site/v2/sports/mma/ufc/scoreboard']);
    expect(urls.some((u) => u.includes('/summary'))).toBe(false);
    expect(snap.game.id).toBe('espn:ufc:600059599');
    expect(snap.state).toBeUndefined();
  });

  it('refreshes the game from the scoreboard event — phase, rounds, both fighters', async () => {
    const stale = ufcGame('600059599');
    stale.phase = 'pre';
    const snap = await espnProvider.fetchPlays(makeCtx(ufcCard()).ctx, stale);
    expect(snap.game.phase).toBe('in'); // re-derived, not carried from the stale input
    expect(snap.game.statusShort).toBe('R2'); // a fight card counts ROUNDS
    expect(snap.game.statusText).toBe('In Progress');
    // competitors carry `order` and no `homeAway`: feed array order decides, so the
    // sides are real fighters instead of the old TBD/TBD.
    expect(snap.game.home?.name).toBe('Kamaru Usman');
    expect(snap.game.away?.name).toBe('Dricus Du Plessis');
    expect(snap.game.home?.name).not.toBe('Stale Home');
    expect(snap.game.format).toBe('versus');
  });

  it('the card is named after its MAIN EVENT, never after the opening prelim', async () => {
    // B2: `competitions[0]` is the first bout of the night — the opening women's
    // strawweight prelim — so the tree row, the status-bar tag and the relay's
    // final line all named two fighters nobody followed the card for, while the
    // main event the card is literally called after never appeared anywhere.
    const card = ufcCard();
    expect(card.events[0].name).toBe('UFC Fight Night: Du Plessis vs. Usman');
    const games = await espnProvider.listGames(makeCtx(card).ctx, UFC);
    const sides = [games[0].home?.name, games[0].away?.name];
    expect(sides).toContain('Dricus Du Plessis');
    expect(sides).toContain('Kamaru Usman');
    // the opening prelim's fighters must not be what the card is called.
    expect(sides).not.toContain('Anna Melisano');
    expect(sides).not.toContain('Dione Barbosa');
    // and both halves of the feed's own event name are represented in the row.
    for (const s of sides) expect(card.events[0].name).toContain(s!.split(' ').pop());
  });

  it('a single-competition event is unchanged by the main-event rule (last IS first)', async () => {
    // Every non-card league puts exactly one competition on an event.
    const games = await espnProvider.listGames(makeCtx(load('espn-scoreboard-ufc.json')).ctx, UFC);
    expect(games[0].home?.name).toBe('Jon Jones');
    expect(games[0].away?.name).toBe('Tom Aspinall');
  });

  it('one result line per settled bout, a start line for the live bout, nothing for a bout to come', async () => {
    const snap = await espnProvider.fetchPlays(makeCtx(ufcCard()).ctx, ufcGame('600059599'));
    expect(snap.events.map((e) => e.id)).toEqual(['401889642:result', '401889641:start']);
    const result = snap.events[0];
    expect(result.text).toBe('Result — Dione Barbosa def. Anna Melisano');
    expect(result.kind).toBe('score');
    expect(result.scoreAfter).toBeUndefined(); // a bout has no numeric score
    expect(result.gameId).toBe('espn:ufc:600059599');
    const start = snap.events[1];
    expect(start.text).toBe('Under way — Alvin Hines vs RJ Harris');
    expect(start.kind).toBe('status');
    // sorted by sequence ascending (§2), and the unstarted bout produced nothing.
    expect(snap.events.map((e) => e.sequence)).toEqual([1, 2]);
    expect(snap.events.some((e) => e.text.includes('Usman'))).toBe(false);
  });

  it('event ids are stable across two identical fetches', async () => {
    const first = await espnProvider.fetchPlays(makeCtx(ufcCard()).ctx, ufcGame('600059599'));
    const second = await espnProvider.fetchPlays(makeCtx(ufcCard()).ctx, ufcGame('600059599'));
    expect(second.events.map((e) => e.id)).toEqual(first.events.map((e) => e.id));
    expect(second.events.map((e) => e.text)).toEqual(first.events.map((e) => e.text));
    // and the ids are derived from the bout, not from its position in the array.
    expect(first.events.map((e) => e.id)).toEqual(['401889642:result', '401889641:start']);
  });

  it('a settled bout with no winner flag states the pairing and invents no outcome', async () => {
    const mut = ufcCard();
    mut.events[0].competitions[0].competitors[0].winner = false; // draw / no contest
    const snap = await espnProvider.fetchPlays(makeCtx(mut).ctx, ufcGame('600059599'));
    expect(snap.events[0].text).toBe('Final — Dione Barbosa vs Anna Melisano');
    expect(snap.events[0].id).toBe('401889642:result');
  });

  it('ko: the composed lines are localized (§12.1)', async () => {
    const snap = await espnProvider.fetchPlays(makeCtx(ufcCard(), { locale: 'ko' }).ctx, ufcGame('600059599'));
    expect(snap.events[0].text).toBe('경기 결과 — Dione Barbosa 승, Anna Melisano 패');
    expect(snap.events[1].text).toBe('경기 시작 — Alvin Hines 대 RJ Harris');
    // no raw {placeholder} ever survives into a relay line.
    expect(snap.events.every((e) => !/[{}]/.test(e.text))).toBe(true);
  });

  it('an event that is GONE from a well-formed non-empty board raises not-found (auto-unfollow is right)', async () => {
    const err = await espnProvider.fetchPlays(makeCtx(ufcCard()).ctx, ufcGame('999999999')).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).kind).toBe('not-found');
  });

  it('only a genuine absence is not-found — a failure, a malformed body and an EMPTY board are not', async () => {
    // B4: 'not-found' is what the poller counts three of before AUTO-UNFOLLOWING
    // (NOT_FOUND_LIMIT = 3). A day rollover, an off-season board and a route-level
    // failure all used to raise it, so a transient blip unfollowed a live fight
    // in ~2 minutes, mid-card, with the main event still ahead. The identical
    // upstream condition is harmless on a summary-backed league, where an empty
    // body is simply zero plays — that asymmetry was the bug.
    const cases: Array<[string, ProviderContext]> = [
      ['fetch throws a 404 on the scoreboard ROUTE', throwingCtx(new ProviderError('not-found', 'HTTP 404'))],
      ['fetch throws a plain Error', throwingCtx(new Error('socket hang up'))],
      ['malformed body (not a scoreboard)', makeCtx({ events: 'nope' }).ctx],
      ['malformed body (not an object)', makeCtx('<html>502</html>').ctx],
      ['empty board (off-season / day rollover)', makeCtx({ events: [] }).ctx],
      ['board with no key at all', makeCtx({}).ctx],
      ['board whose events carry no usable id', makeCtx({ events: [{}, 42, { id: '' }] }).ctx],
    ];
    for (const [label, ctx] of cases) {
      const err = await espnProvider.fetchPlays(ctx, ufcGame('600059599')).catch((e) => e);
      expect(err, label).toBeInstanceOf(ProviderError);
      // never the auto-unfollow signal, and always a kind the poller retries.
      expect((err as ProviderError).kind, label).not.toBe('not-found');
      expect((err as ProviderError).kind, label).toBe('unavailable');
    }
  });

  it('a network error keeps its own kind — it is retryable and never auto-unfollows', async () => {
    const err = await espnProvider
      .fetchPlays(throwingCtx(new ProviderError('network', 'timeout')), ufcGame('600059599'))
      .catch((e) => e);
    expect((err as ProviderError).kind).toBe('network');
  });

  it('a single-competition card (no per-bout status) falls back to the event phase', async () => {
    // The fixture shape: one competition per event, homeAway declared, status only
    // on the event itself.
    const { ctx, urls } = makeCtx(load('espn-scoreboard-ufc.json'));
    const snap = await espnProvider.fetchPlays(ctx, ufcGame('600053622'));
    expect(urls[0]).toContain('/mma/ufc/scoreboard');
    expect(snap.game.phase).toBe('in');
    expect(snap.game.statusShort).toBe('R3');
    expect(snap.game.home?.name).toBe('Jon Jones');
    expect(snap.events.map((e) => e.id)).toEqual(['600053622:start']);
    expect(snap.events[0].text).toBe('Under way — Jon Jones vs Tom Aspinall');
  });

  it('a finished fixture bout produces the result line from the winner flag', async () => {
    const mut = clone(load('espn-scoreboard-ufc.json'));
    mut.events[0].status.type.state = 'post';
    mut.events[0].status.type.shortDetail = 'Final';
    mut.events[0].competitions[0].competitors[1].winner = true; // Aspinall
    const snap = await espnProvider.fetchPlays(makeCtx(mut).ctx, ufcGame('600053622'));
    expect(snap.game.phase).toBe('post');
    expect(snap.game.statusShort).toBe('F');
    expect(snap.events.map((e) => e.id)).toEqual(['600053622:result']);
    expect(snap.events[0].text).toBe('Result — Tom Aspinall def. Jon Jones');
    expect(snap.events[0].kind).toBe('score');
  });

  it('a malformed competition is skipped (logged), never fatal', async () => {
    const mut = ufcCard();
    mut.events[0].competitions.unshift(42); // not an object
    mut.events[0].competitions.push({ id: 'lonely', status: { type: { state: 'post' } }, competitors: [] });
    const { ctx, logs } = makeCtx(mut);
    const snap = await espnProvider.fetchPlays(ctx, ufcGame('600059599'));
    expect(snap.events.map((e) => e.id)).toEqual(['401889642:result', '401889641:start']);
    expect(logs.some((l) => l.includes('no two sides'))).toBe(true);
  });
});

// --- two-poll behaviour: every stateful defect needs exactly TWO snapshots ---

/**
 * A card whose competitions declare NO id of their own, so the provider must
 * derive one. `bouts` is the card's list in running order; a settled bout has
 * simply been removed, which is exactly what the live feed does.
 */
function idlessCard(bouts: Array<{ state: string; a: [string, string]; b: [string, string]; winner?: 'a' | 'b' }>): unknown {
  return {
    events: [
      {
        id: '600059599',
        date: '2026-07-18T21:00Z',
        name: 'UFC Fight Night: Du Plessis vs. Usman',
        status: { period: 1, type: { state: 'in', detail: 'In Progress', shortDetail: 'In Progress' } },
        competitions: bouts.map((b) => ({
          status: { type: { state: b.state } },
          competitors: [
            { id: b.a[0], order: 1, winner: b.winner === 'a', athlete: { id: b.a[0], displayName: b.a[1] } },
            { id: b.b[0], order: 2, winner: b.winner === 'b', athlete: { id: b.b[0], displayName: b.b[1] } },
          ],
        })),
      },
    ],
  };
}

const ALPHA = { a: ['91', 'Alpha One'] as [string, string], b: ['92', 'Alpha Two'] as [string, string] };
const BRAVO = { a: ['93', 'Bravo One'] as [string, string], b: ['94', 'Bravo Two'] as [string, string] };

describe('espn UFC across TWO polls (the state the one-snapshot gates could not see)', () => {
  it('a bout dropping out of the array emits ZERO corrections through the real relay engine', async () => {
    // B3: the fallback id used to be `${eventId}#${arrayIndex}`, and a card's
    // competitions[] is exactly the list that SHRINKS as bouts settle. After the
    // Alpha bout was removed, the Bravo bout sat at index 0 and re-emitted its
    // result under Alpha's id — so the user's relay log claimed a fight ended
    // differently than it did:
    //   relay1 [score]      Result — Alpha One def. Alpha Two
    //   relay2 [correction] Result — Bravo One def. Bravo Two
    const poll1 = idlessCard([
      { state: 'post', ...ALPHA, winner: 'a' },
      { state: 'in', ...BRAVO },
    ]);
    const poll2 = idlessCard([{ state: 'post', ...BRAVO, winner: 'a' }]);

    const engine = createRelayEngine({ backfillLimit: 10, locale: 'en' });
    const first = await espnProvider.fetchPlays(makeCtx(poll1).ctx, ufcGame('600059599'));
    const second = await espnProvider.fetchPlays(makeCtx(poll2).ctx, ufcGame('600059599'));

    const e1 = engine.ingest(first);
    const e2 = engine.ingest(second);

    expect(e1.events.map((e) => e.text)).toEqual([
      'Result — Alpha One def. Alpha Two',
      'Under way — Bravo One vs Bravo Two',
    ]);
    expect(e2.events.map((e) => e.text)).toEqual(['Result — Bravo One def. Bravo Two']);
    // the indictment: not one line of either emission is a rewrite of an earlier one.
    for (const e of [...e1.events, ...e2.events]) expect(e.kind).not.toBe('correction');
    // and the two results are two distinct events, not one event edited.
    expect(second.events[0].id).not.toBe(first.events[0].id);
  });

  it('a derived contest id is a function of the COMPETITORS, not of the array position', async () => {
    const alone = await espnProvider.fetchPlays(
      makeCtx(idlessCard([{ state: 'post', ...BRAVO, winner: 'a' }])).ctx,
      ufcGame('600059599'),
    );
    const preceded = await espnProvider.fetchPlays(
      makeCtx(
        idlessCard([
          { state: 'post', ...ALPHA, winner: 'a' },
          { state: 'post', ...BRAVO, winner: 'a' },
        ]),
      ).ctx,
      ufcGame('600059599'),
    );
    // the SAME bout carries the same id at index 0 and at index 1 …
    const bravoAlone = alone.events.find((e) => e.text.includes('Bravo One'))!;
    const bravoPreceded = preceded.events.find((e) => e.text.includes('Bravo One'))!;
    expect(bravoAlone.id).toBe(bravoPreceded.id);
    // … and two different bouts never share one.
    expect(new Set(preceded.events.map((e) => e.id)).size).toBe(2);
    expect(bravoAlone.id.startsWith('600059599#')).toBe(true);
  });

  it('a bout with no status of its own is NOT announced as under way', async () => {
    // B5: every bout used to inherit the CARD's 'in', so a 12-bout card emitted a
    // burst of twelve false "Under way" lines at once — which also spent the
    // relay's backfill limit on announcements that were not true.
    const card = idlessCard(
      Array.from({ length: 12 }, (_, i) => ({
        state: 'unknown',
        a: [`${100 + i}`, `Red ${i}`] as [string, string],
        b: [`${200 + i}`, `Blue ${i}`] as [string, string],
      })),
    );
    const snap = await espnProvider.fetchPlays(makeCtx(card).ctx, ufcGame('600059599'));
    expect(snap.game.phase).toBe('in'); // the CARD is live …
    expect(snap.events).toEqual([]); // … but no individual bout claims to be.

    // a bout that DOES declare itself live is still announced, exactly once.
    const mixed: any = idlessCard(
      Array.from({ length: 12 }, (_, i) => ({
        state: i === 5 ? 'in' : 'unknown',
        a: [`${100 + i}`, `Red ${i}`] as [string, string],
        b: [`${200 + i}`, `Blue ${i}`] as [string, string],
      })),
    );
    const live = await espnProvider.fetchPlays(makeCtx(mixed).ctx, ufcGame('600059599'));
    expect(live.events.map((e) => e.text)).toEqual(['Under way — Red 5 vs Blue 5']);
  });

  it('a card mixing homeAway and order keeps BOTH fighters and still relays the bout', async () => {
    // B6: the order fallback was all-or-nothing — it fired only when NO competitor
    // declared homeAway — so a card mixing the two shapes (the repo fixture
    // declares homeAway, the live card carries only `order`) yielded
    // "Jon Jones vs TBD" and no relay line for that bout at all.
    const mut: any = ufcCard();
    mut.events[0].competitions[0].competitors[0].homeAway = 'home'; // one side declares, one does not
    const snap = await espnProvider.fetchPlays(makeCtx(mut).ctx, ufcGame('600059599'));
    expect(snap.events[0].text).toBe('Result — Dione Barbosa def. Anna Melisano');

    // and the same holds for the side the feed leaves to `order` alone.
    const other: any = ufcCard();
    other.events[0].competitions[0].competitors[1].homeAway = 'away';
    const snap2 = await espnProvider.fetchPlays(makeCtx(other).ctx, ufcGame('600059599'));
    expect(snap2.events[0].text).toBe('Result — Dione Barbosa def. Anna Melisano');

    // listGames sees it too: no side is lost to TBD.
    const games = await espnProvider.listGames(makeCtx(mut).ctx, UFC);
    expect([games[0].home?.name, games[0].away?.name]).not.toContain('TBD');
  });
});

describe('espn fetchPlays still takes the summary path for every other league', () => {
  it('a summary-backed league (NBA) is unchanged: it calls /summary and parses plays', async () => {
    const { ctx, urls } = makeCtx(load('espn-summary-plays.json'));
    const snap = await espnProvider.fetchPlays(ctx, nbaGame('401'));
    expect(urls).toEqual(['https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=401']);
    expect(snap.events).toHaveLength(7);
  });

  it('the other three new leagues keep their summary endpoints', async () => {
    const cases: Array<[Game, string]> = [
      [{ ...nbaGame('1'), leagueId: 'cricket', sport: 'cricket', id: 'espn:cricket:1' }, 'cricket/8039/summary?event=1'],
      [
        { ...nbaGame('2'), leagueId: 'college-football', sport: 'football', id: 'espn:college-football:2' },
        'football/college-football/summary?event=2',
      ],
      [
        { ...nbaGame('3'), leagueId: 'mens-college-basketball', id: 'espn:mens-college-basketball:3' },
        'basketball/mens-college-basketball/summary?event=3',
      ],
      [soccerGame('4'), 'soccer/fifa.world/summary?event=4'],
    ];
    for (const [game, expectedUrl] of cases) {
      const { ctx, urls } = makeCtx({});
      await espnProvider.fetchPlays(ctx, game);
      expect(urls).toEqual([`https://site.api.espn.com/apis/site/v2/sports/${expectedUrl}`]);
    }
  });
});

describe('espn cricket', () => {
  it('parses a live match: innings not quarters, integer scores coerced', async () => {
    const games = await espnProvider.listGames(makeCtx(load('espn-scoreboard-cricket.json')).ctx, CRICKET);
    expect(games).toHaveLength(2);
    const g = games[0];
    expect(g.sport).toBe('cricket');
    expect(g.phase).toBe('in');
    // cricket plays INNINGS — 'Q2' would be simply wrong.
    expect(g.statusShort).toBe('I2');
    expect(g.statusText).toBe('2nd Innings');
    expect(g.home?.name).toBe('India');
    expect(g.home?.abbrev).toBe('IND');
    expect(g.home?.score).toBe(287);
    expect(g.away?.score).toBe(246);
    expect(g.home?.logo).toEqual({
      light: 'https://a.espncdn.com/combiner/i?img=/i/teamlogos/cricket/500/6.png&w=64&h=64&transparent=true',
    });
  });

  it('a completed match reads F, and a runs/wickets score yields the RUNS', async () => {
    const base = load('espn-scoreboard-cricket.json');
    const games = await espnProvider.listGames(makeCtx(base).ctx, CRICKET);
    expect(games[1].phase).toBe('post');
    expect(games[1].statusShort).toBe('F');
    expect(games[1].statusText).toBe('Australia won');

    // '287/5' is runs/wickets: 287 runs. This assertion used to expect `undefined`,
    // which is what shipped — and it is why the side that had already batted showed
    // a score while the side actually AHEAD showed none.
    const mut = clone(base);
    mut.events[0].competitions[0].competitors[0].score = '287/5';
    const mutated = await espnProvider.listGames(makeCtx(mut).ctx, CRICKET);
    expect(mutated).toHaveLength(2);
    expect(mutated[0].home?.score).toBe(287);
  });

  it('the LIVE runs/wickets/overs string parses to the runs, and the display no longer inverts the result', async () => {
    // B1, live-confirmed on event 1384439: India "240", Australia
    // "241/4 (43/50 ov, target 241)". Australia won by 6 wickets; the shipped
    // display read 'AUS –:240 IND', asserting the opposite.
    const mut = clone(load('espn-scoreboard-cricket.json'));
    const comp = mut.events[0].competitions[0];
    comp.competitors[0].score = '240'; // India, all out
    comp.competitors[1].score = '241/4 (43/50 ov, target 241)'; // Australia, chasing and ahead
    const games = await espnProvider.listGames(makeCtx(mut).ctx, CRICKET);
    expect(games[0].home?.score).toBe(240);
    expect(games[0].away?.score).toBe(241);
    // the side that is ahead is the side with the higher number.
    expect(games[0].away!.score!).toBeGreaterThan(games[0].home!.score!);
    // the wickets and overs the number cannot hold stay readable.
    expect(games[0].statusText).toContain('241/4 (43/50 ov, target 241)');
    expect(games[0].statusText).toContain('2nd Innings');
    // a bare integer adds nothing and is not repeated into the status.
    expect(games[0].statusText).not.toContain('IND 240');
  });

  it('a mid-match cricket score CHANGES across two polls through the real relay engine', async () => {
    // Both innings carry the runs/wickets format mid-match, so both scores used to
    // be undefined — `sideChanged()` was permanently false and a followed match
    // updated nothing for its entire duration.
    function summary(home: string, away: string): unknown {
      return {
        header: {
          id: '1384439',
          competitions: [
            {
              status: { period: 2, type: { state: 'in', detail: '2nd Innings', shortDetail: '2nd Innings' } },
              competitors: [
                { homeAway: 'home', score: home, team: { id: '6', displayName: 'India', abbreviation: 'IND' } },
                { homeAway: 'away', score: away, team: { id: '3', displayName: 'Australia', abbreviation: 'AUS' } },
              ],
            },
          ],
        },
      };
    }
    const game: Game = {
      ...nbaGame('1384439'),
      id: 'espn:cricket:1384439',
      leagueId: 'cricket',
      leagueName: 'Cricket',
      sport: 'cricket',
    };
    const engine = createRelayEngine({ backfillLimit: 10, locale: 'en' });
    const first = await espnProvider.fetchPlays(makeCtx(summary('240', '198/3 (39/50 ov, target 241)')).ctx, game);
    const second = await espnProvider.fetchPlays(makeCtx(summary('240', '241/4 (43/50 ov, target 241)')).ctx, game);
    expect(first.game.away?.score).toBe(198);
    expect(second.game.away?.score).toBe(241);
    engine.ingest(first);
    const emission = engine.ingest(second);
    expect(emission.scoreChanged).toBe(true);
    expect(emission.game.statusText).toContain('43/50 ov');
  });

  it('a cricket score that is not runs-led still degrades to undefined, never NaN', async () => {
    for (const bad of ['DNB', '', 'no result', '-5', {}, null]) {
      const mut = clone(load('espn-scoreboard-cricket.json'));
      mut.events[0].competitions[0].competitors[0].score = bad;
      const games = await espnProvider.listGames(makeCtx(mut).ctx, CRICKET);
      expect(games[0].home?.score).toBeUndefined();
    }
  });

  it('the runs parse is cricket-only — no other sport reinterprets a slashed score', async () => {
    const mut = clone(load('espn-scoreboard-soccer-post.json'));
    mut.events[0].competitions[0].competitors[0].score = '3/1';
    const games = await espnProvider.listGames(makeCtx(mut).ctx, SOCCER);
    expect(games[0].home?.score).toBeUndefined();
  });
});

describe('espn college football / mens college basketball', () => {
  it('college football parses a normal 2-competitor event with quarter periods', async () => {
    const games = await espnProvider.listGames(makeCtx(teamScoreboard('401752000', 3)).ctx, CFB);
    expect(games).toHaveLength(1);
    const g = games[0];
    expect(g.id).toBe('espn:college-football:401752000');
    expect(g.sport).toBe('football');
    expect(g.statusShort).toBe('Q3'); // a gridiron sport really does play quarters
    expect(g.home?.abbrev).toBe('FSU');
    expect(g.home?.score).toBe(21);
    expect(g.away?.abbrev).toBe('UGA');
    expect(g.away?.score).toBe(17);
  });

  it("men's college basketball parses a normal 2-competitor event", async () => {
    const games = await espnProvider.listGames(makeCtx(teamScoreboard('401700111', 2)).ctx, CBB);
    expect(games).toHaveLength(1);
    expect(games[0].sport).toBe('basketball');
    expect(games[0].leagueName).toBe("Men's College Basketball");
    expect(games[0].statusShort).toBe('Q2');
  });

  it('college football tolerates a large single-day scoreboard (99 events, no cap here)', async () => {
    // The provider caps nothing: every well-formed event becomes a Game. See the
    // report — a display cap, if wanted, belongs in the tree, not in the parser.
    const one = teamScoreboard('401752000', 3) as { events: unknown[] };
    const many = { events: Array.from({ length: 99 }, (_, i) => ({ ...(one.events[0] as object), id: `4017520${i}` })) };
    const games = await espnProvider.listGames(makeCtx(many).ctx, CFB);
    expect(games).toHaveLength(99);
    expect(new Set(games.map((g) => g.id)).size).toBe(99);
  });
});

describe('espn new leagues: §14 shape and empty scoreboards', () => {
  it('every game from a new league is a versus contest with both sides and no entrants', async () => {
    const cases: Array<[League, unknown]> = [
      [UFC, load('espn-scoreboard-ufc.json')],
      [CRICKET, load('espn-scoreboard-cricket.json')],
      [CFB, teamScoreboard('401752000', 3)],
      [CBB, teamScoreboard('401700111', 2)],
    ];
    for (const [league, payload] of cases) {
      const games = await espnProvider.listGames(makeCtx(payload).ctx, league);
      expect(games.length).toBeGreaterThan(0);
      for (const g of games) {
        expect(g.format).toBe('versus');
        expect(g.home).toBeDefined();
        expect(g.away).toBeDefined();
        expect(g.entrants).toBeUndefined();
        // §contract: statusShort is never empty and never exceeds 8 chars.
        expect(g.statusShort.length).toBeGreaterThan(0);
        expect(g.statusShort.length).toBeLessThanOrEqual(8);
        expect(g.statusText.length).toBeGreaterThan(0);
      }
    }
  });

  it('an EMPTY scoreboard (off-season) is a valid empty list, never an error', async () => {
    for (const league of [UFC, CRICKET, CFB, CBB]) {
      await expect(espnProvider.listGames(makeCtx({ events: [] }).ctx, league)).resolves.toEqual([]);
      // the key is absent entirely — same answer.
      await expect(espnProvider.listGames(makeCtx({}).ctx, league)).resolves.toEqual([]);
    }
  });
});
