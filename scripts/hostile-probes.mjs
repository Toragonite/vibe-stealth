// Contract-breaking probe suite (docs/CONTRACT.md §8, probes P1–P11).
// Goal: BREAK the contract, not confirm it. Run: node scripts/hostile-probes.mjs
// Verification instrument — .vscodeignore'd, not shipped in the .vsix.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { createFetchJson } = require('../out/core/http.js');
const { createRelayEngine } = require('../out/core/relay.js');
const { createGamePoller, createSemaphore } = require('../out/core/poller.js');
const { formatEventLine, formatStatusBar } = require('../out/core/format.js');
const { coerceScore, sanitizeText, parseIsoUtc } = require('../out/core/util.js');
const { espnProvider } = require('../out/providers/espn.js');

const results = [];
const check = (id, desc, pass, observed) => {
  results.push({ id, desc, pass, observed });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${id}  ${desc}\n      observed: ${observed}`);
};

const G = (o = {}) => ({
  id: 'espn:nba:1', providerId: 'espn', leagueId: 'nba', leagueName: 'NBA', sport: 'basketball',
  startTimeUtc: '2026-07-08T10:00:00Z', phase: 'in', statusText: 'Q4', statusShort: 'Q4',
  home: { id: 'h', name: 'H', abbrev: 'HOM', score: 1 },
  away: { id: 'a', name: 'A', abbrev: 'AWY', score: 2 }, ...o,
});
const ev = (o) => ({ gameId: 'g', clock: undefined, period: undefined, kind: 'play', scoreAfter: undefined, ...o });
const FMT = { locale: 'en', showEmoji: false, multiGame: false, now: () => 0 };

// ---- P1: truncated / invalid JSON body ⇒ one `parse` error, no crash --------
{
  const fetchImpl = async () => new Response('{"events":[{"id"', { status: 200, headers: { 'content-type': 'application/json' } });
  const fetchJson = createFetchJson({ version: 't', log: () => {}, fetchImpl });
  let kind = 'NONE', head = '';
  try { await fetchJson('https://x/y'); } catch (e) { kind = e.kind; head = (e.payloadHead ?? '').slice(0, 16); }
  check('P1', 'truncated JSON ⇒ ProviderError(parse) with payloadHead, no crash',
    kind === 'parse' && head.length > 0, `kind=${kind} payloadHead="${head}"`);
}

// ---- P2: null text + duplicate ids ⇒ no null line, one line per unique id ----
{
  const snap = { game: G(), events: [
    ev({ id: 'a', sequence: 1, text: 'first' }),
    ev({ id: 'a', sequence: 2, text: 'dupe of a' }),   // duplicate id, first wins
    ev({ id: 'b', sequence: 3, text: 'second' }),
  ] };
  const em = createRelayEngine({ backfillLimit: 100, locale: 'en' }).ingest(snap);
  const plays = em.events.filter((e) => e.kind !== 'system');
  const nullDropped = sanitizeText(null) === undefined && sanitizeText('') === undefined;
  check('P2', 'null text dropped by sanitizer; duplicate id in one snapshot ⇒ first wins',
    nullDropped && plays.length === 2 && plays[0].text === 'first',
    `emitted=${plays.length} texts=${JSON.stringify(plays.map((e) => e.text))}`);
}

// ---- P3: hostile scores ⇒ undefined, UI shows '–', never NaN ---------------
{
  const inputs = ['N/A', '-1', '3.5', '1e9', '', ' ', null, undefined, {}, NaN, Infinity, '007'];
  const coerced = inputs.map(coerceScore);
  const onlyValid = coerced.every((v) => v === undefined || (Number.isInteger(v) && v >= 0 && v <= 999));
  const bar = formatStatusBar('AWY', undefined, undefined, 'HOM', 'Q4');
  check('P3', "hostile scores ⇒ undefined (never NaN/negative/absurd); status bar renders '–'",
    onlyValid && !/NaN/.test(bar) && bar.includes('–'),
    `coerced=${JSON.stringify(coerced)} bar="${bar}"`);
}

// ---- P4: snapshot shrinks then re-grows with changed text ⇒ ≤1 correction ---
{
  const engine = createRelayEngine({ backfillLimit: 100, locale: 'en' });
  engine.ingest({ game: G(), events: [ev({ id: 'x', sequence: 1, text: 'original' })] });
  engine.ingest({ game: G(), events: [] });                                       // vanished
  const a = engine.ingest({ game: G(), events: [ev({ id: 'x', sequence: 1, text: 'CHANGED' })] });
  const b = engine.ingest({ game: G(), events: [ev({ id: 'x', sequence: 1, text: 'CHANGED AGAIN' })] });
  const c = engine.ingest({ game: G(), events: [ev({ id: 'x', sequence: 1, text: 'FLAP' })] });
  const corrections = [...a.events, ...b.events, ...c.events].filter((e) => e.kind === 'correction');
  check('P4', 'correction storm ⇒ at most ONE correction per id, no duplicate originals',
    corrections.length === 1, `corrections=${corrections.length}`);
}

// ---- P5: hostile dates ⇒ parsed or undefined, never 'Invalid Date' ---------
{
  const cases = ['2026-07-07T18:15Z', '2026-07-08T18:30:00+09:00', 'TBD', '', '2026-13-45T99:99Z', null, '2026-07-08T18:30:00'];
  const out = cases.map(parseIsoUtc);
  const ok = out[0] === '2026-07-07T18:15:00Z' && out[1] === '2026-07-08T09:30:00Z' &&
    out.slice(2).every((v) => v === undefined) && !out.some((v) => String(v).includes('Invalid'));
  check('P5', "ESPN seconds-less ISO parses; 'TBD'/''/garbage/naive ⇒ undefined, never 'Invalid Date'",
    ok, JSON.stringify(out));
}

// ---- P6: 429 Retry-After: 120 ⇒ next poll armed ≥ 120s ---------------------
// ---- P6b: Retry-After: 99999999999 ⇒ huge delay, NOT Node's 1ms 32-bit wrap -
// Measures the ARMED DELAY directly. A fetch-gap assertion would be ambiguous:
// under P6b the delay is clamped to the 12h runaway deadline, so no 2nd fetch
// ever happens and any gap test would vacuously "pass".
{
  const NODE_MAX_TIMEOUT = 2 ** 31 - 1;
  for (const [label, retryAfter, minMs] of [['P6', '120', 120_000], ['P6b', '99999999999', 60_000]]) {
    let now = 0, timers = [];
    const armed = [];
    const timersApi = {
      now: () => now,
      setTimeout: (fn, ms) => { armed.push(ms); const h = { fn, at: now + Math.max(0, ms) }; timers.push(h); return h; },
      clearTimeout: (h) => { timers = timers.filter((x) => x !== h); },
    };
    const fetchImpl = async () => new Response('rate limited', { status: 429, headers: { 'retry-after': retryAfter } });
    const fetchJson = createFetchJson({ version: 't', log: () => {}, fetchImpl });
    const poller = createGamePoller({
      engine: { ingest: (s) => ({ events: [], game: s.game, scoreChanged: false, phaseTransition: undefined }) },
      initialPhase: 'in', startTimeUtc: undefined, liveSeconds: 20, timers: timersApi, semaphore: createSemaphore(4),
      callbacks: { fetchSnapshot: async () => { await fetchJson('https://x/y'); return { game: G(), events: [] }; },
        onEmission: () => {}, onSystemLine: () => {}, onAutoUnfollow: () => {}, onDiagnostic: () => {} },
    });
    poller.start();
    const flush = () => new Promise((r) => setImmediate(r));
    await flush();
    // Fire the initial armTick(0): the fake clock stores handles, it does not run them.
    // Then let the 429 round-trip settle so the rate-limit delay is armed.
    for (let i = 0; i < 4 && timers.length; i++) {
      timers.sort((a, b) => a.at - b.at);
      const t = timers.shift(); now = t.at; t.fn();
      await flush(); await flush();
      if (armed.length > 1) break;
    }
    poller.stop();
    // The rate-limit delay is the largest one armed after the initial armTick(0).
    const backoff = armed.length > 1 ? Math.max(...armed.slice(1)) : -1;
    const noWrap = backoff > 1 && backoff <= NODE_MAX_TIMEOUT;   // 1ms ⇒ Node 32-bit wrap
    check(label, `429 Retry-After ${retryAfter} ⇒ armed delay ≥ ${minMs}ms and ≤ 2^31-1 (no 1ms wrap)`,
      backoff >= minMs && noWrap, `armedDelay=${backoff}ms (Node cap ${NODE_MAX_TIMEOUT}) armed=${JSON.stringify(armed)}`);
  }
}

// ---- P7: 5000 events, backfillLimit 10 ⇒ exactly 11 lines ------------------
{
  const events = Array.from({ length: 5000 }, (_, i) => ev({ id: `e${i}`, sequence: i, text: `play ${i}` }));
  const t0 = Date.now();
  const em = createRelayEngine({ backfillLimit: 10, locale: 'en' }).ingest({ game: G(), events });
  const ms = Date.now() - t0;
  const sys = em.events.filter((e) => e.kind === 'system');
  const last = em.events[em.events.length - 1];
  check('P7', 'first ingest of 5000 events, backfillLimit 10 ⇒ exactly 11 lines (1 system + last 10)',
    em.events.length === 11 && sys.length === 1 && last.text === 'play 4999',
    `lines=${em.events.length} system=${sys.length} last="${last.text}" in ${ms}ms`);
}

// ---- P8: unicode / CJK / emoji intact end-to-end, ≤500 chars ---------------
{
  const hostile = 'CF Montréal ⚽ 롯데 자이언츠 9회말 🎉 ' + 'あ'.repeat(600);
  const clean = sanitizeText(hostile);
  const line = formatEventLine(ev({ id: 'u', sequence: 1, text: clean, kind: 'score' }), G(), FMT);
  check('P8', 'unicode/CJK/emoji survive; text hard-capped at 500 chars; line renders',
    clean.length === 500 && clean.startsWith('CF Montréal ⚽ 롯데') && clean.endsWith('…') &&
    line.includes('★') && line.includes('롯데'),
    `len=${clean.length} tail="${clean.slice(-3)}" line="${line.slice(0, 46)}…"`);
}

// ---- P9: terminal payload ⇒ phase 'post' (fresh-game pin, breaker B1) ------
{
  const ctx = { locale: 'en', now: () => 0, log: () => {}, getSecret: async () => undefined,
    fetchJson: async () => ({
      header: { competitions: [{ status: { type: { state: 'post', detail: 'Final', shortDetail: 'Final' } },
        competitors: [{ homeAway: 'home', score: '90', team: { abbreviation: 'SA' } },
                      { homeAway: 'away', score: '94', team: { abbreviation: 'NY' } }] }] },
      plays: [{ id: 'p', text: 'End of Game', period: { number: 4 }, awayScore: 94, homeScore: 90 }] }) };
  const snap = await espnProvider.fetchPlays(ctx, G({ phase: 'in' }));
  check('P9', "terminal ESPN payload ⇒ fetchPlays returns phase 'post' with refreshed score, events kept",
    snap.game.phase === 'post' && snap.game.home.score === 90 && snap.events.length === 1,
    `phase=${snap.game.phase} score=${snap.game.home.score}-${snap.game.away.score} events=${snap.events.length}`);
}

// ---- P10: provider never reports post ⇒ 12h runaway guard stops the loop ----
{
  let now = 0, timers = [];
  const timersApi = { now: () => now, setTimeout: (fn, ms) => { const h = { fn, at: now + Math.max(0, ms) }; timers.push(h); return h; }, clearTimeout: (h) => { timers = timers.filter((x) => x !== h); } };
  let ticks = 0, unfollow = 0; const lines = [];
  const poller = createGamePoller({
    engine: { ingest: (s) => ({ events: [], game: s.game, scoreChanged: false, phaseTransition: undefined }) },
    initialPhase: 'in', startTimeUtc: undefined, liveSeconds: 20, timers: timersApi, semaphore: createSemaphore(4),
    callbacks: { fetchSnapshot: async () => { ticks++; return { game: G({ phase: 'in' }), events: [] }; },
      onEmission: () => {}, onSystemLine: (k) => lines.push(k), onAutoUnfollow: () => { unfollow++; }, onDiagnostic: () => {} },
  });
  poller.start();
  const flush = () => new Promise((r) => setImmediate(r));
  await flush();
  const HORIZON = 13 * 60 * 60 * 1000;
  while (timers.length) { timers.sort((a, b) => a.at - b.at); const t = timers.shift(); now = t.at; if (now > HORIZON) break; t.fn(); await flush(); }
  check('P10', 'provider stuck at phase "in" ⇒ 12h runaway guard: loop stops, staleGame once, auto-unfollow once, 0 timers',
    lines.filter((l) => l === 'staleGame').length === 1 && unfollow === 1 && timers.length === 0 && ticks < 2200,
    `ticks=${ticks} lines=${JSON.stringify(lines)} unfollow=${unfollow} timersArmed=${timers.length}`);
}

// ---- P11: key-free 403 ⇒ network backoff, NO authRequired, no block --------
{
  let now = 0, timers = [];
  const timersApi = { now: () => now, setTimeout: (fn, ms) => { const h = { fn, at: now + Math.max(0, ms) }; timers.push(h); return h; }, clearTimeout: (h) => { timers = timers.filter((x) => x !== h); } };
  const lines = []; const fetchTimes = [];
  const { ProviderError } = require('../out/core/contract.js');
  const poller = createGamePoller({   // NOTE: isProviderBlocked omitted ⇒ key-free (§4)
    engine: { ingest: (s) => ({ events: [], game: s.game, scoreChanged: false, phaseTransition: undefined }) },
    initialPhase: 'in', startTimeUtc: undefined, liveSeconds: 20, timers: timersApi, semaphore: createSemaphore(4),
    callbacks: { fetchSnapshot: async () => { fetchTimes.push(now); throw new ProviderError('auth', 'ESPN transient 403'); },
      onEmission: () => {}, onSystemLine: (k) => lines.push(k), onAutoUnfollow: () => {}, onDiagnostic: () => {} },
  });
  poller.start();
  const flush = () => new Promise((r) => setImmediate(r));
  await flush();
  for (let i = 0; i < 8 && timers.length; i++) { timers.sort((a, b) => a.at - b.at); const t = timers.shift(); now = t.at; t.fn(); await flush(); }
  poller.stop();
  const gaps = fetchTimes.slice(1).map((t, i) => t - fetchTimes[i]);
  const growing = gaps.length >= 2 && gaps[gaps.length - 1] > gaps[0];
  check('P11', 'key-free provider 403 ⇒ exponential network backoff + connectionTrouble; NO authRequired line',
    !lines.includes('authRequired') && lines.includes('connectionTrouble') && growing,
    `lines=${JSON.stringify(lines)} gaps=${JSON.stringify(gaps)}`);
}

// ---- P12: multi-map series ⇒ one line per map, ZERO false corrections ------
{
  const { lolesportsProvider } = require('../out/providers/lolesports.js');
  const payload = (wins, states) => ({ data: { event: { state: null, match: { strategy: { count: 5 },
    teams: [{ code: 'G2', name: 'G2', result: { gameWins: wins[0] } }, { code: 'T1', name: 'T1', result: { gameWins: wins[1] } }],
    games: states.map((s, i) => ({ number: i + 1, state: s })) } } } });
  const ctx = (p) => ({ locale: 'en', now: () => 0, log: () => {}, getSecret: async () => undefined, fetchJson: async () => p });
  const g = G({ id: 'lolesports:msi:1', providerId: 'lolesports', leagueId: 'msi', leagueName: 'MSI',
    sport: 'esports', statusText: 'BO5', statusShort: 'G1',
    home: { id: 't', name: 'T1', abbrev: 'T1', score: 0 }, away: { id: 'g', name: 'G2', abbrev: 'G2', score: 0 } });
  const engine = createRelayEngine({ backfillLimit: 100, locale: 'en' });
  const emitted = [];
  // Poll once per finished map: the series score climbs 1:0 → 1:1 → 2:1.
  const polls = [[[1, 0], ['completed', 'unstarted', 'unstarted', 'unstarted', 'unstarted']],
                 [[1, 1], ['completed', 'completed', 'unstarted', 'unstarted', 'unstarted']],
                 [[2, 1], ['completed', 'completed', 'completed', 'unstarted', 'unstarted']]];
  for (const [wins, states] of polls) {
    const snap = await lolesportsProvider.fetchPlays(ctx(payload(wins, states)), g);
    emitted.push(...engine.ingest(snap).events);
  }
  const corrections = emitted.filter((e) => e.kind === 'correction');
  const texts = emitted.map((e) => e.text);
  check('P12', 'multi-map series ⇒ one line per map, ZERO false corrections (immutable-text pin)',
    corrections.length === 0 && emitted.length === 3 &&
      texts.join('|') === 'Game 1 complete|Game 2 complete|Game 3 complete',
    `emitted=${emitted.length} corrections=${corrections.length} texts=${JSON.stringify(texts)}`);
}

// ---- P13: state-build failure ⇒ events survive, state undefined (§11.2) -----
{
  const { mlbProvider } = require('../out/providers/mlb.js');
  // A live feed whose linescore/boxscore is booby-trapped to throw mid-state-build,
  // but whose plays are well-formed. State must degrade to undefined; plays survive.
  const hostilePayload = {
    gameData: { status: { abstractGameState: 'Live' },
      teams: { home: { abbreviation: 'HOM' }, away: { abbreviation: 'AWY' } }, datetime: {} },
    liveData: {
      plays: { allPlays: [{ about: { atBatIndex: 0, isComplete: true, halfInning: 'top', inning: 1 },
        result: { description: 'Leadoff single.', homeScore: 0, awayScore: 0 } }] },
      linescore: { get balls() { throw new Error('boom'); }, currentInning: 1, inningState: 'Top',
        teams: { home: { runs: 0 }, away: { runs: 0 } } },
      boxscore: { teams: { home: {}, away: {} } },
    },
  };
  const ctx = { locale: 'en', gameStateEnabled: true, now: () => 0, log: () => {}, getSecret: async () => undefined, fetchJson: async () => hostilePayload };
  const game = G({ id: 'mlb:mlb:1', providerId: 'mlb', leagueId: 'mlb', leagueName: 'MLB', sport: 'baseball', phase: 'in' });
  let snap, threw = false;
  try { snap = await mlbProvider.fetchPlays(ctx, game); } catch { threw = true; }
  check('P13', 'state-build throw ⇒ fetchPlays still returns events, state undefined, no throw',
    !threw && snap?.state === undefined && snap?.events.length === 1,
    `threw=${threw} state=${snap?.state} events=${snap?.events?.length}`);
}

// =============================================================================
// §14 field-event probes (P18–P23). The invariant under attack: a game is
// EITHER 'versus' with home+away, OR 'field' with a non-empty entrants list.
// Every probe below hands the UI a game that VIOLATES that pairing, or hands it
// semantically meaningless values that are structurally well-formed. Nothing
// here may throw: a malformed game must degrade to something renderable.
// =============================================================================

const { leadEntrant, formatLeader, statusBarText } = require('../out/core/format.js');
const { gameLabel, gameLine, contestName } = require('../out/ui/display.js');

/** Render a game through every surface at once; returns the outputs or the throw. */
const renderAll = (game) => {
  try {
    return {
      threw: false,
      label: gameLabel(game, 'en'),
      line: gameLine(game, 'en'),
      status: statusBarText(game, 'en'),
      contest: contestName(game),
    };
  } catch (e) {
    return { threw: true, err: `${e?.name}: ${e?.message}` };
  }
};

const F = (o = {}) => ({
  id: 'espn-racing:f1:x', providerId: 'espn-racing', leagueId: 'f1',
  leagueName: 'Belgian Grand Prix', sport: 'motorsport',
  startTimeUtc: '2026-07-08T10:00:00Z', phase: 'in', statusText: 'Lap 32', statusShort: 'L32',
  format: 'field', home: undefined, away: undefined,
  entrants: [{ id: '1', position: 1, name: 'Max Verstappen', abbrev: 'VER', detail: 'Red Bull', logo: undefined }],
  ...o,
});

// ---- P18: field game with an EMPTY entrants list (violates non-empty pin) ----
{
  const r = renderAll(F({ entrants: [] }));
  check('P18', "field game with entrants:[] ⇒ degrades to contest name, never throws, never invents a score",
    !r.threw && typeof r.label === 'string' && r.label.length > 0 && !/\d+\s*[:\-–]\s*\d+/.test(r.label),
    r.threw ? r.err : `label=${JSON.stringify(r.label)} status=${JSON.stringify(r.status)}`);
}

// ---- P19: BOTH shapes present at once (home/away AND entrants) --------------
{
  const r = renderAll(F({
    home: { id: 'h', name: 'H', abbrev: 'HOM', score: 3 },
    away: { id: 'a', name: 'A', abbrev: 'AWY', score: 2 },
  }));
  // format is the discriminator: 'field' must WIN, so no two-sided score renders.
  check('P19', "format:'field' but home/away also set ⇒ discriminator wins, no fake 'AWY 2:3 HOM' score",
    !r.threw && !/AWY|HOM/.test(r.label) && !/\d+\s*[:\-–]\s*\d+/.test(r.label),
    r.threw ? r.err : `label=${JSON.stringify(r.label)}`);
}

// ---- P20: semantically meaningless positions that are structurally fine -----
{
  const bad = [0, -1, 1.5, NaN, Infinity, -Infinity, '1', null, undefined, 1e308];
  const ent = bad.map((p, i) => ({ id: String(i), position: p, name: `D${i}`, abbrev: `D${i}`, detail: undefined, logo: undefined }));
  // Only a 1-based positive INTEGER is a real position; every value above is not.
  ent.push({ id: 'ok', position: 7, name: 'Real Driver', abbrev: 'RLD', detail: undefined, logo: undefined });
  const g = F({ entrants: ent });
  const lead = leadEntrant(g.entrants); // takes the entrants array, not the game
  const r = renderAll(g);
  check('P20', 'hostile positions (0/-1/1.5/NaN/±Inf/string/null/1e308) rejected ⇒ leader is the only valid one',
    !r.threw && lead?.abbrev === 'RLD' && !/NaN|Infinity|undefined|null/.test(r.label + r.status),
    r.threw ? r.err : `lead=${lead?.abbrev} pos=${lead?.position} label=${JSON.stringify(r.label)}`);
}

// ---- P21: entrants is not an array at all (hostile type confusion) ----------
{
  const shapes = [null, 'VER', 42, {}, { length: 3 }, [null], [undefined], [{}]];
  let threw = null, dirty = null;
  for (const s of shapes) {
    const r = renderAll(F({ entrants: s }));
    if (r.threw) { threw = `${JSON.stringify(s)} → ${r.err}`; break; }
    if (/undefined|null|NaN|\[object/.test(String(r.label))) { dirty = `${JSON.stringify(s)} → ${r.label}`; break; }
  }
  check('P21', 'entrants of every wrong type (null/string/number/{}/[null]/[{}]) ⇒ no throw, no leaked undefined/[object',
    threw === null && dirty === null,
    threw ? `THREW ${threw}` : dirty ? `DIRTY ${dirty}` : `all ${shapes.length} hostile shapes degraded cleanly`);
}

// ---- P22: versus game missing a side (the mirror-image violation) -----------
{
  const V = (o) => ({ ...G(), format: 'versus', entrants: undefined, ...o });
  const cases = [{ home: undefined }, { away: undefined }, { home: undefined, away: undefined }];
  let bad = null;
  for (const c of cases) {
    const r = renderAll(V(c));
    if (r.threw) { bad = `${JSON.stringify(Object.keys(c))} → ${r.err}`; break; }
    if (/undefined|NaN|\[object/.test(String(r.label) + String(r.status))) { bad = `${JSON.stringify(Object.keys(c))} → ${r.label} / ${r.status}`; break; }
  }
  check('P22', "format:'versus' with a missing side ⇒ degrades, never throws, never prints 'undefined'",
    bad === null, bad ? `BAD ${bad}` : 'all 3 missing-side cases degraded cleanly');
}

// ---- P23: absurdly large field ⇒ bounded output, no explosion ---------------
{
  const many = Array.from({ length: 5000 }, (_, i) => ({
    id: String(i), position: i + 1, name: `Driver ${i}`, abbrev: `D${i}`, detail: undefined, logo: undefined,
  }));
  const t0 = Date.now();
  const r = renderAll(F({ entrants: many }));
  const ms = Date.now() - t0;
  // The row must stay a ROW: the whole 5000-strong field must not be inlined.
  check('P23', '5000-entrant field ⇒ label stays bounded (≤200 chars) and renders fast (<250ms)',
    !r.threw && typeof r.label === 'string' && r.label.length <= 200 && ms < 250,
    r.threw ? r.err : `len=${r.label.length} ms=${ms} label=${JSON.stringify(r.label.slice(0, 60))}`);
}

// ---- P24: tennis D3 — score MUST be sets won, never games in a set ----------
{
  const ctx = { locale: 'en', now: () => Date.parse('2026-07-08T12:00:00Z'), log: () => {},
    getSecret: async () => undefined,
    fetchJson: async () => ({ events: [{ id: 't1', name: 'Probe Open', date: '2026-07-08T10:00:00Z',
      groupings: [{ grouping: { slug: 'mens-singles', displayName: "Men's Singles" }, competitions: [{
        id: 'm1', date: '2026-07-08T10:00:00Z',
        status: { type: { state: 'post', completed: true, description: 'Final', shortDetail: 'Final' } },
        competitors: [
          { id: 'a', winner: true, score: null, athlete: { displayName: 'Winner Player' },
            linescores: [{ value: 6, winner: true }, { value: 7, winner: true }] },
          { id: 'b', winner: false, score: null, athlete: { displayName: 'Loser Player' },
            linescores: [{ value: 2, winner: false }, { value: 5, winner: false }] }] }] }] }] }) };
  const { espnTennisProvider } = require('../out/providers/espnTennis.js');
  let games = [], err = null;
  try { games = await espnTennisProvider.listGames(ctx, { id: 'atp', providerId: 'espn-tennis', name: 'ATP Tour', sport: 'tennis' }); }
  catch (e) { err = `${e?.name}: ${e?.message}`; }
  const g = games[0];
  const scores = g ? [g.home?.score, g.away?.score].sort((a, b) => b - a) : [];
  // 6-2, 7-5 is a straight-sets win: the score is 2–0 (SETS), never 6, 7, 13 or 2.
  check('P24', 'tennis 6-2 7-5 ⇒ score is SETS won (2–0), never games (6/7/13) [contract D3]',
    !err && scores[0] === 2 && scores[1] === 0 && g?.format === 'versus' && g?.entrants === undefined,
    err ? `ERROR ${err}` : `scores=${JSON.stringify(scores)} format=${g?.format} status=${JSON.stringify(g?.statusText)}`);
}

// ---- P25: TWO evolving polls ⇒ zero false corrections (gate-gap closer) ----
// The adversarial review's structural finding: every probe above tests ONE
// snapshot, but the worst defects (a set published early then retracted, a bout
// id derived from an array index that shifts) only appear on the SECOND poll.
// This probe ingests two evolving payloads through a REAL relay engine and
// asserts the immutable-text pin: an id that reappears must carry the same text,
// so no line is ever retracted as a 'correction'.
{
  const { espnTennisProvider } = require('../out/providers/espnTennis.js');
  const board = (sets) => ({
    events: [{ id: 't1', name: 'Probe Open', date: '2026-07-08T10:00:00Z',
      groupings: [{ grouping: { slug: 'mens-singles', displayName: "Men's Singles" }, competitions: [{
        id: 'm1', date: '2026-07-08T10:00:00Z',
        status: { type: { state: 'in', completed: false, description: 'In Progress', shortDetail: 'Set 2' } },
        competitors: [
          { id: 'a', winner: false, score: null, athlete: { displayName: 'Alpha Player' },
            linescores: sets.map(([h]) => ({ value: h })) },
          { id: 'b', winner: false, score: null, athlete: { displayName: 'Beta Player' },
            linescores: sets.map(([, a]) => ({ value: a })) }] }] }] }] });

  const league = { id: 'atp', providerId: 'espn-tennis', name: 'ATP Tour', sport: 'tennis' };
  const mk = (payload) => ({ locale: 'en', now: () => Date.parse('2026-07-08T12:00:00Z'), log: () => {},
    getSecret: async () => undefined, fetchJson: async () => payload });

  // Poll 1: set 1 done (6-4), set 2 under way at 5-3. Poll 2: set 2 reached 6-4.
  const g1 = (await espnTennisProvider.listGames(mk(board([[6, 4], [5, 3]])), league))[0];
  const s1 = await espnTennisProvider.fetchPlays(mk(board([[6, 4], [5, 3]])), g1);
  const s2 = await espnTennisProvider.fetchPlays(mk(board([[6, 4], [6, 4]])), g1);

  const engine = createRelayEngine({ backfillLimit: 50, locale: 'en' });
  const e1 = engine.ingest(s1);
  const e2 = engine.ingest(s2);
  const all = [...e1.events, ...e2.events];
  const corrections = all.filter((e) => e.kind === 'correction');
  // Any id emitted twice must carry identical text — that is the pin.
  const byId = new Map();
  let mutated = null;
  for (const e of all) {
    if (byId.has(e.id) && byId.get(e.id) !== e.text) mutated = `${e.id}: "${byId.get(e.id)}" → "${e.text}"`;
    byId.set(e.id, e.text);
  }
  check('P25', 'two EVOLVING polls through a real engine ⇒ 0 corrections, no emitted text ever mutates',
    corrections.length === 0 && mutated === null,
    `corrections=${corrections.length} mutated=${mutated ?? 'none'} poll1=${e1.events.length} poll2=${e2.events.length}`);
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} probes passed`);
if (failed.length) console.log('FAILED: ' + failed.map((f) => f.id).join(', '));
process.exit(failed.length ? 1 : 0);
