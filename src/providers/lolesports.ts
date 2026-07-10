/**
 * LoL Esports (esports-api.lolesports.com/persisted/gw) — key-free via the
 * public gateway key embedded in the lolesports.com frontend. Unofficial; the
 * key may be rotated by Riot at any time (⇒ 403 handled upstream as key-free
 * auth). See docs/CONTRACT.md §2.6.
 *
 * Every field access is defensive: a shape surprise becomes ProviderError('parse');
 * one bad list entry is skipped (ctx.log), never fatal.
 */
import {
  DraftPick,
  EsportsState,
  Game,
  GamePhase,
  League,
  LogoRef,
  PlayEvent,
  PlaySnapshot,
  ProviderContext,
  ProviderError,
  SportProvider,
  TeamSide,
} from '../core/contract';
import { t, tEnum } from '../core/i18n';
import { clampInt, coerceScore, parseIsoUtc, sanitizeText } from '../core/util';

const BASE = 'https://esports-api.lolesports.com/persisted/gw';
// Public livestats window (§11.5) — served WITHOUT the gateway key.
const LIVESTATS = 'https://feed.lolesports.com/livestats/v1/window';
// Public key embedded in the lolesports.com frontend (documented as unofficial).
const API_KEY = '0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z';
const WINDOW_MS = 48 * 60 * 60 * 1000;

interface LolLeagueMeta {
  nativeId: string;
  name: string;
  /** Static league logo URL (§13.3), probed 2026-07-09. Absent ⇒ no league logo. */
  image?: string;
}

const LOL_LEAGUES: Record<string, LolLeagueMeta> = {
  lck: { nativeId: '98767991310872058', name: 'LCK', image: 'https://static.lolesports.com/leagues/lck-color-on-black.png' },
  lpl: { nativeId: '98767991314006698', name: 'LPL' },
  lec: { nativeId: '98767991302996019', name: 'LEC' },
  msi: { nativeId: '98767991325878492', name: 'MSI', image: 'https://static.lolesports.com/leagues/1592594634248_MSIDarkBG.png' },
  worlds: { nativeId: '98767975604431411', name: 'Worlds' },
  first_stand: { nativeId: '113464388705111224', name: 'First Stand' },
};

// --- defensive accessors -----------------------------------------------------

function asObj(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}
function asArr(v: unknown): unknown[] | undefined {
  return Array.isArray(v) ? v : undefined;
}
function asStr(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}
function asNum(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

// --- logos (§13) -------------------------------------------------------------

/**
 * Coerce a candidate logo URL (§13.3): must be a non-empty string; a leading
 * `http://` is upgraded to `https://` (the API returns `http://` team images);
 * the result must then start with `https://`, else undefined. Never throws.
 */
function normLogoUrl(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  let s = v.trim();
  if (s === '') return undefined;
  if (s.startsWith('http://')) s = `https://${s.slice(7)}`;
  return s.startsWith('https://') ? s : undefined;
}

/** LogoRef from a required light candidate; undefined when unusable (LoL has no dark variant). */
function logoRef(lightRaw: unknown): LogoRef | undefined {
  const light = normLogoUrl(lightRaw);
  return light ? { light } : undefined;
}

function hlFor(ctx: ProviderContext): string {
  return ctx.locale === 'ko' ? 'ko-KR' : 'en-US';
}

function headers(): Record<string, string> {
  return { 'x-api-key': API_KEY };
}

function mapPhase(state: unknown): GamePhase {
  switch (asStr(state)) {
    case 'unstarted':
      return 'pre';
    case 'inProgress':
      return 'in';
    case 'completed':
      return 'post';
    default:
      return 'unknown';
  }
}

function buildTeam(t: Record<string, unknown> | undefined): TeamSide {
  const code = (asStr(t?.code) ?? '').trim();
  const nm = sanitizeText(t?.name);
  const abbrev = code !== '' ? code.slice(0, 5) : nm ? nm.slice(0, 3).toUpperCase() : 'TBD';
  const name = nm ?? (abbrev !== 'TBD' ? abbrev : 'TBD');
  const gameWins = coerceScore(asObj(t?.result)?.gameWins);
  const side: TeamSide = { id: asStr(t?.id) ?? code, name, abbrev, score: gameWins };
  const logo = logoRef(t?.image);
  if (logo) side.logo = logo;
  return side;
}

/** True when a team object's `code` is 'TBD' (case-insensitive, trimmed) — an undecided bracket slot. */
function isTbdTeam(t: Record<string, unknown> | undefined): boolean {
  return (asStr(t?.code) ?? '').trim().toLowerCase() === 'tbd';
}

/** Local wall-clock 'HH:MM' for the start instant, or 'TBD'. */
function localHHMM(startTimeUtc: string | undefined): string {
  if (!startTimeUtc) return 'TBD';
  const d = new Date(startTimeUtc);
  if (Number.isNaN(d.getTime())) return 'TBD';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

// --- provider ----------------------------------------------------------------

async function listLeagues(_ctx: ProviderContext): Promise<League[]> {
  return Object.entries(LOL_LEAGUES).map(([id, meta]) => {
    const league: League = { id, providerId: 'lolesports', name: meta.name, sport: 'esports' };
    const logo = logoRef(meta.image);
    if (logo) league.logo = logo;
    return league;
  });
}

async function listGames(ctx: ProviderContext, league: League): Promise<Game[]> {
  const meta = LOL_LEAGUES[league.id];
  if (!meta) return [];
  const url = `${BASE}/getSchedule?hl=${hlFor(ctx)}&leagueId=${meta.nativeId}`;

  let raw: unknown;
  try {
    raw = await ctx.fetchJson(url, headers());
  } catch (e) {
    throw wrap(e, 'lolesports listGames fetch failed');
  }

  try {
    const events = asArr(asObj(asObj(asObj(raw)?.data)?.schedule)?.events);
    if (!events) throw new ProviderError('parse', 'lolesports: data.schedule.events not an array');

    const now = ctx.now();
    const out: Game[] = [];
    let matchesSeen = 0;
    let nearestMs = Number.POSITIVE_INFINITY;
    for (const ev of events) {
      try {
        const obj = asObj(ev);
        if (!obj || asStr(obj.type) !== 'match') continue;
        matchesSeen++;
        const match = asObj(obj.match);
        const matchId = asStr(match?.id);
        if (!match || !matchId) {
          ctx.log('lolesports: match event missing match.id, skipped');
          continue;
        }
        const startTimeUtc = parseIsoUtc(obj.startTime);
        if (!startTimeUtc) continue; // cannot place in the ±48h window
        const distanceMs = Math.abs(Date.parse(startTimeUtc) - now);
        if (distanceMs < nearestMs) nearestMs = distanceMs;
        if (distanceMs > WINDOW_MS) continue;

        const teams = asArr(match.teams) ?? [];
        const awayObj = asObj(teams[0]);
        const homeObj = asObj(teams[1]);
        // Defect 3: an undecided bracket slot returns BOTH teams with code 'TBD' (placeholder
        // crest team-tbd.png) — there is nothing to relay, so drop it. A slot with ONE decided
        // team is a real half-drawn matchup and still shows.
        if (isTbdTeam(awayObj) && isTbdTeam(homeObj)) {
          ctx.log(`lolesports: skipping match ${matchId} — both teams TBD (undecided bracket slot)`);
          continue;
        }
        const away = buildTeam(awayObj);
        const home = buildTeam(homeObj);
        const phase = mapPhase(obj.state);
        const count = asNum(asObj(match.strategy)?.count);
        const { statusText, statusShort } = scheduleStatus(phase, count, away, home, startTimeUtc);

        out.push({
          id: `lolesports:${league.id}:${matchId}`,
          providerId: 'lolesports',
          leagueId: league.id,
          leagueName: league.name,
          sport: 'esports',
          startTimeUtc,
          phase,
          statusText,
          statusShort,
          home,
          away,
        });
      } catch (inner) {
        ctx.log(`lolesports: skipped malformed event: ${String(inner)}`);
      }
    }
    if (out.length === 0 && matchesSeen > 0) {
      // The ±48h window is the only now-relative filter in any provider, so a badly skewed
      // host clock silently empties a league and looks like "no games today" (breaker m1).
      // But an off-season league is empty for the same reason, so report the distance to the
      // nearest match and only blame the clock when that distance is absurd — every match
      // being a year away means the clock, not the schedule.
      const nearest = Number.isFinite(nearestMs)
        ? `nearest ${Math.round(nearestMs / 86_400_000)}d away`
        : 'none had a parsable start time';
      const skewed = nearestMs > 365 * 86_400_000; // Infinity satisfies this too — still worth saying
      ctx.log(
        `lolesports: no ${league.id} match within ±48h of now (${matchesSeen} in schedule, ${nearest})` +
          (skewed ? ` — host clock reads ${new Date(now).toISOString()}; check the system clock` : ''),
      );
    }
    return out;
  } catch (e) {
    throw wrap(e, 'lolesports listGames parse failed');
  }
}

function scheduleStatus(
  phase: GamePhase,
  count: number | undefined,
  away: TeamSide,
  home: TeamSide,
  startTimeUtc: string | undefined,
): { statusText: string; statusShort: string } {
  const bo = count !== undefined ? `BO${count}` : 'BO?';
  const aw = away.score ?? 0;
  const hw = home.score ?? 0;
  if (phase === 'in') {
    return { statusText: `${bo} · ${aw}:${hw}`, statusShort: `G${aw + hw + 1}` };
  }
  if (phase === 'post') {
    return { statusText: 'Final', statusShort: 'F' };
  }
  // pre / unknown
  return { statusText: `${bo} ${localHHMM(startTimeUtc)}`, statusShort: localHHMM(startTimeUtc) };
}

function nativeMatchId(game: Game): string {
  return game.id.split(':').slice(2).join(':');
}

async function fetchPlays(ctx: ProviderContext, game: Game): Promise<PlaySnapshot> {
  const matchId = nativeMatchId(game);
  const url = `${BASE}/getEventDetails?hl=${hlFor(ctx)}&id=${matchId}`;

  let raw: unknown;
  try {
    raw = await ctx.fetchJson(url, headers());
  } catch (e) {
    throw wrap(e, 'lolesports fetchPlays fetch failed');
  }

  let snapshot: PlaySnapshot;
  let games: unknown[];
  let away: TeamSide;
  let home: TeamSide;
  try {
    const match = asObj(asObj(asObj(asObj(raw)?.data)?.event)?.match);
    if (!match) throw new ProviderError('parse', 'lolesports: data.event.match missing');

    const teams = asArr(match.teams) ?? [];
    away = buildTeam(asObj(teams[0]));
    home = buildTeam(asObj(teams[1]));
    const aw = away.score ?? 0;
    const hw = home.score ?? 0;

    games = asArr(match.games) ?? [];
    const count = asNum(asObj(match.strategy)?.count);
    const phase = derivePhase(count, aw, hw, games, game.phase);
    const events: PlayEvent[] = [];
    let firstInProgress: number | undefined;

    for (const g of games) {
      try {
        const obj = asObj(g);
        if (!obj) continue;
        const number = asNum(obj.number);
        const state = asStr(obj.state);
        if (state === 'inProgress' && number !== undefined && firstInProgress === undefined) {
          firstInProgress = number;
        }
        if (state !== 'completed' || number === undefined) continue;

        // Text is a pure function of the map's own IMMUTABLE fact (§2 immutable-text pin):
        // the winner of map N is NOT derivable from getEventDetails (games[].teams[] carry
        // only {id, side}; only aggregate gameWins exists), so the text names no score — a
        // running score re-derives each poll and would fire a false correction (§2.6).
        const text = sanitizeText(`Game ${number} complete`);
        if (!text) continue;
        events.push({
          id: `lol:${matchId}:game${number}`,
          gameId: game.id,
          sequence: number,
          clock: undefined,
          period: undefined,
          text,
          kind: 'score',
          scoreAfter: undefined,
        });
      } catch (inner) {
        ctx.log(`lolesports: skipped malformed game entry: ${String(inner)}`);
      }
    }
    events.sort((a, b) => a.sequence - b.sequence);

    const refreshed = refreshGame(game, away, home, phase, aw, hw, firstInProgress);
    snapshot = { game: refreshed, events };
  } catch (e) {
    throw wrap(e, 'lolesports fetchPlays parse failed');
  }

  // §11.5 live state + §12.6 kill feed. ADDITIVE, gated, and NEVER load-bearing
  // (§11.2): the whole block is wrapped so a livestats failure can never throw out
  // of fetchPlays — the map-result events and the fresh game always return.
  try {
    const livestatsGameId = pickLivestatsGameId(games);
    if (snapshot.game.phase !== 'in') {
      // §12.6: the resume cursor lives ONLY while the game is 'in'. Drop it when the
      // game leaves 'in' so a finished/paused game holds no stale cursor and a fresh
      // start reads a single window.
      if (livestatsGameId) killCursor.delete(livestatsGameId);
    } else if (ctx.gameStateEnabled) {
      if (ctx.detail === 'detailed') {
        // §12.6: the livestats windows supply BOTH the per-kill/objective events AND
        // the draft state — one fetch path. At the default 20 s poll that is 2 windows,
        // so a live detailed game costs getEventDetails + 2 windows = 3 requests.
        const feed = await fetchKillFeed(ctx, game, livestatsGameId, away, home);
        if (feed.events.length > 0) {
          snapshot.events = [...snapshot.events, ...feed.events].sort(bySequenceThenId);
        }
        if (feed.state) snapshot.state = feed.state;
      } else {
        // §11.5 summary path: exactly one livestats window (now − 60 s) for the draft.
        const state = await fetchDraftState(ctx, games, away, home);
        if (state) snapshot.state = state;
      }
    }
  } catch (e) {
    ctx.log(`lolesports: live-state/kill-feed block failed (${String(e)}); events & state degraded, cursor unchanged`);
  }

  return snapshot;
}

/**
 * §11.5 — the `startingTime` query value for the livestats window. Without it the
 * endpoint replies with the KICKOFF frames whose gold/kills are all 0, so a live game
 * silently reports no gold and no kills (Defect 1). `ts = now - 60s`, floored to a
 * 10-second boundary (the API rejects sub-10s precision), formatted
 * `YYYY-MM-DDTHH:MM:SSZ` (no milliseconds). Built from the injected `now` (epoch ms) —
 * NEVER Date.now() — so tests are deterministic.
 */
export function livestatsStartingTime(nowMs: number): string {
  const floored = Math.floor((nowMs - 60_000) / 10_000) * 10_000;
  return new Date(floored).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * §11.5 — fetch the public livestats window for the live/most-recent game and
 * build EsportsState from its immutable draft. Returns undefined (never throws)
 * on a missing game id, a ProviderError (204/404/network/parse), or a window
 * that lacks gameMetadata (draft not locked yet).
 */
async function fetchDraftState(
  ctx: ProviderContext,
  games: unknown[],
  away: TeamSide,
  home: TeamSide,
): Promise<EsportsState | undefined> {
  const gameId = pickLivestatsGameId(games);
  if (!gameId) return undefined;

  let raw: unknown;
  try {
    // No api-key header — the livestats window is public (§11.5). `startingTime` is
    // REQUIRED for live data: without it the endpoint returns the KICKOFF frames whose
    // gold/kills are all 0 (Defect 1). Derived from ctx.now(), never Date.now().
    const startingTime = livestatsStartingTime(ctx.now());
    raw = await ctx.fetchJson(`${LIVESTATS}/${gameId}?startingTime=${startingTime}`, {});
  } catch (e) {
    ctx.log(`lolesports: livestats window fetch failed (${String(e)}); state undefined`);
    return undefined;
  }

  return buildEsportsState(ctx, raw, away, home);
}

/**
 * §11.5 — build EsportsState from a livestats window payload. Pure and fully
 * defensive: any shape surprise ⇒ undefined (never throws). Shared by the summary
 * draft-state path (fetchDraftState) and the §12.6 kill feed, which derives the
 * draft from the SAME windows it reads for events rather than issuing a second GET.
 */
function buildEsportsState(
  ctx: ProviderContext,
  raw: unknown,
  away: TeamSide,
  home: TeamSide,
): EsportsState | undefined {
  try {
    const meta = asObj(asObj(raw)?.gameMetadata);
    if (!meta) {
      ctx.log('lolesports: livestats window has no gameMetadata; state undefined');
      return undefined;
    }

    const state: EsportsState = {
      kind: 'esports',
      patch: shortenPatch(asStr(meta.patchVersion)),
      // Pin (§11.5): blue = the Game's away team, red = home (teams[0]→away convention).
      blue: { teamCode: away.abbrev, picks: buildPicks(asObj(meta.blueTeamMetadata)?.participantMetadata) },
      red: { teamCode: home.abbrev, picks: buildPicks(asObj(meta.redTeamMetadata)?.participantMetadata) },
    };

    const frames = asArr(asObj(raw)?.frames);
    const last = frames && frames.length > 0 ? asObj(frames[frames.length - 1]) : undefined;
    if (last) {
      const blue = asObj(last.blueTeam);
      const red = asObj(last.redTeam);
      const gold = pairIfFinite(asNum(blue?.totalGold), asNum(red?.totalGold));
      if (gold) state.gold = gold;
      const kills = pairIfFinite(asNum(blue?.totalKills), asNum(red?.totalKills));
      if (kills) state.kills = kills;
    }
    return state;
  } catch (e) {
    ctx.log(`lolesports: livestats window parse failed (${String(e)}); state undefined`);
    return undefined;
  }
}

// --- §12.6 kill feed (detailed only) -----------------------------------------

/**
 * Per-livestats-game resume cursor: the `rfc460Timestamp` of the last frame the
 * kill feed consumed. Module-level so it survives across the stateless per-poll
 * `fetchPlays` calls.
 *
 * §2 stateless rule: a provider must not DIFF or DEDUPE across calls — that is the
 * engine's job (§3.4), and breaking it is what caused the P12 false-correction bug.
 * This cursor does neither. It only records WHERE TO RESUME READING the window feed;
 * whether an event is new is still decided by the engine, by id. (Same sanctioned
 * exception as Naver's latest-window relay — §12.6.)
 */
const killCursor = new Map<string, string>();

/** Test seam: clear all resume cursors so a test starts from a first-poll state. */
export function __resetKillCursors(): void {
  killCursor.clear();
}

interface RosterEntry {
  champion: string;
  player: string;
  side: 'blue' | 'red';
}
type Roster = Map<number, RosterEntry>;

interface FrameStat {
  kills: number;
  deaths: number;
  assists: number;
}

interface ObjectiveCounts {
  towers: number;
  inhibitors: number;
  barons: number;
  dragons: string[];
}

/** 'YYYY-MM-DDTHH:MM:SSZ' for the 10-second boundary at or below `ms` (the API rejects sub-10s). */
function tenSecFloorIso(ms: number): string {
  const floored = Math.floor(ms / 10_000) * 10_000;
  return new Date(floored).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * §12.6 catch-up plan: the `startingTime` values to request this poll.
 * - No cursor (first poll of a game): exactly ONE window at `now − 60 s`.
 * - Otherwise: `clamp(ceil((now − cursor) / 10 s), 1, 6)` consecutive windows
 *   starting at the cursor floored to a 10 s boundary. The cap of 6 (60 s) stops a
 *   resumed follow from stampeding; `pollSeconds` is unknown so cursor age stands in.
 */
function planWindows(cursor: string | undefined, now: number): string[] {
  if (cursor === undefined) return [livestatsStartingTime(now)];
  const cursorMs = Date.parse(cursor);
  if (!Number.isFinite(cursorMs)) return [livestatsStartingTime(now)];
  const count = clampInt(Math.ceil((now - cursorMs) / 10_000), 1, 6, 1);
  const base = Math.floor(cursorMs / 10_000) * 10_000;
  const out: string[] = [];
  for (let i = 0; i < count; i++) out.push(tenSecFloorIso(base + i * 10_000));
  return out;
}

/** Global participantId → {champion, player, side} map from a window's gameMetadata. */
function buildRoster(meta: Record<string, unknown>): Roster {
  const roster: Roster = new Map();
  addRosterSide(roster, asObj(meta.blueTeamMetadata)?.participantMetadata, 'blue');
  addRosterSide(roster, asObj(meta.redTeamMetadata)?.participantMetadata, 'red');
  return roster;
}

function addRosterSide(roster: Roster, v: unknown, side: 'blue' | 'red'): void {
  const arr = asArr(v);
  if (!arr) return;
  for (const p of arr) {
    const o = asObj(p);
    if (!o) continue;
    const pid = asNum(o.participantId);
    if (pid === undefined) continue;
    roster.set(pid, {
      champion: sanitizeText(o.championId) ?? '',
      player: sanitizeText(o.summonerName) ?? '',
      side,
    });
  }
}

/** participantId → cumulative {kills, deaths, assists} for one frame (both teams). */
function frameStats(frame: Record<string, unknown>): Map<number, FrameStat> {
  const stats = new Map<number, FrameStat>();
  for (const key of ['blueTeam', 'redTeam'] as const) {
    const parts = asArr(asObj(frame[key])?.participants);
    if (!parts) continue;
    for (const p of parts) {
      const o = asObj(p);
      if (!o) continue;
      const pid = asNum(o.participantId);
      if (pid === undefined) continue;
      stats.set(pid, {
        kills: asNum(o.kills) ?? 0,
        deaths: asNum(o.deaths) ?? 0,
        assists: asNum(o.assists) ?? 0,
      });
    }
  }
  return stats;
}

/** One side's team-level objective counters for a frame. */
function teamObjectives(frame: Record<string, unknown>, side: 'blue' | 'red'): ObjectiveCounts {
  const team = asObj(frame[side === 'blue' ? 'blueTeam' : 'redTeam']);
  const dragons: string[] = [];
  for (const d of asArr(team?.dragons) ?? []) {
    const s = asStr(d);
    if (s !== undefined) dragons.push(s);
  }
  return {
    towers: asNum(team?.towers) ?? 0,
    inhibitors: asNum(team?.inhibitors) ?? 0,
    barons: asNum(team?.barons) ?? 0,
    dragons,
  };
}

/**
 * §12.6 — diff ONE window's frames pairwise into kill/objective events. Each window
 * is diffed independently: the seam between consecutive 10 s windows was measured to
 * lose and duplicate zero kills, so no cross-window state is needed. Frames are sorted
 * chronologically first (API order is never trusted — §2). A single bad transition is
 * skipped (logged), never fatal to the window.
 */
function diffWindow(
  ctx: ProviderContext,
  gid: string,
  matchGameId: string,
  raw: unknown,
  roster: Roster,
  away: TeamSide,
  home: TeamSide,
): PlayEvent[] {
  const frames = asArr(asObj(raw)?.frames);
  if (!frames) return [];
  const seq: { frame: Record<string, unknown>; ts: string; ms: number }[] = [];
  for (const fr of frames) {
    const frame = asObj(fr);
    if (!frame) continue;
    const ts = asStr(frame.rfc460Timestamp);
    if (ts === undefined) continue;
    const ms = Date.parse(ts);
    if (!Number.isFinite(ms)) continue;
    seq.push({ frame, ts, ms });
  }
  seq.sort((a, b) => a.ms - b.ms);

  const out: PlayEvent[] = [];
  for (let i = 1; i < seq.length; i++) {
    const prev = seq[i - 1];
    const curr = seq[i];
    if (!prev || !curr) continue;
    try {
      diffTransition(out, ctx, gid, matchGameId, prev.frame, curr.frame, curr.ts, curr.ms, roster, away, home);
    } catch (e) {
      ctx.log(`lolesports: kill-feed transition at ${curr.ts} skipped (${String(e)})`);
    }
  }
  return out;
}

/** §12.6 — emit the events for a single prev→curr frame transition into `out`. */
function diffTransition(
  out: PlayEvent[],
  ctx: ProviderContext,
  gid: string,
  matchGameId: string,
  prevFrame: Record<string, unknown>,
  currFrame: Record<string, unknown>,
  ts: string,
  ms: number,
  roster: Roster,
  away: TeamSide,
  home: TeamSide,
): void {
  const prevStats = frameStats(prevFrame);
  const currStats = frameStats(currFrame);
  const victims: number[] = [];
  const killers: number[] = [];
  const assisters: number[] = [];
  for (const [pid, cur] of currStats) {
    const pv = prevStats.get(pid);
    if (cur.deaths > (pv?.deaths ?? 0)) victims.push(pid);
    if (cur.kills > (pv?.kills ?? 0)) killers.push(pid);
    if (cur.assists > (pv?.assists ?? 0)) assisters.push(pid);
  }
  victims.sort((a, b) => a - b);
  assisters.sort((a, b) => a - b);

  // "whose kills incremented ⇒ killer" — the feed models one killer per ~166 ms frame
  // (measured: kills land on distinct frames). If more than one participant's kills
  // advanced in a single step we cannot pair a victim to a killer without GUESSING, so
  // we name none — §12.6: never invent a killer (the victims fall through to lolDeath).
  const killerId = killers.length === 1 ? killers[0] : undefined;
  const killer = killerId !== undefined ? roster.get(killerId) : undefined;
  const assistNames = assisters
    .filter((pid) => pid !== killerId)
    .map((pid) => roster.get(pid)?.champion)
    .filter((c): c is string => c !== undefined && c !== '');

  for (const victimId of victims) {
    const victimChamp = roster.get(victimId)?.champion;
    if (!victimChamp) {
      ctx.log(`lolesports: kill-feed victim participant ${victimId} unresolved; skipped`);
      continue;
    }
    let composed: string;
    let kind: PlayEvent['kind'];
    if (killer && killer.champion) {
      // Killer names the player (champion(player)); victim/assists name champions only —
      // matching the measured feed (JarvanIV(BLG Xun) → Naafiri [assists Akali, Shen]).
      const killerDisplay = killer.player ? `${killer.champion}(${killer.player})` : killer.champion;
      composed =
        assistNames.length > 0
          ? t(ctx.locale, 'lolKillAssist', { killer: killerDisplay, victim: victimChamp, assists: assistNames.join(', ') })
          : t(ctx.locale, 'lolKill', { killer: killerDisplay, victim: victimChamp });
      kind = 'score';
    } else {
      // Death with no killer ⇒ execute / tower / minion. Never fabricate a killer.
      composed = t(ctx.locale, 'lolDeath', { victim: victimChamp });
      kind = 'play';
    }
    const text = sanitizeText(composed);
    if (!text) continue;
    out.push({
      id: `lol:${gid}:k:${ts}:${victimId}`,
      gameId: matchGameId,
      sequence: ms,
      clock: undefined,
      period: undefined,
      text,
      kind,
      scoreAfter: undefined,
    });
  }

  for (const side of ['blue', 'red'] as const) {
    const pv = teamObjectives(prevFrame, side);
    const cu = teamObjectives(currFrame, side);
    // The side whose counter grew took the objective; blue = away, red = home (§11.5).
    const team = side === 'blue' ? away.abbrev : home.abbrev;
    const pushObjective = (objective: string, kind: PlayEvent['kind']): void => {
      const display = tEnum(ctx.locale, 'lolObjective', objective);
      const text = sanitizeText(t(ctx.locale, 'lolObjective', { team, objective: display }));
      if (!text) return;
      out.push({
        id: `lol:${gid}:o:${ts}:${side}:${objective}`,
        gameId: matchGameId,
        sequence: ms,
        clock: undefined,
        period: undefined,
        text,
        kind,
        scoreAfter: undefined,
      });
    };
    if (cu.towers > pv.towers) pushObjective('tower', 'play');
    if (cu.inhibitors > pv.inhibitors) pushObjective('inhibitor', 'score');
    if (cu.barons > pv.barons) pushObjective('baron', 'score');
    for (let d = pv.dragons.length; d < cu.dragons.length; d++) {
      const drake = cu.dragons[d];
      if (drake) pushObjective(drake, 'score');
    }
  }
}

/**
 * §12.6 — read the catch-up windows for the live game, diff them into kill/objective
 * events, and derive the draft state from the most recent window (so a live detailed
 * game costs getEventDetails + N windows, NOT a separate draft GET). Never throws:
 * ANY window fetch/parse failure ⇒ no events, no state, and the cursor is left
 * UNCHANGED so the interval is retried next poll. The cursor advances only after a
 * fully successful parse.
 */
async function fetchKillFeed(
  ctx: ProviderContext,
  game: Game,
  livestatsGameId: string | undefined,
  away: TeamSide,
  home: TeamSide,
): Promise<{ events: PlayEvent[]; state: EsportsState | undefined }> {
  if (!livestatsGameId) return { events: [], state: undefined };
  const now = ctx.now();
  const cursor = killCursor.get(livestatsGameId);
  const startingTimes = planWindows(cursor, now);

  const raws: unknown[] = [];
  try {
    for (const ts of startingTimes) {
      // No api-key header — the livestats window is public (§12.6). A 204 (empty body ⇒
      // ProviderError('parse')) or a 400 (ProviderError('unavailable')) throws here.
      raws.push(await ctx.fetchJson(`${LIVESTATS}/${livestatsGameId}?startingTime=${ts}`, {}));
    }
  } catch (e) {
    ctx.log(`lolesports: kill-feed window fetch failed (${String(e)}); no kill events, cursor unchanged`);
    return { events: [], state: undefined };
  }

  try {
    let roster: Roster = new Map();
    for (const raw of raws) {
      const meta = asObj(asObj(raw)?.gameMetadata);
      if (meta) roster = buildRoster(meta); // identical across a game's windows; last wins
    }

    // Dedupe by id within the poll (defensive): a real seam never duplicates a frame,
    // but re-derived ids must collapse to one line if it ever did (§3.4 "first wins").
    const byId = new Map<string, PlayEvent>();
    const cursorMs = cursor !== undefined ? Date.parse(cursor) : NaN;
    let latestMs = Number.isFinite(cursorMs) ? cursorMs : -Infinity;
    let latestTs = cursor;
    for (const raw of raws) {
      for (const ev of diffWindow(ctx, livestatsGameId, game.id, raw, roster, away, home)) {
        if (!byId.has(ev.id)) byId.set(ev.id, ev);
      }
      for (const fr of asArr(asObj(raw)?.frames) ?? []) {
        const ts = asStr(asObj(fr)?.rfc460Timestamp);
        const ms = ts !== undefined ? Date.parse(ts) : NaN;
        if (Number.isFinite(ms) && ms > latestMs) {
          latestMs = ms;
          latestTs = ts;
        }
      }
    }

    const state = buildEsportsState(ctx, raws[raws.length - 1], away, home);

    if (latestTs !== undefined) killCursor.set(livestatsGameId, latestTs);
    return { events: [...byId.values()], state };
  } catch (e) {
    ctx.log(`lolesports: kill-feed parse failed (${String(e)}); no kill events, cursor unchanged`);
    return { events: [], state: undefined };
  }
}

/** Sort by sequence ascending, ties broken by id lexicographically (§3.4). */
function bySequenceThenId(a: PlayEvent, b: PlayEvent): number {
  if (a.sequence !== b.sequence) return a.sequence - b.sequence;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * §11.5 — the livestats game id from getEventDetails' match.games[]: the game
 * whose state is 'inProgress', else the highest-`number` game whose state is not
 * 'unstarted'. Only games carrying a platform id qualify. undefined ⇒ skip.
 */
function pickLivestatsGameId(games: unknown[]): string | undefined {
  let inProgress: string | undefined;
  let bestId: string | undefined;
  let bestNumber = -Infinity;
  for (const g of games) {
    const obj = asObj(g);
    if (!obj) continue;
    const id = asStr(obj.id);
    if (!id) continue;
    const state = asStr(obj.state);
    if (state === 'inProgress' && inProgress === undefined) inProgress = id;
    if (state !== undefined && state !== 'unstarted') {
      const number = asNum(obj.number);
      if (number !== undefined && number > bestNumber) {
        bestNumber = number;
        bestId = id;
      }
    }
  }
  return inProgress ?? bestId;
}

/** Patch 'major.minor' from '16.13.790.6961' ⇒ '16.13'; undefined if unparsable. */
function shortenPatch(v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  const m = /^(\d+)\.(\d+)/.exec(v);
  return m ? `${m[1]}.${m[2]}` : undefined;
}

/** DraftPick[] from a team's participantMetadata; entries without a champion are skipped. */
function buildPicks(v: unknown): DraftPick[] {
  const arr = asArr(v);
  if (!arr) return [];
  const picks: DraftPick[] = [];
  for (const p of arr) {
    const obj = asObj(p);
    if (!obj) continue;
    const champion = sanitizeText(obj.championId);
    if (!champion) continue; // DraftPick.champion is never empty (§contract)
    picks.push({
      role: (asStr(obj.role) ?? '').toLowerCase(),
      champion,
      player: sanitizeText(obj.summonerName) ?? '',
    });
  }
  return picks;
}

/**
 * A blue/red pair when BOTH sides are finite numbers, else undefined. A genuine 0-0
 * early in a game is a REAL score (§11.5) and IS emitted. The old code additionally
 * dropped both-zero pairs to hide Defect 1's all-zero kickoff frames — that guard
 * suppressed real openings and is removed now that `startingTime` is sent.
 */
function pairIfFinite(blue: number | undefined, red: number | undefined): { blue: number; red: number } | undefined {
  if (blue === undefined || red === undefined) return undefined;
  return { blue, red };
}

/**
 * Fresh phase (§2.6 pin). `getEventDetails` carries no usable state, so phase
 * is derived from the match: win threshold W = ceil(count / 2); `post` iff
 * max(gameWins) ≥ W, or — when the best-of count is missing/unparsable — every
 * game is terminal ('completed' or 'unneeded') with at least one 'completed'
 * (a swept series leaves unplayed maps 'unneeded', which is terminal). `in` iff
 * any game is 'inProgress'; otherwise the input game's phase is carried through.
 */
function derivePhase(
  count: number | undefined,
  aw: number,
  hw: number,
  games: unknown[],
  inputPhase: GamePhase,
): GamePhase {
  if (count !== undefined) {
    if (Math.max(aw, hw) >= Math.ceil(count / 2)) return 'post';
  } else {
    const states = games.map((g) => asStr(asObj(g)?.state));
    const allTerminal = states.length > 0 && states.every((s) => s === 'completed' || s === 'unneeded');
    if (allTerminal && states.some((s) => s === 'completed')) return 'post';
  }
  if (games.some((g) => asStr(asObj(g)?.state) === 'inProgress')) return 'in';
  return inputPhase;
}

function refreshGame(
  game: Game,
  away: TeamSide,
  home: TeamSide,
  phase: GamePhase,
  aw: number,
  hw: number,
  firstInProgress: number | undefined,
): Game {
  const homeSide: TeamSide = { ...game.home, score: home.score ?? game.home.score };
  if (home.logo) homeSide.logo = home.logo;
  const awaySide: TeamSide = { ...game.away, score: away.score ?? game.away.score };
  if (away.logo) awaySide.logo = away.logo;
  const next: Game = {
    ...game,
    phase,
    home: homeSide,
    away: awaySide,
  };
  if (phase === 'post') {
    next.statusText = 'Final';
    next.statusShort = 'F';
  } else if (phase === 'in') {
    const g = firstInProgress ?? aw + hw + 1;
    next.statusShort = `G${g}`;
    const bo = game.statusText.match(/^BO\d+/)?.[0] ?? 'BO?';
    next.statusText = `${bo} · ${aw}:${hw}`;
  }
  return next;
}

function wrap(e: unknown, msg: string): ProviderError {
  if (e instanceof ProviderError) return e;
  return new ProviderError('parse', `${msg}: ${String(e)}`);
}

export const lolesportsProvider: SportProvider = {
  id: 'lolesports',
  displayName: 'LoL Esports',
  requiresSecret: undefined,
  listLeagues,
  listGames,
  fetchPlays,
};
