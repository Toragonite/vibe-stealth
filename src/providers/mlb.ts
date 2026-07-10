/**
 * MLB StatsAPI provider (key-free, official). Implements docs/CONTRACT.md §2.2.
 *
 * Layering: no 'vscode' import, no npm dependencies. Defensive throughout —
 * shape surprises become ProviderError('parse'); one bad play/game is skipped
 * (logged), never fatal.
 */

import {
  BaseballState,
  Game,
  League,
  LineupSpot,
  LogoRef,
  PlayEvent,
  PlaySnapshot,
  ProviderContext,
  ProviderError,
  SportProvider,
  TeamSide,
} from '../core/contract';
import { t, tEnum } from '../core/i18n';
import { clampInt, coerceScore, dateInZone, parseIsoUtc, sanitizeText } from '../core/util';

/**
 * Sequence layout for the detailed level (docs/CONTRACT.md §12.3): each pitch of
 * an at-bat is `atBatIndex * AT_BAT_STRIDE + playEvent.index`; the at-bat RESULT
 * line is `atBatIndex * AT_BAT_STRIDE + RESULT_SLOT`. Because every observed
 * pitch index is < RESULT_SLOT, every pitch sorts before its at-bat's result and
 * before the next at-bat's first pitch. The RESULT_SLOT scheme is applied in BOTH
 * detail levels so the sequence — like the text — is a pure function of the
 * event's own immutable atBatIndex, never of the current `detail` setting.
 */
const AT_BAT_STRIDE = 1000;
const RESULT_SLOT = 999;

const MLB_LEAGUE: League = { id: 'mlb', providerId: 'mlb', name: 'MLB', sport: 'baseball' };

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

/** LogoRef from a required light candidate; undefined when unusable (MLB has no dark variant). */
function logoRef(lightRaw: unknown): LogoRef | undefined {
  const light = normLogoUrl(lightRaw);
  return light ? { light } : undefined;
}

/**
 * DERIVED MLB team logo (§13.3) — statsapi carries none:
 * `https://www.mlbstatic.com/team-logos/{teamId}.svg`. teamId must be a positive
 * integer (number or numeric string); missing/non-numeric ⇒ no logo.
 */
function mlbTeamLogo(idRaw: unknown): LogoRef | undefined {
  let id: string | undefined;
  if (typeof idRaw === 'number' && Number.isInteger(idRaw) && idRaw > 0) id = String(idRaw);
  else if (typeof idRaw === 'string' && /^[1-9]\d*$/.test(idRaw.trim())) id = idRaw.trim();
  if (!id) return undefined;
  return logoRef(`https://www.mlbstatic.com/team-logos/${id}.svg`);
}

function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

// --- status ----------------------------------------------------------------

type Phase = Game['phase'];

interface Status {
  phase: Phase;
  statusText: string;
  statusShort: string;
}

function abstractPhase(abstract: string): Phase {
  return abstract === 'Preview' ? 'pre' : abstract === 'Live' ? 'in' : abstract === 'Final' ? 'post' : 'unknown';
}

function buildStatus(
  abstract: string,
  detailed: string,
  linescore: Record<string, unknown> | undefined,
  startTimeUtc: string | undefined,
): Status {
  const phase = abstractPhase(abstract);
  if (phase === 'post') return { phase, statusText: 'Final', statusShort: 'F' };
  if (phase === 'pre') {
    const hhmm = localHHMM(startTimeUtc);
    return { phase, statusText: hhmm, statusShort: hhmm };
  }
  if (phase === 'in') {
    const ci = linescore ? linescore.currentInning : undefined;
    const n = typeof ci === 'number' && Number.isFinite(ci) ? ci : undefined;
    const state = linescore ? str(linescore.inningState) : '';
    if (n !== undefined) {
      const ord = ordinal(n);
      if (state === 'Middle') return { phase, statusText: `Middle ${ord}`, statusShort: `M${n}` };
      if (state === 'End') return { phase, statusText: `End ${ord}`, statusShort: `E${n}` };
      if (state === 'Top') return { phase, statusText: `Top ${ord}`, statusShort: `T${n}` };
      if (state === 'Bottom') return { phase, statusText: `Bottom ${ord}`, statusShort: `B${n}` };
    }
    const dt = sanitizeText(detailed) ?? 'Live';
    return { phase, statusText: dt, statusShort: dt.slice(0, 8) };
  }
  const dt = sanitizeText(detailed);
  return { phase: 'unknown', statusText: dt ?? 'TBD', statusShort: dt ? dt.slice(0, 8) : 'TBD' };
}

// --- provider --------------------------------------------------------------

function buildScheduleSide(side: unknown): TeamSide {
  const team = rec(rec(side).team);
  const out = buildTeam(team.id, team.name, undefined, rec(side).score);
  const logo = mlbTeamLogo(team.id);
  if (logo) out.logo = logo;
  return out;
}

function parseSchedule(raw: unknown, ctx: ProviderContext): Game[] {
  const dates = asArray(rec(raw).dates);
  const games: Game[] = [];
  for (const d of dates) {
    for (const g of asArray(rec(d).games)) {
      try {
        if (!isRecord(g)) continue;
        const gamePk = str(g.gamePk);
        if (!gamePk) continue;
        const status = rec(g.status);
        const teams = rec(g.teams);
        const startTimeUtc = parseIsoUtc(g.gameDate);
        const st = buildStatus(str(status.abstractGameState), str(status.detailedState), undefined, startTimeUtc);
        games.push({
          id: `mlb:mlb:${gamePk}`,
          providerId: 'mlb',
          leagueId: 'mlb',
          leagueName: MLB_LEAGUE.name,
          sport: 'baseball',
          startTimeUtc,
          phase: st.phase,
          statusText: st.statusText,
          statusShort: st.statusShort,
          home: buildScheduleSide(teams.home),
          away: buildScheduleSide(teams.away),
        });
      } catch (e) {
        ctx.log(`mlb: skipped malformed schedule game: ${String(e)}`);
      }
    }
  }
  return games;
}

// --- live current state (§11.3) --------------------------------------------

/** `.fullName` of a person-like object, or undefined when the object/name is absent. */
function fullName(v: unknown): string | undefined {
  const s = str(rec(v).fullName);
  return s.length ? s : undefined;
}

/** Jersey number as text (string or finite number), else undefined. */
function jerseyText(v: unknown): string | undefined {
  if (typeof v === 'string' && v.trim().length) return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}

/** One side's batting order → LineupSpot[]; unresolvable ids are skipped (logged). */
function buildLineup(teamRec: Record<string, unknown>, side: string, ctx: ProviderContext): LineupSpot[] {
  const order = asArray(teamRec.battingOrder);
  const players = rec(teamRec.players);
  const spots: LineupSpot[] = [];
  order.forEach((idRaw, idx) => {
    const id = str(idRaw);
    const player = players['ID' + id];
    if (!isRecord(player)) {
      ctx.log(`mlb: ${side} lineup id ${id || String(idRaw)} not in boxscore.players — skipping spot ${idx + 1}`);
      return;
    }
    const name = str(rec(player.person).fullName);
    if (!name) {
      ctx.log(`mlb: ${side} lineup id ${id} has no fullName — skipping spot ${idx + 1}`);
      return;
    }
    const spot: LineupSpot = { order: idx + 1, name, position: str(rec(player.position).abbreviation) };
    const jersey = jerseyText(player.jerseyNumber);
    if (jersey !== undefined) spot.jersey = jersey;
    spots.push(spot);
  });
  return spots;
}

/**
 * Baseball current state from the SAME feed/live payload (§11.3). Callers gate
 * on phase==='in' and wrap in try/catch: any throw here degrades state to
 * undefined without failing fetchPlays.
 */
function buildBaseballState(liveData: Record<string, unknown>, ctx: ProviderContext): BaseballState {
  const linescore = rec(liveData.linescore);
  const offense = rec(linescore.offense);
  const defense = rec(linescore.defense);
  const boxTeams = rec(rec(liveData.boxscore).teams);
  return {
    kind: 'baseball',
    balls: clampInt(linescore.balls, 0, 4, 0),
    strikes: clampInt(linescore.strikes, 0, 3, 0),
    outs: clampInt(linescore.outs, 0, 3, 0),
    bases: {
      first: fullName(offense.first),
      second: fullName(offense.second),
      third: fullName(offense.third),
    },
    atBat: fullName(offense.batter),
    onDeck: fullName(offense.onDeck),
    pitcher: fullName(defense.pitcher),
    lineups: {
      home: buildLineup(rec(boxTeams.home), 'home', ctx),
      away: buildLineup(rec(boxTeams.away), 'away', ctx),
    },
  };
}

// --- pitch-by-pitch (detailed level, §12.3) --------------------------------

/** A ball/strike count. Always the count BEFORE a pitch when it reaches a pitch line (§12.3). */
interface PitchCount {
  balls: number;
  strikes: number;
}

/** A count component the payload can legitimately report after a pitch (balls ≤ 4, strikes ≤ 3). */
function inCountDomain(v: unknown, max: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max;
}

/**
 * The post-pitch count carried by a pitch entry's OWN `count`, or undefined when
 * it is missing / non-numeric / outside the domain above. On undefined the caller
 * carries the previous count forward unchanged, so one unreadable entry cannot
 * corrupt the rest of the at-bat (§12.3).
 */
function readPostCount(peRaw: Record<string, unknown>): PitchCount | undefined {
  const count = rec(peRaw.count);
  const balls = count.balls;
  const strikes = count.strikes;
  if (!inCountDomain(balls, 4) || !inCountDomain(strikes, 3)) return undefined;
  return { balls, strikes };
}

/**
 * One pitch `playEvents[]` entry (the caller has already established `isPitch === true`)
 * → one pitch PlayEvent, or undefined when it carries neither a type nor a call
 * (nothing meaningful to say — skipped and logged, §12.3).
 *
 * `pre` is the count BEFORE this pitch, threaded by the caller. The text is a pure
 * function of the pitch's OWN immutable facts — type/speed/zone/call and the count it
 * was thrown on, both fixed the moment it left the hand — and NEVER the running score
 * or the current inning, so a later poll re-derives it byte-for-byte and no false
 * correction fires (§12.2).
 */
function buildPitchEvent(
  peRaw: Record<string, unknown>,
  gameId: string,
  gamePk: string,
  atBatIndex: number,
  period: string | undefined,
  pre: PitchCount,
  ctx: ProviderContext,
): PlayEvent | undefined {
  const index = peRaw.index;
  if (typeof index !== 'number' || !Number.isFinite(index)) return undefined;

  const details = rec(peRaw.details);
  const typeDesc = str(rec(details.type).description);
  const callDesc = str(details.description) || str(rec(details.call).description);
  if (!typeDesc && !callDesc) {
    ctx.log(`mlb: pitch ${atBatIndex}:p${index} has neither type nor call — skipping`);
    return undefined;
  }

  const pitchData = rec(peRaw.pitchData);

  // Localize the enums (never a raw key, API English on a miss) and select the
  // pitchLine variant matching which of speed/zone are present, so the chosen
  // template only references placeholders it is guaranteed to receive — the
  // templates own every separator, so an absent token collapses without doubling.
  const type = tEnum(ctx.locale, 'pitchType', typeDesc);
  const call = tEnum(ctx.locale, 'pitchCall', callDesc);
  const balls = pre.balls;
  const strikes = pre.strikes;
  const speed = typeof pitchData.startSpeed === 'number' && Number.isFinite(pitchData.startSpeed) ? pitchData.startSpeed : undefined;
  const zone = typeof pitchData.zone === 'number' && Number.isFinite(pitchData.zone) ? pitchData.zone : undefined;

  let line: string;
  if (speed !== undefined && zone !== undefined) {
    line = t(ctx.locale, 'pitchLine', { type, mph: speed.toFixed(1), zone, call, balls, strikes });
  } else if (speed !== undefined) {
    line = t(ctx.locale, 'pitchLineNoZone', { type, mph: speed.toFixed(1), call, balls, strikes });
  } else if (zone !== undefined) {
    line = t(ctx.locale, 'pitchLineNoSpeed', { type, zone, call, balls, strikes });
  } else {
    line = t(ctx.locale, 'pitchLineBare', { type, call, balls, strikes });
  }

  const text = sanitizeText(line);
  if (!text) return undefined;

  return {
    id: `mlb:${gamePk}:${atBatIndex}:p${index}`,
    gameId,
    sequence: atBatIndex * AT_BAT_STRIDE + index,
    clock: undefined,
    period,
    text,
    kind: 'play',
    scoreAfter: undefined, // a pitch never sets the score; the at-bat result line does
  };
}

function parseFeedLive(raw: unknown, game: Game, gamePk: string, ctx: ProviderContext): PlaySnapshot {
  const data = rec(raw);
  const gameData = rec(data.gameData);
  const liveData = rec(data.liveData);
  const allPlays = asArray(rec(liveData.plays).allPlays);
  const linescore = isRecord(liveData.linescore) ? liveData.linescore : undefined;

  const detailed = ctx.detail === 'detailed';
  const events: PlayEvent[] = [];
  for (const pl of allPlays) {
    try {
      if (!isRecord(pl)) continue;
      const about = rec(pl.about);
      const atBatIndex = about.atBatIndex;
      if (typeof atBatIndex !== 'number' || !Number.isFinite(atBatIndex)) continue;

      const inning = typeof about.inning === 'number' && Number.isFinite(about.inning) ? about.inning : undefined;
      const half = str(about.halfInning);
      const period =
        inning !== undefined ? (half === 'bottom' ? `B${inning}` : half === 'top' ? `T${inning}` : undefined) : undefined;

      // Pitch-by-pitch lines (detailed level only). Emitted for EVERY at-bat,
      // complete or not — a thrown pitch is immutable even while the at-bat is
      // still in progress, and P14 polls a live at-bat as its count advances.
      //
      // A playEvent's `count` is the count AFTER that pitch, and on the pitch that
      // ends an at-bat it overflows to a count baseball does not have (a strikeout
      // swing reads 0-3, a walk 4-2). §12.3 pins the BROADCAST convention instead:
      // render the count BEFORE the pitch, which is exactly the previous pitch's
      // post-pitch count, and 0-0 for the first. Non-pitch entries (pickoffs,
      // timeouts) neither emit nor advance it; a pitch whose count is unreadable
      // renders at the running value and leaves it untouched. Clamping the overflow
      // is forbidden — it would render that strikeout as 0-2, wrong just as quietly.
      if (detailed) {
        let pre: PitchCount = { balls: 0, strikes: 0 };
        for (const pe of asArray(pl.playEvents)) {
          if (!isRecord(pe) || pe.isPitch !== true) continue;
          const pitch = buildPitchEvent(pe, game.id, gamePk, atBatIndex, period, pre, ctx);
          if (pitch) events.push(pitch); // a skipped pitch was still thrown: it advances the count
          pre = readPostCount(pe) ?? pre;
        }
      }

      // At-bat result line (BOTH detail levels) — only once the at-bat completes
      // and carries prose (in-progress at-bats churn text; do not emit until done).
      if (about.isComplete !== true) continue;
      const result = rec(pl.result);
      const text = sanitizeText(result.description);
      if (!text) continue;
      const home = coerceScore(result.homeScore);
      const away = coerceScore(result.awayScore);
      events.push({
        id: `mlb:${gamePk}:${atBatIndex}`,
        gameId: game.id,
        sequence: atBatIndex * AT_BAT_STRIDE + RESULT_SLOT,
        clock: undefined,
        period,
        text,
        kind: about.isScoringPlay === true ? 'score' : 'play',
        scoreAfter: home !== undefined && away !== undefined ? { home, away } : undefined,
      });
    } catch (e) {
      ctx.log(`mlb: skipped malformed play: ${String(e)}`);
    }
  }
  events.sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id));

  // Fresh game state from the feed (§ PlaySnapshot.game — score/phase may have advanced).
  const status = rec(gameData.status);
  const gdTeams = rec(gameData.teams);
  const homeGd = rec(gdTeams.home);
  const awayGd = rec(gdTeams.away);
  const lsTeams = rec(linescore ? linescore.teams : undefined);
  const lsHome = rec(lsTeams.home);
  const lsAway = rec(lsTeams.away);
  const startTimeUtc = parseIsoUtc(rec(gameData.datetime).dateTime) ?? game.startTimeUtc;
  const st = buildStatus(str(status.abstractGameState), str(status.detailedState), linescore, startTimeUtc);

  const homeSide = buildTeam(homeGd.id, homeGd.name, homeGd.abbreviation, lsHome.runs);
  const homeLogo = mlbTeamLogo(homeGd.id);
  if (homeLogo) homeSide.logo = homeLogo;
  const awaySide = buildTeam(awayGd.id, awayGd.name, awayGd.abbreviation, lsAway.runs);
  const awayLogo = mlbTeamLogo(awayGd.id);
  if (awayLogo) awaySide.logo = awayLogo;

  const freshGame: Game = {
    ...game,
    startTimeUtc,
    phase: st.phase,
    statusText: st.statusText,
    statusShort: st.statusShort,
    home: homeSide,
    away: awaySide,
  };

  // Live current state (§11.2/§11.3): free from this same payload, populated
  // only while live. Any state-shape surprise degrades to undefined — it must
  // NEVER fail fetchPlays or drop the plays.
  let state: BaseballState | undefined;
  if (st.phase === 'in') {
    try {
      state = buildBaseballState(liveData, ctx);
    } catch (e) {
      ctx.log(`mlb: state build failed, state undefined: ${String(e)}`);
      state = undefined;
    }
  }

  return { game: freshGame, events, state };
}

export const mlbProvider: SportProvider = {
  id: 'mlb',
  displayName: 'MLB',
  requiresSecret: undefined,

  async listLeagues(): Promise<League[]> {
    return [{ ...MLB_LEAGUE }];
  },

  async listGames(ctx: ProviderContext): Promise<Game[]> {
    const date = dateInZone(ctx.now(), 'America/New_York');
    const raw = await ctx.fetchJson(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${date}`);
    try {
      return parseSchedule(raw, ctx);
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      throw new ProviderError('parse', `mlb listGames parse: ${String(e)}`);
    }
  },

  async fetchPlays(ctx: ProviderContext, game: Game): Promise<PlaySnapshot> {
    const gamePk = lastSegment(game.id);
    const raw = await ctx.fetchJson(`https://statsapi.mlb.com/api/v1.1/game/${gamePk}/feed/live`);
    try {
      return parseFeedLive(raw, game, gamePk, ctx);
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      throw new ProviderError('parse', `mlb fetchPlays parse: ${String(e)}`);
    }
  },
};
