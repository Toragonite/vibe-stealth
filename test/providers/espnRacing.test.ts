import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DetailLevel,
  Entrant,
  Game,
  League,
  MAX_FIELD_POSITION,
  ProviderContext,
  ProviderError,
  RelayLocale,
} from '../../src/core/contract';
import { fnv1a32 } from '../../src/core/util';
import { espnRacingProvider } from '../../src/providers/espnRacing';

function load(name: string): any {
  return JSON.parse(readFileSync(join(process.cwd(), 'test', 'fixtures', name), 'utf8'));
}
function fixture(): any {
  return load('espn-racing-scoreboard.json');
}

/** The Belgian GP weekend runs 24–26 July 2026; "now" sits on race day. */
const NOW = Date.parse('2026-07-26T14:00:00Z');

const F1: League = { id: 'f1', providerId: 'espn-racing', name: 'Formula 1', sport: 'motorsport' };

/** Native ids, composed as `${eventId}-${sessionToken}` (the session token keeps FP1 and the race apart). */
const FP1 = '600030401-600030401001';
const QUALI = '600030401-600030401004';
const RACE = '600030401-600030401005';
/** This session carries no competition id, so its token is a hash of its type. */
const FP4 = `600030402-${fnv1a32('fp4')}`;
const NO_TYPE = '600030402-600030402003';

function gameId(nativeId: string): string {
  return `espn-racing:f1:${nativeId}`;
}

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

async function listF1(payload: unknown, opts?: { locale?: RelayLocale }): Promise<Game[]> {
  return espnRacingProvider.listGames(makeCtx(payload, opts).ctx, F1);
}

function byId(games: Game[], nativeId: string): Game {
  const hit = games.find((g) => g.id === gameId(nativeId));
  if (!hit) throw new Error(`no game ${nativeId} in [${games.map((g) => g.id).join(', ')}]`);
  return hit;
}

function entrantsOf(game: Game): Entrant[] {
  const list = game.entrants;
  if (!list) throw new Error(`game ${game.id} has no entrants`);
  return list;
}

/** The stub game a poller would hand to fetchPlays (its fields must all be re-derived). */
function stubGame(nativeId: string): Game {
  return {
    id: gameId(nativeId),
    providerId: 'espn-racing',
    leagueId: 'f1',
    leagueName: 'stale',
    sport: 'motorsport',
    startTimeUtc: undefined,
    phase: 'pre',
    statusText: 'stale',
    statusShort: 'stale',
    format: 'field',
    home: undefined,
    away: undefined,
    entrants: [{ id: '', position: undefined, name: 'stale', abbrev: 'STA', detail: undefined, logo: undefined }],
  };
}

// --- leagues ---------------------------------------------------------------

describe('espn-racing leagues', () => {
  it('exposes f1 as a motorsport league', async () => {
    const leagues = await espnRacingProvider.listLeagues(makeCtx({}).ctx);
    expect(espnRacingProvider.id).toBe('espn-racing');
    expect(espnRacingProvider.displayName).toBe('Motorsport');
    expect(espnRacingProvider.requiresSecret).toBeUndefined();
    expect(leagues).toEqual([{ id: 'f1', providerId: 'espn-racing', name: 'Formula 1', sport: 'motorsport' }]);
  });

  it('fetches the racing scoreboard path', async () => {
    const { ctx, urls } = makeCtx(fixture());
    await espnRacingProvider.listGames(ctx, F1);
    expect(urls).toEqual(['https://site.api.espn.com/apis/site/v2/sports/racing/f1/scoreboard']);
  });
});

// --- §14: the field invariant ----------------------------------------------

describe('espn-racing §14 field invariant', () => {
  it('every emitted game is a field contest with a non-empty entrant list and no sides', async () => {
    const games = await listF1(fixture());
    expect(games.length).toBeGreaterThan(0);
    for (const g of games) {
      expect(g.format).toBe('field');
      expect(g.home).toBeUndefined();
      expect(g.away).toBeUndefined();
      expect(entrantsOf(g).length).toBeGreaterThan(0);
      expect(g.sport).toBe('motorsport');
      expect(g.providerId).toBe('espn-racing');
      expect(g.leagueId).toBe('f1');
      expect(g.statusText.length).toBeGreaterThan(0);
      expect(g.statusShort.length).toBeGreaterThan(0);
      expect(g.statusShort.length).toBeLessThanOrEqual(8);
    }
  });

  it('every entrant obeys the §14 field rules (name, abbrev, position, detail)', async () => {
    for (const g of await listF1(fixture())) {
      for (const e of entrantsOf(g)) {
        expect(e.name.length).toBeGreaterThan(0);
        expect(e.abbrev.length).toBeGreaterThan(0);
        expect(e.abbrev.length).toBeLessThanOrEqual(5);
        if (e.position !== undefined) {
          expect(Number.isInteger(e.position)).toBe(true);
          expect(e.position).toBeGreaterThanOrEqual(1);
        }
        if (e.detail !== undefined) {
          expect(e.detail.length).toBeGreaterThan(0);
          expect(e.detail.length).toBeLessThanOrEqual(40);
        }
      }
    }
  });

  it('a session with ZERO competitors emits no game at all', async () => {
    const games = await listF1(fixture());
    // The Sprint Shootout entry of the test event has an empty competitors array;
    // emitting it would break the "entrants non-empty" half of the §14 pairing.
    expect(games.find((g) => g.id === gameId('600030402-600030402001'))).toBeUndefined();
    await expect(listF1({ events: [{ id: '1', competitions: [{ id: '2', competitors: [] }] }] })).resolves.toEqual([]);
  });
});

// --- listGames: sessions ---------------------------------------------------

describe('espn-racing listGames', () => {
  it('emits one game per SESSION, keyed so practice and the race never collapse', async () => {
    const games = await listF1(fixture());
    expect(games.map((g) => g.id)).toEqual([
      gameId(FP1),
      gameId(QUALI),
      gameId(RACE),
      gameId(FP4),
      gameId(NO_TYPE),
    ]);
    // Every id is distinct — the whole point of the session token.
    expect(new Set(games.map((g) => g.id)).size).toBe(games.length);
  });

  it('P10: the full 22-driver field is sorted by position ascending', async () => {
    const race = byId(await listF1(fixture()), RACE);
    const field = entrantsOf(race);
    expect(field).toHaveLength(22);
    expect(field.map((e) => e.position)).toEqual(Array.from({ length: 22 }, (_, i) => i + 1));
    expect(field.slice(0, 3).map((e) => e.name)).toEqual(['Max Verstappen', 'Lando Norris', 'Oscar Piastri']);
    expect(field[21]?.name).toBe('Zhou Guanyu');
    // Abbrevs are the three-letter codes motorsport uses.
    expect(field.slice(0, 3).map((e) => e.abbrev)).toEqual(['VER', 'NOR', 'PIA']);
    expect(field[0]?.detail).toBe('Red Bull');
  });

  it('P10: entrants with no order sort LAST, deterministically by name', async () => {
    const fp1 = byId(await listF1(fixture()), FP1);
    const field = entrantsOf(fp1);
    expect(field.map((e) => e.position)).toEqual([1, 2, 4, undefined, undefined]);
    expect(field.map((e) => e.name)).toEqual([
      'Max Verstappen',
      'Lando Norris',
      'TBD', // the competitor with no athlete
      'Alex Albon', // the two unranked entrants tie-break by name
      'Oscar Piastri',
    ]);
  });

  it('an order that is not a 1-based place is undefined, never a fabricated position', async () => {
    for (const bad of [0, -3, 1.5, 'P1', null, {}]) {
      const raw = fixture();
      raw.events[0].competitions[0].competitors[0].order = bad;
      const field = entrantsOf(byId(await listF1(raw), FP1));
      const verstappen = field.find((e) => e.name === 'Max Verstappen');
      expect(verstappen?.position).toBeUndefined();
    }
  });

  it('§14: an order outside [1, MAX_FIELD_POSITION] is unranked, never clamped', async () => {
    // FP1's ranked field is Verstappen(1), Norris(2), TBD(4); knocking Verstappen's
    // order out of range must drop him to the unranked tail, not to `MAX_FIELD_POSITION`.
    for (const bad of [1e308, MAX_FIELD_POSITION + 1, 0, 2.5, Number.MAX_SAFE_INTEGER]) {
      const raw = fixture();
      raw.events[0].competitions[0].competitors[0].order = bad;
      const field = entrantsOf(byId(await listF1(raw), FP1));
      const verstappen = field.find((e) => e.name === 'Max Verstappen');
      expect(verstappen?.position, `order ${bad}`).toBeUndefined();
      // Not clamped to the bound, and not invented as any other plausible place.
      expect(field.map((e) => e.position), `order ${bad}`).toEqual([2, 4, undefined, undefined, undefined]);
      // Unranked ⇒ sorts LAST, still deterministically by name within the tail.
      expect(field.map((e) => e.name), `order ${bad}`).toEqual([
        'Lando Norris',
        'TBD',
        'Alex Albon',
        'Max Verstappen',
        'Oscar Piastri',
      ]);
    }
  });

  it('§14: an exotic numeric NOTATION never becomes a position', async () => {
    // Each of these is inside [1, MAX_FIELD_POSITION] once `Number()` has had its
    // way with it ('0x10' → 16, '+6' → 6, '1e3' → 1000), which is precisely why a
    // range check alone is not enough: the notation itself is not a place.
    for (const bad of ['0x10', '+6', '1e3', '-1', '1.0', '0b11', '0o17', ' ', '', 'Infinity', '3px', '١٢']) {
      const raw = fixture();
      raw.events[0].competitions[0].competitors[0].order = bad;
      const field = entrantsOf(byId(await listF1(raw), FP1));
      expect(field.find((e) => e.name === 'Max Verstappen')?.position, `order ${JSON.stringify(bad)}`).toBeUndefined();
    }
  });

  it('§14: a plain decimal string IS a position — zero-padded and space-padded included', async () => {
    // The documented judgement call: '007' and ' 3 ' each have exactly one reading,
    // unlike a hex, signed or exponent literal.
    for (const [order, expected] of [
      ['007', 7],
      [' 3 ', 3],
      ['12', 12],
      [7, 7],
    ] as [unknown, number][]) {
      const raw = fixture();
      raw.events[0].competitions[0].competitors[0].order = order;
      const field = entrantsOf(byId(await listF1(raw), FP1));
      expect(field.find((e) => e.name === 'Max Verstappen')?.position, `order ${JSON.stringify(order)}`).toBe(expected);
    }
  });

  it('§14: MAX_FIELD_POSITION itself is a valid order — the bound is inclusive', async () => {
    const raw = fixture();
    raw.events[0].competitions[0].competitors[0].order = MAX_FIELD_POSITION;
    const field = entrantsOf(byId(await listF1(raw), FP1));
    expect(field.find((e) => e.name === 'Max Verstappen')?.position).toBe(MAX_FIELD_POSITION);
    // A valid-but-huge place still ranks, so it sorts ahead of the unranked tail.
    expect(field.map((e) => e.position)).toEqual([2, 4, MAX_FIELD_POSITION, undefined, undefined]);
  });

  it('a competitor with no athlete degrades to TBD rather than an empty name', async () => {
    const field = entrantsOf(byId(await listF1(fixture()), FP1));
    const tbd = field.find((e) => e.position === 4);
    expect(tbd?.name).toBe('TBD');
    expect(tbd?.abbrev).toBe('TBD');
    expect(tbd?.detail).toBeUndefined();
    expect(tbd?.id).toBe('9101');
  });

  it('detail prefers a populated gap statistic and falls back to the constructor', async () => {
    const field = entrantsOf(byId(await listF1(fixture()), FP1));
    expect(field.find((e) => e.name === 'Lando Norris')?.detail).toBe('+0.214');
    // `statistics` came back empty on every live probe, so the constructor carries the slot.
    expect(field.find((e) => e.name === 'Max Verstappen')?.detail).toBe('Red Bull');
    expect(field.find((e) => e.name === 'Oscar Piastri')?.detail).toBe('McLaren');
  });

  it('a long gap statistic is capped at the §14 detail length', async () => {
    const raw = fixture();
    raw.events[0].competitions[0].competitors[1].statistics[0].displayValue = 'x'.repeat(80);
    const field = entrantsOf(byId(await listF1(raw), FP1));
    expect(field.find((e) => e.name === 'Lando Norris')?.detail).toHaveLength(40);
  });

  it('P7: only a portrait on the allowlisted host becomes a logo', async () => {
    const field = entrantsOf(byId(await listF1(fixture()), FP1));
    expect(field.find((e) => e.name === 'Max Verstappen')?.logo?.light).toBe(
      'https://a.espncdn.com/combiner/i?img=/i/headshots/rpm/players/full/4665.png&w=64&h=64&transparent=true',
    );
    // secure.espncdn.com is NOT on src/ui/logoCache.ts's allowlist.
    expect(field.find((e) => e.name === 'Lando Norris')?.logo).toBeUndefined();
    expect(field.find((e) => e.name === 'Oscar Piastri')?.logo).toBeUndefined();
  });

  it('P9: an empty scoreboard is an empty list, not an error', async () => {
    await expect(listF1({ events: [] })).resolves.toEqual([]);
    await expect(listF1({})).resolves.toEqual([]);
    await expect(listF1({ events: null })).resolves.toEqual([]);
    await expect(listF1({ events: [{ id: '1', name: 'Quiet weekend' }] })).resolves.toEqual([]);
    await expect(listF1({ events: [{ id: '1', competitions: [] }] })).resolves.toEqual([]);
  });

  it('skips an event with no id, and a duplicate session id', async () => {
    const raw = fixture();
    delete raw.events[0].id;
    const games = await listF1(raw);
    expect(games.map((g) => g.id)).toEqual([gameId(FP4), gameId(NO_TYPE)]);

    const dup = fixture();
    dup.events[0].competitions[1].id = '600030401001'; // qualifying now claims FP1's id
    const { ctx, logs } = makeCtx(dup);
    const deduped = await espnRacingProvider.listGames(ctx, F1);
    expect(deduped.map((g) => g.id)).toEqual([gameId(FP1), gameId(RACE), gameId(FP4), gameId(NO_TYPE)]);
    expect(logs.some((l) => l.includes('duplicate session id'))).toBe(true);
  });
});

// --- native id: the two-poll defects ---------------------------------------

/** One session, spelled out, so an id can be built from exactly known operands. */
function weekend(eventId: string, compId: string, driver: string): Record<string, unknown> {
  return {
    id: eventId,
    name: 'Belgian GP',
    competitions: [
      {
        id: compId,
        type: { abbreviation: 'R' },
        status: { type: { state: 'post' } },
        competitors: [{ id: '1', order: 1, athlete: { fullName: driver, abbreviation: 'ALI' } }],
      },
    ],
  };
}

describe('espn-racing native ids', () => {
  it('ids are byte-identical across two identical fetches', async () => {
    const first = await listF1(fixture());
    const second = await listF1(fixture());
    expect(second.map((g) => g.id)).toEqual(first.map((g) => g.id));
  });

  it('ids do not move when the sessions are REORDERED between polls', async () => {
    // An index-derived id would follow the array; a feed-keyed one must not.
    const shuffled = fixture();
    for (const e of shuffled.events) e.competitions.reverse();
    shuffled.events.reverse();
    const before = await listF1(fixture());
    const after = await listF1(shuffled);
    expect(new Set(after.map((g) => g.id))).toEqual(new Set(before.map((g) => g.id)));
    // The session that carries no competition id is hash-keyed, so it moves too.
    expect(after.map((g) => g.id)).toContain(gameId(FP4));
    for (const g of after) {
      const twin = before.find((b) => b.id === g.id);
      expect(twin?.leagueName).toBe(g.leagueName);
    }
  });

  it('an event id containing ":" or "-" survives list → follow → poll', async () => {
    for (const eventId of ['EVT:1', 'EVT-1', 'E:V-T:1', '600030401']) {
      const payload = { events: [weekend(eventId, '111', 'Alice')] };
      const games = await listF1(payload);
      expect(games, eventId).toHaveLength(1);
      const game = games[0] as Game;
      // The colon must not have leaked into the id, where `lastSegment` cuts.
      expect(game.id.startsWith('espn-racing:f1:'), eventId).toBe(true);
      expect(game.id.slice('espn-racing:f1:'.length), eventId).not.toContain(':');
      // The round trip a poller makes: the listed game goes straight back in.
      const snap = await espnRacingProvider.fetchPlays(makeCtx(payload).ctx, game);
      expect(snap.game.id, eventId).toBe(game.id);
      expect(snap.events.map((e) => e.id), eventId).toEqual([
        `${game.id.slice('espn-racing:f1:'.length)}:start`,
        `${game.id.slice('espn-racing:f1:'.length)}:end`,
        `${game.id.slice('espn-racing:f1:'.length)}:result`,
      ]);
    }
  });

  it('event "A" + session "B-C" and event "A-B" + session "C" are TWO distinct games', async () => {
    const { ctx, logs } = makeCtx({ events: [weekend('A', 'B-C', 'Alice'), weekend('A-B', 'C', 'Bob')] });
    const games = await espnRacingProvider.listGames(ctx, F1);
    expect(games).toHaveLength(2);
    expect(new Set(games.map((g) => g.id)).size).toBe(2);
    // Neither weekend was silently swallowed by the dedupe.
    expect(logs.some((l) => l.includes('duplicate session id'))).toBe(false);
    expect(entrantsOf(games[0] as Game)[0]?.name).toBe('Alice');
    expect(entrantsOf(games[1] as Game)[0]?.name).toBe('Bob');
  });

  it('an ordinary numeric id is untouched by the escaping', async () => {
    const games = await listF1({ events: [weekend('600030401', '600030401005', 'Alice')] });
    expect(games[0]?.id).toBe(gameId('600030401-600030401005'));
  });
});

// --- P4: a practice session is not the race --------------------------------

describe('espn-racing session labelling (P4)', () => {
  it('names the SPECIFIC contest and its session in leagueName, not the series', async () => {
    const games = await listF1(fixture());
    expect(byId(games, FP1).leagueName).toBe('Moët & Chandon Belgian Grand Prix — Practice 1');
    expect(byId(games, QUALI).leagueName).toBe('Moët & Chandon Belgian Grand Prix — Qualifying');
    expect(byId(games, RACE).leagueName).toBe('Moët & Chandon Belgian Grand Prix — Race');
    // listLeagues still advertises the generic series.
    const leagues = await espnRacingProvider.listLeagues(makeCtx({}).ctx);
    expect(leagues[0]?.name).toBe('Formula 1');
  });

  it('carries the session in statusText and, where it fits, in the short status', async () => {
    const games = await listF1(fixture());
    expect(byId(games, FP1).statusText).toBe('Practice 1 · Final');
    expect(byId(games, FP1).statusShort).toBe('FP1 F');
    expect(byId(games, QUALI).statusText).toBe('Qualifying · LIVE');
    expect(byId(games, QUALI).statusShort).toBe('Q LIVE');
    // §14: status.period is the LAP number.
    expect(byId(games, RACE).statusText).toBe('Race · Final');
    expect(byId(games, RACE).statusShort).toBe('R F');
  });

  it('a live race reports the lap it is on', async () => {
    const raw = fixture();
    raw.events[0].competitions[2].status.type.state = 'in';
    const race = byId(await listF1(raw), RACE);
    expect(race.phase).toBe('in');
    expect(race.statusText).toBe('Race · Lap 44');
    expect(race.statusShort).toBe('R L44');
  });

  it('a code that would not fit is dropped whole rather than truncated', async () => {
    const raw = fixture();
    raw.events[0].competitions[0].type.abbreviation = 'Sprint';
    raw.events[0].competitions[0].status.type.state = 'in';
    raw.events[0].competitions[0].status.period = 12;
    const g = byId(await listF1(raw), FP1);
    expect(g.statusText).toBe('Sprint · Lap 12');
    expect(g.statusShort).toBe('Sprint'); // 'Sprint L12' is 10 chars — the state is dropped, not sliced
    expect(g.statusShort.length).toBeLessThanOrEqual(8);
  });

  it('the 8-char budget is measured on VISIBLE text, not on control characters', async () => {
    const raw = fixture();
    // This abbreviation renders as a bare 'Q': counting its invisible characters
    // against the budget would drop the session code the status is there for.
    raw.events[0].competitions[0].type.abbreviation = '\u0000\u0000\u0000\u0000Q';
    raw.events[0].competitions[0].status.type.state = 'in';
    delete raw.events[0].competitions[0].status.period;
    const g = byId(await listF1(raw), FP1);
    expect(g.statusShort).toBe('Q LIVE');
    expect(g.statusText).toBe('Qualifying \u00b7 LIVE');
  });

  it('no control character reaches the status strings', async () => {
    const raw = fixture();
    raw.events[0].competitions[0].type.abbreviation = '\u001b[31mFP1\u001b[0m';
    raw.events[0].competitions[1].type.abbreviation = '\u0007\u0008R\u007f';
    for (const g of await listF1(raw)) {
      // eslint-disable-next-line no-control-regex
      const control = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
      expect(control.test(g.statusShort), g.id).toBe(false);
      expect(control.test(g.statusText), g.id).toBe(false);
      expect(g.statusShort.length, g.id).toBeLessThanOrEqual(8);
    }
  });

  it('an unknown session abbreviation passes through, and a missing one is simply omitted', async () => {
    const games = await listF1(fixture());
    const fp4 = byId(games, FP4);
    expect(fp4.leagueName).toBe('Zandvoort Young Driver Test — FP4');
    expect(fp4.phase).toBe('pre');
    expect(fp4.statusShort).toBe('FP4'); // 'FP4 09:00' is 9 chars
    expect(fp4.statusText).toMatch(/^FP4 · \d{2}:\d{2}$/);

    const untyped = byId(games, NO_TYPE);
    expect(untyped.leagueName).toBe('Zandvoort Young Driver Test');
    expect(untyped.phase).toBe('unknown');
    expect(untyped.statusText).toBe('Delayed');
    expect(untyped.statusShort).toBe('Delayed');
  });

  it('the session phase comes from the SESSION, not from the weekend around it', async () => {
    const raw = fixture();
    expect(raw.events[0].status.type.state).toBe('post'); // the weekend as a whole
    raw.events[0].competitions[1].status.type.state = 'in';
    const games = await listF1(raw);
    expect(byId(games, FP1).phase).toBe('post');
    expect(byId(games, QUALI).phase).toBe('in');
    // A session with no status of its own inherits the weekend's.
    delete raw.events[0].competitions[1].status;
    expect(byId(await listF1(raw), QUALI).phase).toBe('post');
  });

  it('start times come from the session, falling back to the weekend', async () => {
    const games = await listF1(fixture());
    expect(byId(games, FP1).startTimeUtc).toBe('2026-07-24T11:30:00Z');
    expect(byId(games, RACE).startTimeUtc).toBe('2026-07-26T13:00:00Z');
    const raw = fixture();
    delete raw.events[0].competitions[0].date;
    expect(byId(await listF1(raw), FP1).startTimeUtc).toBe('2026-07-26T13:00:00Z');
  });
});

// --- malformed payloads ----------------------------------------------------

describe('espn-racing error handling', () => {
  it('a truncated/mistyped payload is ProviderError(parse), never a raw throw', async () => {
    for (const payload of ['{"events":[{"id"', 42, null, [], { events: 'nope' }, { events: 7 }]) {
      const err = await listF1(payload).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).kind).toBe('parse');
    }
  });

  it('the parse error carries a payload head for diagnostics', async () => {
    const err = (await listF1({ events: 'nope' }).catch((e: unknown) => e)) as ProviderError;
    expect(err.payloadHead).toContain('nope');
    expect((err.payloadHead ?? '').length).toBeLessThanOrEqual(300);
  });

  it('survives junk in place of every nested block', async () => {
    const raw = fixture();
    raw.events[0].competitions[0].competitors = 'nope';
    raw.events[0].competitions[1].type = 7;
    raw.events[0].competitions[2].status = 'gone';
    raw.events[1].competitions = null;
    const games = await listF1(raw);
    // FP1 lost its field (no entrants ⇒ no game); the other two degrade but survive.
    expect(games.map((g) => g.id)).toEqual([gameId(QUALI), gameId(RACE)]);
    for (const g of games) {
      expect(g.format).toBe('field');
      expect(entrantsOf(g).length).toBeGreaterThan(0);
      expect(g.statusText.length).toBeGreaterThan(0);
    }
    // With no readable status the race falls back to the weekend's, which reads 'post'.
    expect(byId(games, RACE).phase).toBe('post');
  });

  it('propagates a fetch-layer ProviderError unchanged', async () => {
    const boom = new ProviderError('rate-limit', 'slow down', 60000);
    await expect(espnRacingProvider.listGames(throwingCtx(boom), F1)).rejects.toBe(boom);
    await expect(espnRacingProvider.fetchPlays(throwingCtx(boom), stubGame(RACE))).rejects.toBe(boom);
  });

  it('a vanished session is not-found, and so is an unknown league', async () => {
    const gone = await espnRacingProvider.fetchPlays(makeCtx(fixture()).ctx, stubGame('999-999')).catch((e) => e);
    expect(gone).toBeInstanceOf(ProviderError);
    expect((gone as ProviderError).kind).toBe('not-found');

    const bad = { ...stubGame(RACE), leagueId: 'nascar' };
    const err = await espnRacingProvider.fetchPlays(makeCtx(fixture()).ctx, bad).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).kind).toBe('not-found');
  });

  it('fetchPlays on a truncated payload is ProviderError(parse)', async () => {
    const err = await espnRacingProvider.fetchPlays(makeCtx('{"events":[').ctx, stubGame(RACE)).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).kind).toBe('parse');
  });
});

// --- fetchPlays: D4/P5 events ----------------------------------------------

describe('espn-racing fetchPlays', () => {
  it('D4: session boundaries plus a result, all from one response', async () => {
    const snap = await espnRacingProvider.fetchPlays(makeCtx(fixture()).ctx, stubGame(RACE));
    expect(snap.events.map((e) => e.id)).toEqual([`${RACE}:start`, `${RACE}:end`, `${RACE}:result`]);
    expect(snap.events.map((e) => e.text)).toEqual([
      'Race under way',
      'Race complete',
      'Race result — P1 Max Verstappen, P2 Lando Norris, P3 Oscar Piastri',
    ]);
    expect(snap.events.map((e) => e.kind)).toEqual(['status', 'status', 'score']);
    expect(snap.events.map((e) => e.sequence)).toEqual([0, 1, 2]);
    // The lap advances every poll, so only the settled events carry it.
    expect(snap.events.map((e) => e.period)).toEqual([undefined, 'L44', 'L44']);
    for (const e of snap.events) {
      expect(e.gameId).toBe(gameId(RACE));
      expect(e.clock).toBeUndefined();
      // §14: a field contest has no two-sided score to report.
      expect(e.scoreAfter).toBeUndefined();
    }
    expect(snap.state).toBeUndefined();
  });

  it('P5: a live session emits its start line only — never a position-change stream', async () => {
    const snap = await espnRacingProvider.fetchPlays(makeCtx(fixture()).ctx, stubGame(QUALI));
    expect(snap.events.map((e) => e.id)).toEqual([`${QUALI}:start`]);
    expect(snap.events[0]?.text).toBe('Qualifying under way');
    // The running order is on the game, not in the relay — the UI rebuilds it each poll.
    expect(entrantsOf(snap.game).map((e) => e.name)).toEqual([
      'Charles Leclerc',
      'Lewis Hamilton',
      'George Russell',
    ]);
  });

  it('a session that has not started emits nothing at all', async () => {
    const snap = await espnRacingProvider.fetchPlays(makeCtx(fixture()).ctx, stubGame(FP4));
    expect(snap.events).toEqual([]);
    expect(snap.game.phase).toBe('pre');
  });

  it('§2: the snapshot game is re-derived, never the stale input game', async () => {
    const snap = await espnRacingProvider.fetchPlays(makeCtx(fixture()).ctx, stubGame(RACE));
    expect(snap.game.leagueName).toBe('Moët & Chandon Belgian Grand Prix — Race');
    expect(snap.game.phase).toBe('post');
    expect(snap.game.statusText).toBe('Race · Final');
    expect(snap.game.statusShort).toBe('R F');
    expect(snap.game.startTimeUtc).toBe('2026-07-26T13:00:00Z');
    expect(snap.game.format).toBe('field');
    expect(snap.game.home).toBeUndefined();
    expect(snap.game.away).toBeUndefined();
    expect(entrantsOf(snap.game)).toHaveLength(22);
  });

  it('event ids are stable across two identical fetches (the engine dedupes by id)', async () => {
    const first = await espnRacingProvider.fetchPlays(makeCtx(fixture()).ctx, stubGame(RACE));
    const second = await espnRacingProvider.fetchPlays(makeCtx(fixture()).ctx, stubGame(RACE));
    expect(second.events.map((e) => e.id)).toEqual(first.events.map((e) => e.id));
    expect(second.events.map((e) => e.text)).toEqual(first.events.map((e) => e.text));
    expect(second.events.map((e) => e.sequence)).toEqual(first.events.map((e) => e.sequence));
    expect(second.events.map((e) => e.period)).toEqual(first.events.map((e) => e.period));
  });

  it('the start line survives the session finishing, unchanged', async () => {
    // The relay engine would treat a shifted text as a correction, forever.
    const raw = fixture();
    raw.events[0].competitions[2].status.type.state = 'in';
    const live = await espnRacingProvider.fetchPlays(makeCtx(raw).ctx, stubGame(RACE));
    const finished = await espnRacingProvider.fetchPlays(makeCtx(fixture()).ctx, stubGame(RACE));
    expect(live.events.map((e) => e.id)).toEqual([`${RACE}:start`]);
    expect(finished.events[0]?.id).toBe(live.events[0]?.id);
    expect(finished.events[0]?.text).toBe(live.events[0]?.text);
    expect(finished.events[0]?.period).toBe(live.events[0]?.period);
  });

  it('a finished session with an unranked field states no result', async () => {
    const raw = fixture();
    for (const c of raw.events[0].competitions[2].competitors) delete c.order;
    const snap = await espnRacingProvider.fetchPlays(makeCtx(raw).ctx, stubGame(RACE));
    expect(snap.events.map((e) => e.id)).toEqual([`${RACE}:start`, `${RACE}:end`]);
    expect(entrantsOf(snap.game).every((e) => e.position === undefined)).toBe(true);
  });

  it('a result with fewer than three ranked finishers names the ones there are', async () => {
    const raw = fixture();
    raw.events[0].competitions[0].status.type.state = 'post';
    const snap = await espnRacingProvider.fetchPlays(makeCtx(raw).ctx, stubGame(FP1));
    // FP1 is ranked 1, 2, 4 — the podium stops at the first unranked entrant.
    expect(snap.events[2]?.text).toBe('Practice 1 result — P1 Max Verstappen, P2 Lando Norris, P4 TBD');
  });

  it('a session with no type names the contest instead of a raw placeholder', async () => {
    const raw = fixture();
    raw.events[1].competitions[2].status.type.state = 'in';
    const snap = await espnRacingProvider.fetchPlays(makeCtx(raw).ctx, stubGame(NO_TYPE));
    expect(snap.events[0]?.text).toBe('Zandvoort Young Driver Test under way');
  });
});

// --- localization (§12.1) --------------------------------------------------

describe('espn-racing localization', () => {
  it('composes Korean relay lines for the boundaries and the result', async () => {
    const snap = await espnRacingProvider.fetchPlays(makeCtx(fixture(), { locale: 'ko' }).ctx, stubGame(RACE));
    expect(snap.events.map((e) => e.text)).toEqual([
      '결승 시작',
      '결승 종료',
      '결승 결과 — 1위 Max Verstappen, 2위 Lando Norris, 3위 Oscar Piastri',
    ]);
  });

  it('localizes practice and qualifying too', async () => {
    const raw = fixture();
    raw.events[0].competitions[0].status.type.state = 'post';
    const fp1 = await espnRacingProvider.fetchPlays(makeCtx(raw, { locale: 'ko' }).ctx, stubGame(FP1));
    expect(fp1.events[0]?.text).toBe('연습주행 1 시작');
    const quali = await espnRacingProvider.fetchPlays(makeCtx(fixture(), { locale: 'ko' }).ctx, stubGame(QUALI));
    expect(quali.events[0]?.text).toBe('예선 시작');
  });

  it('an unknown session abbreviation keeps its raw English in both locales', async () => {
    const raw = fixture();
    raw.events[1].competitions[1].status.type.state = 'in';
    for (const locale of ['en', 'ko'] as RelayLocale[]) {
      const snap = await espnRacingProvider.fetchPlays(makeCtx(raw, { locale }).ctx, stubGame(FP4));
      expect(snap.events[0]?.text).toContain('FP4');
      expect(snap.events[0]?.text).not.toMatch(/racingSession/);
    }
  });

  it('every composed line renders in both locales with no leftover {placeholder}', async () => {
    const raw = fixture();
    raw.events[0].competitions[0].status.type.state = 'post';
    raw.events[1].competitions[1].status.type.state = 'post';
    raw.events[1].competitions[2].status.type.state = 'post';
    for (const locale of ['en', 'ko'] as RelayLocale[]) {
      for (const nativeId of [FP1, QUALI, RACE, FP4, NO_TYPE]) {
        const snap = await espnRacingProvider.fetchPlays(makeCtx(raw, { locale }).ctx, stubGame(nativeId));
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
