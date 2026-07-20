/**
 * ESPN Racing provider (key-free, unofficial) — Formula 1.
 *
 * Layering: no 'vscode' import, no npm dependencies. Every field access on the
 * ESPN JSON is defensive; a shape surprise is wrapped in ProviderError('parse')
 * and one malformed list entry is skipped (logged), never fatal.
 *
 * This is the codebase's first FIELD contest (§14): a race is one field of ~22
 * drivers placing against each other, with no home side and no away side. Every
 * game emitted here therefore sets `format: 'field'`, leaves `home`/`away`
 * undefined, and carries a NON-EMPTY, already-sorted `entrants` list. Faking a
 * two-sided score from the leader and the runner-up would render as a
 * meaningless `VER 1:2 NOR`, so it is never done.
 *
 * The payload nests one level deeper than a two-sided ESPN sport, and the extra
 * level is not cosmetic — it is the SESSION:
 *
 *   events[]            — a race WEEKEND ('Moët & Chandon Belgian Grand Prix')
 *     competitions[]    — the weekend's SESSIONS (FP1, FP2, FP3, Q, Sprint, R)
 *       competitors[]   — the field, one entry per driver
 *
 * A weekend therefore yields several games, one per session, and the native id
 * must distinguish them or Friday practice and Sunday's Grand Prix collapse into
 * a single row (P4). The session also rides in `leagueName` and in the status
 * strings, so a user is never told a practice session is the race.
 *
 * There is no upstream play-by-play at all (`racing/f1/summary?event=…` returns
 * an error object), and this provider is stateless — it never diffs across polls
 * (P5). A position-change stream ('Hamilton up to P3') would require remembering
 * the previous poll, so it is deliberately NOT attempted: the relay carries only
 * session boundaries and the result, while the live running order lives on
 * `entrants`, which the UI rebuilds from scratch every poll.
 */

import {
  Entrant,
  Game,
  League,
  LogoRef,
  MAX_FIELD_POSITION,
  PlayEvent,
  PlayEventKind,
  PlaySnapshot,
  ProviderContext,
  ProviderError,
  RelayLocale,
  SportProvider,
} from '../core/contract';
import { registerMessages, t, tEnum } from '../core/i18n';
import { coerceScore, fnv1a32, normalizeWs, parseIsoUtc, sanitizeText } from '../core/util';

const PROVIDER_ID = 'espn-racing';
const BASE = 'https://site.api.espn.com/apis/site/v2/sports/racing/';

interface RacingLeagueDef {
  id: string;
  name: string;
}

const RACING_LEAGUES: RacingLeagueDef[] = [{ id: 'f1', name: 'Formula 1' }];

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
 * `racingSession.*` is an enum map read through `tEnum`, so an abbreviation this
 * table does not know (a one-off test session) passes its raw API value through —
 * never a raw key, and never a raw `{placeholder}`.
 */
const EN_RACING: Record<string, string> = {
  racingSessionStart: '{session} under way',
  racingSessionEnd: '{session} complete',
  // `podium` is a comma-joined list of racingPosition entries, built by this provider.
  racingResult: '{session} result — {podium}',
  racingPosition: 'P{n} {who}',

  'racingSession.fp1': 'Practice 1',
  'racingSession.fp2': 'Practice 2',
  'racingSession.fp3': 'Practice 3',
  'racingSession.q': 'Qualifying',
  'racingSession.q1': 'Qualifying 1',
  'racingSession.q2': 'Qualifying 2',
  'racingSession.q3': 'Qualifying 3',
  'racingSession.sq': 'Sprint Qualifying',
  'racingSession.ss': 'Sprint Shootout',
  'racingSession.sprint': 'Sprint',
  'racingSession.spr': 'Sprint',
  'racingSession.r': 'Race',
  'racingSession.race': 'Race',
};

const KO_RACING: Record<string, string> = {
  racingSessionStart: '{session} 시작',
  racingSessionEnd: '{session} 종료',
  racingResult: '{session} 결과 — {podium}',
  racingPosition: '{n}위 {who}',

  'racingSession.fp1': '연습주행 1',
  'racingSession.fp2': '연습주행 2',
  'racingSession.fp3': '연습주행 3',
  'racingSession.q': '예선',
  'racingSession.q1': '예선 1',
  'racingSession.q2': '예선 2',
  'racingSession.q3': '예선 3',
  'racingSession.sq': '스프린트 예선',
  'racingSession.ss': '스프린트 슈트아웃',
  'racingSession.sprint': '스프린트',
  'racingSession.spr': '스프린트',
  'racingSession.r': '결승',
  'racingSession.race': '결승',
};

registerMessages('en', EN_RACING);
registerMessages('ko', KO_RACING);

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

/** Every character a native-id operand is allowed to keep verbatim. */
const ID_UNRESERVED = /[^A-Za-z0-9_.]/g;

/**
 * Percent-escape one operand of a native id into `[A-Za-z0-9_.%]`.
 *
 * This is an ESCAPE, not a strip, and the difference is the whole point: a strip
 * maps 'A-B' and 'AB' onto the same token, so two different race weekends would
 * collide on one id and the second one would be silently dropped as a duplicate.
 * Escaping is INJECTIVE — '%' is itself escaped and every escape is a fixed
 * `%` + 4 hex digits, so no two inputs can produce the same output.
 *
 * The two characters the composed id reserves are therefore impossible inside an
 * operand: ':' (the game id is `${providerId}:${leagueId}:${nativeId}` and
 * `lastSegment` splits on the final colon) and '-' (the separator in
 * `${eventId}-${sessionToken}`). Ordinary ESPN ids are digit runs and pass
 * through unchanged.
 */
function escapeIdOperand(v: unknown): string {
  return str(v)
    .trim()
    .replace(ID_UNRESERVED, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`);
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
 * P7. The ONLY host a driver portrait may come from: the one ESPN host already
 * on the logo cache's allowlist (src/ui/logoCache.ts). An image served from
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
 * else passes through unresized (a big portrait beats a broken one).
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

/** An image reference arrives either as `{ href }` or as a bare string. */
function href(v: unknown): unknown {
  return isRecord(v) ? v.href : v;
}

/** P7: an https image on the allowlisted host, resized; anything else undefined. */
function logoRef(v: unknown): LogoRef | undefined {
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

/** The driver's portrait, else the constructor crest. Both host-checked. */
function entrantLogo(c: Record<string, unknown>): LogoRef | undefined {
  const athlete = rec(c.athlete);
  const teamLogos = asArray(rec(c.team).logos);
  return (
    logoRef(href(athlete.headshot)) ??
    logoRef(href(c.headshot)) ??
    logoRef(href(teamLogos[0])) ??
    logoRef(href(rec(c.team).logo))
  );
}

// --- entrants (§14) --------------------------------------------------------

/** Statistic names (lowercased) that carry a gap to the leader, when populated at all. */
const GAP_STATS: ReadonlySet<string> = new Set(['gap', 'behind', 'timebehind', 'gaptoleader']);

/** `detail` is one SHORT locale-neutral qualifier (§14): ≤ 40 chars, or undefined. */
const MAX_DETAIL_CHARS = 40;

function athleteName(v: unknown): string | undefined {
  const a = rec(v);
  return sanitizeText(a.fullName) ?? sanitizeText(a.displayName) ?? sanitizeText(a.shortName);
}

/**
 * A driver's display name. The athlete block is the source of truth; a competitor
 * that carries none (a reserve entry, or a payload trimmed by the upstream) falls
 * back to its own name and then to the constructor. Never empty — 'TBD' is the
 * floor the contract demands.
 */
function entrantName(c: Record<string, unknown>): string {
  const solo = athleteName(c.athlete);
  if (solo !== undefined) return solo;
  const team = rec(c.team);
  return (
    sanitizeText(c.displayName) ??
    sanitizeText(c.name) ??
    sanitizeText(team.displayName) ??
    sanitizeText(team.name) ??
    'TBD'
  );
}

/**
 * §14 abbrev rule for person names: the three-letter code motorsport already
 * uses ('Max Verstappen' → 'VER'). A feed-supplied abbreviation wins when there
 * is one. Never empty, never longer than 5.
 */
function entrantAbbrev(c: Record<string, unknown>, name: string): string {
  const given = sanitizeText(rec(c.athlete).abbreviation) ?? sanitizeText(c.abbreviation);
  if (given !== undefined) return given.slice(0, 5);
  const words = normalizeWs(name).split(' ');
  const surname = words[words.length - 1] ?? '';
  const code = (surname || name).trim().slice(0, 3).toUpperCase();
  return code || 'TBD';
}

/**
 * The gap to the leader when `statistics` is populated. Live probing found it an
 * EMPTY ARRAY on every session, so nothing here may depend on it — this reads it
 * defensively and yields undefined the moment anything is missing.
 */
function gapDetail(c: Record<string, unknown>): string | undefined {
  for (const entry of asArray(c.statistics)) {
    const stat = rec(entry);
    const name = str(stat.name).trim().toLowerCase();
    if (!GAP_STATS.has(name)) continue;
    const value = sanitizeText(stat.displayValue) ?? sanitizeText(stat.value);
    if (value !== undefined) return value;
  }
  return undefined;
}

/** The constructor, from whichever of the two shapes the payload uses. */
function constructorDetail(c: Record<string, unknown>): string | undefined {
  const team = rec(c.team);
  return (
    sanitizeText(rec(c.vehicle).manufacturer) ??
    sanitizeText(team.displayName) ??
    sanitizeText(team.name) ??
    sanitizeText(team.shortDisplayName)
  );
}

/**
 * §14 position rule, applied at the PRODUCING end: an integer in
 * [1, MAX_FIELD_POSITION], or undefined when the field is not ranked yet. `order`
 * is the only ranking the payload carries (there is no score); a 0, a negative, a
 * float, a magnitude outside the range or an unparsable value is undefined, never
 * a fabricated place.
 *
 * The upper bound is a value-semantics rule, not decoration: `Number.isInteger(1e308)`
 * is true, so a shape-only check would let an upstream `order` of 1e308 through as a
 * rank. It is dropped rather than CLAMPED — clamping would silently promote garbage
 * to a plausible place, which is worse than admitting the rank is unknown; an
 * unranked entrant merely sorts last (see `compareEntrants`).
 *
 * Deliberately not `coerceScore`: that helper enforces the SCORE range [0, 999],
 * which admits 0 and rejects a contract-valid position above 999.
 *
 * A STRING is held to the notation, not just to the arithmetic: `Number()` reads
 * '0x10' as 16, '+6' as 6 and '1e3' as 1000, all of which land inside the range
 * and would render as a place nobody finished in. Only a plain decimal digit run
 * is a finishing position. Two judgement calls, made explicit:
 *   • '007' IS accepted (P7). A zero-padded decimal denotes exactly one place —
 *     there is no second reading of it — unlike a hexadecimal, signed or exponent
 *     literal, which is a different notation entirely.
 *   • ' 3 ' IS accepted (P3), because surrounding whitespace is a transport
 *     artefact rather than a notation.
 */
function entrantPosition(v: unknown): number | undefined {
  let n: number;
  if (typeof v === 'number') {
    n = v;
  } else if (typeof v === 'string') {
    const s = v.trim();
    if (!/^[0-9]+$/.test(s)) return undefined;
    n = Number(s);
  } else {
    return undefined;
  }
  return Number.isInteger(n) && n >= 1 && n <= MAX_FIELD_POSITION ? n : undefined;
}

function parseEntrant(raw: unknown): Entrant {
  const c = rec(raw);
  const name = entrantName(c);
  const detail = gapDetail(c) ?? constructorDetail(c);
  return {
    id: str(c.id),
    position: entrantPosition(c.order),
    name,
    abbrev: entrantAbbrev(c, name),
    detail: detail === undefined ? undefined : detail.slice(0, MAX_DETAIL_CHARS),
    logo: entrantLogo(c),
  };
}

/**
 * P10: the provider sorts, consumers do not. Position ascending; an entrant the
 * feed has not ranked sorts LAST; ties break by name and then by id, so the
 * order is total and two identical payloads always produce the same list.
 */
function compareEntrants(a: Entrant, b: Entrant): number {
  if (a.position !== b.position) {
    if (a.position === undefined) return 1;
    if (b.position === undefined) return -1;
    return a.position - b.position;
  }
  const byName = a.name.localeCompare(b.name);
  if (byName !== 0) return byName;
  return a.id.localeCompare(b.id);
}

// --- sessions (P4) ---------------------------------------------------------

/**
 * The session's readable label. Locale-neutral English is what `leagueName` and
 * the status strings want (the contract pins both as locale-neutral, and the
 * tree renders `leagueName` verbatim); the relay lines ask for `locale` instead,
 * since provider-composed prose IS localized (§12.1).
 *
 * undefined when the payload names no session type at all — the caller then omits
 * the session rather than inventing one.
 */
function sessionLabel(locale: RelayLocale, abbrev: string): string | undefined {
  if (abbrev === '') return undefined;
  return tEnum(locale, 'racingSession', abbrev);
}

/**
 * The session's stable identity within its weekend. The feed's own competition id
 * is preferred; a payload without one is keyed by a hash of the session type, so
 * the id survives the sessions being reordered between polls (an index would not,
 * and the relay engine dedupes by id — an id that shifts re-emits every line
 * forever). Array position is the last resort.
 *
 * The feed's id goes through `escapeIdOperand`, so it can contain neither ':'
 * (which `lastSegment` splits on) nor '-' (the separator against the event id).
 * The two fallbacks are already in that alphabet: a hash is hex, `s${index}` is
 * a letter and digits.
 */
function sessionToken(comp: Record<string, unknown>, abbrev: string, index: number): string {
  const given = escapeIdOperand(comp.id);
  if (given !== '') return given;
  if (abbrev !== '') return fnv1a32(abbrev.trim().toLowerCase());
  return `s${index}`;
}

// --- status ----------------------------------------------------------------

type Phase = Game['phase'];

function espnPhase(state: string): Phase {
  return state === 'pre' || state === 'in' || state === 'post' ? state : 'unknown';
}

/** `status.period` is the LAP number; `L32`, or undefined before the first lap. */
function lapLabel(period: unknown): string | undefined {
  const n = coerceScore(period);
  return n !== undefined && n >= 1 ? `L${n}` : undefined;
}

/**
 * The ≤ 8 char status. The session code is the point of this string (P4), so the
 * candidates are tried longest-first and the first one that FITS wins — a code is
 * dropped whole rather than truncated to 'Sprint L' or 'FP1 14:0'.
 */
function pickShort(code: string, state: string): string {
  for (const candidate of [`${code} ${state}`, code, state]) {
    const s = candidate.trim();
    if (s !== '' && s.length <= 8) return s;
  }
  return (state || code || 'TBD').slice(0, 8);
}

interface SessionStatus {
  phase: Phase;
  statusText: string;
  statusShort: string;
}

/**
 * P8 analogue: the phase comes from the SESSION's own status when it has one and
 * only then from the weekend's — a race weekend reads 'in' from Friday to Sunday,
 * which would leave every finished practice session looking live and would trip
 * the engine's 12-hour runaway guard.
 */
function deriveStatus(
  status: Record<string, unknown>,
  labelEn: string | undefined,
  abbrev: string,
  lap: string | undefined,
  startTimeUtc: string | undefined,
): SessionStatus {
  const type = rec(status.type);
  const phase = espnPhase(str(type.state));

  let long: string;
  let short: string;
  if (phase === 'pre') {
    const hhmm = localHHMM(startTimeUtc);
    long = hhmm;
    short = hhmm;
  } else if (phase === 'post') {
    long = 'Final';
    short = 'F';
  } else if (phase === 'in') {
    long = lap === undefined ? 'LIVE' : `Lap ${lap.slice(1)}`;
    short = lap ?? 'LIVE';
  } else {
    const sd = sanitizeText(type.shortDetail) ?? sanitizeText(type.detail);
    long = sd ?? 'TBD';
    short = sd ?? 'TBD';
  }

  return {
    phase,
    statusText: labelEn === undefined ? long : `${labelEn} · ${long}`,
    statusShort: pickShort(abbrev, short),
  };
}

// --- session parse ---------------------------------------------------------

/** A parsed session: the contract Game plus what the relay lines need. */
interface Session {
  game: Game;
  nativeId: string;
  /** Localizable session label, resolved per locale when the events are composed. */
  abbrev: string;
  entrants: Entrant[];
  lap: string | undefined;
}

/**
 * The race's own name, which is what a field row must show: `Game` carries no
 * event-name field, so the tree renders `leagueName` (§14 integration note). The
 * generic series name ('Formula 1') is the floor, and the session is appended so
 * a Friday practice can never read as the Grand Prix (P4).
 */
function contestName(event: Record<string, unknown>, labelEn: string | undefined, league: League): string {
  const race = sanitizeText(event.name) ?? sanitizeText(event.shortName) ?? league.name;
  return labelEn === undefined ? race : `${race} — ${labelEn}`;
}

/**
 * One `events[].competitions[]` entry → a Session, or undefined when there is not
 * enough there to show a row. A session with ZERO competitors is exactly that
 * case: §14 requires `entrants` to be NON-EMPTY, so no game is emitted rather
 * than one that violates the invariant.
 */
function parseSession(
  compRaw: unknown,
  event: Record<string, unknown>,
  eventId: string,
  index: number,
  league: League,
): Session | undefined {
  const comp = rec(compRaw);
  // Sanitized BEFORE it is used: `pickShort` measures this in UTF-16 code units
  // against the 8-char status budget, and a control character costs budget while
  // rendering nothing — an escape-laden abbreviation would pass the gate and then
  // paint two visible characters.
  const abbrev = normalizeWs(sanitizeText(str(rec(comp.type).abbreviation)) ?? '');
  // `eventId` is already escaped by the caller; the session token escapes its own
  // operand, so '-' is unambiguously the separator between the two.
  const nativeId = `${eventId}-${sessionToken(comp, abbrev, index)}`;

  const entrants = asArray(comp.competitors).map(parseEntrant);
  if (entrants.length === 0) return undefined;
  entrants.sort(compareEntrants);

  const labelEn = sessionLabel('en', abbrev);
  const startTimeUtc = parseIsoUtc(comp.date) ?? parseIsoUtc(event.date);
  const status = isRecord(comp.status) ? comp.status : rec(event.status);
  const lap = lapLabel(status.period);
  const st = deriveStatus(status, labelEn, abbrev, lap, startTimeUtc);

  const game: Game = {
    id: `${PROVIDER_ID}:${league.id}:${nativeId}`,
    providerId: PROVIDER_ID,
    leagueId: league.id,
    leagueName: contestName(event, labelEn, league),
    sport: 'motorsport',
    startTimeUtc,
    phase: st.phase,
    statusText: st.statusText,
    statusShort: st.statusShort,
    // §14: a race is a FIELD, never two sides. Both sides stay undefined and the
    // running order rides on `entrants` — already sorted, never empty.
    format: 'field',
    home: undefined,
    away: undefined,
    entrants,
  };
  return { game, nativeId, abbrev, entrants, lap };
}

/**
 * The weekends of a scoreboard payload. P9: between race weekends the endpoint
 * returns zero events — a valid EMPTY LIST, never an error. A payload that is not
 * an object, or whose `events` is not an array, IS a broken shape assumption and
 * becomes ProviderError('parse').
 */
function scoreboardEvents(raw: unknown): unknown[] {
  if (!isRecord(raw) || Array.isArray(raw)) {
    throw new ProviderError('parse', 'espn-racing: scoreboard payload is not an object', undefined, payloadHead(raw));
  }
  const events = raw.events;
  if (events === undefined || events === null) return [];
  if (!Array.isArray(events)) {
    throw new ProviderError(
      'parse',
      `espn-racing: scoreboard 'events' is ${typeof events}, expected an array`,
      undefined,
      payloadHead(raw),
    );
  }
  return events;
}

/**
 * Every session of the scoreboard, in feed order. A duplicate native id would put
 * two rows in the tree under one identity and make `fetchPlays` ambiguous, so the
 * later one is dropped (logged) — the first occurrence is the one `fetchPlays`
 * finds too, which keeps the two paths agreeing.
 */
function parseScoreboard(raw: unknown, league: League, ctx: ProviderContext): Session[] {
  const sessions: Session[] = [];
  const seen = new Set<string>();
  for (const eventRaw of scoreboardEvents(raw)) {
    const event = rec(eventRaw);
    // Escaped for the same reason the session token is: an event id carrying a
    // ':' would put that colon inside the game id, where `lastSegment` would cut
    // the native id short and every poll of the session would 404 (three of those
    // auto-unfollow it).
    const eventId = escapeIdOperand(event.id);
    if (!eventId) continue;
    const competitions = asArray(event.competitions);
    for (let i = 0; i < competitions.length; i++) {
      try {
        const session = parseSession(competitions[i], event, eventId, i, league);
        if (session === undefined) continue;
        if (seen.has(session.nativeId)) {
          ctx.log(`espn-racing: skipped duplicate session id ${session.nativeId}`);
          continue;
        }
        seen.add(session.nativeId);
        sessions.push(session);
      } catch (e) {
        ctx.log(`espn-racing: skipped malformed session: ${String(e)}`);
      }
    }
  }
  return sessions;
}

// --- D4/P5: relay events from ONE response ---------------------------------

/** How many finishers the result line names — the podium. */
const PODIUM_SIZE = 3;

const SEQ_START = 0;
const SEQ_END = 1;
const SEQ_RESULT = 2;

/**
 * D4/P5. Relay events are derived from a SINGLE response; this provider is
 * stateless and never diffs across polls, which is why there is no position-change
 * stream — deriving 'Hamilton up to P3' would require remembering the previous
 * poll and would emit duplicate or false lines. What one response CAN state
 * truthfully is where the session is and, once it is over, who won it:
 *
 *   `${nativeId}:start`  — the session is under way (emitted from 'in' onward)
 *   `${nativeId}:end`    — the session is complete
 *   `${nativeId}:result` — the podium, named
 *
 * The ids are derived from the event and the session and are therefore stable
 * across polls: the relay engine dedupes by id, so an unstable id would re-emit
 * the same line forever. Text carries only immutable facts (§2, §12.2) — nothing
 * that a later poll could revise, which is also why the live running order stays
 * out of the relay and lives on `Game.entrants` instead.
 */
function buildEvents(session: Session, locale: RelayLocale, ctx: ProviderContext): PlayEvent[] {
  const { game, nativeId, entrants, lap } = session;
  const phase = game.phase;
  if (phase !== 'in' && phase !== 'post') return [];

  const label = sessionLabel(locale, session.abbrev);
  const events: PlayEvent[] = [];

  const push = (
    idSuffix: string,
    sequence: number,
    raw: string,
    period: string | undefined,
    kind: PlayEventKind,
  ): void => {
    const text = sanitizeText(raw);
    if (text === undefined) {
      ctx.log(`espn-racing: session ${nativeId} produced no text for ${idSuffix}`);
      return;
    }
    events.push({
      id: `${nativeId}:${idSuffix}`,
      gameId: game.id,
      sequence,
      clock: undefined,
      period,
      // A field contest has no two-sided score to report (§14).
      scoreAfter: undefined,
      text,
      kind,
    });
  };

  // A session with no named type still boundary-marks; the race name is the
  // subject then, so `{session}` is never left as a raw placeholder.
  const subject = label ?? game.leagueName;

  // The start line is emitted from 'in' onward — a session observed for the first
  // time already finished was still, factually, under way. Its period is left
  // undefined on purpose: the lap advances every poll, and only immutable fields
  // belong on an already-emitted event.
  push('start', SEQ_START, t(locale, 'racingSessionStart', { session: subject }), undefined, 'status');

  if (phase === 'post') {
    push('end', SEQ_END, t(locale, 'racingSessionEnd', { session: subject }), lap, 'status');
    // P10 already sorted the field, so the podium is simply its ranked head.
    const podium: string[] = [];
    for (const entrant of entrants) {
      if (entrant.position === undefined) break;
      podium.push(t(locale, 'racingPosition', { n: entrant.position, who: entrant.name }));
      if (podium.length >= PODIUM_SIZE) break;
    }
    // An unranked field yields no result line rather than an empty one — a
    // session can end abandoned, and inventing a winner is worse than silence.
    if (podium.length > 0) {
      // 'score' rather than 'status': this is the line that reports the outcome,
      // and the relay marks a 'score' line with ★ (§5). A field contest carries no
      // numeric score, so `scoreAfter` stays undefined.
      push(
        'result',
        SEQ_RESULT,
        t(locale, 'racingResult', { session: subject, podium: podium.join(', ') }),
        lap,
        'score',
      );
    }
  }

  // §2: providers sort by sequence ascending; array order is never trusted.
  events.sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id));
  return events;
}

// --- provider --------------------------------------------------------------

function defForLeague(leagueId: string): RacingLeagueDef | undefined {
  return RACING_LEAGUES.find((l) => l.id === leagueId);
}

export const espnRacingProvider: SportProvider = {
  id: PROVIDER_ID,
  displayName: 'Motorsport',
  requiresSecret: undefined,

  async listLeagues(): Promise<League[]> {
    return RACING_LEAGUES.map((l) => ({ id: l.id, providerId: PROVIDER_ID, name: l.name, sport: 'motorsport' }));
  },

  async listGames(ctx: ProviderContext, league: League): Promise<Game[]> {
    const def = defForLeague(league.id);
    const raw = await ctx.fetchJson(`${BASE}${def ? def.id : league.id}/scoreboard`);
    try {
      // The series name is taken from the known league definition so that this
      // path and fetchPlays compose an identical `leagueName` for the same
      // session — a caller-supplied name would make the two disagree.
      const series: League = { ...league, name: def ? def.name : league.name };
      return parseScoreboard(raw, series, ctx).map((s) => s.game);
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      throw new ProviderError('parse', `espn-racing listGames parse: ${String(e)}`);
    }
  },

  /**
   * There is no per-session endpoint (`racing/f1/summary?event=…` returns an error
   * object, not play-by-play), so the scoreboard is re-fetched and the session
   * located by its native id. That single response carries the full running order,
   * which is all D4 needs, and it also supplies the fresh game (§2 pin) — phase,
   * status strings and the whole entrant list are re-derived, never carried over
   * from the input game.
   */
  async fetchPlays(ctx: ProviderContext, game: Game): Promise<PlaySnapshot> {
    const def = defForLeague(game.leagueId);
    if (def === undefined) {
      throw new ProviderError('not-found', `espn-racing: unknown league '${game.leagueId}'`);
    }
    const nativeId = lastSegment(game.id);
    const raw = await ctx.fetchJson(`${BASE}${def.id}/scoreboard`);
    try {
      // Unlike the two-sided ESPN providers, the input game's `leagueName` is NOT
      // reused as the series name: for a field contest it holds the RACE name
      // (§14 integration note), which would nest inside itself on the rebuild.
      const league: League = { id: def.id, providerId: PROVIDER_ID, name: def.name, sport: 'motorsport' };
      for (const session of parseScoreboard(raw, league, ctx)) {
        if (session.nativeId !== nativeId) continue;
        return { game: session.game, events: buildEvents(session, ctx.locale, ctx) };
      }
      // A session that has dropped off the scoreboard is gone, not a parse
      // failure: three of these and the poller auto-unfollows (§4).
      throw new ProviderError('not-found', `espn-racing: session ${nativeId} is not on the ${def.id} scoreboard`);
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      throw new ProviderError('parse', `espn-racing fetchPlays parse: ${String(e)}`);
    }
  },
};
