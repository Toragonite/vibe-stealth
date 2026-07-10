/**
 * PandaScore (api.pandascore.co) — token required (free tier exists). Esports
 * score ticker, NOT commentary. See docs/CONTRACT.md §2.4.
 *
 * Provider is hidden from the tree until its secret exists (requiresSecret).
 * The token is read ONLY from SecretStorage (ctx.getSecret) — never settings.
 * A missing token ⇒ ProviderError('auth') before any network call; 401/403 from
 * the gateway is mapped to 'auth' by the HTTP layer and propagated.
 *
 * Every field access is defensive: a shape surprise becomes ProviderError('parse');
 * one bad list entry is skipped (ctx.log), never fatal.
 */
import {
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
import { coerceScore, parseIsoUtc, sanitizeText } from '../core/util';

const BASE = 'https://api.pandascore.co';
const SECRET_KEY = 'pandascore.token';

interface PandaLeagueMeta {
  name: string;
}

const PANDA_LEAGUES: Record<string, PandaLeagueMeta> = {
  lol: { name: 'League of Legends' },
  csgo: { name: 'Counter-Strike 2' },
  dota2: { name: 'Dota 2' },
  valorant: { name: 'VALORANT' },
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

/** LogoRef from a required light candidate; undefined when unusable (PandaScore has no dark variant). */
function logoRef(lightRaw: unknown): LogoRef | undefined {
  const light = normLogoUrl(lightRaw);
  return light ? { light } : undefined;
}

/** id fields arrive as number or string; normalize to a comparable string ('' if absent). */
function idStr(v: unknown): string {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'string') return v.trim();
  return '';
}

async function requireToken(ctx: ProviderContext): Promise<string> {
  const token = await ctx.getSecret(SECRET_KEY);
  if (!token || token.trim() === '') {
    throw new ProviderError('auth', 'PandaScore token not set');
  }
  return token;
}

function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function mapPhase(status: unknown): GamePhase {
  switch (asStr(status)) {
    case 'running':
      return 'in';
    case 'not_started':
      return 'pre';
    case 'finished':
    case 'canceled':
      return 'post';
    default:
      return 'unknown';
  }
}

interface Sides {
  home: TeamSide;
  away: TeamSide;
}

/** opponents[0] → home, opponents[1] → away (§2.4). Missing side ⇒ 'TBD', score undefined. */
function readSides(match: Record<string, unknown>): Sides {
  const opponents = asArr(match.opponents) ?? [];
  const results = asArr(match.results) ?? [];
  const home = buildOpponent(asObj(asObj(opponents[0])?.opponent), results);
  const away = buildOpponent(asObj(asObj(opponents[1])?.opponent), results);
  return { home, away };
}

function buildOpponent(
  opp: Record<string, unknown> | undefined,
  results: unknown[],
): TeamSide {
  if (!opp) return { id: '', name: 'TBD', abbrev: 'TBD', score: undefined };
  const id = idStr(opp.id);
  const nm = sanitizeText(opp.name);
  const ac = (asStr(opp.acronym) ?? '').trim();
  const abbrev = ac !== '' ? ac.slice(0, 5) : nm ? nm.slice(0, 3).toUpperCase() : 'TBD';
  const name = nm ?? (abbrev !== 'TBD' ? abbrev : 'TBD');
  const side: TeamSide = { id, name, abbrev, score: scoreFor(results, id) };
  const logo = logoRef(opp.image_url);
  if (logo) side.logo = logo;
  return side;
}

function scoreFor(results: unknown[], teamId: string): number | undefined {
  if (teamId === '') return undefined;
  for (const r of results) {
    const obj = asObj(r);
    if (obj && idStr(obj.team_id) === teamId) return coerceScore(obj.score);
  }
  return undefined;
}

function statusStrings(
  phase: GamePhase,
  gamesCount: number,
  sides: Sides,
): { statusText: string; statusShort: string } {
  const aw = sides.away.score ?? 0;
  const hw = sides.home.score ?? 0;
  if (phase === 'in') {
    return {
      statusText: `${sides.away.abbrev} ${aw}–${hw} ${sides.home.abbrev}`,
      statusShort: `G${gamesCount}`,
    };
  }
  if (phase === 'pre') return { statusText: 'Scheduled', statusShort: 'vs' };
  if (phase === 'post') return { statusText: 'Finished', statusShort: 'vs' };
  return { statusText: '—', statusShort: 'vs' };
}

function buildGame(
  match: Record<string, unknown>,
  league: League,
): Game | undefined {
  const matchId = idStr(match.id);
  if (matchId === '') return undefined;
  const sides = readSides(match);
  const phase = mapPhase(match.status);
  const gamesCount = (asArr(match.games) ?? []).length;
  const { statusText, statusShort } = statusStrings(phase, gamesCount, sides);
  return {
    id: `pandascore:${league.id}:${matchId}`,
    providerId: 'pandascore',
    leagueId: league.id,
    leagueName: league.name,
    sport: 'esports',
    startTimeUtc: parseIsoUtc(match.begin_at),
    phase,
    statusText,
    statusShort,
    home: sides.home,
    away: sides.away,
  };
}

// --- provider ----------------------------------------------------------------

async function listLeagues(_ctx: ProviderContext): Promise<League[]> {
  return Object.entries(PANDA_LEAGUES).map(([id, meta]) => ({
    id,
    providerId: 'pandascore',
    name: meta.name,
    sport: 'esports',
  }));
}

async function listGames(ctx: ProviderContext, league: League): Promise<Game[]> {
  if (!PANDA_LEAGUES[league.id]) return [];
  const token = await requireToken(ctx);
  const url =
    `${BASE}/${league.id}/matches?filter[status]=running,not_started` +
    `&sort=begin_at&page[size]=25`;

  let raw: unknown;
  try {
    raw = await ctx.fetchJson(url, authHeaders(token));
  } catch (e) {
    throw wrap(e, 'pandascore listGames fetch failed');
  }

  try {
    const matches = asArr(raw);
    if (!matches) throw new ProviderError('parse', 'pandascore matches: response not an array');

    const out: Game[] = [];
    for (const m of matches) {
      try {
        const obj = asObj(m);
        if (!obj) continue;
        const game = buildGame(obj, league);
        if (game) out.push(game);
        else ctx.log('pandascore: match missing id, skipped');
      } catch (inner) {
        ctx.log(`pandascore: skipped malformed match: ${String(inner)}`);
      }
    }
    return out;
  } catch (e) {
    throw wrap(e, 'pandascore listGames parse failed');
  }
}

function nativeMatchId(game: Game): string {
  return game.id.split(':').slice(2).join(':');
}

async function fetchPlays(ctx: ProviderContext, game: Game): Promise<PlaySnapshot> {
  const token = await requireToken(ctx);
  const matchId = nativeMatchId(game);
  const url = `${BASE}/matches/${matchId}`;

  let raw: unknown;
  try {
    raw = await ctx.fetchJson(url, authHeaders(token));
  } catch (e) {
    throw wrap(e, 'pandascore fetchPlays fetch failed');
  }

  try {
    const match = asObj(raw);
    if (!match) throw new ProviderError('parse', 'pandascore match: response not an object');

    const sides = readSides(match);

    // winner.id → opponent name lookup.
    const nameById = new Map<string, string>();
    if (sides.home.id !== '') nameById.set(sides.home.id, sides.home.name);
    if (sides.away.id !== '') nameById.set(sides.away.id, sides.away.name);

    const games = asArr(match.games) ?? [];
    const events: PlayEvent[] = [];
    for (const g of games) {
      try {
        const obj = asObj(g);
        if (!obj || obj.finished !== true) continue;
        const position = asNum(obj.position);
        if (position === undefined) {
          ctx.log(`pandascore: finished game missing position, skipped (${matchId})`);
          continue;
        }
        // Winner is the map's IMMUTABLE fact (games[].winner.id is fixed once finished);
        // the running match score is mutable and MUST NOT appear in the text (§2.4 /
        // immutable-text pin) — it would re-derive and fire a false correction each poll.
        const winnerId = idStr(asObj(obj.winner)?.id);
        const winnerName = winnerId !== '' ? nameById.get(winnerId) : undefined;
        const text = sanitizeText(
          winnerName ? `Map ${position}: ${winnerName}` : `Map ${position} finished`,
        );
        if (!text) continue;
        events.push({
          id: `ps:${matchId}:map${position}`,
          gameId: game.id,
          sequence: position,
          clock: undefined,
          period: undefined,
          text,
          kind: 'score',
          scoreAfter: undefined,
        });
      } catch (inner) {
        ctx.log(`pandascore: skipped malformed game: ${String(inner)}`);
      }
    }
    events.sort((a, b) => a.sequence - b.sequence);

    const refreshed = buildGame(match, {
      id: game.leagueId,
      providerId: 'pandascore',
      name: game.leagueName,
      sport: 'esports',
    });
    return { game: refreshed ?? game, events };
  } catch (e) {
    throw wrap(e, 'pandascore fetchPlays parse failed');
  }
}

function wrap(e: unknown, msg: string): ProviderError {
  if (e instanceof ProviderError) return e;
  return new ProviderError('parse', `${msg}: ${String(e)}`);
}

export const pandascoreProvider: SportProvider = {
  id: 'pandascore',
  displayName: 'PandaScore',
  requiresSecret: SECRET_KEY,
  listLeagues,
  listGames,
  fetchPlays,
};
