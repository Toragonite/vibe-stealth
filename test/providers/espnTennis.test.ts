import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DetailLevel, Game, League, PlayEvent, ProviderContext, ProviderError, RelayLocale } from '../../src/core/contract';
import { createRelayEngine } from '../../src/core/relay';
import { espnTennisProvider } from '../../src/providers/espnTennis';

function load(name: string): any {
  return JSON.parse(readFileSync(join(process.cwd(), 'test', 'fixtures', name), 'utf8'));
}
function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}
function fixture(): any {
  return load('espn-tennis-scoreboard.json');
}

/** Every fixture match is dated 2026-07-20; "now" sits 14:00 UTC that day. */
const NOW = Date.parse('2026-07-20T14:00:00Z');

const ATP: League = { id: 'atp', providerId: 'espn-tennis', name: 'ATP Tour', sport: 'tennis' };

function makeCtx(
  payload: unknown,
  opts?: { detail?: DetailLevel; locale?: RelayLocale; now?: number },
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
    now: () => opts?.now ?? NOW,
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
    now: () => NOW,
  };
}

async function listAtp(payload: unknown, opts?: { now?: number; locale?: RelayLocale }): Promise<Game[]> {
  return espnTennisProvider.listGames(makeCtx(payload, opts).ctx, ATP);
}

function byId(games: Game[], nativeId: string): Game {
  const hit = games.find((g) => g.id === `espn-tennis:atp:${nativeId}`);
  if (!hit) throw new Error(`no game ${nativeId} in [${games.map((g) => g.id).join(', ')}]`);
  return hit;
}

/** The stub game a poller would hand to fetchPlays (its fields must all be re-derived). */
function stubGame(nativeId: string): Game {
  return {
    id: `espn-tennis:atp:${nativeId}`,
    providerId: 'espn-tennis',
    leagueId: 'atp',
    leagueName: 'ATP Tour',
    sport: 'tennis',
    startTimeUtc: undefined,
    phase: 'pre',
    statusText: 'stale',
    statusShort: 'stale',
    format: 'versus',
    home: { id: '', name: 'stale', abbrev: 'STA', score: undefined },
    away: { id: '', name: 'stale', abbrev: 'STA', score: undefined },
    entrants: undefined,
  };
}

// --- leagues ---------------------------------------------------------------

describe('espn-tennis leagues', () => {
  it('exposes atp and wta as tennis leagues', async () => {
    const leagues = await espnTennisProvider.listLeagues(makeCtx({}).ctx);
    expect(espnTennisProvider.id).toBe('espn-tennis');
    expect(espnTennisProvider.displayName).toBe('Tennis');
    expect(espnTennisProvider.requiresSecret).toBeUndefined();
    expect(leagues.map((l) => l.id)).toEqual(['atp', 'wta']);
    expect(leagues.map((l) => l.name)).toEqual(['ATP Tour', 'WTA Tour']);
    for (const l of leagues) {
      expect(l.sport).toBe('tennis');
      expect(l.providerId).toBe('espn-tennis');
    }
  });

  it('fetches the league-specific scoreboard path', async () => {
    const { ctx, urls } = makeCtx(fixture());
    await espnTennisProvider.listGames(ctx, { ...ATP, id: 'wta', name: 'WTA Tour' });
    expect(urls).toEqual(['https://site.api.espn.com/apis/site/v2/sports/tennis/wta/scoreboard']);
  });
});

// --- listGames: nesting, scoring, filtering --------------------------------

describe('espn-tennis listGames', () => {
  it('digs matches out of events[].groupings[].competitions[] and drops stale ones', async () => {
    const games = await listAtp(fixture());
    // 5 relevant matches; the 3-day-old qualifier and the empty tournament contribute none.
    expect(games.map((g) => g.id)).toEqual([
      'espn-tennis:atp:401700002', // live sorts first
      'espn-tennis:atp:401700001', // then recently finished, chronologically
      'espn-tennis:atp:401700004',
      'espn-tennis:atp:401700005',
      'espn-tennis:atp:401700003', // then upcoming
    ]);
  });

  it('D3: score is SETS won, never games — a 6-2, 6-4 win is 2, not 6', async () => {
    const g = byId(await listAtp(fixture()), '401700001');
    expect(g.home?.name).toBe('Miriam Bulgaru');
    expect(g.home?.score).toBe(2);
    expect(g.away?.name).toBe('Anna Kovacs');
    expect(g.away?.score).toBe(0);
    // The per-set games live in statusText, and only there.
    expect(g.statusText).toBe('6-2, 6-4');
    expect(g.statusShort).toBe('F');
  });

  it('every game is a versus contest with both sides and no entrants (§14)', async () => {
    for (const g of await listAtp(fixture())) {
      expect(g.format).toBe('versus');
      expect(g.entrants).toBeUndefined();
      expect(g.home).toBeDefined();
      expect(g.away).toBeDefined();
      expect(g.sport).toBe('tennis');
      expect(g.providerId).toBe('espn-tennis');
      expect(g.leagueId).toBe('atp');
      expect(g.leagueName).toBe('ATP Tour');
      expect(g.statusText.length).toBeGreaterThan(0);
      expect(g.statusShort.length).toBeGreaterThan(0);
      expect(g.statusShort.length).toBeLessThanOrEqual(8);
    }
  });

  it('a live match mid-set: sets in score, current games in the status', async () => {
    const g = byId(await listAtp(fixture()), '401700002');
    expect(g.phase).toBe('in');
    expect(g.home?.score).toBe(1); // one set each; the third is still being played
    expect(g.away?.score).toBe(1);
    expect(g.statusText).toBe('6-4, 3-6, 2-1');
    expect(g.statusShort).toBe('S3 2-1');
    expect(g.startTimeUtc).toBe('2026-07-20T12:30:00Z');
  });

  it('P6: a doubles side is named from its OBJECT-shaped roster (the live shape)', async () => {
    // Live WTA evidence: `athlete` and `team` are both null and the pair name sits
    // at roster.displayName. Reading `roster` as an array found nothing here and
    // every doubles match rendered as TBD.
    const raw = fixture();
    const doubles = raw.events[0].groupings[1].competitions[0];
    expect(doubles.competitors[0].athlete).toBeNull();
    expect(doubles.competitors[0].team).toBeNull();
    expect(Array.isArray(doubles.competitors[0].roster)).toBe(false);

    const g = byId(await listAtp(raw), '401700004');
    expect(g.home?.name).toBe('Rafael Costa / Nils Berg');
    expect(g.home?.name).not.toBe('TBD');
    expect(g.away?.name).toBe('Paul Mercier / Diego Salas');
    expect(g.away?.name).not.toBe('TBD');
    // Both players, 2 letters each — see abbrevFor's breadth-over-depth note.
    expect(g.home?.abbrev).toBe('CO/BE');
    expect(g.away?.abbrev).toBe('ME/SA');
    expect(g.home?.abbrev.length).toBeLessThanOrEqual(5);
    expect(g.home?.score).toBe(2);
    expect(g.statusText).toBe('7-6, 6-3');
  });

  it('P6: a roster carrying only athletes[] is joined into a pair name', async () => {
    const raw = fixture();
    const home = raw.events[0].groupings[1].competitions[0].competitors[0];
    delete home.roster.displayName;
    delete home.roster.shortDisplayName;
    const g = byId(await listAtp(raw), '401700004');
    expect(g.home?.name).toBe('Rafael Costa / Nils Berg');
    expect(g.home?.abbrev).toBe('CO/BE');
  });

  it('P6: the abbrev prefers shortDisplayName, whose surname is always last', async () => {
    // 'Tang Qianhui' is surname-FIRST, so the full name's last word is the given
    // name; the short form ('Q. Tang') is the only reliable surname source.
    const raw = fixture();
    const home = raw.events[0].groupings[1].competitions[0].competitors[0];
    home.roster.displayName = 'Maia Lumsden / Tang Qianhui';
    home.roster.shortDisplayName = 'M. Lumsden / Q. Tang';
    const g = byId(await listAtp(raw), '401700004');
    expect(g.home?.name).toBe('Maia Lumsden / Tang Qianhui');
    expect(g.home?.abbrev).toBe('LU/TA');
  });

  it('P6: a null, empty or array-shaped roster never throws', async () => {
    const rosters: unknown[] = [
      null,
      undefined,
      {},
      { athletes: [] },
      { athletes: 'nope' },
      'roster',
      42,
      // Not what the feed sends, but tolerated rather than fatal.
      [{ athlete: { displayName: 'Rafael Costa' } }, { athlete: { displayName: 'Nils Berg' } }],
    ];
    const names: Array<string | undefined> = [];
    for (const roster of rosters) {
      const raw = fixture();
      const home = raw.events[0].groupings[1].competitions[0].competitors[0];
      home.roster = roster;
      const g = byId(await listAtp(raw), '401700004');
      expect(g.home?.name.length).toBeGreaterThan(0);
      expect(g.home?.abbrev.length).toBeGreaterThan(0);
      expect(g.home?.abbrev.length).toBeLessThanOrEqual(5);
      names.push(g.home?.name);
    }
    // Only the array form carries readable athletes; the rest degrade to TBD.
    expect(names.slice(0, 7)).toEqual(['TBD', 'TBD', 'TBD', 'TBD', 'TBD', 'TBD', 'TBD']);
    expect(names[7]).toBe('Rafael Costa / Nils Berg');
  });

  it('P6: a singles competitor still resolves through athlete, not roster', async () => {
    const raw = fixture();
    const singles = raw.events[0].groupings[0].competitions[0].competitors[0];
    // A roster alongside a real athlete must not win — singles behaviour is pinned.
    singles.roster = { displayName: 'Wrong / Pair' };
    const g = byId(await listAtp(raw), '401700001');
    expect(g.home?.name).toBe('Miriam Bulgaru');
    expect(g.home?.abbrev).toBe('BUL');
  });

  it('P6: a competitor with no athlete, roster, team or name is TBD — never empty', async () => {
    const g = byId(await listAtp(fixture()), '401700005');
    expect(g.away?.name).toBe('TBD');
    expect(g.away?.abbrev).toBe('TBD');
    expect(g.home?.name).toBe('Erik Lund');
    expect(g.home?.abbrev).toBe('LUN');
  });

  it('a match with EMPTY linescores parses with zero sets won', async () => {
    const g = byId(await listAtp(fixture()), '401700003');
    expect(g.phase).toBe('pre');
    expect(g.home?.score).toBe(0);
    expect(g.away?.score).toBe(0);
    // pre-match status is the local start time, so assert the shape, not the zone.
    expect(g.statusText).toMatch(/^\d{2}:\d{2}$/);
    expect(g.statusShort).toBe(g.statusText);
  });

  it('P8: phase comes from the MATCH even while its tournament reads live', async () => {
    const raw = fixture();
    expect(raw.events[0].status.type.state).toBe('in'); // the tournament runs all week
    const games = await listAtp(raw);
    expect(byId(games, '401700001').phase).toBe('post');
    expect(byId(games, '401700002').phase).toBe('in');
    expect(byId(games, '401700003').phase).toBe('pre');
  });

  it('a match whose status state is unrecognized becomes phase unknown and is not shown', async () => {
    const raw = fixture();
    raw.events[0].groupings[0].competitions[1].status.type.state = 'weird';
    const games = await listAtp(raw);
    expect(games.find((g) => g.id.endsWith('401700002'))).toBeUndefined();
  });

  it('P7: only a headshot on the allowlisted host becomes a logo', async () => {
    const g = byId(await listAtp(fixture()), '401700001');
    expect(g.home?.logo?.light).toBe(
      'https://a.espncdn.com/combiner/i?img=/i/headshots/tennis/players/full/9001.png&w=64&h=64&transparent=true',
    );
    // secure.espncdn.com is NOT on src/ui/logoCache.ts's allowlist.
    expect(g.away?.logo).toBeUndefined();
  });

  it('P9: an empty scoreboard is an empty list, not an error', async () => {
    await expect(listAtp({ events: [] })).resolves.toEqual([]);
    await expect(listAtp({})).resolves.toEqual([]);
    await expect(listAtp({ events: null })).resolves.toEqual([]);
    // A tournament with zero groupings contributes nothing either.
    await expect(listAtp({ events: [{ id: '1', name: 'Quiet Cup' }] })).resolves.toEqual([]);
    await expect(listAtp({ events: [{ id: '1', groupings: [] }] })).resolves.toEqual([]);
  });

  it('P2: a flooding tournament is capped, live matches surviving first', async () => {
    const raw = fixture();
    const live = raw.events[0].groupings[0].competitions[1];
    const finished = raw.events[0].groupings[0].competitions[0];
    const many: any[] = [];
    for (let i = 0; i < 20; i++) {
      const c = clone(i < 4 ? live : finished);
      c.id = `4017100${String(i).padStart(2, '0')}`;
      many.push(c);
    }
    raw.events[0].groupings = [{ grouping: { slug: 'mens-singles' }, competitions: many }];
    const { ctx, logs } = makeCtx(raw, {});
    const games = await espnTennisProvider.listGames(ctx, ATP);
    expect(games).toHaveLength(12);
    expect(games.filter((g) => g.phase === 'in')).toHaveLength(4); // every live match kept
    expect(logs.some((l) => l.includes('capped at 12 of 20'))).toBe(true);
  });

  it('skips a match with no id and a match with no competitors', async () => {
    const raw = fixture();
    delete raw.events[0].groupings[0].competitions[0].id;
    raw.events[0].groupings[0].competitions[1].competitors = [];
    const games = await listAtp(raw);
    expect(games.map((g) => g.id)).toEqual([
      'espn-tennis:atp:401700004',
      'espn-tennis:atp:401700005',
      'espn-tennis:atp:401700003',
    ]);
  });

  it('a match with a single competitor still yields a versus game with a TBD opponent', async () => {
    const raw = fixture();
    raw.events[0].groupings[0].competitions[0].competitors.pop();
    const g = byId(await listAtp(raw), '401700001');
    expect(g.format).toBe('versus');
    expect(g.away?.name).toBe('TBD');
    expect(g.away?.score).toBeUndefined();
  });
});

// --- malformed payloads ----------------------------------------------------

describe('espn-tennis error handling', () => {
  it('a truncated/mistyped payload is ProviderError(parse), never a raw throw', async () => {
    for (const payload of ['{"events":[{"id"', 42, null, [], { events: 'nope' }, { events: 7 }]) {
      const err = await listAtp(payload).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).kind).toBe('parse');
    }
  });

  it('the parse error carries a payload head for diagnostics', async () => {
    const err = (await listAtp({ events: 'nope' }).catch((e: unknown) => e)) as ProviderError;
    expect(err.payloadHead).toContain('nope');
    expect((err.payloadHead ?? '').length).toBeLessThanOrEqual(300);
  });

  it('propagates a fetch-layer ProviderError unchanged', async () => {
    const boom = new ProviderError('rate-limit', 'slow down', 60000);
    await expect(espnTennisProvider.listGames(throwingCtx(boom), ATP)).rejects.toBe(boom);
    await expect(espnTennisProvider.fetchPlays(throwingCtx(boom), stubGame('401700001'))).rejects.toBe(boom);
  });

  it('a vanished match is not-found, and so is an unknown league', async () => {
    const gone = await espnTennisProvider
      .fetchPlays(makeCtx(fixture()).ctx, stubGame('999999'))
      .catch((e: unknown) => e);
    expect(gone).toBeInstanceOf(ProviderError);
    expect((gone as ProviderError).kind).toBe('not-found');

    const bad = { ...stubGame('401700001'), leagueId: 'itf' };
    const err = await espnTennisProvider.fetchPlays(makeCtx(fixture()).ctx, bad).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).kind).toBe('not-found');
  });

  it('fetchPlays on a truncated payload is ProviderError(parse)', async () => {
    const err = await espnTennisProvider
      .fetchPlays(makeCtx('{"events":[').ctx, stubGame('401700001'))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).kind).toBe('parse');
  });
});

// --- fetchPlays: D4 events -------------------------------------------------

describe('espn-tennis fetchPlays', () => {
  it('D4: one event per completed set plus a final, all from one response', async () => {
    const snap = await espnTennisProvider.fetchPlays(makeCtx(fixture()).ctx, stubGame('401700001'));
    expect(snap.events.map((e) => e.id)).toEqual([
      '401700001:set:0',
      '401700001:set:1',
      '401700001:final',
    ]);
    expect(snap.events.map((e) => e.text)).toEqual([
      'Set 1 — Miriam Bulgaru 6-2',
      'Set 2 — Miriam Bulgaru 6-4',
      'Match over — Miriam Bulgaru def. Anna Kovacs 6-2, 6-4',
    ]);
    expect(snap.events.map((e) => e.kind)).toEqual(['score', 'score', 'status']);
    expect(snap.events.map((e) => e.period)).toEqual(['S1', 'S2', undefined]);
    expect(snap.events.map((e) => e.scoreAfter)).toEqual([
      { home: 1, away: 0 },
      { home: 2, away: 0 },
      { home: 2, away: 0 },
    ]);
    expect(snap.events.map((e) => e.sequence)).toEqual([0, 1, 1000]);
    for (const e of snap.events) expect(e.gameId).toBe('espn-tennis:atp:401700001');
    expect(snap.state).toBeUndefined();
  });

  it('§2: the snapshot game is re-derived, never the stale input game', async () => {
    const snap = await espnTennisProvider.fetchPlays(makeCtx(fixture()).ctx, stubGame('401700001'));
    expect(snap.game.phase).toBe('post');
    expect(snap.game.statusText).toBe('6-2, 6-4');
    expect(snap.game.statusShort).toBe('F');
    expect(snap.game.home?.score).toBe(2);
    expect(snap.game.away?.score).toBe(0);
    expect(snap.game.startTimeUtc).toBe('2026-07-20T10:00:00Z');
    expect(snap.game.format).toBe('versus');
    expect(snap.game.entrants).toBeUndefined();
  });

  it('a live match emits only its COMPLETED sets — never the one in progress', async () => {
    const snap = await espnTennisProvider.fetchPlays(makeCtx(fixture()).ctx, stubGame('401700002'));
    expect(snap.game.phase).toBe('in');
    expect(snap.events.map((e) => e.id)).toEqual(['401700002:set:0', '401700002:set:1']);
    expect(snap.events.map((e) => e.text)).toEqual(['Set 1 — Leo Sundqvist 6-4', 'Set 2 — Tomas Neri 6-3']);
    expect(snap.events.map((e) => e.scoreAfter)).toEqual([
      { home: 1, away: 0 },
      { home: 1, away: 1 },
    ]);
  });

  it('a match with EMPTY linescores yields no events at all', async () => {
    const snap = await espnTennisProvider.fetchPlays(makeCtx(fixture()).ctx, stubGame('401700003'));
    expect(snap.events).toEqual([]);
    expect(snap.game.phase).toBe('pre');
  });

  it('a doubles final names both pairs, never TBD', async () => {
    const snap = await espnTennisProvider.fetchPlays(makeCtx(fixture()).ctx, stubGame('401700004'));
    expect(snap.events[snap.events.length - 1]?.text).toBe(
      'Match over — Rafael Costa / Nils Berg def. Paul Mercier / Diego Salas 7-6, 6-3',
    );
    for (const e of snap.events) expect(e.text).not.toContain('TBD');
  });

  it('a missing athlete degrades the final line to TBD rather than an empty name', async () => {
    const snap = await espnTennisProvider.fetchPlays(makeCtx(fixture()).ctx, stubGame('401700005'));
    expect(snap.events[snap.events.length - 1]?.text).toBe('Match over — Erik Lund def. TBD 6-0, 6-2');
  });

  it('event ids are stable across two identical fetches (the engine dedupes by id)', async () => {
    const first = await espnTennisProvider.fetchPlays(makeCtx(fixture()).ctx, stubGame('401700001'));
    const second = await espnTennisProvider.fetchPlays(makeCtx(fixture()).ctx, stubGame('401700001'));
    expect(second.events.map((e) => e.id)).toEqual(first.events.map((e) => e.id));
    expect(second.events.map((e) => e.text)).toEqual(first.events.map((e) => e.text));
    expect(second.events.map((e) => e.sequence)).toEqual(first.events.map((e) => e.sequence));
  });

  it('an already-emitted set keeps its id and text once a later set is added', async () => {
    // The set-1 line must not shift when set 3 lands, or the engine would treat
    // it as a correction (or worse, a brand-new line) forever.
    const before = await espnTennisProvider.fetchPlays(makeCtx(fixture()).ctx, stubGame('401700002'));
    const raw = fixture();
    const live = raw.events[0].groupings[0].competitions[1];
    live.competitors[0].linescores[2] = { value: 6.0, winner: true };
    live.competitors[1].linescores[2] = { value: 3.0, winner: false };
    live.status.type.state = 'post';
    live.competitors[0].winner = true;
    const after = await espnTennisProvider.fetchPlays(makeCtx(raw).ctx, stubGame('401700002'));
    expect(after.events.slice(0, 2).map((e) => e.id)).toEqual(before.events.map((e) => e.id));
    expect(after.events.slice(0, 2).map((e) => e.text)).toEqual(before.events.map((e) => e.text));
    expect(after.events.map((e) => e.id)).toEqual([
      '401700002:set:0',
      '401700002:set:1',
      '401700002:set:2',
      '401700002:final',
    ]);
    expect(after.events[3]?.text).toBe('Match over — Leo Sundqvist def. Tomas Neri 6-4, 3-6, 6-3');
    expect(after.events[3]?.scoreAfter).toEqual({ home: 2, away: 1 });
  });

  it('a completed set with no winner flag is decided by its games — and it counts', async () => {
    const raw = fixture();
    const comp = raw.events[0].groupings[0].competitions[0];
    delete comp.competitors[0].linescores[0].winner;
    delete comp.competitors[1].linescores[0].winner;
    const snap = await espnTennisProvider.fetchPlays(makeCtx(raw).ctx, stubGame('401700001'));
    expect(snap.events[0]?.text).toBe('Set 1 — Miriam Bulgaru 6-2');
    // One rule decides a set (setWinnerAt), so the line and the score agree: the
    // games-decided set counts exactly like a flagged one.
    expect(snap.events[0]?.scoreAfter).toEqual({ home: 1, away: 0 });
    expect(snap.game.home?.score).toBe(2);
  });

  it('a set whose games are unreadable is logged and skipped, later sets unaffected', async () => {
    const raw = fixture();
    raw.events[0].groupings[0].competitions[0].competitors[0].linescores[0].value = 'six';
    const { ctx, logs } = makeCtx(raw);
    const snap = await espnTennisProvider.fetchPlays(ctx, stubGame('401700001'));
    expect(snap.events.map((e) => e.id)).toEqual(['401700001:set:1', '401700001:final']);
    expect(logs.some((l) => l.includes('unreadable games'))).toBe(true);
  });

  it('a finished match with no winner either way states the score without inventing a result', async () => {
    const raw = fixture();
    const comp = raw.events[0].groupings[0].competitions[0];
    comp.competitors[0].winner = false;
    for (const c of comp.competitors) for (const ls of c.linescores) delete ls.winner;
    // With no flag anywhere the games decide, so the sets must be genuinely LEVEL
    // for the result to stay undeterminable: one set each, 6-2 and 4-6.
    comp.competitors[0].linescores[1].value = 4.0;
    comp.competitors[1].linescores[1].value = 6.0;
    const snap = await espnTennisProvider.fetchPlays(makeCtx(raw).ctx, stubGame('401700001'));
    expect(snap.game.home?.score).toBe(1);
    expect(snap.game.away?.score).toBe(1);
    expect(snap.events[snap.events.length - 1]?.text).toBe(
      'Match over — Miriam Bulgaru vs Anna Kovacs: 6-2, 4-6',
    );
  });

  it('a finished match with no readable sets still emits a bare final line', async () => {
    const raw = fixture();
    const comp = raw.events[0].groupings[0].competitions[0];
    for (const c of comp.competitors) c.linescores = [];
    comp.competitors[0].winner = false;
    const snap = await espnTennisProvider.fetchPlays(makeCtx(raw).ctx, stubGame('401700001'));
    expect(snap.events.map((e) => e.text)).toEqual(['Match over']);
  });
});

// --- what one snapshot can never show --------------------------------------

/**
 * A one-match board whose two sides carry the linescores given. Every stateful
 * defect below needed TWO polls to see, and the shipped suite only ever fed the
 * provider one snapshot — this builder is what makes the second poll expressible.
 */
function board(homeLs: unknown[], awayLs: unknown[], state = 'in'): any {
  return {
    events: [
      {
        id: '600009',
        name: 'Two Poll Open',
        status: { type: { state: 'in' } }, // the tournament runs all week (P8)
        groupings: [
          {
            grouping: { id: '1', slug: 'mens-singles', displayName: "Men's Singles" },
            competitions: [
              {
                id: '401799001',
                date: '2026-07-20T12:00Z',
                status: { type: { state } },
                competitors: [
                  { id: '1', winner: false, athlete: { displayName: 'Ada Alpha' }, linescores: homeLs },
                  { id: '2', winner: false, athlete: { displayName: 'Bella Beta' }, linescores: awayLs },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

const corrections = (events: PlayEvent[]): PlayEvent[] => events.filter((e) => e.kind === 'correction');

describe('espn-tennis across polls', () => {
  it('A1: a match flagged only on the COMPETITOR still scores its sets 2-0', async () => {
    // The shape ESPN genuinely serves for a finished match: `competitor.winner`
    // is set and every per-set flag is false. Counting only the per-set flags
    // scored this 0-0 while the prose right above named the winner.
    const raw = fixture();
    const comp = raw.events[0].groupings[0].competitions[0];
    for (const c of comp.competitors) for (const ls of c.linescores) ls.winner = false;
    expect(comp.competitors[0].winner).toBe(true);
    expect(comp.competitors[0].linescores.every((ls: any) => ls.winner === false)).toBe(true);

    const snap = await espnTennisProvider.fetchPlays(makeCtx(raw).ctx, stubGame('401700001'));
    expect(snap.game.home?.score).toBe(2);
    expect(snap.game.away?.score).toBe(0);
    expect(snap.events.map((e) => e.text)).toEqual([
      'Set 1 — Miriam Bulgaru 6-2',
      'Set 2 — Miriam Bulgaru 6-4',
      'Match over — Miriam Bulgaru def. Anna Kovacs 6-2, 6-4',
    ]);
    expect(snap.events[1]?.scoreAfter).toEqual({ home: 2, away: 0 });

    // The closing system line the engine composes from the score must not
    // contradict the prose directly above it.
    const engine = createRelayEngine({ backfillLimit: 20, locale: 'en' });
    const out = engine.ingest(snap);
    expect(out.events.filter((e) => e.kind === 'system').map((e) => e.text)).toEqual(['Final — KOV 0 : 2 BUL']);
    expect(byId(await listAtp(raw), '401700001').home?.score).toBe(2);
  });

  it('A2: two polls of an evolving set emit ZERO corrections', async () => {
    // Away's linescores carry one entry more than home's — a trailing placeholder
    // for the set to come — while set 2 is still being played at 3-5. Reading
    // "a later set exists" off the LONGER side declared set 2 finished at 3-5,
    // then poll 2's real 4-6 arrived under the same id as a false correction.
    const engine = createRelayEngine({ backfillLimit: 20, locale: 'en' });

    const poll1 = board(
      [{ value: 6.0, winner: true }, { value: 3.0 }],
      [{ value: 4.0 }, { value: 5.0 }, { value: 0.0 }],
    );
    const poll2 = board(
      [{ value: 6.0, winner: true }, { value: 4.0 }],
      [{ value: 4.0 }, { value: 6.0, winner: true }, { value: 0.0 }],
    );
    const snap1 = await espnTennisProvider.fetchPlays(makeCtx(poll1).ctx, stubGame('401799001'));
    const out1 = engine.ingest(snap1);
    const snap2 = await espnTennisProvider.fetchPlays(makeCtx(poll2).ctx, stubGame('401799001'));
    const out2 = engine.ingest(snap2);

    // THE assertion: a line the user already read must never be rewritten.
    expect(corrections(out1.events).map((e) => e.text)).toEqual([]);
    expect(corrections(out2.events).map((e) => e.text)).toEqual([]);

    // Poll 1 publishes set 1 only — the live set is nobody's yet, in the lines
    // or in the score.
    expect(out1.events.map((e) => e.id)).toEqual(['401799001:set:0']);
    expect(out1.events.map((e) => e.text)).toEqual(['Set 1 — Ada Alpha 6-4']);
    expect(out1.events.some((e) => e.text.includes('5-3'))).toBe(false);
    expect(snap1.game.home?.score).toBe(1);
    expect(snap1.game.away?.score).toBe(0);

    // Poll 2 publishes set 2 once, with the games it actually finished on.
    expect(out2.events.map((e) => e.id)).toEqual(['401799001:set:1']);
    expect(out2.events.map((e) => e.text)).toEqual(['Set 2 — Bella Beta 6-4']);
    expect(snap2.game.away?.score).toBe(1);

    // Set 1's line never moved, which is what makes its stable id safe.
    expect(snap2.events[0]?.id).toBe(snap1.events[0]?.id);
    expect(snap2.events[0]?.text).toBe(snap1.events[0]?.text);
  });

  it('A2: a third poll finishing the match still emits no correction', async () => {
    const engine = createRelayEngine({ backfillLimit: 20, locale: 'en' });
    const polls = [
      board([{ value: 6.0, winner: true }, { value: 3.0 }], [{ value: 4.0 }, { value: 5.0 }, { value: 0.0 }]),
      board([{ value: 6.0, winner: true }, { value: 4.0 }], [{ value: 4.0 }, { value: 6.0, winner: true }, { value: 2.0 }]),
      board(
        [{ value: 6.0, winner: true }, { value: 4.0 }, { value: 6.0, winner: true }],
        [{ value: 4.0 }, { value: 6.0, winner: true }, { value: 3.0 }],
        'post',
      ),
    ];
    const seen: string[] = [];
    for (const poll of polls) {
      const out = engine.ingest(await espnTennisProvider.fetchPlays(makeCtx(poll).ctx, stubGame('401799001')));
      expect(corrections(out.events)).toEqual([]);
      for (const e of out.events) seen.push(e.text);
    }
    // Every line published exactly once, in order, and the closing score agrees.
    expect(seen).toEqual([
      'Set 1 — Ada Alpha 6-4',
      'Set 2 — Bella Beta 6-4',
      'Set 3 — Ada Alpha 6-3',
      'Match over — Ada Alpha def. Bella Beta 6-4, 4-6, 6-3',
      'Final — BET 1 : 2 ALP',
    ]);
  });
});

// --- P2: the cap must be fair across draws ---------------------------------

describe('espn-tennis draw fairness', () => {
  function bigDraw(slug: string, prefix: string, live: any): any {
    return {
      grouping: { id: slug, slug, displayName: slug },
      competitions: Array.from({ length: 30 }, (_, i) => {
        const c = clone(live);
        c.id = `${prefix}${String(i).padStart(3, '0')}`;
        return c;
      }),
    };
  }

  it('A3: at a Grand Slam every draw is represented — singles are never crowded out', async () => {
    const raw = fixture();
    const live = raw.events[0].groupings[0].competitions[1];
    // The doubles ids sort BEFORE the singles ids. With all 120 matches live and
    // same-dated, relevance and start time tie and the sort falls through to a
    // lexicographic id compare — which handed all twelve slots to the doubles.
    raw.events[0].groupings = [
      bigDraw('mens-doubles', '401710', live),
      bigDraw('womens-doubles', '401720', live),
      bigDraw('mens-singles', '401730', live),
      bigDraw('womens-singles', '401740', live),
    ];
    const { ctx, logs } = makeCtx(raw);
    const games = await espnTennisProvider.listGames(ctx, ATP);

    expect(games).toHaveLength(12);
    const count = (prefix: string): number =>
      games.filter((g) => g.id.startsWith(`espn-tennis:atp:${prefix}`)).length;
    expect(count('401730')).toBeGreaterThan(0); // men's singles
    expect(count('401740')).toBeGreaterThan(0); // women's singles
    // Twelve slots, four draws, shared out evenly.
    expect([count('401710'), count('401720'), count('401730'), count('401740')]).toEqual([3, 3, 3, 3]);
    expect(logs.some((l) => l.includes('capped at 12 of 120'))).toBe(true);
  });

  it('A3: with more draws than slots, the singles draws are the ones that get them', async () => {
    const raw = fixture();
    const live = raw.events[0].groupings[0].competitions[1];
    // A real major also runs juniors, wheelchair and invitational draws.
    const groupings: any[] = [];
    for (let i = 0; i < 13; i++) groupings.push(bigDraw(`draw-${i}-doubles`, `4017${String(i + 20)}`, live));
    groupings.push(bigDraw('womens-singles', '401799', live));
    raw.events[0].groupings = groupings;
    const games = await espnTennisProvider.listGames(makeCtx(raw).ctx, ATP);
    expect(games).toHaveLength(12);
    expect(games.filter((g) => g.id.startsWith('espn-tennis:atp:401799'))).toHaveLength(1);
  });

  it('A3: a single-draw tournament still spends the whole cap on that draw', async () => {
    // The pre-existing flooding case must not regress into 1-of-12.
    const raw = fixture();
    const live = raw.events[0].groupings[0].competitions[1];
    raw.events[0].groupings = [bigDraw('mens-singles', '401750', live)];
    const games = await espnTennisProvider.listGames(makeCtx(raw).ctx, ATP);
    expect(games).toHaveLength(12);
  });

  it('A4: two competitions sharing one native id yield exactly one Game', async () => {
    const raw = fixture();
    // The same match listed again under another draw — Game.id is globally unique
    // (contract §121) and the tree builds its TreeItem ids from it.
    raw.events[0].groupings[1].competitions.push(clone(raw.events[0].groupings[0].competitions[0]));
    const { ctx, logs } = makeCtx(raw);
    const games = await espnTennisProvider.listGames(ctx, ATP);
    const ids = games.map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((id) => id === 'espn-tennis:atp:401700001')).toHaveLength(1);
    expect(logs.some((l) => l.includes('duplicate match id 401700001'))).toBe(true);
  });

  it('A4: a duplicate across TOURNAMENTS is dropped too', async () => {
    const raw = fixture();
    raw.events.push(clone(raw.events[0]));
    const games = await espnTennisProvider.listGames(makeCtx(raw).ctx, ATP);
    const ids = games.map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(5);
  });
});

// --- localization (§12.1) --------------------------------------------------

describe('espn-tennis localization', () => {
  it('composes Korean relay lines for sets and the final', async () => {
    const snap = await espnTennisProvider.fetchPlays(makeCtx(fixture(), { locale: 'ko' }).ctx, stubGame('401700001'));
    expect(snap.events.map((e) => e.text)).toEqual([
      '1세트 — Miriam Bulgaru 6-2',
      '2세트 — Miriam Bulgaru 6-4',
      '경기 종료 — Miriam Bulgaru 승, Anna Kovacs 패 — 6-2, 6-4',
    ]);
  });

  it('every composed line renders in both locales with no leftover {placeholder}', async () => {
    for (const locale of ['en', 'ko'] as RelayLocale[]) {
      for (const nativeId of ['401700001', '401700002', '401700004', '401700005']) {
        const snap = await espnTennisProvider.fetchPlays(makeCtx(fixture(), { locale }).ctx, stubGame(nativeId));
        expect(snap.events.length).toBeGreaterThan(0);
        for (const e of snap.events) {
          expect(e.text).not.toMatch(/[{}]/);
          expect(e.text).not.toContain('undefined');
          expect(e.text.length).toBeGreaterThan(0);
          expect(e.text.length).toBeLessThanOrEqual(500);
          expect(e.text).not.toMatch(/[\n\r]/);
        }
      }
    }
  });
});
