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
import { t, tEnum } from '../core/i18n';
import { coerceScore, fnv1a32, normalizeWs, parseIsoUtc, sanitizeText } from '../core/util';

const BASE = 'https://site.api.espn.com/apis/site/v2/sports/';

interface EspnLeagueDef {
  id: string;
  path: string;
  sport: SportKind;
  name: string;
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
];

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
    return typeof p === 'number' && Number.isFinite(p) ? `Q${p}` : 'LIVE';
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

/** Shared competitor parse: `competitions[0].competitors[]` → home/away (undefined when absent). */
function parseCompetitors(competitors: unknown[]): { home: TeamSide | undefined; away: TeamSide | undefined } {
  let home: TeamSide | undefined;
  let away: TeamSide | undefined;
  for (const c of competitors) {
    if (!isRecord(c)) continue;
    const team = rec(c.team);
    const side = buildTeam(team.id, team.displayName ?? team.name ?? team.shortDisplayName, team.abbreviation, c.score);
    const logo = logoRef(team.logo);
    if (logo) side.logo = logo;
    if (c.homeAway === 'home') home = side;
    else if (c.homeAway === 'away') away = side;
  }
  return { home, away };
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
  const { phase, statusText, statusShort } = deriveStatus(status, game.sport, game.startTimeUtc);
  if (phase === 'unknown') return game;
  const { home, away } = parseCompetitors(asArray(comp.competitors));
  return {
    ...game,
    phase,
    statusText,
    statusShort,
    home: home ? carryLogo(home, game.home) : game.home,
    away: away ? carryLogo(away, game.away) : game.away,
  };
}

// --- provider --------------------------------------------------------------

function defForLeague(leagueId: string): EspnLeagueDef | undefined {
  return ESPN_LEAGUES.find((l) => l.id === leagueId);
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
      const eventId = str(ev.id);
      if (!eventId) continue;
      const status = rec(ev.status);
      const startTimeUtc = parseIsoUtc(ev.date);

      const comps = asArray(ev.competitions);
      const comp = rec(comps[0]);

      const { phase, statusText, statusShort } = deriveStatus(status, league.sport, startTimeUtc);
      const { home, away } = parseCompetitors(asArray(comp.competitors));
      const tbd: TeamSide = { id: '', name: 'TBD', abbrev: 'TBD', score: undefined };

      games.push({
        id: `espn:${league.id}:${eventId}`,
        providerId: 'espn',
        leagueId: league.id,
        leagueName: league.name,
        sport: league.sport,
        startTimeUtc,
        phase,
        statusText,
        statusShort,
        home: home ?? tbd,
        away: away ?? tbd,
      });
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
