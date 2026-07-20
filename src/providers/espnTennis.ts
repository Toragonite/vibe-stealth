/**
 * ESPN Tennis provider (key-free, unofficial) — ATP and WTA.
 *
 * Layering: no 'vscode' import, no npm dependencies. Every field access on the
 * ESPN JSON is defensive; a shape surprise is wrapped in ProviderError('parse')
 * and one malformed list entry is skipped (logged), never fatal.
 *
 * Tennis nests differently from every other ESPN sport. Elsewhere an `event` IS
 * the match; here an `event` is a TOURNAMENT and the matches sit two levels
 * deeper:
 *
 *   events[]            — tournament ('Nordea Open')
 *     groupings[]       — a draw ('Women's Singles')
 *       competitions[]  — THE MATCHES (one grouping has carried 31 of them)
 *         competitors[] — always exactly two
 *
 * There is no upstream play-by-play (`tennis/atp/summary?event=…` does not even
 * return JSON), so both the relay text and the game status are COMPOSED here
 * from the structured score — and per §12.1 provider-composed text is localized.
 */

import {
  Game,
  League,
  LogoRef,
  PlayEvent,
  PlaySnapshot,
  ProviderContext,
  ProviderError,
  RelayLocale,
  SportProvider,
  TeamSide,
} from '../core/contract';
import { registerMessages, t } from '../core/i18n';
import { coerceScore, normalizeWs, parseIsoUtc, sanitizeText } from '../core/util';

const PROVIDER_ID = 'espn-tennis';
const BASE = 'https://site.api.espn.com/apis/site/v2/sports/tennis/';

interface TennisLeagueDef {
  id: string;
  name: string;
}

const TENNIS_LEAGUES: TennisLeagueDef[] = [
  { id: 'atp', name: 'ATP Tour' },
  { id: 'wta', name: 'WTA Tour' },
];

// --- i18n (§12.1) ----------------------------------------------------------

/**
 * Every relay line this provider emits is composed from structured fields — the
 * upstream carries no prose at all — so all of it is localized (§12.1).
 *
 * The templates are registered from here rather than added to the core table in
 * src/core/i18n.ts: that file is owned by another task in this workspace, and
 * `registerMessages` is the pinned public API for exactly this (§9). Registration
 * happens at import time and is idempotent, so a test may override any key
 * afterwards and its value wins.
 *
 * Placeholder discipline mirrors the pitch lines: a variant exists for every
 * combination of tokens that can be absent, so a template only ever references
 * placeholders it is guaranteed to receive and a raw `{placeholder}` can never
 * render.
 */
const EN_TENNIS: Record<string, string> = {
  // `games` is winner-first, e.g. '6-2'; `n` is the 1-based set number.
  tennisSet: 'Set {n} — {winner} {games}',
  // Set complete but the winner is undeterminable ⇒ games in home-away order.
  tennisSetNoWinner: 'Set {n} — {games}',
  // `score` is the full per-set game list from the winner's side, e.g. '6-2, 4-6, 7-5'.
  tennisFinal: 'Match over — {winner} def. {loser} {score}',
  tennisFinalNoScore: 'Match over — {winner} def. {loser}',
  tennisFinalNoWinner: 'Match over — {home} vs {away}: {score}',
  tennisFinalBare: 'Match over',
};

const KO_TENNIS: Record<string, string> = {
  tennisSet: '{n}세트 — {winner} {games}',
  tennisSetNoWinner: '{n}세트 — {games}',
  tennisFinal: '경기 종료 — {winner} 승, {loser} 패 — {score}',
  tennisFinalNoScore: '경기 종료 — {winner} 승, {loser} 패',
  tennisFinalNoWinner: '경기 종료 — {home} 대 {away}: {score}',
  tennisFinalBare: '경기 종료',
};

registerMessages('en', EN_TENNIS);
registerMessages('ko', KO_TENNIS);

// --- defensive helpers -----------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}
function rec(v: unknown): Record<string, unknown> {
  return isRecord(v) ? v : {};
}
function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function str(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return '';
}
function lastSegment(id: string): string {
  const i = id.lastIndexOf(':');
  return i >= 0 ? id.slice(i + 1) : id;
}
function localHHMM(iso: string | undefined): string {
  if (!iso) return 'TBD';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'TBD';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
/** First ≤ 300 chars of an offending payload, for ProviderError diagnostics. */
function payloadHead(raw: unknown): string {
  try {
    const s = JSON.stringify(raw);
    return (typeof s === 'string' ? s : String(raw)).slice(0, 300);
  } catch {
    return '';
  }
}

// --- logos (§13) -----------------------------------------------------------

/** §13.2b: a tree icon paints at ~16 px — ask the CDN for a small image. */
const LOGO_PX = 64;

/**
 * P7. The ONLY host a tennis headshot may come from: the one ESPN host already
 * on the logo cache's allowlist (src/ui/logoCache.ts). A headshot served from
 * anywhere else yields `undefined` rather than a URL the cache would reject —
 * this provider does not add hosts.
 */
const ALLOWED_LOGO_HOST = 'a.espncdn.com';

/**
 * Coerce a candidate logo URL (§13.3): must be a non-empty string; a leading
 * `http://` is upgraded to `https://`; the result must then start with
 * `https://`, else undefined. Never throws.
 */
function normLogoUrl(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  let s = v.trim();
  if (s === '') return undefined;
  if (s.startsWith('http://')) s = `https://${s.slice(7)}`;
  return s.startsWith('https://') ? s : undefined;
}

/**
 * Resize an ESPN image URL to LOGO_PX (§13.2b/§13.3). The caller has already
 * pinned the host, so only the two known path shapes are rewritten; anything
 * else passes through unresized (a big headshot beats a broken one).
 */
function resizeEspnLogo(url: string): string {
  try {
    const u = new URL(url);
    if (u.pathname.startsWith('/combiner/i')) {
      u.searchParams.set('w', String(LOGO_PX));
      u.searchParams.set('h', String(LOGO_PX));
      return u.toString();
    }
    if (u.pathname.startsWith('/i/')) {
      return `https://${ALLOWED_LOGO_HOST}/combiner/i?img=${u.pathname}&w=${LOGO_PX}&h=${LOGO_PX}&transparent=true`;
    }
    return url;
  } catch {
    return url;
  }
}

/** `headshot` arrives either as `{ href }` or as a bare string, depending on the draw. */
function headshotHref(v: unknown): unknown {
  const h = rec(v).headshot;
  return isRecord(h) ? h.href : h;
}

/** P7: an https headshot on the allowlisted host, resized; anything else undefined. */
function headshotRef(v: unknown): LogoRef | undefined {
  const url = normLogoUrl(v);
  if (url === undefined) return undefined;
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return undefined;
  }
  if (host !== ALLOWED_LOGO_HOST) return undefined;
  return { light: resizeEspnLogo(url) };
}

// --- competitors -----------------------------------------------------------

function athleteName(v: unknown): string | undefined {
  const a = rec(v);
  return sanitizeText(a.displayName) ?? sanitizeText(a.fullName) ?? sanitizeText(a.shortName);
}

/** What a competitor is called, plus the compact form when the feed offers one. */
interface CompetitorNames {
  /** Full display name — the tree row and every composed relay line use this. */
  name: string;
  /** Feed-supplied short form, e.g. 'M. Lumsden / Q. Tang'. Drives the abbrev only. */
  short?: string;
}

/** Athlete names out of a roster list; entries are `{ athlete }` OR bare athletes. */
function rosterAthleteNames(entries: unknown[]): string[] {
  const names: string[] = [];
  for (const entry of entries) {
    const name = athleteName(rec(entry).athlete) ?? athleteName(entry);
    if (name !== undefined) names.push(name);
  }
  return names;
}

/**
 * The pair name for a doubles competitor. Live evidence (WTA competition 180298):
 * `roster` is an OBJECT carrying the assembled pair name —
 *
 *   "roster": { "displayName": "Maia Lumsden / Tang Qianhui",
 *               "shortDisplayName": "M. Lumsden / Q. Tang",
 *               "athletes": [ { "displayName": "Maia Lumsden", … }, … ] }
 *
 * — while `athlete` and `team` are both null. The array form read here as well is
 * NOT what the feed sends; it stays because `roster` is upstream-shaped and the
 * loop that tolerates it costs nothing. Absent, null and every other type simply
 * yield undefined, so the caller falls through. Never throws.
 */
function rosterNames(raw: unknown): CompetitorNames | undefined {
  if (Array.isArray(raw)) {
    const pair = rosterAthleteNames(raw);
    return pair.length > 0 ? { name: pair.join(' / ') } : undefined;
  }
  if (!isRecord(raw)) return undefined;
  const pair = rosterAthleteNames(asArray(raw.athletes));
  // The assembled name wins; `athletes[]` alone is joined into one.
  const name = sanitizeText(raw.displayName) ?? (pair.length > 0 ? pair.join(' / ') : undefined);
  if (name === undefined) return undefined;
  const short = sanitizeText(raw.shortDisplayName);
  return short === undefined ? { name } : { name, short };
}

/**
 * P6. Singles carry `competitor.athlete`; a doubles pair carries `competitor.roster`
 * and leaves `athlete` null, so the name is assembled defensively: the athlete, else
 * the roster's pair name, else the team name the feed supplies, else the competitor's
 * own name. Never empty — 'TBD' is the floor, and an unfilled bracket slot legitimately
 * lands there.
 */
function competitorNames(c: Record<string, unknown>): CompetitorNames {
  const solo = athleteName(c.athlete);
  if (solo !== undefined) return { name: solo };
  const pair = rosterNames(c.roster);
  if (pair !== undefined) return pair;
  const team = rec(c.team);
  return {
    name:
      sanitizeText(team.displayName) ??
      sanitizeText(team.name) ??
      sanitizeText(c.displayName) ??
      sanitizeText(c.name) ??
      'TBD',
  };
}

/** Last word of a name — the surname for the forms ESPN emits. Never empty for non-empty input. */
function surnameOf(name: string): string {
  const words = normalizeWs(name).split(' ');
  const last = words[words.length - 1] ?? '';
  return last || normalizeWs(name);
}

/**
 * §2 abbrev rule (≤ 5 chars) adapted to person names.
 *
 * Singles keeps the historical code: 3 letters of the surname, 'Erik Lund' → 'LUN'.
 *
 * A pair cannot be summarised as informatively — five characters do not hold two
 * surnames — so the trade-off taken is BREADTH OVER DEPTH: 2 letters of each
 * player's surname joined by '/', 'Maia Lumsden / Tang Qianhui' → 'LU/TA'. Naming
 * both players and marking the side as a pair beats spelling one surname in full
 * and reading like a singles entry; the cost is that 2 letters collide more easily
 * than 3, which the '/' at least makes legible as a pair rather than as a name.
 *
 * The feed's short form is the preferred source: `shortDisplayName`
 * ('M. Lumsden / Q. Tang') puts the surname last for every player, whereas
 * `displayName` does not for surname-first names ('Tang Qianhui'), where the last
 * word is the GIVEN name and a naive read yields 'QI'.
 */
function abbrevFor(names: CompetitorNames): string {
  const source = names.short ?? names.name;
  const parts = normalizeWs(source)
    .split('/')
    .map((p) => p.trim())
    .filter((p) => p !== '');
  if (parts.length >= 2) {
    const a = surnameOf(parts[0] ?? '').slice(0, 2);
    const b = surnameOf(parts[1] ?? '').slice(0, 2);
    if (a && b) return `${a}/${b}`.toUpperCase();
  }
  const first = parts[0] ?? normalizeWs(source);
  const code = surnameOf(first).slice(0, 3).toUpperCase();
  return code || 'TBD';
}

/**
 * One side of a match: the contract's TeamSide plus the per-set detail that
 * TeamSide deliberately cannot hold (D3 — `score` is SETS, the games live in
 * `statusText` and in the composed relay lines).
 */
interface Sideline {
  side: TeamSide;
  /** Games won in each set; index = set number − 1. undefined where unreadable. */
  games: Array<number | undefined>;
  /**
   * `linescores[i].winner === true`, index-aligned with `games`. A HINT, not the
   * answer: ESPN often leaves every entry false and flags the competitor instead,
   * so `setWinnerAt` decides a set and nothing else reads this directly.
   */
  wonSet: boolean[];
  /** `competitor.winner === true` — the match winner flag. */
  won: boolean;
}

function tbdSideline(): Sideline {
  return {
    side: { id: '', name: 'TBD', abbrev: 'TBD', score: undefined },
    games: [],
    wonSet: [],
    won: false,
  };
}

function parseSide(raw: unknown): Sideline {
  const c = rec(raw);
  const games: Array<number | undefined> = [];
  const wonSet: boolean[] = [];
  for (const entry of asArray(c.linescores)) {
    const ls = rec(entry);
    // `value` is the GAMES won in that set (6.0, 7.0 …), never the match score.
    games.push(coerceScore(ls.value));
    wonSet.push(ls.winner === true);
  }
  const names = competitorNames(c);
  const side: TeamSide = {
    id: str(c.id),
    name: names.name,
    abbrev: abbrevFor(names),
    // D3: the score IS the number of SETS won, which needs BOTH sides to decide
    // (see setWinnerAt), so parseMatch fills it in. `competitor.score` is always
    // null upstream and is deliberately ignored.
    score: undefined,
  };
  const logo = headshotRef(headshotHref(c.athlete)) ?? headshotRef(headshotHref(c));
  if (logo) side.logo = logo;
  return { side, games, wonSet, won: c.winner === true };
}

// --- status ----------------------------------------------------------------

type Phase = Game['phase'];

function espnPhase(state: string): Phase {
  return state === 'pre' || state === 'in' || state === 'post' ? state : 'unknown';
}

/** '6-2, 4-6, 2-1' in first-then-second order; a set unreadable on either side is skipped. */
function setScoreText(first: Sideline, second: Sideline): string {
  const parts: string[] = [];
  const n = Math.max(first.games.length, second.games.length);
  for (let i = 0; i < n; i++) {
    const a = first.games[i];
    const b = second.games[i];
    if (a === undefined || b === undefined) continue;
    parts.push(`${a}-${b}`);
  }
  return parts.join(', ');
}

/**
 * P8: the phase comes from the MATCH's own `status.type.state`, NEVER the
 * tournament's — a tournament stays 'in' for a week, which would leave every
 * finished match looking live and would trip the engine's 12-hour runaway guard.
 */
function deriveStatus(
  status: Record<string, unknown>,
  home: Sideline,
  away: Sideline,
  startTimeUtc: string | undefined,
): { phase: Phase; statusText: string; statusShort: string } {
  const type = rec(status.type);
  const phase = espnPhase(str(type.state));
  const sets = setScoreText(home, away);
  if (phase === 'pre') {
    const hhmm = localHHMM(startTimeUtc);
    return { phase, statusText: hhmm, statusShort: hhmm };
  }
  if (phase === 'post') {
    return { phase, statusText: sets || 'Final', statusShort: 'F' };
  }
  if (phase === 'in') {
    const n = Math.max(home.games.length, away.games.length);
    const hg = home.games[n - 1];
    const ag = away.games[n - 1];
    const short = n > 0 && hg !== undefined && ag !== undefined ? `S${n} ${hg}-${ag}` : 'LIVE';
    return { phase, statusText: sets || 'LIVE', statusShort: short.slice(0, 8) };
  }
  const sd = sanitizeText(type.shortDetail) ?? sanitizeText(type.detail);
  return { phase, statusText: sd ?? (sets || 'TBD'), statusShort: sd ? sd.slice(0, 8) : 'TBD' };
}

// --- who won a set: the ONE rule -------------------------------------------

/** How one set stands. */
interface SetResult {
  /** The side that won it, or undefined when it is level or unreadable. */
  winner: Sideline | undefined;
  /** True once the set is settled — only a settled set scores or emits a line. */
  complete: boolean;
}

/**
 * Who won set `i`.
 *
 * The per-set `winner` flag is authoritative when it is set, but ESPN genuinely
 * serves finished matches that carry the flag on the COMPETITOR only, leaving
 * every `linescores[i].winner` false — trusting the flag alone scored those
 * matches 0-0 while the composed prose named a winner. An unflagged set is
 * therefore decided by comparing games.
 *
 * This is the single place a set is decided: the D3 score and the relay lines
 * both read it, so the two halves of this file cannot drift apart again.
 */
function setWinnerAt(home: Sideline, away: Sideline, i: number): Sideline | undefined {
  if (home.wonSet[i] === true) return home;
  if (away.wonSet[i] === true) return away;
  const hg = home.games[i];
  const ag = away.games[i];
  if (hg === undefined || ag === undefined) return undefined;
  return hg > ag ? home : ag > hg ? away : undefined;
}

/**
 * A set is settled when a side is flagged its winner, when the match itself is
 * over, or when a LATER set exists ON BOTH SIDES.
 *
 * The two sides' `linescores` routinely differ in length mid-match — the side
 * that just won a game posts the current set first — so the last COMMON index
 * is still being played. Reading "a later index exists" off the LONGER side
 * published that live game count as a finished set, and the id `…:set:i` is
 * stable by construction, so the next poll's real games arrived as a false
 * correction (src/core/relay.ts §3.4). Math.min is what makes an emitted line's
 * text a function of immutable facts.
 */
function setIsComplete(home: Sideline, away: Sideline, phase: Phase, i: number): boolean {
  if (home.wonSet[i] === true || away.wonSet[i] === true) return true;
  // The match's own status is over ⇒ nothing about it can change again (P8).
  if (phase === 'post') return true;
  return i < Math.min(home.games.length, away.games.length) - 1;
}

/** Every set of a match, resolved once so score and relay agree by construction. */
function resolveSets(home: Sideline, away: Sideline, phase: Phase): SetResult[] {
  const n = Math.max(home.games.length, away.games.length);
  const sets: SetResult[] = [];
  for (let i = 0; i < n; i++) {
    sets.push({ winner: setWinnerAt(home, away, i), complete: setIsComplete(home, away, phase, i) });
  }
  return sets;
}

/** Sets won by each side. A settled set with an undecidable winner counts for neither. */
function tallySets(sets: SetResult[], home: Sideline): { home: number; away: number } {
  let h = 0;
  let a = 0;
  for (const set of sets) {
    if (!set.complete || set.winner === undefined) continue;
    if (set.winner === home) h++;
    else a++;
  }
  return { home: h, away: a };
}

// --- match parse -----------------------------------------------------------

/** A parsed match: the contract Game plus the per-set detail the events need. */
interface Match {
  game: Game;
  nativeId: string;
  home: Sideline;
  away: Sideline;
  /** Resolved once in parseMatch; buildEvents never re-decides a set. */
  sets: SetResult[];
}

/**
 * One `groupings[].competitions[]` entry → a Match, or undefined when there is
 * not enough there to show a row (no id, or no competitors at all).
 */
function parseMatch(raw: unknown, league: League): Match | undefined {
  const comp = rec(raw);
  const nativeId = str(comp.id);
  if (!nativeId) return undefined;
  const competitors = asArray(comp.competitors);
  if (competitors.length === 0) return undefined;

  // Which side is "home" is meaningless in tennis, so it is pinned to the FEED'S
  // OWN competitor ORDER: competitors[0] is home, competitors[1] is away. This
  // provider is stateless and re-derives the sides on every poll, so an
  // order-independent rule (alphabetical, seeding, winner-first) would let a
  // match swap sides mid-relay; the feed's order does not.
  const home = parseSide(competitors[0]);
  const away = competitors.length > 1 ? parseSide(competitors[1]) : tbdSideline();

  const startTimeUtc = parseIsoUtc(comp.date);
  const st = deriveStatus(rec(comp.status), home, away, startTimeUtc);
  // D3: the score is the count of COMPLETED sets won. A set still in play is not
  // counted, so a live third set cannot inflate the score to a win.
  const sets = resolveSets(home, away, st.phase);
  const won = tallySets(sets, home);
  home.side.score = won.home;
  // A side the feed never sent has no score to state — 'TBD' stays unscored.
  if (competitors.length > 1) away.side.score = won.away;
  const game: Game = {
    id: `${PROVIDER_ID}:${league.id}:${nativeId}`,
    providerId: PROVIDER_ID,
    leagueId: league.id,
    leagueName: league.name,
    sport: 'tennis',
    startTimeUtc,
    phase: st.phase,
    statusText: st.statusText,
    statusShort: st.statusShort,
    // §14: tennis is two-sided, so both sides are present and there is no field.
    format: 'versus',
    home: home.side,
    away: away.side,
    entrants: undefined,
  };
  return { game, nativeId, home, away, sets };
}

/** One draw of a tournament — "Men's Singles", "Mixed Doubles" — and its matches. */
interface Draw {
  /** A singles draw is the one a follower is most likely to want (see selectAcrossDraws). */
  singles: boolean;
  competitions: unknown[];
}

/**
 * ESPN names a draw in `grouping.grouping.slug` ('mens-singles') and its
 * sibling display names. Nothing else in the payload distinguishes a draw, and
 * no doubles slug contains 'singles', so a substring test is enough; a grouping
 * with no readable name is simply not treated as singles.
 */
function isSinglesDraw(grouping: Record<string, unknown>): boolean {
  const meta = rec(grouping.grouping);
  const text = `${str(meta.slug)} ${str(meta.displayName)} ${str(meta.shortName)} ${str(grouping.slug)} ${str(grouping.displayName)}`;
  return text.toLowerCase().includes('singles');
}

/** The draws of one tournament, in feed order; an empty draw contributes nothing. */
function tournamentDraws(eventRaw: unknown): Draw[] {
  const draws: Draw[] = [];
  for (const grouping of asArray(rec(eventRaw).groupings)) {
    const g = rec(grouping);
    const competitions = asArray(g.competitions);
    if (competitions.length === 0) continue;
    draws.push({ singles: isSinglesDraw(g), competitions });
  }
  return draws;
}

/** Every match of one tournament, flattened across its draws — feed order preserved. */
function tournamentMatches(eventRaw: unknown): unknown[] {
  const out: unknown[] = [];
  for (const draw of tournamentDraws(eventRaw)) {
    for (const comp of draw.competitions) out.push(comp);
  }
  return out;
}

/**
 * The tournaments of a scoreboard payload. P9: an off-season or quiet day
 * returns zero events — a valid EMPTY LIST, never an error. A payload that is
 * not an object, or whose `events` is not an array, IS a broken shape
 * assumption and becomes ProviderError('parse').
 */
function scoreboardTournaments(raw: unknown): unknown[] {
  if (!isRecord(raw) || Array.isArray(raw)) {
    throw new ProviderError('parse', 'espn-tennis: scoreboard payload is not an object', undefined, payloadHead(raw));
  }
  const events = raw.events;
  if (events === undefined || events === null) return [];
  if (!Array.isArray(events)) {
    throw new ProviderError(
      'parse',
      `espn-tennis: scoreboard 'events' is ${typeof events}, expected an array`,
      undefined,
      payloadHead(raw),
    );
  }
  return events;
}

// --- P2: what is worth showing ---------------------------------------------

/** A finished match stays in the tree this long after its scheduled start. */
const RECENT_FINISH_MS = 12 * 60 * 60 * 1000;
/** An upcoming match appears this far ahead of its scheduled start. */
const UPCOMING_MS = 24 * 60 * 60 * 1000;
/** …and a not-yet-started match stays this long past its scheduled start (delays). */
const LATE_START_MS = 6 * 60 * 60 * 1000;
/** P2 hard cap. One tournament has returned 124 matches; the tree shows at most this many. */
const MAX_MATCHES_PER_TOURNAMENT = 12;

/**
 * P2 relevance rank — lower sorts first, -1 means "do not show". Live beats
 * recently finished beats upcoming, which is also the order the cap keeps.
 */
function relevanceRank(game: Game, nowMs: number): number {
  if (game.phase === 'in') return 0;
  const parsed = game.startTimeUtc === undefined ? NaN : Date.parse(game.startTimeUtc);
  const start = Number.isFinite(parsed) ? parsed : undefined;
  if (game.phase === 'post') {
    // No start time ⇒ no way to call it recent, so it is not shown.
    if (start === undefined) return -1;
    return nowMs - start <= RECENT_FINISH_MS ? 1 : -1;
  }
  if (game.phase === 'pre') {
    // A draw slot whose time is still TBD is upcoming by definition.
    if (start === undefined) return 2;
    return start - nowMs <= UPCOMING_MS && nowMs - start <= LATE_START_MS ? 2 : -1;
  }
  return -1;
}

/** Sort key within a tournament: rank, then chronological, then id for determinism. */
function compareByRelevance(a: { rank: number; game: Game }, b: { rank: number; game: Game }): number {
  if (a.rank !== b.rank) return a.rank - b.rank;
  const at = a.game.startTimeUtc ?? '';
  const bt = b.game.startTimeUtc ?? '';
  if (at !== bt) {
    // An unknown start time sorts last rather than to 1970.
    if (at === '') return 1;
    if (bt === '') return -1;
    return at < bt ? -1 : 1;
  }
  return a.game.id.localeCompare(b.game.id);
}

interface RankedMatch {
  rank: number;
  game: Game;
}

/**
 * Spend the tournament's cap ROUND-ROBIN across its draws, one match from each
 * in turn, so every draw is represented.
 *
 * A Grand Slam runs its draws concurrently and a major has carried 100 matches
 * over four groupings; ranking the tournament as one flat pool let the doubles
 * draws — same rank, same date, so the tie broke on the id — take all twelve
 * slots and the singles show none. Singles draws go first so that a tournament
 * with more draws than slots still spends them on the matches a follower is
 * most likely to be looking for.
 */
function selectAcrossDraws(draws: Array<{ singles: boolean; ranked: RankedMatch[] }>, cap: number): RankedMatch[] {
  // Stable sort: singles first, feed order otherwise.
  const ordered = draws.slice().sort((a, b) => (a.singles === b.singles ? 0 : a.singles ? -1 : 1));
  const kept: RankedMatch[] = [];
  let depth = 0;
  for (const draw of ordered) depth = Math.max(depth, draw.ranked.length);
  for (let round = 0; round < depth && kept.length < cap; round++) {
    for (const draw of ordered) {
      if (kept.length >= cap) break;
      const entry = draw.ranked[round];
      if (entry !== undefined) kept.push(entry);
    }
  }
  return kept;
}

/**
 * A duplicate native id would put two rows in the tree under one `Game.id`
 * (contract §Game.id is globally unique, and the tree builds its TreeItem ids
 * from it), so the later one is dropped. The FIRST occurrence is also the one
 * `fetchPlays` finds when it scans the scoreboard, which keeps the two paths
 * agreeing about which match an id means.
 */
function parseScoreboard(raw: unknown, league: League, ctx: ProviderContext): Game[] {
  const nowMs = ctx.now();
  const games: Game[] = [];
  const seen = new Set<string>();
  for (const tournament of scoreboardTournaments(raw)) {
    const draws: Array<{ singles: boolean; ranked: RankedMatch[] }> = [];
    let relevant = 0;
    for (const draw of tournamentDraws(tournament)) {
      const ranked: RankedMatch[] = [];
      for (const compRaw of draw.competitions) {
        try {
          const match = parseMatch(compRaw, league);
          if (match === undefined) continue;
          if (seen.has(match.nativeId)) {
            ctx.log(`espn-tennis: skipped duplicate match id ${match.nativeId}`);
            continue;
          }
          seen.add(match.nativeId);
          const rank = relevanceRank(match.game, nowMs);
          if (rank < 0) continue;
          ranked.push({ rank, game: match.game });
        } catch (e) {
          ctx.log(`espn-tennis: skipped malformed match: ${String(e)}`);
        }
      }
      if (ranked.length === 0) continue;
      // P2 order holds WITHIN a draw: live, then recently finished, then upcoming.
      ranked.sort(compareByRelevance);
      relevant += ranked.length;
      draws.push({ singles: draw.singles, ranked });
    }
    const kept = selectAcrossDraws(draws, MAX_MATCHES_PER_TOURNAMENT);
    if (relevant > kept.length) {
      ctx.log(
        `espn-tennis: ${str(rec(tournament).name) || 'tournament'} capped at ${MAX_MATCHES_PER_TOURNAMENT} of ${relevant} relevant matches`,
      );
    }
    // The tree still reads in relevance order, whichever draws the slots came from.
    kept.sort(compareByRelevance);
    for (const entry of kept) games.push(entry.game);
  }
  return games;
}

// --- D4: relay events from ONE response ------------------------------------

/**
 * Sits above every set index so the final line always sorts last. A match has at
 * most five sets, so this can never collide.
 */
const FINAL_SEQUENCE = 1000;

/**
 * The match winner, preferring the competitor flag and falling back to sets won.
 * undefined when the feed says neither (an unfinished or abandoned match).
 */
function matchWinner(home: Sideline, away: Sideline, homeSets: number, awaySets: number): Sideline | undefined {
  if (home.won !== away.won) return home.won ? home : away;
  if (homeSets !== awaySets) return homeSets > awaySets ? home : away;
  return undefined;
}

/**
 * D4. Relay events are derived from a SINGLE response — this provider is
 * stateless and never diffs across polls — which works because one response
 * carries the FULL set history: one event per COMPLETED set, plus a match-final
 * event once the match's own status reads 'post'.
 *
 * Ids are `${matchId}:set:${index}` and `${matchId}:final`, where `matchId` is
 * the native ESPN competition id and `index` is the 0-based position in
 * `linescores`. They must be derived and stable: the relay engine dedupes by id
 * across polls, so an id that shifted would re-emit the same line forever.
 *
 * Text carries only immutable facts (§2, §12.2): the set number, its winner and
 * its final games. The running set count rides in `scoreAfter`, never in the
 * prose, so a later set cannot trigger a false correction of an earlier line.
 */
function buildEvents(match: Match, locale: RelayLocale, ctx: ProviderContext): PlayEvent[] {
  const { game, home, away, nativeId, sets } = match;
  const events: PlayEvent[] = [];
  let homeSets = 0;
  let awaySets = 0;

  for (let i = 0; i < sets.length; i++) {
    try {
      const set = sets[i];
      if (set === undefined || !set.complete) continue;
      const winner = set.winner;
      if (winner === home) homeSets++;
      else if (winner === away) awaySets++;
      const hg = home.games[i];
      const ag = away.games[i];
      if (hg === undefined || ag === undefined) {
        ctx.log(`espn-tennis: match ${nativeId} set ${i + 1} has unreadable games — no event`);
        continue;
      }
      const text =
        winner === undefined
          ? sanitizeText(t(locale, 'tennisSetNoWinner', { n: i + 1, games: `${hg}-${ag}` }))
          : sanitizeText(
              t(locale, 'tennisSet', {
                n: i + 1,
                winner: winner.side.name,
                games: winner === home ? `${hg}-${ag}` : `${ag}-${hg}`,
              }),
            );
      if (text === undefined) continue;
      events.push({
        id: `${nativeId}:set:${i}`,
        gameId: game.id,
        sequence: i,
        clock: undefined,
        period: `S${i + 1}`,
        text,
        kind: 'score',
        scoreAfter: { home: homeSets, away: awaySets },
      });
    } catch (e) {
      ctx.log(`espn-tennis: skipped malformed set ${i + 1}: ${String(e)}`);
    }
  }

  if (game.phase === 'post') {
    const winner = matchWinner(home, away, homeSets, awaySets);
    let text: string | undefined;
    if (winner === undefined) {
      // Abandoned/walkover with no flag either way: state the score, invent no result.
      const score = setScoreText(home, away);
      text = score
        ? sanitizeText(t(locale, 'tennisFinalNoWinner', { home: home.side.name, away: away.side.name, score }))
        : sanitizeText(t(locale, 'tennisFinalBare'));
    } else {
      const loser = winner === home ? away : home;
      const score = setScoreText(winner, loser);
      text = score
        ? sanitizeText(t(locale, 'tennisFinal', { winner: winner.side.name, loser: loser.side.name, score }))
        : sanitizeText(t(locale, 'tennisFinalNoScore', { winner: winner.side.name, loser: loser.side.name }));
    }
    if (text !== undefined) {
      events.push({
        id: `${nativeId}:final`,
        gameId: game.id,
        sequence: FINAL_SEQUENCE,
        clock: undefined,
        period: undefined,
        text,
        kind: 'status',
        scoreAfter: { home: homeSets, away: awaySets },
      });
    }
  }

  // §2: providers sort by sequence ascending; array order is never trusted.
  events.sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id));
  return events;
}

// --- provider --------------------------------------------------------------

function defForLeague(leagueId: string): TennisLeagueDef | undefined {
  return TENNIS_LEAGUES.find((l) => l.id === leagueId);
}

export const espnTennisProvider: SportProvider = {
  id: PROVIDER_ID,
  displayName: 'Tennis',
  requiresSecret: undefined,

  async listLeagues(): Promise<League[]> {
    return TENNIS_LEAGUES.map((l) => ({ id: l.id, providerId: PROVIDER_ID, name: l.name, sport: 'tennis' }));
  },

  async listGames(ctx: ProviderContext, league: League): Promise<Game[]> {
    const def = defForLeague(league.id);
    const raw = await ctx.fetchJson(`${BASE}${def ? def.id : league.id}/scoreboard`);
    try {
      return parseScoreboard(raw, league, ctx);
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      throw new ProviderError('parse', `espn-tennis listGames parse: ${String(e)}`);
    }
  },

  /**
   * There is no per-match endpoint (the tennis `summary` route returns non-JSON),
   * so the scoreboard is re-fetched and the match located by its native id. That
   * single response carries the full set history, which is all D4 needs, and it
   * also supplies the fresh game (§2 pin) — phase, both scores and both status
   * strings are re-derived, never carried over from the input game.
   */
  async fetchPlays(ctx: ProviderContext, game: Game): Promise<PlaySnapshot> {
    const def = defForLeague(game.leagueId);
    if (def === undefined) {
      throw new ProviderError('not-found', `espn-tennis: unknown league '${game.leagueId}'`);
    }
    const nativeId = lastSegment(game.id);
    const raw = await ctx.fetchJson(`${BASE}${def.id}/scoreboard`);
    try {
      const league: League = {
        id: def.id,
        providerId: PROVIDER_ID,
        name: game.leagueName || def.name,
        sport: 'tennis',
      };
      for (const tournament of scoreboardTournaments(raw)) {
        for (const compRaw of tournamentMatches(tournament)) {
          if (str(rec(compRaw).id) !== nativeId) continue;
          const match = parseMatch(compRaw, league);
          if (match === undefined) break;
          return { game: match.game, events: buildEvents(match, ctx.locale, ctx) };
        }
      }
      // A match that has dropped off the scoreboard is gone, not a parse failure:
      // three of these and the poller auto-unfollows (§4).
      throw new ProviderError('not-found', `espn-tennis: match ${nativeId} is not on the ${def.id} scoreboard`);
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      throw new ProviderError('parse', `espn-tennis fetchPlays parse: ${String(e)}`);
    }
  },
};
