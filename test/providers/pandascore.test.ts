import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pandascoreProvider } from '../../src/providers/pandascore';
import { createRelayEngine } from '../../src/core/relay';
import type { Game, League, PlayEvent, ProviderContext } from '../../src/core/contract';
import { ProviderError } from '../../src/core/contract';

function loadFixture(name: string): any {
  return JSON.parse(readFileSync(join(process.cwd(), 'test/fixtures', name), 'utf8'));
}

interface CtxOpts {
  response?: unknown;
  throwErr?: unknown;
  secret?: string;
}

function makeCtx(opts: CtxOpts = {}) {
  const calls: { url: string; headers?: Record<string, string> }[] = [];
  const ctx: ProviderContext = {
    locale: 'en',
    now: () => Date.parse('2026-07-08T09:00:00Z'),
    log: () => {},
    getSecret: async () => opts.secret,
    fetchJson: async (url, headers) => {
      calls.push({ url, headers });
      if (opts.throwErr) throw opts.throwErr;
      return opts.response;
    },
  };
  return { ctx, calls };
}

const LOL: League = { id: 'lol', providerId: 'pandascore', name: 'League of Legends', sport: 'esports' };

function lolGame(): Game {
  return {
    id: 'pandascore:lol:1001',
    providerId: 'pandascore',
    leagueId: 'lol',
    leagueName: 'League of Legends',
    sport: 'esports',
    startTimeUtc: '2026-07-08T10:00:00Z',
    phase: 'in',
    statusText: 'GEN 0–1 T1',
    statusShort: 'G2',
    home: { id: '11', name: 'T1', abbrev: 'T1', score: 1 },
    away: { id: '22', name: 'Gen.G', abbrev: 'GEN', score: 0 },
  };
}

describe('pandascore requiresSecret', () => {
  it('is the pandascore.token secret key', () => {
    expect(pandascoreProvider.requiresSecret).toBe('pandascore.token');
  });
});

describe('pandascore listGames', () => {
  it('parses matches with opponents[0]→home, opponents[1]→away, Bearer auth', async () => {
    const { ctx, calls } = makeCtx({
      response: loadFixture('pandascore-matches.json').matches,
      secret: 'tok',
    });
    const games = await pandascoreProvider.listGames(ctx, LOL);

    expect(games).toHaveLength(2);
    const running = games[0]!;
    expect(running.id).toBe('pandascore:lol:1001');
    expect(running.phase).toBe('in');
    expect(running.home.abbrev).toBe('T1'); // opponents[0]
    expect(running.home.score).toBe(1);
    expect(running.away.abbrev).toBe('GEN'); // opponents[1]
    expect(running.away.score).toBe(0);
    expect(running.statusShort).toBe('G2'); // games count
    expect(running.statusText).toBe('GEN 0–1 T1');
    expect(running.startTimeUtc).toBe('2026-07-08T10:00:00Z');

    const pre = games[1]!;
    expect(pre.phase).toBe('pre');
    expect(pre.statusShort).toBe('vs');

    expect(calls[0]!.headers?.authorization).toBe('Bearer tok');
  });

  it('empty opponents ⇒ TBD sides, undefined scores', async () => {
    const fix = loadFixture('pandascore-matches.json');
    fix.matches[0].opponents = [];
    const { ctx } = makeCtx({ response: fix.matches, secret: 'tok' });
    const games = await pandascoreProvider.listGames(ctx, LOL);
    expect(games[0]!.home.abbrev).toBe('TBD');
    expect(games[0]!.away.abbrev).toBe('TBD');
    expect(games[0]!.home.score).toBeUndefined();
    expect(games[0]!.away.score).toBeUndefined();
  });

  it('absurd score string ⇒ score undefined (no NaN)', async () => {
    const fix = loadFixture('pandascore-matches.json');
    fix.matches[0].results[0].score = '1e9';
    const { ctx } = makeCtx({ response: fix.matches, secret: 'tok' });
    const games = await pandascoreProvider.listGames(ctx, LOL);
    expect(games[0]!.home.score).toBeUndefined();
  });

  it('response not an array ⇒ ProviderError(parse)', async () => {
    const { ctx } = makeCtx({ response: {}, secret: 'tok' });
    await expect(pandascoreProvider.listGames(ctx, LOL)).rejects.toMatchObject({ kind: 'parse' });
  });
});

describe('pandascore fetchPlays', () => {
  it('synthesizes map-result events, sorted ascending by position, with winners', async () => {
    const { ctx } = makeCtx({
      response: loadFixture('pandascore-match.json').match,
      secret: 'tok',
    });
    const snap = await pandascoreProvider.fetchPlays(ctx, lolGame());

    expect(snap.events.map((e) => e.sequence)).toEqual([1, 2, 3]);
    const m1 = snap.events[0]!;
    expect(m1.id).toBe('ps:1001:map1');
    expect(m1.kind).toBe('score');
    // §2.4 immutable-text pin: winner is the map's immutable fact; the running match score is
    // mutable and MUST NOT appear in the text (it would re-derive and fire a false correction).
    expect(m1.text).toBe('Map 1: T1');
    expect(m1.scoreAfter).toBeUndefined();
    expect(snap.events[1]!.text).toBe('Map 2: Gen.G');
    // Refreshed game.
    expect(snap.game.home.score).toBe(2);
    expect(snap.game.away.score).toBe(1);
    expect(snap.game.statusShort).toBe('G3');
  });

  it('unresolvable winner ⇒ "Map {position} finished"', async () => {
    const fix = loadFixture('pandascore-match.json');
    fix.match.games[1].winner.id = null; // position 1 entry (out of order in fixture)
    const { ctx } = makeCtx({ response: fix.match, secret: 'tok' });
    const snap = await pandascoreProvider.fetchPlays(ctx, lolGame());
    expect(snap.events[0]!.text).toBe('Map 1 finished');
  });

  it('response not an object ⇒ ProviderError(parse)', async () => {
    const { ctx } = makeCtx({ response: [], secret: 'tok' });
    await expect(pandascoreProvider.fetchPlays(ctx, lolGame())).rejects.toMatchObject({
      kind: 'parse',
    });
  });
});

// --- P12: no false corrections across a live series (§2 immutable-text pin) -----
//
// Drives the REAL parser AND the REAL RelayEngine. A live series (T1 vs Gen.G) is
// polled once per finished map; results[] (the running match score) advances 1:0 →
// 1:1 → 2:1 while each map's immutable winner is fixed. The bug this guards: the old
// text embedded that mutable match score, so map 1's line re-derived from "(GEN 0–1 T1)"
// to "(GEN 1–1 T1)" when map 2 finished and the engine (§3.4) emitted a FALSE
// 'correction'. The new text names only the map's immutable winner ("Map {position}:
// {winner}"), so it is byte-identical every poll and no correction can fire.

/** Minimal /matches/{id} payload the fetchPlays parser reads. opponents[0]→home (T1). */
function matchPayload(opts: {
  homeScore: number; // T1 (id 11)
  awayScore: number; // Gen.G (id 22)
  games: { position: number; finished: boolean; winnerId: number | null }[];
}): unknown {
  return {
    id: 1001,
    status: 'running',
    begin_at: '2026-07-08T10:00:00Z',
    opponents: [
      { opponent: { id: 11, name: 'T1', acronym: 'T1' } },
      { opponent: { id: 22, name: 'Gen.G', acronym: 'GEN' } },
    ],
    results: [
      { team_id: 11, score: opts.homeScore },
      { team_id: 22, score: opts.awayScore },
    ],
    games: opts.games.map((g) => ({
      position: g.position,
      finished: g.finished,
      winner: { id: g.winnerId },
    })),
  };
}

describe('pandascore P12 — live series produces no false corrections', () => {
  it('one line per finished map, zero corrections, stable texts across three polls', async () => {
    const polls = [
      matchPayload({ homeScore: 1, awayScore: 0, games: [
        { position: 1, finished: true, winnerId: 11 }, // T1
        { position: 2, finished: false, winnerId: null },
      ] }),
      matchPayload({ homeScore: 1, awayScore: 1, games: [
        { position: 1, finished: true, winnerId: 11 }, // T1
        { position: 2, finished: true, winnerId: 22 }, // Gen.G
        { position: 3, finished: false, winnerId: null },
      ] }),
      matchPayload({ homeScore: 2, awayScore: 1, games: [
        { position: 1, finished: true, winnerId: 11 }, // T1
        { position: 2, finished: true, winnerId: 22 }, // Gen.G
        { position: 3, finished: true, winnerId: 11 }, // T1
        { position: 4, finished: false, winnerId: null },
      ] }),
    ];

    const engine = createRelayEngine({ backfillLimit: 10, locale: 'en' });
    const emitted: PlayEvent[] = [];
    for (const response of polls) {
      const { ctx } = makeCtx({ response, secret: 'tok' });
      const snap = await pandascoreProvider.fetchPlays(ctx, lolGame());
      emitted.push(...engine.ingest(snap).events);
    }

    // (b) NO correction is ever produced — the crux of the fix.
    expect(emitted.filter((e) => e.kind === 'correction')).toEqual([]);
    // No spurious system lines either (match status stays 'running').
    expect(emitted.every((e) => e.kind === 'score')).toBe(true);
    // (a) exactly one event per finished map, and (c) the exact stable strings.
    expect(emitted.map((e) => e.text)).toEqual([
      'Map 1: T1',
      'Map 2: Gen.G',
      'Map 3: T1',
    ]);
    expect(emitted.map((e) => e.id)).toEqual([
      'ps:1001:map1',
      'ps:1001:map2',
      'ps:1001:map3',
    ]);
    // Each map appears exactly once — no re-emission of a prior map.
    expect(new Set(emitted.map((e) => e.id)).size).toBe(emitted.length);
  });
});

describe('pandascore hidden-secret behavior', () => {
  it('listGames throws ProviderError(auth) when the token is unset', async () => {
    const { ctx } = makeCtx({ secret: undefined });
    await expect(pandascoreProvider.listGames(ctx, LOL)).rejects.toMatchObject({ kind: 'auth' });
  });

  it('fetchPlays throws ProviderError(auth) when the token is unset', async () => {
    const { ctx } = makeCtx({ secret: undefined });
    await expect(pandascoreProvider.fetchPlays(ctx, lolGame())).rejects.toMatchObject({
      kind: 'auth',
    });
  });
});

// --- logos (§13) -------------------------------------------------------------

describe('pandascore logos (§13)', () => {
  it('populates opponent image_url when present, omits when absent (listGames)', async () => {
    const { ctx } = makeCtx({ response: loadFixture('pandascore-matches.json').matches, secret: 'tok' });
    const games = await pandascoreProvider.listGames(ctx, LOL);
    // match 1: opponents[0] (home, T1) has image_url; opponents[1] (away) does not.
    expect(games[0]!.home.logo).toEqual({ light: 'https://cdn.pandascore.co/images/team/image/11/t1.png' });
    expect(games[0]!.away.logo).toBeUndefined();
    // match 2: no image_url on either opponent.
    expect(games[1]!.home.logo).toBeUndefined();
    expect(games[1]!.away.logo).toBeUndefined();
  });

  it('carries the opponent logo onto the fresh game (fetchPlays)', async () => {
    const { ctx } = makeCtx({ response: loadFixture('pandascore-match.json').match, secret: 'tok' });
    const snap = await pandascoreProvider.fetchPlays(ctx, lolGame());
    expect(snap.game.home.logo).toEqual({ light: 'https://cdn.pandascore.co/images/team/image/11/t1.png' });
    expect(snap.game.away.logo).toBeUndefined();
  });

  it('garbage image_url (number, empty, javascript:, ftp:) ⇒ omitted, no throw', async () => {
    for (const bad of [42, '', 'javascript:alert(1)', 'ftp://x/y.png']) {
      const fix = loadFixture('pandascore-matches.json');
      fix.matches[0].opponents[0].opponent.image_url = bad;
      const { ctx } = makeCtx({ response: fix.matches, secret: 'tok' });
      const games = await pandascoreProvider.listGames(ctx, LOL);
      expect(games[0]!.home.logo).toBeUndefined();
    }
  });
});
