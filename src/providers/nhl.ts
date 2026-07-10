/**
 * NHL provider (key-free, official). Implements docs/CONTRACT.md §2.3.
 *
 * Layering: no 'vscode' import, no npm dependencies. Defensive throughout —
 * shape surprises become ProviderError('parse'); one bad game/play is skipped
 * (logged), never fatal. NHL sends no prose, so play text is templated from
 * typeDescKey; noise events are dropped at the provider (§2.3 noise cap).
 */

import {
  Game,
  League,
  LogoRef,
  PlayEvent,
  PlayEventKind,
  PlaySnapshot,
  ProviderContext,
  ProviderError,
  RelayLocale,
  SportProvider,
  TeamSide,
} from '../core/contract';
import { t, tEnum } from '../core/i18n';
import { coerceScore, normalizeWs, parseIsoUtc, sanitizeText } from '../core/util';

const NHL_LEAGUE: League = { id: 'nhl', providerId: 'nhl', name: 'NHL', sport: 'hockey' };

// Pure noise — dropped at BOTH detail levels (§12.4: never faceoff/stoppage).
const ALWAYS_DROP = new Set(['faceoff', 'stoppage']);

// Emitted only when ctx.detail === 'detailed' (§12.4). In 'summary' these are
// dropped, preserving the v0.2 typeDescKey set exactly.
const DETAIL_ONLY = new Set([
  'shot-on-goal',
  'missed-shot',
  'blocked-shot',
  'hit',
  'takeaway',
  'giveaway',
]);

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

/** LogoRef from a required light + optional dark candidate; undefined when light is unusable. */
function logoRef(lightRaw: unknown, darkRaw?: unknown): LogoRef | undefined {
  const light = normLogoUrl(lightRaw);
  if (!light) return undefined;
  const dark = normLogoUrl(darkRaw);
  return dark ? { light, dark } : { light };
}

function periodLabel(n: number | undefined): string | undefined {
  if (n === undefined) return undefined;
  if (n === 4) return 'OT';
  if (n === 5) return 'SO';
  return `P${n}`;
}

// --- status ----------------------------------------------------------------

type Phase = Game['phase'];

function nhlPhase(gameState: string): Phase {
  if (gameState === 'FUT' || gameState === 'PRE') return 'pre';
  if (gameState === 'LIVE' || gameState === 'CRIT') return 'in';
  if (gameState === 'OFF' || gameState === 'FINAL') return 'post';
  return 'unknown';
}

function nhlStatus(
  phase: Phase,
  gameState: string,
  periodNum: number | undefined,
  periodType: string,
  clock: Record<string, unknown>,
  startTimeUtc: string | undefined,
): { statusText: string; statusShort: string } {
  if (phase === 'pre') {
    const hhmm = localHHMM(startTimeUtc);
    return { statusText: hhmm, statusShort: hhmm };
  }
  if (phase === 'post') {
    const suffix = periodType === 'OT' || periodNum === 4 ? 'OT' : periodType === 'SO' || periodNum === 5 ? 'SO' : '';
    return suffix
      ? { statusText: `Final (${suffix})`, statusShort: `F/${suffix}` }
      : { statusText: 'Final', statusShort: 'F' };
  }
  if (phase === 'in') {
    const lbl = periodLabel(periodNum) ?? 'LIVE';
    const tr = sanitizeText(clock.timeRemaining);
    const statusText = clock.inIntermission === true ? `${lbl} INT` : tr ? `${lbl} ${tr}` : lbl;
    return { statusText, statusShort: lbl.slice(0, 8) };
  }
  const gs = sanitizeText(gameState);
  return { statusText: gs ?? 'TBD', statusShort: gs ? gs.slice(0, 8) : 'TBD' };
}

/**
 * Merge a play-by-play team block onto the input game's side. The play feed's
 * team objects carry `abbrev`/`score` but often no `name` (§2.3), so the
 * richer scoreboard name is preferred when the feed has none, and a missing
 * score carries the input value through.
 */
function mergeTeam(input: TeamSide, raw: Record<string, unknown>): TeamSide {
  const side: TeamSide = {
    id: str(raw.id) || input.id,
    name: sanitizeText(rec(raw.name).default) ?? input.name,
    abbrev: str(raw.abbrev) || input.abbrev,
    score: coerceScore(raw.score) ?? input.score,
  };
  // The play-by-play team blocks carry no logo (score/now does), so keep the
  // input game's logo; still prefer a feed logo if a future payload adds one.
  const logo = logoRef(raw.logo, raw.darkLogo) ?? input.logo;
  if (logo) side.logo = logo;
  return side;
}

/**
 * Fresh game (§2 pin) from the play-by-play top-level fields: `gameState`,
 * `homeTeam`/`awayTeam` (score, abbrev), `periodDescriptor`, `clock` — same
 * gameState mapping as the scoreboard. An absent/unknown gameState cannot
 * supply the phase, so the input game is carried through unchanged.
 */
function freshGameFromPlayByPlay(data: Record<string, unknown>, game: Game): Game {
  const gameState = str(data.gameState);
  const phase = nhlPhase(gameState);
  if (phase === 'unknown') return game;
  const pd = rec(data.periodDescriptor);
  const periodNum = typeof pd.number === 'number' && Number.isFinite(pd.number) ? pd.number : undefined;
  const st = nhlStatus(phase, gameState, periodNum, str(pd.periodType), rec(data.clock), game.startTimeUtc);
  return {
    ...game,
    phase,
    statusText: st.statusText,
    statusShort: st.statusShort,
    home: mergeTeam(game.home, rec(data.homeTeam)),
    away: mergeTeam(game.away, rec(data.awayTeam)),
  };
}

// --- play templates --------------------------------------------------------

interface TemplateResult {
  text: string;
  kind: PlayEventKind;
}

/**
 * Goal line (§12.4). Immutable facts only: shot type, scorer, scorer season
 * goal number (`scoringPlayerTotal`), and assist names — never the running
 * score in the composed text (the goal's own post-goal score rides in
 * `scoreAfter`). Localized through `nhlGoal`/`nhlGoalNoAssist`; the assist
 * clause is localized through `nhlAssists`. An unresolvable scorer falls back
 * to the §2.3 English line (which carries the immutable goal score).
 */
function goalTemplate(
  details: Record<string, unknown>,
  roster: Map<number, string>,
  locale: RelayLocale,
  awayAbbrev: string,
  homeAbbrev: string,
): TemplateResult {
  const away = coerceScore(details.awayScore);
  const home = coerceScore(details.homeScore);
  const as = away !== undefined ? String(away) : '';
  const hs = home !== undefined ? String(home) : '';
  const scorerId = details.scoringPlayerId;
  const scorer = typeof scorerId === 'number' ? roster.get(scorerId) : undefined;
  if (!scorer) {
    return { text: t(locale, 'nhlGoalFallback', { away: awayAbbrev, as, home: homeAbbrev, hs }), kind: 'score' };
  }
  const shotType = tEnum(locale, 'nhlShot', str(details.shotType));
  const totalRaw = details.scoringPlayerTotal;
  const total = typeof totalRaw === 'number' && Number.isFinite(totalRaw) ? totalRaw : '';
  const assistNames: string[] = [];
  for (const key of ['assist1PlayerId', 'assist2PlayerId'] as const) {
    const aid = details[key];
    const name = typeof aid === 'number' ? roster.get(aid) : undefined;
    if (name) assistNames.push(name);
  }
  if (assistNames.length) {
    const assists = t(locale, 'nhlAssists', { names: assistNames.join(', ') });
    return { text: t(locale, 'nhlGoal', { shotType, scorer, total, assists }), kind: 'score' };
  }
  return { text: t(locale, 'nhlGoalNoAssist', { shotType, scorer, total }), kind: 'score' };
}

/**
 * Detailed-only structured event (§12.4): shot-on-goal / missed-shot /
 * blocked-shot / hit / takeaway / giveaway. Enriched from `details.shotType`
 * (via `nhlShot`) and `details.zoneCode` (via `nhlZone`); the play-type label
 * routes through `tEnum('nhlEvent', …)`, which localizes the label (유효 슈팅/
 * 체크/…) and gracefully falls back to the humanized typeDescKey on a miss. All
 * immutable.
 */
function detailTemplate(typeKey: string, details: Record<string, unknown>, locale: RelayLocale): TemplateResult {
  const parts: string[] = [];
  const shotTypeRaw = str(details.shotType);
  if (shotTypeRaw) parts.push(tEnum(locale, 'nhlShot', shotTypeRaw));
  const zoneRaw = str(details.zoneCode);
  if (zoneRaw) parts.push(tEnum(locale, 'nhlZone', zoneRaw));
  const label = tEnum(locale, 'nhlEvent', typeKey, typeKey.replace(/-/g, ' '));
  const text = parts.length ? `${label} — ${parts.join(' · ')}` : label;
  return { text, kind: 'play' };
}

/**
 * Localized period NAME for the composed period-start/period-end line (§12.1).
 * Numbered periods render as `P{n}` / `{n}피리어드`; 4→OT/연장, 5→SO/승부치기; an
 * absent number degrades to the generic word. This is the display name only — the
 * locale-neutral `P{n}`/OT/SO label still rides on `PlayEvent.period`.
 */
function localizePeriod(locale: RelayLocale, pnum: number | undefined): string {
  if (pnum === 4) return t(locale, 'nhlPeriodOT');
  if (pnum === 5) return t(locale, 'nhlPeriodSO');
  if (pnum === undefined) return t(locale, 'nhlPeriodGeneric');
  return t(locale, 'nhlPeriodNum', { n: pnum });
}

function templateFor(
  typeKey: string,
  details: Record<string, unknown>,
  pnum: number | undefined,
  roster: Map<number, string>,
  locale: RelayLocale,
  awayAbbrev: string,
  homeAbbrev: string,
): TemplateResult {
  if (typeKey === 'goal') return goalTemplate(details, roster, locale, awayAbbrev, homeAbbrev);
  if (typeKey === 'penalty') {
    const descRaw = str(details.descKey);
    if (!descRaw) return { text: t(locale, 'nhlPenaltyBare'), kind: 'play' };
    // descKey localized through nhlPenaltyType.*; unknown ⇒ tEnum passes the API value through.
    return { text: t(locale, 'nhlPenalty', { descKey: tEnum(locale, 'nhlPenaltyType', descRaw) }), kind: 'play' };
  }
  if (typeKey === 'period-start') {
    return { text: t(locale, 'nhlPeriodStart', { period: localizePeriod(locale, pnum) }), kind: 'status' };
  }
  if (typeKey === 'period-end') {
    return { text: t(locale, 'nhlPeriodEnd', { period: localizePeriod(locale, pnum) }), kind: 'status' };
  }
  if (typeKey === 'game-end') return { text: t(locale, 'nhlGameOver'), kind: 'status' };
  if (typeKey === 'shootout-complete') return { text: t(locale, 'nhlShootoutComplete'), kind: 'status' };
  if (typeKey === 'goalie-change') return { text: t(locale, 'nhlGoalieChange'), kind: 'play' };
  if (DETAIL_ONLY.has(typeKey)) return detailTemplate(typeKey, details, locale);
  // Unknown typeDescKey ⇒ humanize (localized shell, immutable key), never dropped silently.
  return { text: t(locale, 'nhlUnknownEvent', { key: typeKey.replace(/-/g, ' ') }), kind: 'play' };
}

// --- provider --------------------------------------------------------------

function parseScore(raw: unknown, ctx: ProviderContext): Game[] {
  const games: Game[] = [];
  for (const g of asArray(rec(raw).games)) {
    try {
      if (!isRecord(g)) continue;
      const gid = str(g.id);
      if (!gid) continue;
      const gameState = str(g.gameState);
      const phase = nhlPhase(gameState);
      const startTimeUtc = parseIsoUtc(g.startTimeUTC);
      const pd = rec(g.periodDescriptor);
      const periodNum = typeof pd.number === 'number' && Number.isFinite(pd.number) ? pd.number : undefined;
      const st = nhlStatus(phase, gameState, periodNum, str(pd.periodType), rec(g.clock), startTimeUtc);
      const away = rec(g.awayTeam);
      const home = rec(g.homeTeam);
      const homeSide = buildTeam(home.id, rec(home.name).default, home.abbrev, home.score);
      const homeLogo = logoRef(home.logo, home.darkLogo);
      if (homeLogo) homeSide.logo = homeLogo;
      const awaySide = buildTeam(away.id, rec(away.name).default, away.abbrev, away.score);
      const awayLogo = logoRef(away.logo, away.darkLogo);
      if (awayLogo) awaySide.logo = awayLogo;
      games.push({
        id: `nhl:nhl:${gid}`,
        providerId: 'nhl',
        leagueId: 'nhl',
        leagueName: NHL_LEAGUE.name,
        sport: 'hockey',
        startTimeUtc,
        phase,
        statusText: st.statusText,
        statusShort: st.statusShort,
        home: homeSide,
        away: awaySide,
      });
    } catch (e) {
      ctx.log(`nhl: skipped malformed score game: ${String(e)}`);
    }
  }
  return games;
}

function buildRoster(rosterRaw: unknown): Map<number, string> {
  const map = new Map<number, string>();
  for (const r of asArray(rosterRaw)) {
    if (!isRecord(r)) continue;
    const pid = r.playerId;
    if (typeof pid !== 'number' || !Number.isFinite(pid)) continue;
    const name = normalizeWs(`${str(rec(r.firstName).default)} ${str(rec(r.lastName).default)}`);
    if (name) map.set(pid, name);
  }
  return map;
}

function parsePlayByPlay(raw: unknown, game: Game, ctx: ProviderContext): PlaySnapshot {
  const data = rec(raw);
  const roster = buildRoster(data.rosterSpots);
  const awayAbbrev = str(rec(data.awayTeam).abbrev) || game.away.abbrev;
  const homeAbbrev = str(rec(data.homeTeam).abbrev) || game.home.abbrev;

  const events: PlayEvent[] = [];
  for (const pl of asArray(data.plays)) {
    try {
      if (!isRecord(pl)) continue;
      const typeKey = str(pl.typeDescKey);
      if (ALWAYS_DROP.has(typeKey)) continue;
      if (DETAIL_ONLY.has(typeKey) && ctx.detail !== 'detailed') continue;
      const id = str(pl.eventId);
      if (!id) continue;
      const sortOrder = typeof pl.sortOrder === 'number' && Number.isFinite(pl.sortOrder) ? pl.sortOrder : 0;
      const pd = rec(pl.periodDescriptor);
      const pnum = typeof pd.number === 'number' && Number.isFinite(pd.number) ? pd.number : undefined;
      const period = periodLabel(pnum);
      const clock = clockOrUndef(pl.timeInPeriod);
      const details = rec(pl.details);

      const tpl = templateFor(typeKey, details, pnum, roster, ctx.locale, awayAbbrev, homeAbbrev);
      const text = sanitizeText(tpl.text);
      if (!text) continue;

      let scoreAfter: PlayEvent['scoreAfter'];
      if (typeKey === 'goal') {
        const home = coerceScore(details.homeScore);
        const away = coerceScore(details.awayScore);
        scoreAfter = home !== undefined && away !== undefined ? { home, away } : undefined;
      }

      events.push({ id, gameId: game.id, sequence: sortOrder, clock, period, text, kind: tpl.kind, scoreAfter });
    } catch (e) {
      ctx.log(`nhl: skipped malformed play: ${String(e)}`);
    }
  }
  events.sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id));
  // Fresh game (§2 pin). A malformed status block must never lose the parsed
  // events, so the rebuild degrades to carrying the input game through.
  let freshGame = game;
  try {
    freshGame = freshGameFromPlayByPlay(data, game);
  } catch (e) {
    ctx.log(`nhl: game refresh failed, carrying input game: ${String(e)}`);
  }
  return { game: freshGame, events };
}

export const nhlProvider: SportProvider = {
  id: 'nhl',
  displayName: 'NHL',
  requiresSecret: undefined,

  async listLeagues(): Promise<League[]> {
    return [{ ...NHL_LEAGUE }];
  },

  async listGames(ctx: ProviderContext): Promise<Game[]> {
    const raw = await ctx.fetchJson('https://api-web.nhle.com/v1/score/now');
    try {
      return parseScore(raw, ctx);
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      throw new ProviderError('parse', `nhl listGames parse: ${String(e)}`);
    }
  },

  async fetchPlays(ctx: ProviderContext, game: Game): Promise<PlaySnapshot> {
    const gid = lastSegment(game.id);
    const raw = await ctx.fetchJson(`https://api-web.nhle.com/v1/gamecenter/${gid}/play-by-play`);
    try {
      return parsePlayByPlay(raw, game, ctx);
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      throw new ProviderError('parse', `nhl fetchPlays parse: ${String(e)}`);
    }
  },
};
