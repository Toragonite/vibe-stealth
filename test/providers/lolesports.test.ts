import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { lolesportsProvider, livestatsStartingTime, __resetKillCursors } from '../../src/providers/lolesports';
import { createRelayEngine } from '../../src/core/relay';
import { registerMessages } from '../../src/core/i18n';
import type { Game, League, PlayEvent, ProviderContext } from '../../src/core/contract';
import { ProviderError } from '../../src/core/contract';

function loadFixture(name: string): any {
  return JSON.parse(readFileSync(join(process.cwd(), 'test/fixtures', name), 'utf8'));
}

interface CtxOpts {
  response?: unknown;
  throwErr?: unknown;
  now?: number;
  locale?: 'en' | 'ko';
  /** §11.5 gate — default false so pre-state tests keep exactly today's request shape. */
  gameStateEnabled?: boolean;
  /** §12 detail level — default 'summary' so existing tests keep today's behavior. */
  detail?: 'summary' | 'detailed';
  /** Response for the livestats window URL (feed.lolesports.com). */
  windowResponse?: unknown;
  /** If set, the livestats window fetch throws this instead of returning windowResponse. */
  windowThrow?: unknown;
}

function isWindowUrl(url: string): boolean {
  return url.includes('feed.lolesports.com/livestats');
}

function makeCtx(opts: CtxOpts = {}) {
  const calls: { url: string; headers?: Record<string, string> }[] = [];
  const logs: string[] = [];
  const ctx: ProviderContext = {
    locale: opts.locale ?? 'en',
    gameStateEnabled: opts.gameStateEnabled ?? false,
    detail: opts.detail ?? 'summary',
    now: () => opts.now ?? Date.parse('2026-07-08T09:00:00Z'),
    log: (msg: string) => {
      logs.push(msg);
    },
    getSecret: async () => undefined,
    fetchJson: async (url, headers) => {
      calls.push({ url, headers });
      if (isWindowUrl(url)) {
        if (opts.windowThrow) throw opts.windowThrow;
        return opts.windowResponse;
      }
      if (opts.throwErr) throw opts.throwErr;
      return opts.response;
    },
  };
  return { ctx, calls, logs };
}

const MSI: League = { id: 'msi', providerId: 'lolesports', name: 'MSI', sport: 'esports' };
const LCK: League = { id: 'lck', providerId: 'lolesports', name: 'LCK', sport: 'esports' };

function msiGame(phase: Game['phase'] = 'in'): Game {
  return {
    id: 'lolesports:msi:115570934355614581',
    providerId: 'lolesports',
    leagueId: 'msi',
    leagueName: 'MSI',
    sport: 'esports',
    startTimeUtc: '2026-07-08T08:00:00Z',
    phase,
    statusText: 'BO5 · 0:0',
    statusShort: 'G1',
    home: { id: '98767991853197861', name: 'T1', abbrev: 'T1', score: 0 },
    away: { id: '98767991926151025', name: 'G2 Esports', abbrev: 'G2', score: 0 },
  };
}

describe('lolesports livestatsStartingTime (§11.5)', () => {
  it('subtracts 60 s, floors to a 10-second boundary, emits YYYY-MM-DDTHH:MM:SSZ (no ms)', () => {
    // now − 60 s lands mid-window ⇒ floored down to the boundary. Matches the value the
    // orchestrator probed live during BLG-vs-HLE (?startingTime=2026-07-09T08:28:40Z).
    expect(livestatsStartingTime(Date.parse('2026-07-09T08:29:49.976Z'))).toBe('2026-07-09T08:28:40Z');
    // exactly on the minute ⇒ now − 60 s = :29:00, already on a boundary.
    expect(livestatsStartingTime(Date.parse('2026-07-09T08:30:00.000Z'))).toBe('2026-07-09T08:29:00Z');
    // now − 60 s already on a 10-second boundary ⇒ unchanged.
    expect(livestatsStartingTime(Date.parse('2026-07-09T08:29:40.000Z'))).toBe('2026-07-09T08:28:40Z');
    // sub-10s precision is floored away (the API rejects it).
    expect(livestatsStartingTime(Date.parse('2026-07-09T08:29:47.003Z'))).toBe('2026-07-09T08:28:40Z');
  });
});

describe('lolesports listLeagues', () => {
  it('returns the six static leagues, all esports', async () => {
    const { ctx } = makeCtx();
    const leagues = await lolesportsProvider.listLeagues(ctx);
    expect(leagues.map((l) => l.id).sort()).toEqual(
      ['first_stand', 'lck', 'lec', 'lpl', 'msi', 'worlds'],
    );
    expect(leagues.every((l) => l.sport === 'esports')).toBe(true);
  });
});

describe('lolesports listGames', () => {
  it('parses a live match within ±48h; en locale ⇒ hl=en-US; numeric leagueId', async () => {
    const { ctx, calls } = makeCtx({ response: loadFixture('lolesports-getlive.json') });
    const games = await lolesportsProvider.listGames(ctx, MSI);

    expect(games).toHaveLength(1);
    const g = games[0]!;
    expect(g.id).toBe('lolesports:msi:115570934355614581');
    expect(g.phase).toBe('in');
    expect(g.away.abbrev).toBe('G2');
    expect(g.home.abbrev).toBe('T1');
    expect(g.away.score).toBe(0);
    expect(g.home.score).toBe(0);
    expect(g.startTimeUtc).toBe('2026-07-08T08:00:00Z');
    expect(g.statusText).toBe('BO5 · 0:0');
    expect(g.statusShort).toBe('G1');
    expect(calls[0]!.url).toContain('hl=en-US');
    expect(calls[0]!.url).toContain('leagueId=98767991325878492');
  });

  it('ko locale ⇒ hl=ko-KR', async () => {
    const { ctx, calls } = makeCtx({
      response: loadFixture('lolesports-getlive.json'),
      locale: 'ko',
    });
    await lolesportsProvider.listGames(ctx, MSI);
    expect(calls[0]!.url).toContain('hl=ko-KR');
  });

  it('±48h window filter drops far-off matches', async () => {
    const july = makeCtx({
      response: loadFixture('lolesports-schedule.json'),
      now: Date.parse('2026-07-08T09:00:00Z'),
    });
    expect(await lolesportsProvider.listGames(july.ctx, LCK)).toEqual([]);

    const june = makeCtx({
      response: loadFixture('lolesports-schedule.json'),
      now: Date.parse('2026-06-13T12:00:00Z'),
    });
    const games = await lolesportsProvider.listGames(june.ctx, LCK);
    expect(games).toHaveLength(3);
    expect(games.every((g) => g.phase === 'post')).toBe(true);
    expect(games[0]!.statusText).toBe('Final');
    expect(games[0]!.statusShort).toBe('F');
    // completed LCK: HLE (teams[0] → away) gameWins 3, T1 (teams[1] → home) gameWins 1.
    expect(games[0]!.away.abbrev).toBe('HLE');
    expect(games[0]!.away.score).toBe(3);
    expect(games[0]!.home.score).toBe(1);
    expect(games[0]!.id).toBe('lolesports:lck:115548128963037575');
  });

  it('gameWins missing ⇒ score undefined', async () => {
    const fix = loadFixture('lolesports-getlive.json');
    delete fix.data.schedule.events[0].match.teams[0].result.gameWins;
    const { ctx } = makeCtx({ response: fix });
    const games = await lolesportsProvider.listGames(ctx, MSI);
    expect(games[0]!.away.score).toBeUndefined();
  });

  it('unseen state ⇒ phase unknown', async () => {
    const fix = loadFixture('lolesports-getlive.json');
    fix.data.schedule.events[0].state = 'weird_new_state';
    const { ctx } = makeCtx({ response: fix });
    const games = await lolesportsProvider.listGames(ctx, MSI);
    expect(games[0]!.phase).toBe('unknown');
  });

  it('missing data.schedule.events ⇒ ProviderError(parse)', async () => {
    const { ctx } = makeCtx({ response: {} });
    await expect(lolesportsProvider.listGames(ctx, MSI)).rejects.toMatchObject({ kind: 'parse' });
  });
});

// --- Defect 3: undecided (TBD vs TBD) bracket slots are not followable -------------

/** A minimal getSchedule 'match' event the listGames parser reads; start is within ±48h of the default now. */
function tbdMatchEvent(id: string, awayCode: string, homeCode: string): unknown {
  const team = (code: string) => ({
    id: `team-${id}-${code}`,
    code,
    name: code.trim().toLowerCase() === 'tbd' ? '' : code,
    result: { gameWins: 0 },
  });
  return {
    type: 'match',
    state: 'unstarted',
    startTime: '2026-07-08T08:00:00Z',
    match: { id, strategy: { count: 5 }, teams: [team(awayCode), team(homeCode)] },
  };
}
function scheduleResponse(events: unknown[]): unknown {
  return { data: { schedule: { events } } };
}

describe('lolesports listGames — TBD bracket slots (Defect 3)', () => {
  it('omits a match whose BOTH teams are code TBD (and logs it); keeps a half-drawn slot', async () => {
    const { ctx, logs } = makeCtx({
      response: scheduleResponse([
        tbdMatchEvent('m-both-tbd', 'TBD', 'TBD'),
        tbdMatchEvent('m-one-tbd', 'BLG', 'TBD'), // one decided team ⇒ real slot, kept
        tbdMatchEvent('m-real', 'BLG', 'HLE'),
      ]),
    });
    const games = await lolesportsProvider.listGames(ctx, MSI);
    const ids = games.map((g) => g.id);

    expect(ids).not.toContain('lolesports:msi:m-both-tbd');
    expect(ids).toContain('lolesports:msi:m-one-tbd');
    expect(ids).toContain('lolesports:msi:m-real');
    expect(games).toHaveLength(2);
    expect(logs.some((l) => l.includes('m-both-tbd') && l.toLowerCase().includes('tbd'))).toBe(true);
  });

  it('the TBD match is case-insensitive and trimmed', async () => {
    const { ctx } = makeCtx({
      response: scheduleResponse([tbdMatchEvent('m-messy-tbd', ' tbd ', 'TbD')]),
    });
    const games = await lolesportsProvider.listGames(ctx, MSI);
    expect(games).toHaveLength(0);
  });
});

describe('lolesports fetchPlays', () => {
  it('no completed games ⇒ empty events, statusShort from first inProgress game', async () => {
    const { ctx } = makeCtx({ response: loadFixture('lolesports-eventdetails.json') });
    const snap = await lolesportsProvider.fetchPlays(ctx, msiGame('in'));
    expect(snap.events).toEqual([]);
    expect(snap.game.statusShort).toBe('G1'); // game 1 inProgress
  });

  it('synthesizes one map-result event per completed game, sorted ascending', async () => {
    const fix = loadFixture('lolesports-eventdetails.json');
    fix.data.event.match.games[0].state = 'completed';
    fix.data.event.match.games[1].state = 'completed';
    fix.data.event.match.teams[0].result.gameWins = 1;
    fix.data.event.match.teams[1].result.gameWins = 1;
    const { ctx } = makeCtx({ response: fix });
    const snap = await lolesportsProvider.fetchPlays(ctx, msiGame('in'));

    expect(snap.events.map((e) => e.sequence)).toEqual([1, 2]);
    const e1 = snap.events[0]!;
    expect(e1.id).toBe('lol:115570934355614581:game1');
    expect(e1.kind).toBe('score');
    // §2.6 immutable-text pin: the per-map winner is NOT derivable and the running series
    // score is mutable, so the text names only the map's own immutable fact and carries no score.
    expect(e1.text).toBe('Game 1 complete');
    expect(e1.scoreAfter).toBeUndefined();
  });

  it('propagates a ProviderError (auth) from fetchJson unchanged', async () => {
    const err = new ProviderError('auth', 'key rotated');
    const { ctx } = makeCtx({ throwErr: err });
    await expect(lolesportsProvider.fetchPlays(ctx, msiGame())).rejects.toBe(err);
  });
});

// --- P9: fresh game / phase derivation (§2.6 pin) --------------------------

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}
function staleInGame(): Game {
  const g = msiGame('in');
  g.home.score = 0;
  g.away.score = 0;
  return g;
}

describe('lolesports fetchPlays fresh game (P9 / §2.6 pin)', () => {
  it('swept series (3-0, unneeded maps) ⇒ phase post, scores refreshed, Final status', async () => {
    const { ctx } = makeCtx({ response: loadFixture('lolesports-eventdetails-sweep.json') });
    const snap = await lolesportsProvider.fetchPlays(ctx, staleInGame());
    // freshly derived (the OLD refreshGame copied `...game` phase, leaving 'in').
    expect(snap.game.phase).toBe('post');
    expect(snap.game.away.score).toBe(3); // teams[0] DK gameWins 3
    expect(snap.game.home.score).toBe(0); // teams[1] BRO gameWins 0
    expect(snap.game.statusText).toBe('Final');
    expect(snap.game.statusShort).toBe('F');
    // 'unneeded' maps are terminal, not events: only the 3 completed maps emit.
    expect(snap.events.map((e) => e.sequence)).toEqual([1, 2, 3]);
  });

  it('full-length series (3-2, all completed) ⇒ phase post, scores refreshed', async () => {
    const fix = clone(loadFixture('lolesports-eventdetails-sweep.json'));
    for (const g of fix.data.event.match.games) g.state = 'completed';
    fix.data.event.match.teams[0].result.gameWins = 3;
    fix.data.event.match.teams[1].result.gameWins = 2;
    const { ctx } = makeCtx({ response: fix });
    const snap = await lolesportsProvider.fetchPlays(ctx, staleInGame());
    expect(snap.game.phase).toBe('post');
    expect(snap.game.away.score).toBe(3);
    expect(snap.game.home.score).toBe(2);
    expect(snap.events.map((e) => e.sequence)).toEqual([1, 2, 3, 4, 5]); // all 5 completed emit
  });

  it('a game inProgress ⇒ phase in (derived, not carried from the input)', async () => {
    const { ctx } = makeCtx({ response: loadFixture('lolesports-eventdetails.json') });
    const snap = await lolesportsProvider.fetchPlays(ctx, msiGame('pre'));
    expect(snap.game.phase).toBe('in'); // game 1 inProgress, input was 'pre'
    expect(snap.game.statusShort).toBe('G1');
    expect(snap.events).toEqual([]);
  });

  it('strategy.count missing ⇒ games-terminal fallback yields phase post', async () => {
    const fix = clone(loadFixture('lolesports-eventdetails-sweep.json'));
    delete fix.data.event.match.strategy.count;
    const { ctx } = makeCtx({ response: fix });
    const snap = await lolesportsProvider.fetchPlays(ctx, staleInGame());
    // 3 completed + 2 unneeded, all terminal, ≥1 completed ⇒ post via the fallback.
    expect(snap.game.phase).toBe('post');
    expect(snap.game.away.score).toBe(3);
    expect(snap.game.home.score).toBe(0);
  });
});

// --- P12: no false corrections across a live series (§2 immutable-text pin) -----
//
// Drives the REAL parser AND the REAL RelayEngine, not the parser alone: a live BO5
// (G2 vs T1) is polled once per finished map with games[] states advancing and the
// aggregate gameWins climbing 1:0 → 1:1 → 2:1. The bug this guards: the old text
// embedded the *current* series score in every map's text, so map 1's line re-derived
// with a different score when map 2 finished and the engine (§3.4) emitted a FALSE
// 'correction' claiming "Game 1 — G2 1:1 T1". The new text is a pure function of the
// map's own immutable fact ("Game {number} complete"), so it is byte-identical every
// poll and no correction can ever fire.

/** Minimal getEventDetails payload the fetchPlays parser reads. */
function eventDetails(opts: {
  awayWins: number; // teams[0] → away (G2)
  homeWins: number; // teams[1] → home (T1)
  games: { number: number; state: string }[];
}): unknown {
  return {
    data: {
      event: {
        match: {
          strategy: { count: 5 },
          teams: [
            { id: '98767991926151025', code: 'G2', name: 'G2 Esports', result: { gameWins: opts.awayWins } },
            { id: '98767991853197861', code: 'T1', name: 'T1', result: { gameWins: opts.homeWins } },
          ],
          games: opts.games.map((g) => ({
            number: g.number,
            state: g.state,
            teams: [{ id: '98767991926151025', side: 'blue' }, { id: '98767991853197861', side: 'red' }],
          })),
        },
      },
    },
  };
}

describe('lolesports P12 — live series produces no false corrections', () => {
  it('one line per finished map, zero corrections, stable texts across three polls', async () => {
    // Aggregate gameWins climbs while earlier maps stay 'completed' — exactly the
    // sequence the live MSI smoke test surfaced.
    const polls = [
      eventDetails({ awayWins: 1, homeWins: 0, games: [
        { number: 1, state: 'completed' }, { number: 2, state: 'inProgress' },
      ] }),
      eventDetails({ awayWins: 1, homeWins: 1, games: [
        { number: 1, state: 'completed' }, { number: 2, state: 'completed' }, { number: 3, state: 'inProgress' },
      ] }),
      eventDetails({ awayWins: 2, homeWins: 1, games: [
        { number: 1, state: 'completed' }, { number: 2, state: 'completed' },
        { number: 3, state: 'completed' }, { number: 4, state: 'inProgress' },
      ] }),
    ];

    const engine = createRelayEngine({ backfillLimit: 10, locale: 'en' });
    const emitted: PlayEvent[] = [];
    for (const response of polls) {
      const { ctx } = makeCtx({ response });
      const snap = await lolesportsProvider.fetchPlays(ctx, msiGame('in'));
      emitted.push(...engine.ingest(snap).events);
    }

    // (b) NO correction is ever produced — the crux of the fix.
    expect(emitted.filter((e) => e.kind === 'correction')).toEqual([]);
    // No spurious system lines either (series never reaches 'post').
    expect(emitted.every((e) => e.kind === 'score')).toBe(true);
    // (a) exactly one event per finished map, and (c) the exact stable strings.
    expect(emitted.map((e) => e.text)).toEqual([
      'Game 1 complete',
      'Game 2 complete',
      'Game 3 complete',
    ]);
    expect(emitted.map((e) => e.id)).toEqual([
      'lol:115570934355614581:game1',
      'lol:115570934355614581:game2',
      'lol:115570934355614581:game3',
    ]);
    // Each map appears exactly once — no re-emission of a prior map.
    expect(new Set(emitted.map((e) => e.id)).size).toBe(emitted.length);
  });
});

// --- §11.5: LoL champion-draft "current state" (gated livestats window) ----------
//
// The existing lolesports-eventdetails.json has game 1 'inProgress' with livestats
// id 115570934355614582 — the same id as lolesports-window.json — so it is the
// natural getEventDetails source for these tests.

describe('lolesports fetchPlays — §11.5 champion-draft state', () => {
  it('gameStateEnabled + live match ⇒ EsportsState with patch, 5+5 picks, and a genuine 0-0 gold/kills (Defect 2 regression)', async () => {
    const { ctx, calls } = makeCtx({
      response: loadFixture('lolesports-eventdetails.json'),
      windowResponse: loadFixture('lolesports-window.json'),
      gameStateEnabled: true,
    });
    const snap = await lolesportsProvider.fetchPlays(ctx, msiGame('in'));

    const state = snap.state!;
    expect(state.kind).toBe('esports');
    if (state.kind !== 'esports') throw new Error('narrowing');

    // patch shortened from '16.13.790.6961'.
    expect(state.patch).toBe('16.13');

    // blue = the Game's away team (G2), red = home (T1) — §11.5 convention pin.
    expect(state.blue.teamCode).toBe('G2');
    expect(state.red.teamCode).toBe('T1');

    expect(state.blue.picks).toHaveLength(5);
    expect(state.blue.picks[0]).toEqual({ role: 'top', champion: 'Vayne', player: 'G2 BrokenBlade' });
    expect(state.red.picks).toHaveLength(5);
    expect(state.red.picks[0]).toEqual({ role: 'top', champion: 'Renekton', player: 'T1 Doran' });

    // Defect 2 regression: the fixture's last frame is a genuine 0-0 in the opening
    // seconds. The OLD pairIfLive DROPPED both-zero pairs ("early frames are 0-0"), a
    // guard that only existed to hide Defect 1's kickoff frames and that suppressed real
    // openings. Now that startingTime is sent, a 0-0 is REAL and IS emitted.
    expect(state.gold).toEqual({ blue: 0, red: 0 });
    expect(state.kills).toEqual({ blue: 0, red: 0 });

    // Two requests: getEventDetails then the livestats window (which used NO api-key).
    // The window URL now carries ?startingTime, floored from ctx.now() = 2026-07-08T09:00:00Z
    // (now − 60 s = 08:59:00, already on a 10-second boundary).
    expect(calls).toHaveLength(2);
    const windowCall = calls.find((c) => isWindowUrl(c.url))!;
    expect(windowCall.url).toBe(
      'https://feed.lolesports.com/livestats/v1/window/115570934355614582?startingTime=2026-07-08T08:59:00Z',
    );
    expect(windowCall.headers?.['x-api-key']).toBeUndefined();

    // Events + game unchanged by the additive state fetch.
    expect(snap.events).toEqual([]);
    expect(snap.game.phase).toBe('in');
  });

  it('a window whose last frame has real gold/kills ⇒ gold/kills populated', async () => {
    const win = clone(loadFixture('lolesports-window.json'));
    const last = win.frames[win.frames.length - 1];
    last.blueTeam.totalGold = 30000;
    last.redTeam.totalGold = 28000;
    last.blueTeam.totalKills = 5;
    last.redTeam.totalKills = 3;
    const { ctx } = makeCtx({
      response: loadFixture('lolesports-eventdetails.json'),
      windowResponse: win,
      gameStateEnabled: true,
    });
    const snap = await lolesportsProvider.fetchPlays(ctx, msiGame('in'));

    const state = snap.state!;
    if (state.kind !== 'esports') throw new Error('narrowing');
    expect(state.gold).toEqual({ blue: 30000, red: 28000 });
    expect(state.kills).toEqual({ blue: 5, red: 3 });
  });

  it('last frame with the live BLG-vs-HLE totals (32516/15, 27082/2) ⇒ gold & kills populated (Defect 1)', async () => {
    // The exact frame the orchestrator probed: with ?startingTime the endpoint returns a
    // real score; without it every total was 0 (Defect 1). blue = away (G2), red = home (T1).
    const win = clone(loadFixture('lolesports-window.json'));
    const last = win.frames[win.frames.length - 1];
    last.blueTeam.totalGold = 32516;
    last.blueTeam.totalKills = 15;
    last.redTeam.totalGold = 27082;
    last.redTeam.totalKills = 2;
    const { ctx } = makeCtx({
      response: loadFixture('lolesports-eventdetails.json'),
      windowResponse: win,
      gameStateEnabled: true,
    });
    const snap = await lolesportsProvider.fetchPlays(ctx, msiGame('in'));

    const state = snap.state!;
    if (state.kind !== 'esports') throw new Error('narrowing');
    expect(state.gold).toEqual({ blue: 32516, red: 27082 });
    expect(state.kills).toEqual({ blue: 15, red: 2 });
  });

  it('last frame with a non-finite/missing total ⇒ that pair is undefined, no throw', async () => {
    const win = clone(loadFixture('lolesports-window.json'));
    const last = win.frames[win.frames.length - 1];
    last.blueTeam.totalGold = 30000;
    last.redTeam.totalGold = 'oops'; // non-numeric ⇒ asNum undefined ⇒ pair dropped
    last.blueTeam.totalKills = 5;
    delete last.redTeam.totalKills; // missing ⇒ undefined ⇒ pair dropped
    const { ctx } = makeCtx({
      response: loadFixture('lolesports-eventdetails.json'),
      windowResponse: win,
      gameStateEnabled: true,
    });
    const snap = await lolesportsProvider.fetchPlays(ctx, msiGame('in'));

    const state = snap.state!;
    if (state.kind !== 'esports') throw new Error('narrowing');
    // One finite side is not enough — pairIfFinite requires BOTH sides finite.
    expect(state.gold).toBeUndefined();
    expect(state.kills).toBeUndefined();
    // Draft still parsed fine — only the totals dropped.
    expect(state.blue.picks).toHaveLength(5);
  });

  it('gameStateEnabled false ⇒ window NEVER fetched, state undefined', async () => {
    const { ctx, calls } = makeCtx({
      response: loadFixture('lolesports-eventdetails.json'),
      windowResponse: loadFixture('lolesports-window.json'),
      gameStateEnabled: false,
    });
    const snap = await lolesportsProvider.fetchPlays(ctx, msiGame('in'));

    expect(snap.state).toBeUndefined();
    expect(calls.some((c) => isWindowUrl(c.url))).toBe(false);
    expect(calls).toHaveLength(1); // getEventDetails only — exactly today's shape.
  });

  it('window with no gameMetadata ⇒ state undefined, events + game intact', async () => {
    const { ctx } = makeCtx({
      response: loadFixture('lolesports-eventdetails.json'),
      windowResponse: {},
      gameStateEnabled: true,
    });
    const snap = await lolesportsProvider.fetchPlays(ctx, msiGame('in'));
    expect(snap.state).toBeUndefined();
    expect(snap.events).toEqual([]);
    expect(snap.game.phase).toBe('in');
    expect(snap.game.statusShort).toBe('G1');
  });

  it('window returns {} verbatim ⇒ state undefined (no gameMetadata)', async () => {
    const { ctx } = makeCtx({
      response: loadFixture('lolesports-eventdetails.json'),
      windowResponse: undefined,
      gameStateEnabled: true,
    });
    const snap = await lolesportsProvider.fetchPlays(ctx, msiGame('in'));
    expect(snap.state).toBeUndefined();
  });

  it('window throws ProviderError(not-found) ⇒ state undefined, fetchPlays does NOT throw', async () => {
    const { ctx } = makeCtx({
      response: loadFixture('lolesports-eventdetails.json'),
      windowThrow: new ProviderError('not-found', 'window 404'),
      gameStateEnabled: true,
    });
    const snap = await lolesportsProvider.fetchPlays(ctx, msiGame('in'));
    expect(snap.state).toBeUndefined();
    expect(snap.events).toEqual([]);
    expect(snap.game.phase).toBe('in');
  });

  it('phase not in (all games completed ⇒ post) ⇒ window not fetched, state undefined', async () => {
    const { ctx, calls } = makeCtx({
      response: loadFixture('lolesports-eventdetails-sweep.json'),
      windowResponse: loadFixture('lolesports-window.json'),
      gameStateEnabled: true,
    });
    const snap = await lolesportsProvider.fetchPlays(ctx, staleInGame());
    expect(snap.game.phase).toBe('post');
    expect(snap.state).toBeUndefined();
    expect(calls.some((c) => isWindowUrl(c.url))).toBe(false);
  });
});

// --- logos (§13) -------------------------------------------------------------

describe('lolesports logos (§13)', () => {
  it('listLeagues attaches static league logos for lck & msi only', async () => {
    const { ctx } = makeCtx();
    const leagues = await lolesportsProvider.listLeagues(ctx);
    const byId = new Map(leagues.map((l) => [l.id, l]));
    expect(byId.get('lck')!.logo).toEqual({ light: 'https://static.lolesports.com/leagues/lck-color-on-black.png' });
    expect(byId.get('msi')!.logo).toEqual({ light: 'https://static.lolesports.com/leagues/1592594634248_MSIDarkBG.png' });
    expect(byId.get('lpl')!.logo).toBeUndefined();
    expect(byId.get('worlds')!.logo).toBeUndefined();
  });

  it('listGames upgrades http:// team images to https://', async () => {
    const { ctx } = makeCtx({ response: loadFixture('lolesports-getlive.json') });
    const games = await lolesportsProvider.listGames(ctx, MSI);
    expect(games[0]!.away.logo).toEqual({ light: 'https://static.lolesports.com/teams/G2-FullonDark.png' });
    expect(games[0]!.home.logo).toEqual({
      light: 'https://static.lolesports.com/teams/1726801573959_539px-T1_2019_full_allmode.png',
    });
  });

  it('fetchPlays carries the http→https team image onto the fresh game', async () => {
    const { ctx } = makeCtx({ response: loadFixture('lolesports-eventdetails.json') });
    const snap = await lolesportsProvider.fetchPlays(ctx, msiGame('in'));
    expect(snap.game.away.logo).toEqual({ light: 'https://static.lolesports.com/teams/G2-FullonDark.png' });
    expect(snap.game.home.logo).toEqual({
      light: 'https://static.lolesports.com/teams/1726801573959_539px-T1_2019_full_allmode.png',
    });
  });

  it('an explicit http:// entry is upgraded; garbage ⇒ omitted, no throw', async () => {
    const fix = loadFixture('lolesports-getlive.json');
    fix.data.schedule.events[0].match.teams[0].image = 'http://static.lolesports.com/teams/x.png';
    const games = await lolesportsProvider.listGames(makeCtx({ response: fix }).ctx, MSI);
    expect(games[0]!.away.logo).toEqual({ light: 'https://static.lolesports.com/teams/x.png' });

    for (const bad of [42, '', 'javascript:alert(1)', 'ftp://x/y.png']) {
      const f = loadFixture('lolesports-getlive.json');
      f.data.schedule.events[0].match.teams[0].image = bad;
      const g = await lolesportsProvider.listGames(makeCtx({ response: f }).ctx, MSI);
      expect(g[0]!.away.logo).toBeUndefined();
    }
  });
});

// --- §12.6: LoL Esports kill feed (detailed only) --------------------------------
//
// The kill-feed i18n keys (lolKill, lolKillAssist, lolDeath, lolObjective, and the
// lolObjective.* enum map) are registered by a sibling task in src/core/i18n.ts and
// are NOT re-defined here (forbidden — src/core/**). The contract pins the key NAMES
// and params but not the ko/en wording, so these tests register representative
// templates through the public registerMessages() API and assert the composed output
// verbatim. This exercises the real t()/tEnum() path and verifies the provider's own
// obligations (which keys, which params, correct diffing) independent of the sibling's
// exact strings and of its landing time.

function registerKillFeedMessages(): void {
  registerMessages('en', {
    lolKill: '{killer} killed {victim}',
    lolKillAssist: '{killer} killed {victim} (assists: {assists})',
    lolDeath: '{victim} died',
    lolObjective: '{team} took {objective}',
    'lolObjective.tower': 'tower',
    'lolObjective.inhibitor': 'inhibitor',
    'lolObjective.baron': 'Baron',
    'lolObjective.chemtech': 'chemtech dragon',
  });
  registerMessages('ko', {
    lolKill: '{killer}이(가) {victim} 처치',
    lolKillAssist: '{killer}이(가) {victim} 처치 (도움: {assists})',
    lolDeath: '{victim} 사망',
    lolObjective: '{team} {objective} 획득',
    'lolObjective.tower': '포탑',
    'lolObjective.inhibitor': '억제기',
    'lolObjective.baron': '바론',
    'lolObjective.chemtech': '화학공학 드래곤',
  });
}

/**
 * A minimal getEventDetails payload with ONE in-progress game (⇒ phase 'in') whose
 * `id` is the livestats game id, and teams whose codes drive blue=away / red=home.
 */
function liveEventDetails(livestatsGameId: string, awayCode: string, homeCode: string): unknown {
  return {
    data: {
      event: {
        match: {
          strategy: { count: 5 },
          teams: [
            { id: `team-${awayCode}`, code: awayCode, name: awayCode, result: { gameWins: 0 } },
            { id: `team-${homeCode}`, code: homeCode, name: homeCode, result: { gameWins: 0 } },
          ],
          games: [
            {
              number: 1,
              state: 'inProgress',
              id: livestatsGameId,
              teams: [{ id: `team-${awayCode}`, side: 'blue' }, { id: `team-${homeCode}`, side: 'red' }],
            },
          ],
        },
      },
    },
  };
}

/** The `startingTime` query value requested on a livestats window URL. */
function startingTimeOf(url: string): string {
  return /[?&]startingTime=([^&]+)/.exec(url)?.[1] ?? '';
}

function windowUrls(calls: { url: string }[]): string[] {
  return calls.filter((c) => isWindowUrl(c.url)).map((c) => startingTimeOf(c.url));
}

const KILL_ID = (e: PlayEvent): boolean => e.id.includes(':k:');
const OBJ_ID = (e: PlayEvent): boolean => e.id.includes(':o:');

beforeAll(registerKillFeedMessages);

describe('lolesports §12.6 kill feed — teamfight fixture', () => {
  beforeEach(__resetKillCursors);

  async function killsFor(locale: 'en' | 'ko'): Promise<{ events: PlayEvent[]; windows: string[] }> {
    __resetKillCursors();
    const { ctx, calls } = makeCtx({
      response: liveEventDetails('115570934355614576', 'BLG', 'HLE'),
      windowResponse: loadFixture('lolesports-window-teamfight.json'),
      gameStateEnabled: true,
      detail: 'detailed',
      locale,
    });
    const snap = await lolesportsProvider.fetchPlays(ctx, msiGame('in'));
    return { events: snap.events, windows: windowUrls(calls) };
  }

  it('detailed + in ⇒ all four kills with killer, victim and assists; en verbatim', async () => {
    const { events, windows } = await killsFor('en');
    // FIRST poll of the game ⇒ exactly one livestats window.
    expect(windows).toHaveLength(1);

    const kills = events.filter(KILL_ID);
    // blue totalKills 9→12 (+3), red 1→2 (+1) over the window ⇒ 4 kills.
    expect(kills).toHaveLength(4);
    expect(kills.every((e) => e.kind === 'score')).toBe(true);
    expect(kills.every((e) => e.scoreAfter === undefined)).toBe(true);
    // provider returns events sorted by sequence ascending (§2).
    const seqs = kills.map((e) => e.sequence);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);

    const texts = kills.map((e) => e.text);
    expect(texts).toContain('JarvanIV(BLG Xun) killed Naafiri (assists: Akali, Shen)');
    expect(texts).toContain('Ziggs(HLE Gumayusi) killed Akali (assists: Rumble, Naafiri, Yone, Rell)');

    // id is a pure function of the frame's own facts (gameId, frame ts, victim id).
    const named = kills.find((e) => e.text.startsWith('JarvanIV'))!;
    expect(named.id).toBe('lol:115570934355614576:k:2026-07-09T08:27:37.481Z:7');
  });

  it('ko locale ⇒ the same two sequences rendered in Korean', async () => {
    const { events } = await killsFor('ko');
    const texts = events.filter(KILL_ID).map((e) => e.text);
    expect(texts).toContain('JarvanIV(BLG Xun)이(가) Naafiri 처치 (도움: Akali, Shen)');
    expect(texts).toContain('Ziggs(HLE Gumayusi)이(가) Akali 처치 (도움: Rumble, Naafiri, Yone, Rell)');
  });
});

describe('lolesports §12.6 kill feed — objectives fixture', () => {
  beforeEach(__resetKillCursors);

  it('a tower (play) and a chemtech dragon (score), attributed to the side whose counter grew', async () => {
    const { ctx } = makeCtx({
      response: liveEventDetails('115570934355614576', 'BLG', 'HLE'),
      windowResponse: loadFixture('lolesports-window-objectives.json'),
      gameStateEnabled: true,
      detail: 'detailed',
    });
    const snap = await lolesportsProvider.fetchPlays(ctx, msiGame('in'));

    // The fixture's per-participant kills/deaths never change ⇒ no kill/death events.
    expect(snap.events.filter(KILL_ID)).toEqual([]);
    const objectives = snap.events.filter(OBJ_ID);
    expect(objectives).toHaveLength(2);

    // blue's towers 0→1 ⇒ blue (= away = BLG) took a tower. tower ⇒ kind 'play'.
    const tower = objectives.find((e) => e.id.endsWith(':blue:tower'))!;
    expect(tower.id).toBe('lol:115570934355614576:o:2026-07-09T08:29:13.519Z:blue:tower');
    expect(tower.kind).toBe('play');
    expect(tower.scoreAfter).toBeUndefined();
    expect(tower.text).toBe('BLG took tower');

    // blue's dragons ["cloud","ocean"] → +"chemtech" ⇒ blue took a chemtech drake. dragon ⇒ 'score'.
    const drake = objectives.find((e) => e.id.endsWith(':blue:chemtech'))!;
    expect(drake.id).toBe('lol:115570934355614576:o:2026-07-09T08:29:41.567Z:blue:chemtech');
    expect(drake.kind).toBe('score');
    expect(drake.text).toBe('BLG took chemtech dragon');
  });
});

describe('lolesports §12.6 kill feed — death with no killer', () => {
  beforeEach(__resetKillCursors);

  /** Two frames: participant 7 (Naafiri) deaths 0→1 with NO participant's kills advancing. */
  function deathWindow(): unknown {
    const part = (participantId: number, deaths: number) => ({ participantId, kills: 0, deaths, assists: 0 });
    const frame = (ts: string, deaths: number) => ({
      rfc460Timestamp: ts,
      blueTeam: { towers: 0, inhibitors: 0, barons: 0, dragons: [], participants: [part(1, 0)] },
      redTeam: { towers: 0, inhibitors: 0, barons: 0, dragons: [], participants: [part(7, deaths)] },
    });
    return {
      gameMetadata: {
        blueTeamMetadata: { participantMetadata: [{ participantId: 1, championId: 'Gnar', summonerName: 'BLG Bin', role: 'top' }] },
        redTeamMetadata: { participantMetadata: [{ participantId: 7, championId: 'Naafiri', summonerName: 'HLE Kanavi', role: 'jungle' }] },
      },
      frames: [frame('2026-07-08T09:00:00.000Z', 0), frame('2026-07-08T09:00:10.000Z', 1)],
    };
  }

  it('a death with no kill increment ⇒ lolDeath (play), and no killer is fabricated', async () => {
    const { ctx } = makeCtx({
      response: liveEventDetails('G-DEATH', 'BLG', 'HLE'),
      windowResponse: deathWindow(),
      gameStateEnabled: true,
      detail: 'detailed',
    });
    const snap = await lolesportsProvider.fetchPlays(ctx, msiGame('in'));

    const kills = snap.events.filter(KILL_ID);
    expect(kills).toHaveLength(1);
    const death = kills[0]!;
    expect(death.kind).toBe('play');
    expect(death.text).toBe('Naafiri died'); // champion only, no invented killer
    expect(death.id).toBe('lol:G-DEATH:k:2026-07-08T09:00:10.000Z:7');
  });
});

describe('lolesports §12.6 kill feed — gates and request counts', () => {
  beforeEach(__resetKillCursors);

  it("detail 'summary' ⇒ zero kill events; the window is fetched exactly once (for the draft)", async () => {
    const { ctx, calls } = makeCtx({
      response: loadFixture('lolesports-eventdetails.json'),
      windowResponse: loadFixture('lolesports-window.json'),
      gameStateEnabled: true,
      detail: 'summary',
    });
    const snap = await lolesportsProvider.fetchPlays(ctx, msiGame('in'));

    expect(snap.events.filter((e) => KILL_ID(e) || OBJ_ID(e))).toEqual([]);
    expect(calls.filter((c) => isWindowUrl(c.url))).toHaveLength(1); // draft window only
    expect(calls).toHaveLength(2); // getEventDetails + 1 window
    expect(snap.state?.kind).toBe('esports'); // draft still produced in summary mode
  });

  it('gameStateEnabled false ⇒ the livestats host is never contacted at all', async () => {
    const { ctx, calls } = makeCtx({
      response: loadFixture('lolesports-eventdetails.json'),
      windowResponse: loadFixture('lolesports-window-teamfight.json'),
      gameStateEnabled: false,
      detail: 'detailed',
    });
    const snap = await lolesportsProvider.fetchPlays(ctx, msiGame('in'));

    expect(calls.some((c) => isWindowUrl(c.url))).toBe(false);
    expect(calls).toHaveLength(1); // getEventDetails only
    expect(snap.events.filter(KILL_ID)).toEqual([]);
    expect(snap.state).toBeUndefined();
  });
});

describe('lolesports §12.6 kill feed — idempotence', () => {
  beforeEach(__resetKillCursors);

  it('re-reading the same window yields identical event ids', async () => {
    const run = async (): Promise<string[]> => {
      __resetKillCursors();
      const { ctx } = makeCtx({
        response: liveEventDetails('115570934355614576', 'BLG', 'HLE'),
        windowResponse: loadFixture('lolesports-window-teamfight.json'),
        gameStateEnabled: true,
        detail: 'detailed',
      });
      const snap = await lolesportsProvider.fetchPlays(ctx, msiGame('in'));
      return snap.events.filter(KILL_ID).map((e) => e.id);
    };
    const first = await run();
    const second = await run();
    expect(second).toEqual(first);
    expect(new Set(first).size).toBe(first.length); // all ids distinct
  });
});

describe('lolesports §12.6 kill feed — cursor catch-up', () => {
  beforeEach(__resetKillCursors);

  /** A two-frame window with no stat changes (no events); its last frame ts becomes the cursor. */
  function cursorWindow(lastTs: string): unknown {
    const frame = (ts: string) => ({ rfc460Timestamp: ts, blueTeam: { participants: [] }, redTeam: { participants: [] } });
    return { frames: [frame('2026-07-08T08:59:00.000Z'), frame(lastTs)] };
  }

  it('first poll ⇒ 1 window (now−60s); +40s ⇒ 4 windows; +10min ⇒ 6 (the cap)', async () => {
    __resetKillCursors();
    const ev = liveEventDetails('LGID', 'BLG', 'HLE');
    const win = cursorWindow('2026-07-08T09:00:05.000Z'); // cursor lands at :00:05

    // Poll 1 — no cursor ⇒ exactly one window at floor(now−60s) = 08:59:00.
    const p1 = makeCtx({
      response: ev,
      windowResponse: win,
      gameStateEnabled: true,
      detail: 'detailed',
      now: Date.parse('2026-07-08T09:00:00.000Z'),
    });
    await lolesportsProvider.fetchPlays(p1.ctx, msiGame('in'));
    expect(windowUrls(p1.calls)).toEqual(['2026-07-08T08:59:00Z']);

    // Poll 2 — 40s later. ceil((09:00:40 − 09:00:05)/10) = ceil(3.5) = 4 windows from base 09:00:00.
    const p2 = makeCtx({
      response: ev,
      windowResponse: win,
      gameStateEnabled: true,
      detail: 'detailed',
      now: Date.parse('2026-07-08T09:00:40.000Z'),
    });
    await lolesportsProvider.fetchPlays(p2.ctx, msiGame('in'));
    expect(windowUrls(p2.calls)).toEqual([
      '2026-07-08T09:00:00Z',
      '2026-07-08T09:00:10Z',
      '2026-07-08T09:00:20Z',
      '2026-07-08T09:00:30Z',
    ]);

    // Poll 3 — 10 min after poll 1. ceil((595)/10) = 60 ⇒ clamped to the 6-window cap.
    const p3 = makeCtx({
      response: ev,
      windowResponse: win,
      gameStateEnabled: true,
      detail: 'detailed',
      now: Date.parse('2026-07-08T09:10:00.000Z'),
    });
    await lolesportsProvider.fetchPlays(p3.ctx, msiGame('in'));
    expect(windowUrls(p3.calls)).toEqual([
      '2026-07-08T09:00:00Z',
      '2026-07-08T09:00:10Z',
      '2026-07-08T09:00:20Z',
      '2026-07-08T09:00:30Z',
      '2026-07-08T09:00:40Z',
      '2026-07-08T09:00:50Z',
    ]);
  });

  it('the cursor is dropped when the game leaves in ⇒ next live poll is a first poll again', async () => {
    __resetKillCursors();
    const win = cursorWindow('2026-07-08T09:00:05.000Z');

    // A live poll establishes the cursor for livestats game LGID.
    const live = makeCtx({
      response: liveEventDetails('LGID', 'BLG', 'HLE'),
      windowResponse: win,
      gameStateEnabled: true,
      detail: 'detailed',
      now: Date.parse('2026-07-08T09:00:00.000Z'),
    });
    await lolesportsProvider.fetchPlays(live.ctx, msiGame('in'));

    // The match is now completed (all games terminal) ⇒ phase post ⇒ cursor for LGID dropped.
    const done = clone(loadFixture('lolesports-eventdetails-sweep.json'));
    // point the sweep's games at LGID so pickLivestatsGameId returns it and the drop targets our cursor.
    for (const g of done.data.event.match.games) g.id = 'LGID';
    const post = makeCtx({ response: done, windowResponse: win, gameStateEnabled: true, detail: 'detailed' });
    const postSnap = await lolesportsProvider.fetchPlays(post.ctx, staleInGame());
    expect(postSnap.game.phase).toBe('post');
    expect(post.calls.some((c) => isWindowUrl(c.url))).toBe(false); // not 'in' ⇒ no windows

    // A fresh live poll for LGID now behaves as a first poll: exactly one window.
    const again = makeCtx({
      response: liveEventDetails('LGID', 'BLG', 'HLE'),
      windowResponse: win,
      gameStateEnabled: true,
      detail: 'detailed',
      now: Date.parse('2026-07-08T09:05:00.000Z'),
    });
    await lolesportsProvider.fetchPlays(again.ctx, msiGame('in'));
    expect(windowUrls(again.calls)).toEqual(['2026-07-08T09:04:00Z']);
  });
});

describe('lolesports §12.6 kill feed — failure paths never fail fetchPlays', () => {
  beforeEach(__resetKillCursors);

  /** eventDetails with map 1 completed (a surviving map-result) and map 2 in progress (phase 'in'). */
  function mixedEventDetails(): any {
    const ev = clone(loadFixture('lolesports-eventdetails.json'));
    ev.data.event.match.games[0].state = 'completed';
    ev.data.event.match.games[1].state = 'inProgress';
    return ev;
  }

  it.each([
    ['parse (the real 204 — empty body)', new ProviderError('parse', 'empty body')],
    ['unavailable (the real 400 — bad/future startingTime)', new ProviderError('unavailable', 'bad startingTime')],
  ])('window throwing %s ⇒ no throw; zero kills; map-result + game intact; cursor unchanged', async (_label, err) => {
    const first = makeCtx({
      response: mixedEventDetails(),
      windowThrow: err,
      gameStateEnabled: true,
      detail: 'detailed',
    });
    const snap = await lolesportsProvider.fetchPlays(first.ctx, msiGame('in'));

    // No kill events, but the completed map's map-result line survives, and phase is fresh.
    expect(snap.events.filter(KILL_ID)).toEqual([]);
    expect(snap.events.some((e) => e.id === 'lol:115570934355614581:game1')).toBe(true);
    expect(snap.game.phase).toBe('in');
    expect(snap.state).toBeUndefined();

    // Cursor left UNCHANGED: a following successful poll is still a first poll (1 window).
    const second = makeCtx({
      response: mixedEventDetails(),
      windowResponse: loadFixture('lolesports-window.json'),
      gameStateEnabled: true,
      detail: 'detailed',
    });
    await lolesportsProvider.fetchPlays(second.ctx, msiGame('in'));
    expect(second.calls.filter((c) => isWindowUrl(c.url))).toHaveLength(1);
  });
});
