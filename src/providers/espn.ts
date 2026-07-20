/**
 * ESPN provider (key-free, unofficial). Implements docs/CONTRACT.md §2.1.
 *
 * Layering: no 'vscode' import, no npm dependencies. Every field access on the
 * ESPN JSON is defensive; a shape surprise is wrapped in ProviderError('parse')
 * and one malformed list entry is skipped (logged), never fatal.
 */

import {
  Game,
  League,
  LineupSpot,
  LogoRef,
  PlayEvent,
  PlaySnapshot,
  ProviderContext,
  ProviderError,
  RelayLocale,
  SoccerState,
  SportKind,
  SportProvider,
  TeamSide,
} from '../core/contract';
import { registerMessages, t, tEnum } from '../core/i18n';
import { coerceScore, fnv1a32, normalizeWs, parseIsoUtc, sanitizeText } from '../core/util';

const BASE = 'https://site.api.espn.com/apis/site/v2/sports/';

interface EspnLeagueDef {
  id: string;
  path: string;
  sport: SportKind;
  name: string;
  /**
   * Whether `<path>/summary?event=<id>` exists for this league. Absent ⇒ true.
   *
   * `mma/ufc` has no summary route at all (probed live: HTTP 404), and a 404 is
   * ProviderError('not-found') — the very signal the poller uses to auto-unfollow
   * a vanished game (§4). Left unmarked, following a UFC fight silently unfollows
   * itself. A league marked `false` derives its snapshot from the SCOREBOARD
   * instead, exactly as the tennis and motorsport providers do.
   */
  hasSummary?: boolean;
}

// Static list (§2.1). Soccer paths are `soccer/<id>`; the others carry their own sport segment.
const ESPN_LEAGUES: EspnLeagueDef[] = [
  { id: 'nfl', path: 'football/nfl', sport: 'football', name: 'NFL' },
  { id: 'nba', path: 'basketball/nba', sport: 'basketball', name: 'NBA' },
  { id: 'wnba', path: 'basketball/wnba', sport: 'basketball', name: 'WNBA' },
  { id: 'fifa.world', path: 'soccer/fifa.world', sport: 'soccer', name: 'FIFA World Cup' },
  { id: 'eng.1', path: 'soccer/eng.1', sport: 'soccer', name: 'English Premier League' },
  { id: 'esp.1', path: 'soccer/esp.1', sport: 'soccer', name: 'Spanish LaLiga' },
  { id: 'ita.1', path: 'soccer/ita.1', sport: 'soccer', name: 'Italian Serie A' },
  { id: 'ger.1', path: 'soccer/ger.1', sport: 'soccer', name: 'German Bundesliga' },
  { id: 'fra.1', path: 'soccer/fra.1', sport: 'soccer', name: 'French Ligue 1' },
  { id: 'usa.1', path: 'soccer/usa.1', sport: 'soccer', name: 'MLS' },
  { id: 'uefa.champions', path: 'soccer/uefa.champions', sport: 'soccer', name: 'UEFA Champions League' },
  // Two-sided leagues on the same competitors[] shape (probed 2026-07-20). `rugby/scrum`
  // (non-JSON) and `golf/pga` (156-competitor field) do NOT fit this path and are absent.
  { id: 'ufc', path: 'mma/ufc', sport: 'mma', name: 'UFC', hasSummary: false },
  { id: 'cricket', path: 'cricket/8039', sport: 'cricket', name: 'Cricket' },
  { id: 'college-football', path: 'football/college-football', sport: 'football', name: 'College Football' },
  {
    id: 'mens-college-basketball',
    path: 'basketball/mens-college-basketball',
    sport: 'basketball',
    name: "Men's College Basketball",
  },
];

// --- i18n for the scoreboard-derived relay (§12.1) --------------------------

/**
 * The lines a league with NO summary endpoint composes from its scoreboard. The
 * upstream carries no prose for them at all, so per §12.1 they are provider-
 * composed and therefore localized in both locales.
 *
 * Registered from here rather than added to the core table in src/core/i18n.ts,
 * which this task does not own; `registerMessages` is the pinned public API for
 * exactly this (§9), it runs at import time and it is idempotent.
 *
 * Every variant references only placeholders it is guaranteed to receive — the
 * caller picks `espnContestEnd` precisely when there is no winner to name — so a
 * raw `{placeholder}` can never render.
 */
const EN_ESPN: Record<string, string> = {
  espnContestStart: 'Under way — {home} vs {away}',
  espnContestResult: 'Result — {winner} def. {loser}',
  espnContestEnd: 'Final — {home} vs {away}',
};

const KO_ESPN: Record<string, string> = {
  espnContestStart: '경기 시작 — {home} 대 {away}',
  espnContestResult: '경기 결과 — {winner} 승, {loser} 패',
  espnContestEnd: '경기 종료 — {home} 대 {away}',
};

registerMessages('en', EN_ESPN);
registerMessages('ko', KO_ESPN);

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
function clockOrUndef(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = normalizeWs(v);
  return s.length ? s : undefined;
}
function buildTeam(idRaw: unknown, nameRaw: unknown, abbrevRaw: unknown, scoreRaw: unknown): TeamSide {
  const abbrevClean = sanitizeText(abbrevRaw);
  const nameClean = sanitizeText(nameRaw);
  const abbrev = abbrevClean
    ? abbrevClean.slice(0, 5)
    : nameClean
      ? nameClean.trim().slice(0, 3).toUpperCase()
      : undefined;
  return {
    id: str(idRaw),
    name: nameClean ?? abbrev ?? 'TBD',
    abbrev: abbrev ?? 'TBD',
    score: coerceScore(scoreRaw),
  };
}

// --- logos (§13) -----------------------------------------------------------

/** §13.2b: a tree icon paints at ~16 px — ask the CDN for a small image, not the 500 px master. */
const LOGO_PX = 64;

/**
 * The ONLY host an MMA fighter headshot may come from: the one ESPN host already
 * on the logo cache's allowlist (src/ui/logoCache.ts). ESPN serves some headshots
 * from `secure.espncdn.com`, which the cache would reject — a headshot from
 * anywhere else yields `undefined` rather than a URL that can never resolve.
 * This provider does not add hosts.
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
 * Resize an ESPN logo URL to LOGO_PX (§13.2b/§13.3). The input is already https
 * (normLogoUrl ran first), so the rewrite only ever sees an https URL.
 * - `https://a.espncdn.com/i/{path}` ⇒ combiner form; `img` keeps its leading slash.
 * - a URL already on the combiner path ⇒ force `w`/`h` to LOGO_PX, preserve every other param.
 * - any other shape on a.espncdn.com, or any other host ⇒ pass through UNRESIZED.
 * Conservative by design: a big logo beats a broken one, so a `new URL()` throw ⇒ input unchanged.
 */
function resizeEspnLogo(url: string): string {
  try {
    const u = new URL(url);
    if (u.hostname !== 'a.espncdn.com') return url;
    if (u.pathname.startsWith('/combiner/i')) {
      u.searchParams.set('w', String(LOGO_PX));
      u.searchParams.set('h', String(LOGO_PX));
      return u.toString();
    }
    if (u.pathname.startsWith('/i/')) {
      return `https://a.espncdn.com/combiner/i?img=${u.pathname}&w=${LOGO_PX}&h=${LOGO_PX}&transparent=true`;
    }
    return url;
  } catch {
    return url;
  }
}

/** LogoRef from a required light + optional dark candidate; undefined when light is unusable. */
function logoRef(lightRaw: unknown, darkRaw?: unknown): LogoRef | undefined {
  const light = normLogoUrl(lightRaw);
  if (!light) return undefined;
  const dark = normLogoUrl(darkRaw);
  const lightResized = resizeEspnLogo(light);
  return dark ? { light: lightResized, dark: resizeEspnLogo(dark) } : { light: lightResized };
}

/** `headshot` arrives either as `{ href }` or as a bare string, depending on the sport. */
function headshotHref(v: unknown): unknown {
  const h = rec(v).headshot;
  return isRecord(h) ? h.href : h;
}

/** An https headshot on the allowlisted host, resized; anything else undefined. */
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

/** Keep a scoreboard-sourced logo on the fresh game when the summary header carries none. */
function carryLogo(side: TeamSide, prev: TeamSide): TeamSide {
  if (!side.logo && prev.logo) return { ...side, logo: prev.logo };
  return side;
}

/** FNV-1a derived id using occurrence ordinal (NOT array index) so ids stay stable under front-insertion. */
function derivedId(gameId: string, normText: string, occ: Map<string, number>): string {
  const k = occ.get(normText) ?? 0;
  occ.set(normText, k + 1);
  return fnv1a32(`${gameId}|${normText}|${k}`);
}

/** Leading-minute parse for the soccer chronological guard ("90'+7'" → 97). */
function clockMinutes(v: unknown): number | undefined {
  if (typeof v !== 'string') return undefined;
  const m = v.match(/(\d+)\s*'?\s*(?:\+\s*(\d+))?/);
  if (!m) return undefined;
  const base = Number(m[1]);
  if (!Number.isFinite(base)) return undefined;
  const extra = m[2] ? Number(m[2]) : 0;
  return base + (Number.isFinite(extra) ? extra : 0);
}

// --- status ----------------------------------------------------------------

type Phase = Game['phase'];

function espnPhase(state: string): Phase {
  return state === 'pre' || state === 'in' || state === 'post' ? state : 'unknown';
}

/**
 * Live period label by sport. ESPN reports the in-progress unit in the same
 * numeric `status.period` for every sport, but the unit is NOT a quarter
 * everywhere: MMA fights ROUNDS and cricket plays INNINGS, and rendering either
 * as 'Q3' is simply wrong. Sliced to the contract's 8-char statusShort cap so a
 * nonsense period number cannot overflow it.
 */
function livePeriodLabel(sport: SportKind, period: number): string {
  const prefix = sport === 'mma' ? 'R' : sport === 'cricket' ? 'I' : 'Q';
  return `${prefix}${period}`.slice(0, 8);
}

function espnStatusShort(
  phase: Phase,
  sport: SportKind,
  status: Record<string, unknown>,
  type: Record<string, unknown>,
  startTimeUtc: string | undefined,
): string {
  if (phase === 'pre') return localHHMM(startTimeUtc);
  if (phase === 'post') return sport === 'soccer' ? 'FT' : 'F';
  if (phase === 'in') {
    if (sport === 'soccer') {
      const dc = sanitizeText(status.displayClock);
      return dc ? dc.slice(0, 8) : 'LIVE';
    }
    const p = status.period;
    return typeof p === 'number' && Number.isFinite(p) ? livePeriodLabel(sport, p) : 'LIVE';
  }
  const sd = sanitizeText(type.shortDetail);
  return sd ? sd.slice(0, 8) : 'TBD';
}

/**
 * Shared phase/status derivation (§2.1). Both the scoreboard event and the
 * summary `header.competitions[0]` carry a `status.type` block of the same
 * shape, so listGames and the fresh-game rebuild in fetchPlays run identical
 * logic through here.
 */
function deriveStatus(
  status: Record<string, unknown>,
  sport: SportKind,
  startTimeUtc: string | undefined,
): { phase: Phase; statusText: string; statusShort: string } {
  const type = rec(status.type);
  const phase = espnPhase(str(type.state));
  const statusShort = espnStatusShort(phase, sport, status, type, startTimeUtc);
  const statusText = sanitizeText(type.shortDetail) ?? sanitizeText(type.detail) ?? statusShort;
  return { phase, statusText, statusShort };
}

/**
 * Cricket reports a batting side's score as `runs/wickets (overs)` —
 * '241/4 (43/50 ov, target 241)' live — where every other sport reports a bare
 * integer. coerceScore is deliberately strict (§2) and rejects the whole string,
 * so the side that is actually AHEAD showed no score at all while the side that
 * had already batted showed one: the display asserted the opposite of the result,
 * and mid-match BOTH innings carry the format, so neither score ever changed.
 * The runs lead the string, so take them and let coerceScore judge them as usual.
 * Anything that does not start with digits is passed through untouched.
 */
function cricketRuns(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  const m = v.trim().match(/^\d+/);
  return m ? m[0] : v;
}

/**
 * The wickets and overs that `cricketRuns` drops are real information, so they
 * stay readable on statusText: '2nd Innings — IND 241/4 (43/50 ov, target 241)'.
 * A side whose score is already a bare integer adds nothing and is omitted, so a
 * non-cricket-shaped feed leaves the status untouched.
 */
function withCricketDetail(base: string, competitors: unknown[]): string {
  const parts: string[] = [];
  for (const c of competitors) {
    if (!isRecord(c)) continue;
    const raw = sanitizeText(c.score);
    // A bare integer says nothing the number does not, and a feed that already
    // spells the innings out in its own status is not repeated back at itself.
    if (raw === undefined || /^\d+$/.test(raw) || base.includes(raw)) continue;
    parts.push(`${buildCompetitorSide(c, 'cricket').abbrev} ${raw}`);
  }
  if (parts.length === 0) return base;
  return sanitizeText(`${base} — ${parts.join(', ')}`) ?? base;
}

/** One `competitors[]` entry → a TeamSide. */
function buildCompetitorSide(c: Record<string, unknown>, sport: SportKind): TeamSide {
  // Team sports carry `competitor.team`; MMA carries an individual `athlete`
  // and no team at all, so every field falls through team → athlete →
  // the competitor's own name, and buildTeam's 'TBD' is the floor.
  const team = rec(c.team);
  const athlete = rec(c.athlete);
  const side = buildTeam(
    team.id ?? athlete.id ?? c.id,
    team.displayName ??
      team.name ??
      team.shortDisplayName ??
      athlete.displayName ??
      athlete.fullName ??
      athlete.shortName ??
      c.displayName ??
      c.name,
    // NOT athlete.shortName: 'J. Jones' truncates to a meaningless 'J. Jo',
    // where buildTeam's name-derived fallback yields 'JON'.
    team.abbreviation ?? athlete.abbreviation,
    sport === 'cricket' ? cricketRuns(c.score) : c.score,
  );
  const logo = logoRef(team.logo) ?? headshotRef(headshotHref(c.athlete));
  if (logo) side.logo = logo;
  return side;
}

/** `competitor.winner` is boolean on most feeds and the STRING 'true' on cricket's. */
function isWinner(v: unknown): boolean {
  return v === true || v === 'true';
}

/** A side plus the feed's own verdict on it — what the relay needs and TeamSide cannot hold. */
interface Contestant {
  side: TeamSide;
  won: boolean;
}

/**
 * Shared competitor parse: `competitions[].competitors[]` → home/away (undefined
 * when absent), each carrying its winner flag.
 */
function parseContestants(
  competitors: unknown[],
  sport: SportKind,
): { home: Contestant | undefined; away: Contestant | undefined } {
  const ordered: { entry: Contestant; declared: string }[] = [];
  for (const c of competitors) {
    if (!isRecord(c)) continue;
    const entry: Contestant = { side: buildCompetitorSide(c, sport), won: isWinner(c.winner) };
    ordered.push({ entry, declared: typeof c.homeAway === 'string' ? c.homeAway : '' });
  }
  let home: Contestant | undefined;
  let away: Contestant | undefined;
  // A declared side is trusted verbatim and never second-guessed; the first
  // declaration of each side wins, so a duplicate cannot displace it.
  for (const o of ordered) {
    if (o.declared === 'home') home = home ?? o.entry;
    else if (o.declared === 'away') away = away ?? o.entry;
  }
  // A UFC bout's competitors carry `order`, not `homeAway` (probed live), which
  // used to leave both sides 'TBD'. An undeclared competitor takes whichever slot
  // is still free, in the FEED'S OWN array order — index 0 is home — exactly as
  // the tennis provider pins it. Which side is "home" is meaningless in a
  // one-on-one contest; what matters is that the assignment is stable across
  // polls, and array order is.
  //
  // Per-side, NOT all-or-nothing: one card mixes the two shapes (the repo fixture
  // declares homeAway, the live card carries only `order`), and a bout where just
  // ONE competitor declares used to lose the other fighter to 'TBD' entirely and
  // drop the bout's relay line. Only a genuine pair falls back — with three or
  // more competitors and a missing declaration the pairing is ambiguous, and
  // inventing one is worse than reporting none.
  if (ordered.length === 2 && (home === undefined || away === undefined)) {
    for (const o of ordered) {
      if (o.declared === 'home' || o.declared === 'away') continue;
      if (home === undefined) home = o.entry;
      else if (away === undefined) away = o.entry;
    }
  }
  return { home, away };
}

/** parseContestants without the winner flags — the shape the game builders want. */
function parseCompetitors(
  competitors: unknown[],
  sport: SportKind,
): { home: TeamSide | undefined; away: TeamSide | undefined } {
  const { home, away } = parseContestants(competitors, sport);
  return { home: home?.side, away: away?.side };
}

/**
 * Fresh game (§2 pin) from the summary `header` — same logic as the scoreboard
 * parse. When the header carries no usable status (soccer pre-game summaries
 * expose only `{ id }`, so the state maps to 'unknown') the input game is
 * carried through unchanged.
 */
function freshGameFromHeader(data: Record<string, unknown>, game: Game): Game {
  const header = rec(data.header);
  const comp = rec(asArray(header.competitions)[0]);
  const status = rec(comp.status);
  const competitors = asArray(comp.competitors);
  const derived = deriveStatus(status, game.sport, game.startTimeUtc);
  const { phase, statusShort } = derived;
  const statusText =
    game.sport === 'cricket' ? withCricketDetail(derived.statusText, competitors) : derived.statusText;
  if (phase === 'unknown') return game;
  // §14: every game this provider emits is 'versus', so both sides are present.
  // Only a positively-'field' game genuinely has no sides to merge onto; an
  // ABSENT format is a pre-§14 game, and every game shipped before §14 was
  // two-sided, so it refreshes as versus. Do not tighten this back to
  // `!== 'versus'`: that freezes a legacy game's score while its status keeps
  // updating, silently and without a log.
  if (game.format === 'field' || !game.home || !game.away) {
    return { ...game, phase, statusText, statusShort };
  }
  const prevHome = game.home;
  const prevAway = game.away;
  const { home, away } = parseCompetitors(competitors, game.sport);
  return {
    ...game,
    phase,
    statusText,
    statusShort,
    home: home ? carryLogo(home, prevHome) : prevHome,
    away: away ? carryLogo(away, prevAway) : prevAway,
  };
}

// --- provider --------------------------------------------------------------

function defForLeague(leagueId: string): EspnLeagueDef | undefined {
  return ESPN_LEAGUES.find((l) => l.id === leagueId);
}

/**
 * One scoreboard `events[]` entry → a Game, or undefined when it carries no id.
 * Shared by listGames and by the scoreboard-derived fetchPlays path, so a league
 * without a summary endpoint refreshes into EXACTLY the game listGames built.
 */
function parseScoreboardEvent(ev: Record<string, unknown>, league: League): Game | undefined {
  const eventId = str(ev.id);
  if (!eventId) return undefined;
  const status = rec(ev.status);
  const startTimeUtc = parseIsoUtc(ev.date);

  // The LAST competition, not the first. A UFC `event` is a whole fight CARD whose
  // `competitions[]` are its bouts in running order, so `[0]` named the row, the
  // status-bar tag and the relay's final line after the opening PRELIM — two
  // fighters nobody followed the card for — while the main event, which is what
  // `ev.name` itself is named after, never appeared anywhere. The main event closes
  // the card, so the last competition is the one a user recognises. Every other
  // league puts exactly one competition on an event, where last IS first.
  const comps = asArray(ev.competitions);
  const comp = rec(comps.length > 0 ? comps[comps.length - 1] : undefined);
  const competitors = asArray(comp.competitors);

  const derived = deriveStatus(status, league.sport, startTimeUtc);
  const { phase, statusShort } = derived;
  const statusText =
    league.sport === 'cricket' ? withCricketDetail(derived.statusText, competitors) : derived.statusText;
  const { home, away } = parseCompetitors(competitors, league.sport);
  const tbd: TeamSide = { id: '', name: 'TBD', abbrev: 'TBD', score: undefined };

  return {
    id: `espn:${league.id}:${eventId}`,
    providerId: 'espn',
    leagueId: league.id,
    leagueName: league.name,
    sport: league.sport,
    startTimeUtc,
    phase,
    statusText,
    statusShort,
    format: 'versus',
    home: home ?? tbd,
    away: away ?? tbd,
    entrants: undefined,
  };
}

function parseScoreboard(raw: unknown, league: League, ctx: ProviderContext): Game[] {
  const events = asArray(rec(raw).events);
  const games: Game[] = [];
  for (const ev of events) {
    try {
      if (!isRecord(ev)) {
        ctx.log('espn: skipped non-object scoreboard event');
        continue;
      }
      const game = parseScoreboardEvent(ev, league);
      if (game === undefined) continue;
      games.push(game);
    } catch (e) {
      ctx.log(`espn: skipped malformed scoreboard event: ${String(e)}`);
    }
  }
  return games;
}

/** football/basketball: plays[] → sequence = array index, native .id. */
function parsePlays(playsRaw: unknown, gameId: string, ctx: ProviderContext): PlayEvent[] {
  const plays = asArray(playsRaw);
  const occ = new Map<string, number>();
  const out: PlayEvent[] = [];
  plays.forEach((p, idx) => {
    try {
      if (!isRecord(p)) return;
      const text = sanitizeText(p.text);
      if (!text) return;
      const normText = normalizeWs(text);
      const nativeId = str(p.id);
      const id = nativeId || derivedId(gameId, normText, occ);
      const period = rec(p.period);
      const pnum = period.number;
      const periodLabel = typeof pnum === 'number' && Number.isFinite(pnum) ? `Q${pnum}` : undefined;
      const clock = clockOrUndef(rec(p.clock).displayValue);
      const home = coerceScore(p.homeScore);
      const away = coerceScore(p.awayScore);
      const scoreAfter = home !== undefined && away !== undefined ? { home, away } : undefined;
      out.push({
        id,
        gameId,
        sequence: idx,
        clock,
        period: periodLabel,
        text,
        kind: p.scoringPlay === true ? 'score' : 'play',
        scoreAfter,
      });
    } catch (e) {
      ctx.log(`espn: skipped malformed play: ${String(e)}`);
    }
  });
  out.sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id));
  return out;
}

/** Chronological order key: native .sequence when finite, else parsed clock minute. */
function orderKey(c: unknown): number | undefined {
  if (!isRecord(c)) return undefined;
  if (typeof c.sequence === 'number' && Number.isFinite(c.sequence)) return c.sequence;
  return clockMinutes(rec(c.time).displayValue);
}

/** soccer commentary[]: native .sequence (or index after chronological guard); derived ids. */
function parseCommentary(commentaryRaw: unknown, gameId: string, ctx: ProviderContext): PlayEvent[] {
  const arr = asArray(commentaryRaw).slice();
  if (arr.length >= 2) {
    const fk = orderKey(arr[0]);
    const lk = orderKey(arr[arr.length - 1]);
    if (fk !== undefined && lk !== undefined && fk > lk) arr.reverse();
  }
  const occ = new Map<string, number>();
  const out: PlayEvent[] = [];
  arr.forEach((c, idx) => {
    try {
      if (!isRecord(c)) return;
      const text = sanitizeText(c.text);
      if (!text) return;
      const normText = normalizeWs(text);
      const seq = typeof c.sequence === 'number' && Number.isFinite(c.sequence) ? c.sequence : idx;
      out.push({
        id: derivedId(gameId, normText, occ),
        gameId,
        sequence: seq,
        clock: clockOrUndef(rec(c.time).displayValue),
        period: undefined,
        text,
        kind: 'play',
        scoreAfter: undefined,
      });
    } catch (e) {
      ctx.log(`espn: skipped malformed commentary entry: ${String(e)}`);
    }
  });
  out.sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id));
  return out;
}

/** soccer keyEvents[] fallback: native .id present; drop empty text. */
function parseKeyEvents(keyEventsRaw: unknown, gameId: string, ctx: ProviderContext): PlayEvent[] {
  const arr = asArray(keyEventsRaw);
  const occ = new Map<string, number>();
  const out: PlayEvent[] = [];
  arr.forEach((e, idx) => {
    try {
      if (!isRecord(e)) return;
      const text = sanitizeText(e.text);
      if (!text) return;
      const normText = normalizeWs(text);
      const nativeId = str(e.id);
      out.push({
        id: nativeId || derivedId(gameId, normText, occ),
        gameId,
        sequence: idx,
        clock: clockOrUndef(rec(e.clock).displayValue),
        period: undefined,
        text,
        kind: 'play',
        scoreAfter: undefined,
      });
    } catch (err) {
      ctx.log(`espn: skipped malformed keyEvent: ${String(err)}`);
    }
  });
  out.sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id));
  return out;
}

/**
 * Leading-minute parse for the detailed keyEvent sequence (§12.5). Uses the FIRST
 * number only, so stoppage time "90'+7'" → 90 (the trailing +7 is disambiguated by
 * `n`, not folded into the minute). Empty/absent ⇒ 0.
 */
function keyEventMinute(displayValue: unknown): number {
  if (typeof displayValue !== 'string') return 0;
  const m = displayValue.match(/(\d+)/);
  return m ? Number(m[1]) : 0;
}

/**
 * soccer keyEvents[] as detailed, PROVIDER-COMPOSED localized lines (§12.5). Text
 * is built from structured fields (type/player/team) via `soccerEvent` — never the
 * API's own `keyEvent.text` prose — so it is Korean-capable and immutable. id = the
 * native keyEvent `.id`. sequence = `100000 + minute*100 + n`, which sits above every
 * commentary sequence (0..~110) so the two id/sequence spaces cannot collide; `n` is
 * the occurrence index among keyEvents sharing a parsed minute. A keyEvent with empty
 * text AND no participants is skipped (nothing meaningful to compose).
 */
function parseKeyEventsDetailed(
  keyEventsRaw: unknown,
  gameId: string,
  locale: RelayLocale,
  ctx: ProviderContext,
): PlayEvent[] {
  const arr = asArray(keyEventsRaw);
  const minuteCount = new Map<number, number>();
  const out: PlayEvent[] = [];
  for (const e of arr) {
    try {
      if (!isRecord(e)) continue;
      const rawText = sanitizeText(e.text);
      const participants = asArray(e.participants);
      if (rawText === undefined && participants.length === 0) continue;
      const id = str(e.id);
      if (!id) continue;
      const typeObj = rec(e.type);
      const typeLabel = tEnum(locale, 'soccerEventType', str(typeObj.type), str(typeObj.text) || undefined);
      const player = str(rec(rec(participants[0]).athlete).displayName);
      const team = str(rec(e.team).displayName);
      const text = sanitizeText(t(locale, 'soccerEvent', { type: typeLabel, player, team }));
      if (text === undefined) continue;
      const minute = keyEventMinute(rec(e.clock).displayValue);
      const n = minuteCount.get(minute) ?? 0;
      minuteCount.set(minute, n + 1);
      out.push({
        id,
        gameId,
        sequence: 100000 + minute * 100 + n,
        clock: clockOrUndef(rec(e.clock).displayValue),
        period: undefined,
        text,
        kind: e.scoringPlay === true ? 'score' : 'play',
        scoreAfter: undefined,
      });
    } catch (err) {
      ctx.log(`espn: skipped malformed detailed keyEvent: ${String(err)}`);
    }
  }
  out.sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id));
  return out;
}

// --- live current state (§11.4) --------------------------------------------

/** Jersey/shirt number as text (string or finite number), else undefined. */
function jerseyText(v: unknown): string | undefined {
  if (typeof v === 'string' && v.trim().length) return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}

/** One group (starters or bench) of a roster → LineupSpot[], 1-based within the group. */
function buildGroup(roster: unknown[], wantStarter: boolean, side: string, ctx: ProviderContext): LineupSpot[] {
  const spots: LineupSpot[] = [];
  for (const e of roster) {
    if (!isRecord(e)) continue;
    // starters = starter === true; bench = starter === false; anything else in neither.
    if (wantStarter ? e.starter !== true : e.starter !== false) continue;
    if (!isRecord(e.athlete)) {
      ctx.log(`espn: ${side} roster entry missing athlete — skipping`);
      continue;
    }
    const name = str(e.athlete.displayName);
    if (!name) {
      ctx.log(`espn: ${side} roster entry missing displayName — skipping`);
      continue;
    }
    const spot: LineupSpot = { order: spots.length + 1, name, position: str(rec(e.position).abbreviation) };
    const jersey = jerseyText(e.jersey);
    if (jersey !== undefined) spot.jersey = jersey;
    spots.push(spot);
  }
  return spots;
}

/** One roster entry → { formation, starters, bench }; undefined roster ⇒ empty side. */
function buildSide(
  roster: Record<string, unknown> | undefined,
  side: string,
  ctx: ProviderContext,
): { formation?: string; starters: LineupSpot[]; bench: LineupSpot[] } {
  if (roster === undefined) return { starters: [], bench: [] };
  const list = asArray(roster.roster);
  const out: { formation?: string; starters: LineupSpot[]; bench: LineupSpot[] } = {
    starters: buildGroup(list, true, side, ctx),
    bench: buildGroup(list, false, side, ctx),
  };
  const formation = str(roster.formation);
  if (formation) out.formation = formation;
  return out;
}

/**
 * Soccer current state from the SAME summary payload (§11.4). Absent rosters
 * (pre-game) ⇒ undefined. Callers gate on soccer + phase==='in' and wrap in
 * try/catch so any state-shape surprise degrades to undefined.
 */
function buildSoccerState(data: Record<string, unknown>, ctx: ProviderContext): SoccerState | undefined {
  const rosters = asArray(data.rosters);
  if (rosters.length === 0) return undefined;
  let homeRoster: Record<string, unknown> | undefined;
  let awayRoster: Record<string, unknown> | undefined;
  rosters.forEach((r, idx) => {
    if (!isRecord(r)) return;
    const ha = str(r.homeAway);
    if (ha === 'home') homeRoster = r;
    else if (ha === 'away') awayRoster = r;
    // homeAway absent ⇒ index 0 ⇒ home, 1 ⇒ away (mirror competitor order).
    else if (idx === 0) homeRoster = homeRoster ?? r;
    else if (idx === 1) awayRoster = awayRoster ?? r;
  });
  return {
    kind: 'soccer',
    home: buildSide(homeRoster, 'home', ctx),
    away: buildSide(awayRoster, 'away', ctx),
  };
}

// --- leagues with no summary endpoint --------------------------------------

/** Sequence band per contest: `index * 2` for the start line, `+ 1` for the result. */
const SEQ_PER_CONTEST = 2;

/**
 * Contest id when the feed names none: derived from WHO is contesting, never from
 * the array position. A fight card's `competitions[]` is exactly the list that
 * SHRINKS as bouts settle, so position N addresses a different bout after a
 * removal — and because the relay engine keys on id, the next poll re-emitted one
 * bout's result under the previous bout's id as a 'correction' (§3.4), rewriting
 * the user's log to claim a fight ended differently than it did. The two sides are
 * sorted so that a feed reordering them is still the same contest.
 */
function contestFallbackId(eventId: string, a: TeamSide, b: TeamSide): string {
  const keys = [a, b].map((s) => s.id || normalizeWs(s.name)).sort();
  return `${eventId}#${fnv1a32(keys.join('|'))}`;
}

/**
 * Relay events for a league with NO summary endpoint, derived from the SINGLE
 * scoreboard response that also supplies the fresh game. This provider is
 * stateless and never diffs across polls, so nothing here may depend on a
 * previous one: what one response states truthfully is which contests on the
 * event are under way and, for the ones that are over, who won them.
 *
 * A UFC `event` is a whole FIGHT CARD and its `competitions[]` are the individual
 * bouts (probed live), so a card yields one result line per settled bout. A league
 * whose event holds a single competition simply yields one contest's lines.
 *
 * Ids are `${competitionId}:start` and `${competitionId}:result` — derived from
 * the contest and its meaning, and therefore stable across polls. The relay engine
 * dedupes by id, so an id that shifted would re-emit the same line forever. Text
 * carries only immutable facts (§2, §12.2): a settled result never changes, which
 * is why no line reports a live round or a running clock.
 *
 * The start line is emitted only while that contest is 'in'. It has already been
 * relayed by then, and the engine never re-adds an id it has seen, so dropping it
 * once the contest ends keeps a 12-bout card from reading as 24 lines of noise.
 */
function buildContestEvents(
  ev: Record<string, unknown>,
  game: Game,
  locale: RelayLocale,
  ctx: ProviderContext,
): PlayEvent[] {
  const out: PlayEvent[] = [];
  const comps = asArray(ev.competitions);
  // A single-competition league states the contest's status only on the EVENT, so
  // there the event's phase IS the contest's. On a CARD it is not: a 12-bout card
  // sits at 'in' from its first prelim to its main event, and inheriting that
  // announced all twelve bouts as under way at once — a burst of false starts that
  // also spent the relay's backfill limit. A bout that declares no status of its
  // own is not known to be under way, so it produces no line at all.
  const eventPhaseIsContestPhase = comps.length === 1;
  comps.forEach((raw, idx) => {
    try {
      const comp = rec(raw);
      const own = espnPhase(str(rec(rec(comp.status).type).state));
      const phase = own !== 'unknown' ? own : eventPhaseIsContestPhase ? game.phase : 'unknown';
      if (phase !== 'in' && phase !== 'post') return;

      const { home, away } = parseContestants(asArray(comp.competitors), game.sport);
      if (home === undefined || away === undefined) {
        ctx.log(`espn: contest ${idx} of ${game.id} has no two sides — no relay line`);
        return;
      }
      // A native competition id, else one derived from the competitors themselves.
      const nativeId = str(comp.id) || contestFallbackId(str(ev.id), home.side, away.side);
      const base = idx * SEQ_PER_CONTEST;

      if (phase === 'in') {
        const text = sanitizeText(t(locale, 'espnContestStart', { home: home.side.name, away: away.side.name }));
        if (text === undefined) return;
        out.push({
          id: `${nativeId}:start`,
          gameId: game.id,
          sequence: base,
          clock: undefined,
          period: undefined,
          text,
          kind: 'status',
          scoreAfter: undefined,
        });
        return;
      }

      // Exactly one side flagged the winner names a result; a draw, a no-contest
      // or an unflagged pair states the pairing and invents no outcome.
      const winner = home.won !== away.won ? (home.won ? home : away) : undefined;
      const text =
        winner === undefined
          ? sanitizeText(t(locale, 'espnContestEnd', { home: home.side.name, away: away.side.name }))
          : sanitizeText(
              t(locale, 'espnContestResult', {
                winner: winner.side.name,
                loser: (winner === home ? away : home).side.name,
              }),
            );
      if (text === undefined) return;
      const hs = home.side.score;
      const as = away.side.score;
      out.push({
        id: `${nativeId}:result`,
        gameId: game.id,
        sequence: base + 1,
        clock: undefined,
        period: undefined,
        text,
        // 'score' rather than 'status': this is the line reporting the outcome,
        // which the relay marks with ★ (§5). A bout carries no numeric score, so
        // `scoreAfter` simply stays undefined there.
        kind: 'score',
        scoreAfter: hs !== undefined && as !== undefined ? { home: hs, away: as } : undefined,
      });
    } catch (e) {
      ctx.log(`espn: skipped malformed contest: ${String(e)}`);
    }
  });
  // §2: providers sort by sequence ascending; array order is never trusted.
  out.sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id));
  return out;
}

/**
 * fetchPlays for a league whose `summary` route does not exist. The scoreboard is
 * re-fetched and the event located by its native id; that one response supplies
 * both the fresh game (§2 pin — phase, scores and status strings are re-derived,
 * never carried over) and every relay line D4 allows.
 *
 * An event that is genuinely no longer on the scoreboard is still 'not-found':
 * that means the game is gone and auto-unfollowing it (§4) is correct. What must
 * never produce 'not-found' again is the mere absence of a summary ROUTE.
 *
 * 'not-found' is the signal the poller counts three of and then AUTO-UNFOLLOWS
 * (§4), so it is raised ONLY when the board itself testifies to the absence: the
 * response must be well-formed AND carry at least one usable event AND still not
 * contain this id. A fetch failure, a body that is not a scoreboard at all, and an
 * EMPTY board (a day rollover, an off-season, a route hiccup) say nothing about
 * this game and are 'unavailable', which backs off and retries. The asymmetry was
 * the indictment: the identical upstream condition is harmless on a summary-backed
 * league, where an empty body is simply zero plays.
 */
async function fetchFromScoreboard(ctx: ProviderContext, game: Game, def: EspnLeagueDef): Promise<PlaySnapshot> {
  const eventId = lastSegment(game.id);
  let raw: unknown;
  try {
    raw = await ctx.fetchJson(`${BASE}${def.path}/scoreboard`);
  } catch (e) {
    // A 404 on the SCOREBOARD route is the route being unreachable, not the game
    // vanishing — never let it auto-unfollow a live fight. Every other provider
    // error keeps its own kind; none of them auto-unfollows.
    if (e instanceof ProviderError && e.kind !== 'not-found') throw e;
    throw new ProviderError('unavailable', `espn: ${def.id} scoreboard fetch failed: ${String(e)}`);
  }
  try {
    const league: League = {
      id: def.id,
      providerId: 'espn',
      name: game.leagueName || def.name,
      sport: def.sport,
    };
    const events = rec(raw).events;
    if (!Array.isArray(events)) {
      throw new ProviderError('unavailable', `espn: ${def.id} scoreboard body is not a scoreboard`);
    }
    let usable = 0;
    for (const ev of events) {
      if (!isRecord(ev) || str(ev.id) === '') continue;
      usable++;
      if (str(ev.id) !== eventId) continue;
      const fresh = parseScoreboardEvent(ev, league);
      if (fresh === undefined) break;
      return { game: fresh, events: buildContestEvents(ev, fresh, ctx.locale, ctx), state: undefined };
    }
    if (usable === 0) {
      throw new ProviderError('unavailable', `espn: ${def.id} scoreboard carries no usable event`);
    }
    throw new ProviderError('not-found', `espn: event ${eventId} is not on the ${def.id} scoreboard`);
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    throw new ProviderError('parse', `espn fetchPlays parse: ${String(e)}`);
  }
}

export const espnProvider: SportProvider = {
  id: 'espn',
  displayName: 'ESPN',
  requiresSecret: undefined,

  async listLeagues(): Promise<League[]> {
    return ESPN_LEAGUES.map((l) => ({ id: l.id, providerId: 'espn', name: l.name, sport: l.sport }));
  },

  async listGames(ctx: ProviderContext, league: League): Promise<Game[]> {
    const def = defForLeague(league.id);
    const path = def ? def.path : league.sport === 'soccer' ? `soccer/${league.id}` : league.id;
    const raw = await ctx.fetchJson(`${BASE}${path}/scoreboard`);
    try {
      return parseScoreboard(raw, league, ctx);
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      throw new ProviderError('parse', `espn listGames parse: ${String(e)}`);
    }
  },

  async fetchPlays(ctx: ProviderContext, game: Game): Promise<PlaySnapshot> {
    const eventId = lastSegment(game.id);
    const def = defForLeague(game.leagueId);
    // No summary route for this league ⇒ derive the snapshot from the scoreboard.
    // Every other league keeps the summary path untouched.
    if (def !== undefined && def.hasSummary === false) return fetchFromScoreboard(ctx, game, def);
    const path = def ? def.path : game.sport === 'soccer' ? `soccer/${game.leagueId}` : game.leagueId;
    const raw = await ctx.fetchJson(`${BASE}${path}/summary?event=${eventId}`);
    try {
      const data = rec(raw);
      let events: PlayEvent[];
      if (game.sport === 'soccer') {
        const commentaryRaw = asArray(data.commentary);
        const keyEventsRaw = asArray(data.keyEvents);
        if (commentaryRaw.length > 0) {
          // summary = commentary prose (verbatim, §12.1). detailed ALSO appends the
          // composed keyEvent lines; their 100000+ sequences sit after all commentary,
          // so the concatenation stays globally sorted by sequence.
          events = parseCommentary(commentaryRaw, game.id, ctx);
          if (ctx.detail === 'detailed' && keyEventsRaw.length > 0) {
            events = events.concat(parseKeyEventsDetailed(keyEventsRaw, game.id, ctx.locale, ctx));
          }
        } else if (keyEventsRaw.length > 0) {
          // No commentary: summary uses the raw keyEvent text fallback; detailed uses
          // the richer composed lines instead.
          events =
            ctx.detail === 'detailed'
              ? parseKeyEventsDetailed(keyEventsRaw, game.id, ctx.locale, ctx)
              : parseKeyEvents(keyEventsRaw, game.id, ctx);
        } else {
          events = [];
        }
      } else {
        events = parsePlays(data.plays, game.id, ctx);
      }
      // Fresh game (§2 pin). A malformed status block must never lose the
      // parsed events, so header refresh degrades to carrying the input game.
      let freshGame = game;
      try {
        freshGame = freshGameFromHeader(data, game);
      } catch (e) {
        ctx.log(`espn: header refresh failed, carrying input game: ${String(e)}`);
      }

      // Live current state (§11.2/§11.4): soccer only, live only, free from
      // this same summary payload. Any state-shape surprise degrades to
      // undefined — it must NEVER fail fetchPlays or drop the plays.
      let state: SoccerState | undefined;
      if (game.sport === 'soccer' && freshGame.phase === 'in') {
        try {
          state = buildSoccerState(data, ctx);
        } catch (e) {
          ctx.log(`espn: state build failed, state undefined: ${String(e)}`);
          state = undefined;
        }
      }

      return { game: freshGame, events, state };
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      throw new ProviderError('parse', `espn fetchPlays parse: ${String(e)}`);
    }
  },
};
