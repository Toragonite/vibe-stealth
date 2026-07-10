import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DetailLevel, Game, League, PlaySnapshot, ProviderContext, ProviderError, RelayLocale } from '../../src/core/contract';
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
): { ctx: ProviderContext; logs: string[] } {
  const logs: string[] = [];
  const ctx: ProviderContext = {
    locale: opts?.locale ?? 'en',
    gameStateEnabled: true,
    detail: opts?.detail ?? 'summary',
    fetchJson: async () => payload,
    getSecret: async () => undefined,
    log: (m: string) => logs.push(m),
    now: () => 0,
  };
  return { ctx, logs };
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
    home: { id: '448', name: 'England', abbrev: 'ENG', score: undefined },
    away: { id: '2850', name: 'Congo DR', abbrev: 'COD', score: undefined },
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
    home: { id: '1', name: 'Home', abbrev: 'HOM', score: undefined },
    away: { id: '2', name: 'Away', abbrev: 'AWY', score: undefined },
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
    ]);
    expect(ids).not.toContain('mlb');
    expect(leagues.find((l) => l.id === 'nfl')?.sport).toBe('football');
    expect(leagues.find((l) => l.id === 'nba')?.sport).toBe('basketball');
    expect(leagues.find((l) => l.id === 'eng.1')?.sport).toBe('soccer');
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
