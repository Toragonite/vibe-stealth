import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DetailLevel, Game, ProviderContext, ProviderError, RelayLocale } from '../../src/core/contract';
import { nhlProvider } from '../../src/providers/nhl';

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

function nhlGame(gid: string): Game {
  return {
    id: `nhl:nhl:${gid}`,
    providerId: 'nhl',
    leagueId: 'nhl',
    leagueName: 'NHL',
    sport: 'hockey',
    startTimeUtc: undefined,
    phase: 'in',
    statusText: 'x',
    statusShort: 'x',
    home: { id: '7', name: 'Sabres', abbrev: 'BUF', score: undefined },
    away: { id: '25', name: 'Stars', abbrev: 'DAL', score: undefined },
  };
}

// --- listGames -------------------------------------------------------------

describe('nhl listGames (score/now)', () => {
  it('parses games with nickname names, OT/SO-aware Final status', async () => {
    const games = await nhlProvider.listGames(makeCtx(load('nhl-score.json')).ctx, {
      id: 'nhl',
      providerId: 'nhl',
      name: 'NHL',
      sport: 'hockey',
    });
    expect(games).toHaveLength(3);

    const g0 = games[0];
    expect(g0.id).toBe('nhl:nhl:2025021301');
    expect(g0.phase).toBe('post');
    expect(g0.away.name).toBe('Stars'); // name.default nickname
    expect(g0.away.abbrev).toBe('DAL');
    expect(g0.away.score).toBe(4);
    expect(g0.home.name).toBe('Sabres');
    expect(g0.home.score).toBe(3);
    expect(g0.startTimeUtc).toBe('2026-04-15T23:00:00Z');
    // game 1 ended in a shootout.
    expect(g0.statusShort).toBe('F/SO');
    expect(g0.statusText).toBe('Final (SO)');

    // game 2 ended in regulation.
    expect(games[1].statusShort).toBe('F');
    expect(games[1].statusText).toBe('Final');
  });

  it('maps gameState: FUT/PRE→pre, LIVE/CRIT→in, OFF/FINAL→post, else unknown', async () => {
    const base = load('nhl-score.json');
    const cases: Array<[string, string]> = [
      ['FUT', 'pre'],
      ['PRE', 'pre'],
      ['LIVE', 'in'],
      ['CRIT', 'in'],
      ['OFF', 'post'],
      ['FINAL', 'post'],
      ['WEIRD', 'unknown'],
    ];
    for (const [state, phase] of cases) {
      const mut = clone(base);
      mut.games[0].gameState = state;
      const games = await nhlProvider.listGames(makeCtx(mut).ctx, base);
      expect(games[0].phase).toBe(phase);
    }
  });

  it('falls back to abbrev when name absent', async () => {
    const mut = clone(load('nhl-score.json'));
    delete mut.games[0].awayTeam.name;
    const games = await nhlProvider.listGames(makeCtx(mut).ctx, mut);
    expect(games[0].away.name).toBe('DAL');
  });

  it('P5: unparsable startTimeUTC ⇒ startTimeUtc undefined', async () => {
    const mut = clone(load('nhl-score.json'));
    mut.games[0].startTimeUTC = 'TBD';
    const games = await nhlProvider.listGames(makeCtx(mut).ctx, mut);
    expect(games[0].startTimeUtc).toBeUndefined();
  });
});

// --- fetchPlays ------------------------------------------------------------

describe('nhl fetchPlays (play-by-play)', () => {
  it('sorts by sortOrder, templates events, and drops nothing emittable in the fixture', async () => {
    const snap = await nhlProvider.fetchPlays(makeCtx(load('nhl-play-by-play.json')).ctx, nhlGame('2025021301'));
    expect(snap.events.map((e) => e.sequence)).toEqual([8, 39, 139, 182, 824, 825, 829]);
    expect(snap.events.map((e) => e.id)).toEqual(['52', '78', '186', '227', '372', '373', '377']);
  });

  it('goal scorer fallback fires on the real fixture (scorer id absent from rosterSpots)', async () => {
    const snap = await nhlProvider.fetchPlays(makeCtx(load('nhl-play-by-play.json')).ctx, nhlGame('2025021301'));
    const goal1 = snap.events.find((e) => e.id === '78')!;
    expect(goal1.kind).toBe('score');
    expect(goal1.text).toBe('Goal — DAL 1, BUF 0'); // exact unresolvable fallback template
    expect(goal1.period).toBe('P1');
    expect(goal1.clock).toBe('02:19');
    expect(goal1.scoreAfter).toEqual({ home: 0, away: 1 });

    const goal2 = snap.events.find((e) => e.id === '227')!;
    expect(goal2.text).toBe('Goal — DAL 1, BUF 1');
  });

  it('resolves the scorer and enriches with season total (§12.4), no assists resolvable ⇒ nhlGoalNoAssist', async () => {
    const mut = clone(load('nhl-play-by-play.json'));
    mut.rosterSpots.push({
      teamId: 25,
      playerId: 8482145,
      firstName: { default: 'Mavrik' },
      lastName: { default: 'Bourque' },
    });
    // Enrichment happens in BOTH detail levels; assert in the default (summary) mode.
    const snap = await nhlProvider.fetchPlays(makeCtx(mut).ctx, nhlGame('2025021301'));
    const goal1 = snap.events.find((e) => e.id === '78')!;
    // shotType 'snap' (nhlShot.snap), scoringPlayerTotal 20; assist ids absent from rosterSpots.
    expect(goal1.text).toBe('snap goal — Mavrik Bourque (season goal #20)');
    expect(goal1.kind).toBe('score');
    // running score stays out of the composed text, but scoreAfter is retained.
    expect(goal1.scoreAfter).toEqual({ home: 0, away: 1 });
  });

  it('resolves assists and localizes the goal + assist clause in ko (§12.4)', async () => {
    const mut = clone(load('nhl-play-by-play.json'));
    mut.rosterSpots.push(
      { teamId: 25, playerId: 8482145, firstName: { default: 'Mavrik' }, lastName: { default: 'Bourque' } },
      { teamId: 25, playerId: 8476902, firstName: { default: 'Wyatt' }, lastName: { default: 'Johnston' } },
      { teamId: 25, playerId: 8480950, firstName: { default: 'Thomas' }, lastName: { default: 'Harley' } },
    );
    const en = await nhlProvider.fetchPlays(makeCtx(mut).ctx, nhlGame('2025021301'));
    expect(en.events.find((e) => e.id === '78')!.text).toBe(
      'snap goal — Mavrik Bourque (season goal #20) (assists: Wyatt Johnston, Thomas Harley)',
    );
    const ko = await nhlProvider.fetchPlays(makeCtx(mut, { locale: 'ko' }).ctx, nhlGame('2025021301'));
    expect(ko.events.find((e) => e.id === '78')!.text).toBe(
      '스냅 골 — Mavrik Bourque (시즌 20호) (도움: Wyatt Johnston, Thomas Harley)',
    );
  });

  it('applies pinned kinds and templates for status/penalty events', async () => {
    const snap = await nhlProvider.fetchPlays(makeCtx(load('nhl-play-by-play.json')).ctx, nhlGame('2025021301'));
    const byId = new Map(snap.events.map((e) => [e.id, e]));
    expect(byId.get('186')!.kind).toBe('play');
    expect(byId.get('186')!.text).toBe('Penalty — high sticking');
    expect(byId.get('52')!.kind).toBe('status');
    expect(byId.get('52')!.text).toBe('Start of P1');
    expect(byId.get('372')!.kind).toBe('status');
    expect(byId.get('372')!.text).toBe('Shootout complete');
    expect(byId.get('372')!.period).toBe('SO'); // period 5 ⇒ SO
    expect(byId.get('373')!.text).toBe('End of SO');
    expect(byId.get('377')!.text).toBe('Game over');
    // scoreAfter only on goals.
    expect(byId.get('186')!.scoreAfter).toBeUndefined();
    expect(byId.get('52')!.scoreAfter).toBeUndefined();
  });

  it('NOISE DROP: faceoff/hit/shot-on-goal/etc are not emitted at all', async () => {
    const mut = clone(load('nhl-play-by-play.json'));
    for (const key of ['faceoff', 'hit', 'takeaway', 'giveaway', 'blocked-shot', 'missed-shot', 'shot-on-goal', 'stoppage']) {
      mut.plays.push({
        eventId: 9000 + mut.plays.length,
        periodDescriptor: { number: 1 },
        timeInPeriod: '05:00',
        typeDescKey: key,
        sortOrder: 5000 + mut.plays.length,
        details: {},
      });
    }
    const snap = await nhlProvider.fetchPlays(makeCtx(mut).ctx, nhlGame('2025021301'));
    // still only the 7 emittable events from the fixture.
    expect(snap.events).toHaveLength(7);
    expect(snap.events.some((e) => Number(e.id) >= 9000)).toBe(false);
  });

  it('unknown typeDescKey ⇒ humanized text, kind play (never dropped silently)', async () => {
    const mut = clone(load('nhl-play-by-play.json'));
    mut.plays.push({
      eventId: 4242,
      periodDescriptor: { number: 2 },
      timeInPeriod: '10:00',
      typeDescKey: 'delayed-penalty',
      sortOrder: 100,
      details: {},
    });
    const snap = await nhlProvider.fetchPlays(makeCtx(mut).ctx, nhlGame('2025021301'));
    const ev = snap.events.find((e) => e.id === '4242')!;
    expect(ev.text).toBe('delayed penalty');
    expect(ev.kind).toBe('play');
  });

  it('period label maps 4→OT', async () => {
    const mut = clone(load('nhl-play-by-play.json'));
    mut.plays[0].periodDescriptor.number = 4;
    const snap = await nhlProvider.fetchPlays(makeCtx(mut).ctx, nhlGame('2025021301'));
    expect(snap.events.find((e) => e.id === '78')!.period).toBe('OT');
  });

  it('P3: invalid goal scores ⇒ scoreAfter undefined, never NaN', async () => {
    const mut = clone(load('nhl-play-by-play.json'));
    mut.plays[0].details.homeScore = 'N/A';
    mut.plays[0].details.awayScore = '1e9';
    const snap = await nhlProvider.fetchPlays(makeCtx(mut).ctx, nhlGame('2025021301'));
    expect(snap.events.find((e) => e.id === '78')!.scoreAfter).toBeUndefined();
  });
});

// --- §12.4: detail level ---------------------------------------------------

describe('nhl detail level (§12.4)', () => {
  // Push structured shot/hit + pure-noise plays onto the fixture so both levels
  // can be exercised (the committed fixture carries no shot/hit/faceoff plays).
  function withStructuredPlays(): any {
    const p = clone(load('nhl-play-by-play.json'));
    p.plays.push(
      { eventId: 5001, periodDescriptor: { number: 1 }, timeInPeriod: '05:00', typeDescKey: 'shot-on-goal', sortOrder: 300, details: { shotType: 'snap', zoneCode: 'O' } },
      { eventId: 5002, periodDescriptor: { number: 1 }, timeInPeriod: '05:10', typeDescKey: 'hit', sortOrder: 301, details: { zoneCode: 'D' } },
      { eventId: 5003, periodDescriptor: { number: 1 }, timeInPeriod: '05:20', typeDescKey: 'shot-on-goal', sortOrder: 302, details: { shotType: 'banana', zoneCode: 'N' } },
      { eventId: 5004, periodDescriptor: { number: 1 }, timeInPeriod: '05:30', typeDescKey: 'faceoff', sortOrder: 303, details: {} },
      { eventId: 5005, periodDescriptor: { number: 1 }, timeInPeriod: '05:40', typeDescKey: 'stoppage', sortOrder: 304, details: {} },
    );
    return p;
  }

  it('summary REGRESSION: byte-identical to today (goals fall back, no detail-only events)', async () => {
    // The committed fixture goal scorers are absent from rosterSpots ⇒ fallback line.
    const snap = await nhlProvider.fetchPlays(makeCtx(load('nhl-play-by-play.json')).ctx, nhlGame('2025021301'));
    expect(snap.events.map((e) => [e.id, e.text, e.kind])).toEqual([
      ['52', 'Start of P1', 'status'],
      ['78', 'Goal — DAL 1, BUF 0', 'score'],
      ['186', 'Penalty — high sticking', 'play'],
      ['227', 'Goal — DAL 1, BUF 1', 'score'],
      ['372', 'Shootout complete', 'status'],
      ['373', 'End of SO', 'status'],
      ['377', 'Game over', 'status'],
    ]);
  });

  it('summary DROPS all detail-only + noise plays (still the 7 fixture events)', async () => {
    const snap = await nhlProvider.fetchPlays(makeCtx(withStructuredPlays()).ctx, nhlGame('2025021301'));
    expect(snap.events).toHaveLength(7);
    expect(snap.events.some((e) => Number(e.id) >= 5000)).toBe(false);
  });

  it('detailed EMITS shots/hits, localized (en), enriched with shotType + zone', async () => {
    const snap = await nhlProvider.fetchPlays(makeCtx(withStructuredPlays(), { detail: 'detailed' }).ctx, nhlGame('2025021301'));
    const byId = new Map(snap.events.map((e) => [e.id, e]));
    expect(byId.get('5001')!.text).toBe('shot on goal — snap · offensive zone');
    expect(byId.get('5001')!.kind).toBe('play');
    expect(byId.get('5002')!.text).toBe('hit — defensive zone'); // no shotType
    // unknown shot type passes through untranslated (tEnum fallback).
    expect(byId.get('5003')!.text).toBe('shot on goal — banana · neutral zone');
  });

  it('detailed localizes shotType + zone in ko', async () => {
    const snap = await nhlProvider.fetchPlays(
      makeCtx(withStructuredPlays(), { detail: 'detailed', locale: 'ko' }).ctx,
      nhlGame('2025021301'),
    );
    const shot = snap.events.find((e) => e.id === '5001')!;
    expect(shot.text).toContain('스냅'); // nhlShot.snap
    expect(shot.text).toContain('공격 지역'); // nhlZone.o
    expect(shot.text).toContain('유효 슈팅'); // nhlEvent.shot-on-goal — label localized too
    expect(shot.text).toBe('유효 슈팅 — 스냅 · 공격 지역');
  });

  it('faceoff/stoppage are NEVER emitted at EITHER detail level', async () => {
    for (const detail of ['summary', 'detailed'] as const) {
      const snap = await nhlProvider.fetchPlays(makeCtx(withStructuredPlays(), { detail }).ctx, nhlGame('2025021301'));
      expect(snap.events.some((e) => e.id === '5004' || e.id === '5005')).toBe(false);
    }
  });
});

// --- §12.4: detailed fixture (nhl-detailed-plays.json) ---------------------
// Real trimmed payload: goal (scorer + assists all present in rosterSpots),
// shot-on-goal x2, hit x2, blocked-shot, takeaway, giveaway, faceoff, stoppage,
// penalty. Drives EVERY provider-composed NHL line through the production
// registry (imported, not re-registered) so a missing/English key surfaces here.

describe('nhl detailed fixture — full localization (§12.1 / §12.4)', () => {
  const DETAILED = 'nhl-detailed-plays.json';

  // Emitted set, sorted by sortOrder asc; faceoff (51) + stoppage (8) dropped at both levels.
  const EXPECTED_EN: Array<[string, string]> = [
    ['64', 'hit — offensive zone'],
    ['76', 'hit — defensive zone'],
    ['74', 'giveaway — offensive zone'],
    ['78', 'snap goal — Mavrik Bourque (season goal #20) (assists: Esa Lindell, Ilya Lyubushkin)'],
    ['85', 'blocked shot — defensive zone'],
    ['88', 'shot on goal — wrist · neutral zone'],
    ['112', 'shot on goal — wrist · offensive zone'],
    ['152', 'takeaway — defensive zone'],
    ['186', 'Penalty — high sticking'],
  ];
  const EXPECTED_KO: Array<[string, string]> = [
    ['64', '체크 — 공격 지역'],
    ['76', '체크 — 수비 지역'],
    ['74', '턴오버 — 공격 지역'],
    ['78', '스냅 골 — Mavrik Bourque (시즌 20호) (도움: Esa Lindell, Ilya Lyubushkin)'],
    ['85', '블록된 슈팅 — 수비 지역'],
    ['88', '유효 슈팅 — 리스트 · 중립 지역'],
    ['112', '유효 슈팅 — 리스트 · 공격 지역'],
    ['152', '스틸 — 수비 지역'],
    ['186', '페널티 — 하이스틱'],
  ];

  it('detailed en: every composed line renders, localized, no raw placeholder', async () => {
    const snap = await nhlProvider.fetchPlays(
      makeCtx(load(DETAILED), { detail: 'detailed' }).ctx,
      nhlGame('2025021301'),
    );
    expect(snap.events.map((e) => [e.id, e.text])).toEqual(EXPECTED_EN);
    for (const e of snap.events) expect(e.text, e.id).not.toMatch(/\{[a-zA-Z]+\}/);
  });

  it('detailed ko: every composed line differs from en and is Korean, no raw placeholder', async () => {
    const en = await nhlProvider.fetchPlays(
      makeCtx(load(DETAILED), { detail: 'detailed' }).ctx,
      nhlGame('2025021301'),
    );
    const ko = await nhlProvider.fetchPlays(
      makeCtx(load(DETAILED), { detail: 'detailed', locale: 'ko' }).ctx,
      nhlGame('2025021301'),
    );
    expect(ko.events.map((e) => [e.id, e.text])).toEqual(EXPECTED_KO);
    for (const e of ko.events) expect(e.text, e.id).not.toMatch(/\{[a-zA-Z]+\}/);
    // ko must differ from en on EVERY composed line (the whole line is ours).
    const enById = new Map(en.events.map((e) => [e.id, e.text]));
    for (const e of ko.events) expect(e.text, `id ${e.id} not localized`).not.toBe(enById.get(e.id));
  });

  it('enriched goal: scorer + season 20 + both assists, localized; score immutable from the goal', async () => {
    const ko = await nhlProvider.fetchPlays(
      makeCtx(load(DETAILED), { detail: 'detailed', locale: 'ko' }).ctx,
      nhlGame('2025021301'),
    );
    const goal = ko.events.find((e) => e.id === '78')!;
    expect(goal.kind).toBe('score');
    expect(goal.text).toBe('스냅 골 — Mavrik Bourque (시즌 20호) (도움: Esa Lindell, Ilya Lyubushkin)');
    expect(goal.text).toContain('시즌 20호');
    // the running/current score never appears in the composed text — only scoreAfter carries
    // this goal's OWN (immutable) details.awayScore/homeScore. The season total (20) is an
    // immutable per-event fact and legitimately does appear.
    expect(goal.scoreAfter).toEqual({ home: 0, away: 1 });
    expect(goal.text).not.toContain('DAL');
    expect(goal.text).not.toContain('BUF');
  });

  it('faceoff and stoppage are NEVER emitted at EITHER detail level', async () => {
    for (const detail of ['summary', 'detailed'] as const) {
      const snap = await nhlProvider.fetchPlays(makeCtx(load(DETAILED), { detail }).ctx, nhlGame('2025021301'));
      expect(snap.events.some((e) => e.id === '51' || e.id === '8')).toBe(false);
    }
  });

  it('summary: only the pinned typeDescKey set (goal + penalty here), detail-only events absent', async () => {
    const snap = await nhlProvider.fetchPlays(makeCtx(load(DETAILED)).ctx, nhlGame('2025021301'));
    // shot-on-goal/hit/blocked-shot/takeaway/giveaway are detail-only; faceoff/stoppage noise.
    expect(snap.events.map((e) => e.id)).toEqual(['78', '186']);
    expect(snap.events.map((e) => e.kind)).toEqual(['score', 'play']);
  });

  it('unknown shotType ⇒ API English passes through, no placeholder, line not dropped', async () => {
    const mut = clone(load(DETAILED));
    mut.plays.push({
      eventId: 6001,
      periodDescriptor: { number: 1 },
      timeInPeriod: '07:00',
      typeDescKey: 'shot-on-goal',
      sortOrder: 999,
      details: { shotType: 'between-the-legs', zoneCode: 'O' },
    });
    const en = await nhlProvider.fetchPlays(makeCtx(mut, { detail: 'detailed' }).ctx, nhlGame('2025021301'));
    const ko = await nhlProvider.fetchPlays(makeCtx(mut, { detail: 'detailed', locale: 'ko' }).ctx, nhlGame('2025021301'));
    expect(en.events.find((e) => e.id === '6001')!.text).toBe('shot on goal — between-the-legs · offensive zone');
    expect(ko.events.find((e) => e.id === '6001')!.text).toBe('유효 슈팅 — between-the-legs · 공격 지역');
    for (const e of [...en.events, ...ko.events]) expect(e.text, e.id).not.toMatch(/\{[a-zA-Z]+\}/);
  });

  it('unknown penalty descKey ⇒ API English passes through, no placeholder, line not dropped', async () => {
    const mut = clone(load(DETAILED));
    mut.plays.push({
      eventId: 6002,
      periodDescriptor: { number: 2 },
      timeInPeriod: '08:00',
      typeDescKey: 'penalty',
      sortOrder: 998,
      details: { descKey: 'unsportsmanlike-conduct' },
    });
    const en = await nhlProvider.fetchPlays(makeCtx(mut, { detail: 'detailed' }).ctx, nhlGame('2025021301'));
    const ko = await nhlProvider.fetchPlays(makeCtx(mut, { detail: 'detailed', locale: 'ko' }).ctx, nhlGame('2025021301'));
    expect(en.events.find((e) => e.id === '6002')!.text).toBe('Penalty — unsportsmanlike-conduct');
    expect(ko.events.find((e) => e.id === '6002')!.text).toBe('페널티 — unsportsmanlike-conduct');
    expect(en.events.find((e) => e.id === '6002')!.text).not.toMatch(/\{[a-zA-Z]+\}/);
    expect(ko.events.find((e) => e.id === '6002')!.text).not.toMatch(/\{[a-zA-Z]+\}/);
  });

  it('localizes known penalty descKeys through nhlPenaltyType.* (ko)', async () => {
    const mut = clone(load(DETAILED));
    const push = (id: number, desc: string, so: number): void => {
      mut.plays.push({
        eventId: id,
        periodDescriptor: { number: 1 },
        timeInPeriod: '01:00',
        typeDescKey: 'penalty',
        sortOrder: so,
        details: { descKey: desc },
      });
    };
    push(7001, 'tripping', 900);
    push(7002, 'cross-checking', 901);
    push(7003, 'too-many-men-on-the-ice', 902);
    const ko = await nhlProvider.fetchPlays(makeCtx(mut, { locale: 'ko' }).ctx, nhlGame('2025021301'));
    expect(ko.events.find((e) => e.id === '7001')!.text).toBe('페널티 — 트리핑');
    expect(ko.events.find((e) => e.id === '7002')!.text).toBe('페널티 — 크로스체킹');
    expect(ko.events.find((e) => e.id === '7003')!.text).toBe('페널티 — 인원 초과');
  });

  it('localizes period-start/end + game-over/shootout-complete/goalie-change (ko, §12.1)', async () => {
    // The committed detailed fixture carries no status events; push the pinned set to
    // prove the summary-level composed lines localize (P1 start, OT/SO ends, etc.).
    const mut = clone(load(DETAILED));
    const push = (id: number, key: string, num: number, so: number): void => {
      mut.plays.push({
        eventId: id,
        periodDescriptor: { number: num },
        timeInPeriod: '00:00',
        typeDescKey: key,
        sortOrder: so,
        details: {},
      });
    };
    push(8001, 'period-start', 1, 800);
    push(8002, 'period-end', 4, 801);
    push(8003, 'shootout-complete', 5, 802);
    push(8004, 'game-end', 5, 803);
    push(8005, 'goalie-change', 2, 804);
    const en = await nhlProvider.fetchPlays(makeCtx(mut).ctx, nhlGame('2025021301'));
    const ko = await nhlProvider.fetchPlays(makeCtx(mut, { locale: 'ko' }).ctx, nhlGame('2025021301'));
    const enText = (id: string): string => en.events.find((e) => e.id === id)!.text;
    const koText = (id: string): string => ko.events.find((e) => e.id === id)!.text;
    expect(enText('8001')).toBe('Start of P1');
    expect(koText('8001')).toBe('1피리어드 시작');
    expect(enText('8002')).toBe('End of OT');
    expect(koText('8002')).toBe('연장 종료');
    expect(enText('8003')).toBe('Shootout complete');
    expect(koText('8003')).toBe('승부치기 종료');
    expect(enText('8004')).toBe('Game over');
    expect(koText('8004')).toBe('경기 종료');
    expect(enText('8005')).toBe('Goalie change');
    expect(koText('8005')).toBe('골리 교체');
    for (const id of ['8001', '8002', '8003', '8004', '8005']) {
      expect(koText(id), `id ${id} not localized`).not.toBe(enText(id));
    }
  });
});

// --- P9: fresh game from the play-by-play feed -----------------------------

describe('nhl fetchPlays fresh game (P9 / §2 pin)', () => {
  // The committed fixture carries no top-level status block (only homeTeam/awayTeam
  // {id, abbrev}); the play-by-play feed adds gameState/scores/periodDescriptor/clock
  // at the top level (live-probe evidence 2026-07-08), so the terminal payload is
  // built here rather than mutating the shared fixture.
  function terminalPayload(): any {
    const p = clone(load('nhl-play-by-play.json'));
    p.gameState = 'OFF';
    p.homeTeam.score = 3; // BUF
    p.awayTeam.score = 4; // DAL
    p.periodDescriptor = { number: 5, periodType: 'SO' };
    p.clock = { timeRemaining: '00:00', running: false, inIntermission: false };
    return p;
  }

  it('rebuilds phase/scores/status from the feed top level, refreshing 4-3', async () => {
    const input = nhlGame('2025021301');
    input.phase = 'in';
    input.home.score = 1; // stale
    input.away.score = 0; // stale
    const snap = await nhlProvider.fetchPlays(makeCtx(terminalPayload()).ctx, input);

    // freshly derived (the OLD `return { game }` would leave phase 'in', scores 1/0).
    expect(snap.game.phase).toBe('post');
    expect(snap.game.away.score).toBe(4); // DAL — feed 4
    expect(snap.game.home.score).toBe(3); // BUF — feed 3
    expect(snap.game.statusShort).toBe('F/SO'); // periodType SO
    expect(snap.game.statusText).toBe('Final (SO)');
    // richer scoreboard names preserved (feed team blocks carry no name).
    expect(snap.game.away.name).toBe('Stars');
    expect(snap.game.home.name).toBe('Sabres');
    // events still parsed — a status refresh must never drop play lines.
    expect(snap.events.map((e) => e.id)).toEqual(['52', '78', '186', '227', '372', '373', '377']);
  });

  it('feed with no top-level gameState ⇒ input game carried through (phase unchanged)', async () => {
    const input = nhlGame('2025021301'); // phase 'in'
    const snap = await nhlProvider.fetchPlays(makeCtx(load('nhl-play-by-play.json')).ctx, input);
    expect(snap.game.phase).toBe('in');
    expect(snap.events).toHaveLength(7); // events still parsed
  });
});

// --- error semantics -------------------------------------------------------

describe('nhl error propagation', () => {
  it('propagates a ProviderError from fetchJson unchanged (auth — key-free 403)', async () => {
    const err = new ProviderError('auth', 'forbidden');
    await expect(nhlProvider.listGames(throwingCtx(err), nhlGame('1'))).rejects.toBe(err);
  });

  it('propagates a ProviderError unavailable from fetchPlays', async () => {
    const err = new ProviderError('unavailable', 'oversize');
    await expect(nhlProvider.fetchPlays(throwingCtx(err), nhlGame('1'))).rejects.toBe(err);
  });
});

// --- logos (§13) -----------------------------------------------------------

const NHL_LEAGUE = { id: 'nhl', providerId: 'nhl', name: 'NHL', sport: 'hockey' } as const;

describe('nhl logos (§13)', () => {
  it('populates team light logos from score/now; darkLogo absent ⇒ dark omitted', async () => {
    const games = await nhlProvider.listGames(makeCtx(load('nhl-score.json')).ctx, NHL_LEAGUE as any);
    expect(games[0].home.logo).toEqual({ light: 'https://assets.nhle.com/logos/nhl/svg/BUF_light.svg' });
    expect(games[0].away.logo).toEqual({ light: 'https://assets.nhle.com/logos/nhl/svg/DAL_light.svg' });
  });

  it('darkLogo present ⇒ dark populated (light + dark)', async () => {
    const mut = clone(load('nhl-score.json'));
    mut.games[0].homeTeam.darkLogo = 'https://assets.nhle.com/logos/nhl/svg/BUF_dark.svg';
    const games = await nhlProvider.listGames(makeCtx(mut).ctx, NHL_LEAGUE as any);
    expect(games[0].home.logo).toEqual({
      light: 'https://assets.nhle.com/logos/nhl/svg/BUF_light.svg',
      dark: 'https://assets.nhle.com/logos/nhl/svg/BUF_dark.svg',
    });
  });

  it('darkLogo null ⇒ dark omitted (light still populated)', async () => {
    const mut = clone(load('nhl-score.json'));
    mut.games[0].homeTeam.darkLogo = null;
    const games = await nhlProvider.listGames(makeCtx(mut).ctx, NHL_LEAGUE as any);
    expect(games[0].home.logo).toEqual({ light: 'https://assets.nhle.com/logos/nhl/svg/BUF_light.svg' });
  });

  it('garbage logo (number, empty, javascript:, ftp:) ⇒ omitted, no throw', async () => {
    for (const bad of [42, '', 'javascript:alert(1)', 'ftp://x/y.png']) {
      const mut = clone(load('nhl-score.json'));
      mut.games[0].homeTeam.logo = bad;
      const games = await nhlProvider.listGames(makeCtx(mut).ctx, NHL_LEAGUE as any);
      expect(games[0].home.logo).toBeUndefined();
    }
  });
});
