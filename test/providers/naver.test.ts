import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { naverProvider } from '../../src/providers/naver';
import type { Game, League, PlayEvent, ProviderContext } from '../../src/core/contract';
import { ProviderError } from '../../src/core/contract';

function loadFixture(name: string): any {
  return JSON.parse(readFileSync(join(process.cwd(), 'test/fixtures', name), 'utf8'));
}

const kboDetail = () => loadFixture('naver-kbo-game-detail.json');
const kboRelay = () => loadFixture('naver-kbo-relay.json');
const kleagueDetail = () => loadFixture('naver-kleague-game-detail.json');
const kleagueRelay = () => loadFixture('naver-kleague-relay.json');

const DETAIL_URL = /\/schedule\/games\/[^/?]+$/;

interface CtxOpts {
  /** Fallback payload for any URL without a dedicated route (listGames uses this). */
  response?: unknown;
  /** Payload for `/schedule/games/{gameId}` (fetchPlays' authoritative status request). */
  detail?: unknown;
  /** Payload for `/schedule/games/{gameId}/relay` (fetchPlays' event request). */
  relay?: unknown;
  detailThrow?: unknown;
  relayThrow?: unknown;
  /** Throw on EVERY request. */
  throwErr?: unknown;
  now?: number;
  locale?: 'en' | 'ko';
}

/**
 * fetchPlays now issues TWO requests (CONTRACT §2.5 fresh-game pin), so the mock dispatches
 * on the URL rather than answering everything with one fixed payload.
 */
function makeCtx(opts: CtxOpts = {}) {
  const calls: { url: string; headers?: Record<string, string> }[] = [];
  const logs: string[] = [];
  const ctx: ProviderContext = {
    locale: opts.locale ?? 'en',
    now: () => opts.now ?? Date.parse('2026-07-08T09:00:00Z'),
    log: (m) => logs.push(m),
    getSecret: async () => undefined,
    fetchJson: async (url, headers) => {
      calls.push({ url, headers });
      if (opts.throwErr) throw opts.throwErr;
      if (url.endsWith('/relay')) {
        if (opts.relayThrow) throw opts.relayThrow;
        if ('relay' in opts) return opts.relay;
      } else if (DETAIL_URL.test(url)) {
        if (opts.detailThrow) throw opts.detailThrow;
        if ('detail' in opts) return opts.detail;
      }
      return opts.response;
    },
  };
  return { ctx, calls, logs };
}

const KBO_LEAGUE: League = { id: 'kbo', providerId: 'naver', name: 'KBO리그', sport: 'baseball' };
const KLEAGUE: League = { id: 'kleague', providerId: 'naver', name: 'K리그1', sport: 'soccer' };

function kboGame(): Game {
  return {
    id: 'naver:kbo:20260707HTLT02026',
    providerId: 'naver',
    leagueId: 'kbo',
    leagueName: 'KBO리그',
    sport: 'baseball',
    startTimeUtc: undefined,
    phase: 'in',
    statusText: '9회초',
    statusShort: 'T9',
    home: { id: 'LT', name: '롯데', abbrev: 'LT', score: 0 },
    away: { id: 'HT', name: 'KIA', abbrev: 'HT', score: 0 },
  };
}

function kleagueGame(): Game {
  return {
    id: 'naver:kleague:20260704052191',
    providerId: 'naver',
    leagueId: 'kleague',
    leagueName: 'K리그1',
    sport: 'soccer',
    startTimeUtc: undefined,
    phase: 'in',
    statusText: '후반',
    statusShort: 'H2',
    home: { id: '05', name: '전북', abbrev: '05', score: 0 },
    away: { id: '21', name: '강원', abbrev: '21', score: 0 },
  };
}

function findBySeq(events: PlayEvent[], seq: number): PlayEvent | undefined {
  return events.find((e) => e.sequence === seq);
}

describe('naver listGames (KBO schedule)', () => {
  it('parses games with KST→UTC conversion, post phase, teams, and Mozilla UA', async () => {
    const { ctx, calls } = makeCtx({ response: loadFixture('naver-kbo-schedule.json') });
    const games = await naverProvider.listGames(ctx, KBO_LEAGUE);

    expect(games).toHaveLength(3);
    const g = games[0]!;
    expect(g.id).toBe('naver:kbo:20260707HTLT02026');
    expect(g.phase).toBe('post');
    expect(g.statusText).toBe('9회초');
    expect(g.statusShort).toBe('F'); // post ⇒ 'F'
    expect(g.home.abbrev).toBe('LT');
    expect(g.home.name).toBe('롯데');
    expect(g.home.score).toBe(10);
    expect(g.away.score).toBe(2);
    // 18:30 KST (+09:00) ⇒ 09:30 UTC.
    expect(g.startTimeUtc).toBe('2026-07-07T09:30:00Z');
    expect(calls[0]!.headers?.['user-agent']).toBe('Mozilla/5.0');
  });

  it('KST parsing: 2026-07-08T18:30:00 ⇒ 2026-07-08T09:30:00Z', async () => {
    const fix = loadFixture('naver-kbo-schedule.json');
    fix.result.games[0].gameDateTime = '2026-07-08T18:30:00';
    const { ctx } = makeCtx({ response: fix });
    const games = await naverProvider.listGames(ctx, KBO_LEAGUE);
    expect(games[0]!.startTimeUtc).toBe('2026-07-08T09:30:00Z');
  });

  it('unseen statusCode ⇒ phase unknown', async () => {
    const fix = loadFixture('naver-kbo-schedule.json');
    fix.result.games[0].statusCode = 'WEIRD_NEW_VALUE';
    const { ctx } = makeCtx({ response: fix });
    const games = await naverProvider.listGames(ctx, KBO_LEAGUE);
    expect(games[0]!.phase).toBe('unknown');
  });

  it('missing result.games ⇒ ProviderError(parse)', async () => {
    const { ctx } = makeCtx({ response: {} });
    await expect(naverProvider.listGames(ctx, KBO_LEAGUE)).rejects.toMatchObject({
      kind: 'parse',
    });
  });
});

describe('naver fetchPlays (KBO relay)', () => {
  it('flattens options, drops separators, sorts ascending, derives period', async () => {
    const { ctx } = makeCtx({ detail: kboDetail(), relay: kboRelay() });
    const snap = await naverProvider.fetchPlays(ctx, kboGame());

    // 24 non-separator options (seqno 547/548 are type 99 → dropped).
    expect(snap.events).toHaveLength(24);
    // Sorted ascending by seqno.
    const seqs = snap.events.map((e) => e.sequence);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(seqs[0]).toBe(523);
    expect(seqs[seqs.length - 1]).toBe(546);
    // No separator survived.
    expect(snap.events.some((e) => /^=+$/.test(e.text))).toBe(false);
    expect(findBySeq(snap.events, 547)).toBeUndefined();
    expect(findBySeq(snap.events, 548)).toBeUndefined();
    // period from inn 9 + homeOrAway '0' (away batting = top) ⇒ 'T9'.
    expect(snap.events[0]!.period).toBe('T9');
    expect(snap.events[0]!.id).toBe('naver:20260707HTLT02026:523');
    expect(snap.events[0]!.gameId).toBe('naver:kbo:20260707HTLT02026');
    // All 'play' — no score change in the fixture.
    expect(snap.events.every((e) => e.kind === 'play')).toBe(true);
    // Game score refreshed from the authoritative game-detail response.
    expect(snap.game.home.score).toBe(10);
    expect(snap.game.away.score).toBe(2);
  });

  it("marks kind 'score' when scoreAfter changes vs the previous seqno", async () => {
    const fix = kboRelay();
    // Bump the last non-separator option (seqno 546) home score.
    for (const r of fix.result.textRelayData.textRelays) {
      for (const o of r.textOptions) {
        if (o.seqno === 546) o.currentGameState.homeScore = '11';
      }
    }
    const { ctx } = makeCtx({ detail: kboDetail(), relay: fix });
    const snap = await naverProvider.fetchPlays(ctx, kboGame());
    expect(findBySeq(snap.events, 546)!.kind).toBe('score');
    expect(findBySeq(snap.events, 545)!.kind).toBe('play');
  });

  it('missing textRelays ⇒ empty window, no throw', async () => {
    const fix = kboRelay();
    delete fix.result.textRelayData.textRelays;
    const { ctx } = makeCtx({ detail: kboDetail(), relay: fix });
    const snap = await naverProvider.fetchPlays(ctx, kboGame());
    expect(snap.events).toEqual([]);
  });

  it('null seqno ⇒ that option skipped, others survive', async () => {
    const fix = kboRelay();
    for (const r of fix.result.textRelayData.textRelays) {
      for (const o of r.textOptions) {
        if (o.seqno === 523) o.seqno = null;
      }
    }
    const { ctx } = makeCtx({ detail: kboDetail(), relay: fix });
    const snap = await naverProvider.fetchPlays(ctx, kboGame());
    expect(findBySeq(snap.events, 523)).toBeUndefined();
    expect(snap.events).toHaveLength(23);
  });

  it('missing textRelayData ⇒ empty snapshot carrying the FRESH game (pre-game, §2.5)', async () => {
    // A follow placed before first pitch: no relay window yet, but the detail request
    // still supplies the real phase — this is what lets pre → in → post advance at all.
    const detail = kboDetail();
    detail.result.game.statusCode = 'BEFORE';
    detail.result.game.statusInfo = '경기전';
    const { ctx } = makeCtx({ detail, relay: { result: {} } });

    const snap = await naverProvider.fetchPlays(ctx, kboGame());
    expect(snap.events).toEqual([]);
    expect(snap.game.phase).toBe('pre');
    expect(snap.game.statusShort).toBe('18:30'); // KST wall clock from gameDateTime
    expect(snap.game.startTimeUtc).toBe('2026-07-07T09:30:00Z');
  });
});

describe('naver fetchPlays (K League relay)', () => {
  it('re-sorts newest-first fixture ascending; period H2; refreshes game', async () => {
    const { ctx } = makeCtx({ detail: kleagueDetail(), relay: kleagueRelay() });
    const snap = await naverProvider.fetchPlays(ctx, kleagueGame());

    const seqs = snap.events.map((e) => e.sequence);
    expect(seqs).toEqual([55, 56, 57, 58, 59, 60, 61, 62]);
    expect(snap.events[0]!.period).toBe('H2');
    expect(snap.events[0]!.id).toBe('naver:20260704052191:55');
    // clock = `{time}'`, apostrophe appended only when absent (CONTRACT §2.5):
    // '+7' ⇒ "+7'", "89'" stays "89'".
    expect(findBySeq(snap.events, 62)!.clock).toBe("+7'");
    expect(findBySeq(snap.events, 57)!.clock).toBe("89'");
    // No GOAL events ⇒ all 'play'.
    expect(snap.events.every((e) => e.kind === 'play')).toBe(true);
    // Game refreshed from the game-detail response — NOT from the relay's own top-level
    // fields (whose statusInfo is the shorter '종료' and whose statusCode is the numeric 4).
    expect(snap.game.home.score).toBe(1);
    expect(snap.game.away.score).toBe(2);
    expect(snap.game.statusText).toBe('경기종료');
  });

  it("eventType GOAL ⇒ kind 'score'", async () => {
    const fix = kleagueRelay();
    fix.result.textRelayData.textRelays[0].eventType = 'GOAL'; // no 62
    const { ctx } = makeCtx({ detail: kleagueDetail(), relay: fix });
    const snap = await naverProvider.fetchPlays(ctx, kleagueGame());
    expect(findBySeq(snap.events, 62)!.kind).toBe('score');
  });
});

/**
 * P9 (CONTRACT §8): a terminal payload MUST yield `game.phase === 'post'`.
 * Regression for breaker finding B1 — phase was frozen at follow time, so the poller's stop
 * condition, the §3.8 final line, and the post+10-min auto-unfollow never fired.
 */
describe('naver fetchPlays — P9 fresh game (§2 pin, §2.5)', () => {
  it('KBO: stale in-progress input + terminal detail ⇒ phase post, scores refreshed', async () => {
    // Exactly the reproduced defect: `phase=in score=5-3 FROZEN`.
    const stale = kboGame();
    stale.phase = 'in';
    stale.statusText = '8회말';
    stale.statusShort = 'B8';
    stale.home.score = 5;
    stale.away.score = 3;

    const { ctx } = makeCtx({ detail: kboDetail(), relay: kboRelay() });
    const snap = await naverProvider.fetchPlays(ctx, stale);

    expect(snap.game.phase).toBe('post'); // ⇐ the whole point: poller stops, final line fires
    expect(snap.game.statusShort).toBe('F');
    expect(snap.game.statusText).toBe('9회초');
    // Refreshed from result.game.homeTeamScore/awayTeamScore, not carried from the input.
    expect(snap.game.home.score).toBe(10);
    expect(snap.game.away.score).toBe(2);
    // Freshly derived object, not the input reference (§2 pin).
    expect(snap.game).not.toBe(stale);
    // Identity preserved, events still parsed.
    expect(snap.game.id).toBe(stale.id);
    expect(snap.game.leagueName).toBe('KBO리그');
    expect(snap.game.startTimeUtc).toBe('2026-07-07T09:30:00Z');
    expect(snap.events).toHaveLength(24);
  });

  it('K League: stale in-progress input + terminal detail ⇒ phase post, scores refreshed', async () => {
    // Exactly the reproduced defect: `phase=in score=1-2 FROZEN`.
    const stale = kleagueGame();
    stale.phase = 'in';
    stale.statusText = '후반';
    stale.statusShort = 'H2';
    stale.home.score = 0;
    stale.away.score = 0;

    const { ctx } = makeCtx({ detail: kleagueDetail(), relay: kleagueRelay() });
    const snap = await naverProvider.fetchPlays(ctx, stale);

    expect(snap.game.phase).toBe('post');
    expect(snap.game.statusShort).toBe('F');
    expect(snap.game.statusText).toBe('경기종료');
    expect(snap.game.home.score).toBe(1);
    expect(snap.game.away.score).toBe(2);
    expect(snap.game).not.toBe(stale);
    expect(snap.game.id).toBe(stale.id);
    expect(snap.events).toHaveLength(8);
  });

  it('the relay alone can never advance phase: numeric statusCode 4 is not a phase source', async () => {
    // Guards against a regression to the old two-source logic. Detail unusable ⇒ the relay's
    // top-level statusCode 4 / statusInfo '종료' MUST NOT be consulted; phase stays 'in'.
    const relay = kleagueRelay();
    expect(relay.result.textRelayData.statusCode).toBe(4);
    const { ctx } = makeCtx({ detail: {}, relay });
    const snap = await naverProvider.fetchPlays(ctx, kleagueGame());
    expect(snap.game.phase).toBe('in');
  });

  it('fetchPlays requests BOTH the detail and the relay URL, each with the Mozilla UA', async () => {
    const { ctx, calls } = makeCtx({ detail: kboDetail(), relay: kboRelay() });
    await naverProvider.fetchPlays(ctx, kboGame());

    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.url)).toEqual([
      'https://api-gw.sports.naver.com/schedule/games/20260707HTLT02026',
      'https://api-gw.sports.naver.com/schedule/games/20260707HTLT02026/relay',
    ]);
    expect(calls.every((c) => c.headers?.['user-agent'] === 'Mozilla/5.0')).toBe(true);
  });
});

/**
 * A failed status refresh must degrade gracefully: carry the input game, never throw, and
 * never lose play lines. Only a RELAY failure is a real ProviderError.
 */
describe('naver fetchPlays — detail request degradation (§2.5)', () => {
  it('detail throws ⇒ input game carried through unchanged, relay events returned in full', async () => {
    const game = kboGame();
    const { ctx, logs } = makeCtx({
      detailThrow: new ProviderError('network', 'gateway down'),
      relay: kboRelay(),
    });

    const snap = await naverProvider.fetchPlays(ctx, game);

    expect(snap.game).toBe(game); // carried through, not re-derived
    expect(snap.game.phase).toBe('in');
    expect(snap.game.home.score).toBe(0);
    expect(snap.events).toHaveLength(24);
    expect(snap.events[0]!.sequence).toBe(523);
    expect(logs.some((l) => l.includes('status refresh failed'))).toBe(true);
  });

  it('detail 404 ⇒ no throw; input game carried, events intact', async () => {
    const game = kleagueGame();
    const { ctx } = makeCtx({
      detailThrow: new ProviderError('not-found', 'no such game'),
      relay: kleagueRelay(),
    });

    const snap = await naverProvider.fetchPlays(ctx, game);
    expect(snap.game).toBe(game);
    expect(snap.events).toHaveLength(8);
  });

  it.each<[string, unknown]>([
    ['non-object body', 'not json at all'],
    ['null body', null],
    ['no result', {}],
    ['result.game missing', { result: {} }],
    ['result.game not an object', { result: { game: 42 } }],
    ['result.game without gameId', { result: { game: { statusCode: 'RESULT' } } }],
  ])('detail garbage (%s) ⇒ input game carried, events intact', async (_label, detail) => {
    const game = kboGame();
    const { ctx, logs } = makeCtx({ detail, relay: kboRelay() });

    const snap = await naverProvider.fetchPlays(ctx, game);

    expect(snap.game).toBe(game);
    expect(snap.events).toHaveLength(24);
    expect(logs.some((l) => l.includes('carrying input game'))).toBe(true);
  });

  it('a surprise gameId in the detail body does not re-key the game or its events', async () => {
    const detail = kboDetail();
    detail.result.game.gameId = 'SOME_OTHER_GAME';
    const { ctx } = makeCtx({ detail, relay: kboRelay() });

    const snap = await naverProvider.fetchPlays(ctx, kboGame());
    expect(snap.game.id).toBe('naver:kbo:20260707HTLT02026');
    expect(snap.events[0]!.gameId).toBe('naver:kbo:20260707HTLT02026');
    // Status still refreshed from the body.
    expect(snap.game.phase).toBe('post');
  });

  it('relay failure IS a ProviderError even when the detail request succeeded', async () => {
    const err = new ProviderError('network', 'relay boom');
    const { ctx } = makeCtx({ detail: kboDetail(), relayThrow: err });
    await expect(naverProvider.fetchPlays(ctx, kboGame())).rejects.toBe(err);
  });

  it('non-object textRelayData ⇒ empty window, still carrying the fresh game', async () => {
    const { ctx } = makeCtx({ detail: kboDetail(), relay: { result: { textRelayData: 5 } } });
    const snap = await naverProvider.fetchPlays(ctx, kboGame());
    expect(snap.events).toEqual([]);
    expect(snap.game.phase).toBe('post'); // still fresh
  });
});

describe('naver error propagation', () => {
  it('propagates a ProviderError from fetchJson unchanged', async () => {
    const err = new ProviderError('network', 'boom');
    const { ctx } = makeCtx({ throwErr: err });
    await expect(naverProvider.listGames(ctx, KBO_LEAGUE)).rejects.toBe(err);
  });

  it('fetchPlays with every request failing ⇒ the relay error surfaces', async () => {
    const err = new ProviderError('network', 'boom');
    const { ctx } = makeCtx({ throwErr: err });
    await expect(naverProvider.fetchPlays(ctx, kboGame())).rejects.toBe(err);
  });
});

// --- logos (§13) -------------------------------------------------------------

describe('naver logos (§13)', () => {
  it('populates KBO team emblem URLs from the schedule, RESIZED with ?type=f64_64 (§13.2b)', async () => {
    const { ctx } = makeCtx({ response: loadFixture('naver-kbo-schedule.json') });
    const games = await naverProvider.listGames(ctx, KBO_LEAGUE);
    expect(games[0]!.home.logo).toEqual({ light: 'https://sports-phinf.pstatic.net/team/kbo/default/LT.png?type=f64_64' });
    expect(games[0]!.away.logo).toEqual({ light: 'https://sports-phinf.pstatic.net/team/kbo/default/HT.png?type=f64_64' });
  });

  it('populates K League team emblem URLs from the schedule, RESIZED with ?type=f64_64', async () => {
    const { ctx } = makeCtx({ response: loadFixture('naver-kleague-schedule.json') });
    const games = await naverProvider.listGames(ctx, KLEAGUE);
    expect(games[0]!.home.logo).toEqual({ light: 'https://sports-phinf.pstatic.net/team/kleague/default/05.png?type=f64_64' });
    expect(games[0]!.away.logo).toEqual({ light: 'https://sports-phinf.pstatic.net/team/kleague/default/21.png?type=f64_64' });
  });

  it('populates the resized emblem on the fresh game from the game-detail endpoint too', async () => {
    const { ctx } = makeCtx({ detail: kboDetail(), relay: kboRelay() });
    const snap = await naverProvider.fetchPlays(ctx, kboGame());
    expect(snap.game.home.logo).toEqual({ light: 'https://sports-phinf.pstatic.net/team/kbo/default/LT.png?type=f64_64' });
    expect(snap.game.away.logo).toEqual({ light: 'https://sports-phinf.pstatic.net/team/kbo/default/HT.png?type=f64_64' });
  });

  it('an emblem URL that already carries a query string is left entirely alone', async () => {
    const fix = loadFixture('naver-kbo-schedule.json');
    fix.result.games[0].homeTeamEmblemUrl = 'https://sports-phinf.pstatic.net/team/kbo/default/LT.png?type=m180_180';
    const { ctx } = makeCtx({ response: fix });
    const games = await naverProvider.listGames(ctx, KBO_LEAGUE);
    expect(games[0]!.home.logo).toEqual({ light: 'https://sports-phinf.pstatic.net/team/kbo/default/LT.png?type=m180_180' });
  });

  it('garbage emblem (number, empty, javascript:, ftp:) ⇒ omitted, no throw', async () => {
    for (const bad of [42, '', 'javascript:alert(1)', 'ftp://x/y.png']) {
      const fix = loadFixture('naver-kbo-schedule.json');
      fix.result.games[0].homeTeamEmblemUrl = bad;
      const { ctx } = makeCtx({ response: fix });
      const games = await naverProvider.listGames(ctx, KBO_LEAGUE);
      expect(games[0]!.home.logo).toBeUndefined();
    }
  });
});
