/**
 * Naver Sports (api-gw.sports.naver.com) — key-free, unofficial, Korean leagues.
 * KBO (baseball, 문자중계) + K리그1 (soccer). See docs/CONTRACT.md §2.5.
 *
 * Undocumented gateway: every field access is defensive. A shape surprise never
 * throws raw — it becomes ProviderError('parse'); one bad list entry is skipped
 * (ctx.log), never fatal. The relay endpoint returns only the LATEST window, so
 * PlaySnapshot.events is the current window (contract §2 Naver exception).
 *
 * The relay carries NO game-level status, so fetchPlays ALSO hits the game-detail
 * endpoint — the single authoritative phase/score source (§2.5 fresh-game pin).
 */
import {
  Game,
  GamePhase,
  League,
  LogoRef,
  PlayEvent,
  PlayEventKind,
  PlaySnapshot,
  ProviderContext,
  ProviderError,
  SportKind,
  SportProvider,
  TeamSide,
} from '../core/contract';
import { coerceScore, dateInZone, parseIsoUtc, sanitizeText } from '../core/util';

const BASE = 'https://api-gw.sports.naver.com';
// Pinned: the default extension UA is unverified against this gateway (§2.5).
const NAVER_HEADERS: Record<string, string> = { 'user-agent': 'Mozilla/5.0' };

interface NaverLeagueMeta {
  upperCategoryId: string;
  name: string;
  sport: SportKind;
}

const NAVER_LEAGUES: Record<string, NaverLeagueMeta> = {
  kbo: { upperCategoryId: 'kbaseball', name: 'KBO리그', sport: 'baseball' },
  kleague: { upperCategoryId: 'kfootball', name: 'K리그1', sport: 'soccer' },
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

/** seqno / no may arrive as number or numeric string; return a finite integer or undefined. */
function asSeq(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
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

/**
 * Resize a Naver emblem URL (§13.2b/§13.3). The input is already https (normLogoUrl ran first).
 * Append `?type=f64_64` only when the URL has NO query string; if it already has one, leave it
 * entirely alone (never clobber an existing param). Conservative: a `new URL()` throw ⇒ input
 * unchanged (a big logo beats a broken one).
 */
function resizeNaverLogo(url: string): string {
  try {
    const u = new URL(url);
    if (u.search !== '') return url;
    return `${url}?type=f64_64`;
  } catch {
    return url;
  }
}

/** LogoRef from a required light candidate; undefined when unusable (Naver has no dark variant). */
function logoRef(lightRaw: unknown): LogoRef | undefined {
  const light = normLogoUrl(lightRaw);
  return light ? { light: resizeNaverLogo(light) } : undefined;
}

// --- shared building ---------------------------------------------------------

/** §2 team rules: empty name → abbrev → 'TBD'; abbrev provided else first 3 of name upper. */
function buildTeam(nameRaw: unknown, codeRaw: unknown, scoreRaw: unknown): TeamSide {
  const code = (asStr(codeRaw) ?? '').trim();
  const nm = sanitizeText(nameRaw);
  const abbrev = code !== '' ? code.slice(0, 5) : nm ? nm.slice(0, 3).toUpperCase() : 'TBD';
  const name = nm ?? (abbrev !== 'TBD' ? abbrev : 'TBD');
  return { id: code, name, abbrev, score: coerceScore(scoreRaw) };
}

/**
 * §2.5 phase mapping — the STRING statusCode carried by `listGames` entries and by
 * `result.game` of the game-detail endpoint (identical shape). Unknown ⇒ 'unknown'.
 * The relay's own numeric statusCode is NOT a phase source (see fetchPlays).
 */
function mapStatusCode(v: unknown): GamePhase {
  const s = asStr(v);
  switch (s) {
    case 'RESULT':
      return 'post';
    case 'BEFORE':
    case 'READY':
      return 'pre';
    case 'LIVE':
    case 'STARTED':
      return 'in';
    default:
      return 'unknown';
  }
}

function statusStrings(
  statusInfoRaw: unknown,
  phase: GamePhase,
  gameDateTimeRaw: unknown,
): { statusText: string; statusShort: string } {
  const info = sanitizeText(statusInfoRaw);
  const fallback =
    phase === 'pre' ? '예정' : phase === 'in' ? '경기중' : phase === 'post' ? '종료' : '-';
  const statusText = info ?? fallback;

  let statusShort: string;
  if (phase === 'pre') {
    // KST wall-clock HH:MM lives verbatim in gameDateTime (no tz suffix).
    const m = /T(\d{2}:\d{2})/.exec(asStr(gameDateTimeRaw) ?? '');
    statusShort = m ? m[1]! : info ? info.slice(0, 8) : '예정';
  } else if (phase === 'post') {
    statusShort = 'F';
  } else {
    statusShort = info ? info.slice(0, 8) : fallback;
  }
  return { statusText, statusShort };
}

/** The league fields a Game carries but a raw Naver game object does not. */
type GameOrigin = Pick<Game, 'leagueId' | 'leagueName' | 'sport'>;

/**
 * THE game parser (§2.5). One mapping code path, shared by `listGames` entries and by
 * `result.game` of `/schedule/games/{gameId}` — the two are the same shape. Returns
 * undefined when the entry has no gameId (caller decides: skip, or carry the input game).
 */
function parseGame(obj: Record<string, unknown>, origin: GameOrigin): Game | undefined {
  const gameId = asStr(obj.gameId);
  if (!gameId) return undefined;

  const phase = mapStatusCode(obj.statusCode);
  const { statusText, statusShort } = statusStrings(obj.statusInfo, phase, obj.gameDateTime);
  const dt = asStr(obj.gameDateTime);
  const startTimeUtc = dt ? parseIsoUtc(dt + '+09:00') : undefined;

  const home = buildTeam(obj.homeTeamName, obj.homeTeamCode, obj.homeTeamScore);
  const homeLogo = logoRef(obj.homeTeamEmblemUrl);
  if (homeLogo) home.logo = homeLogo;
  const away = buildTeam(obj.awayTeamName, obj.awayTeamCode, obj.awayTeamScore);
  const awayLogo = logoRef(obj.awayTeamEmblemUrl);
  if (awayLogo) away.logo = awayLogo;

  return {
    id: `naver:${origin.leagueId}:${gameId}`,
    providerId: 'naver',
    leagueId: origin.leagueId,
    leagueName: origin.leagueName,
    sport: origin.sport,
    startTimeUtc,
    phase,
    statusText,
    statusShort,
    format: 'versus',
    home,
    away,
    entrants: undefined,
  };
}

// --- provider ----------------------------------------------------------------

async function listLeagues(_ctx: ProviderContext): Promise<League[]> {
  return Object.entries(NAVER_LEAGUES).map(([id, meta]) => ({
    id,
    providerId: 'naver',
    name: meta.name,
    sport: meta.sport,
  }));
}

async function listGames(ctx: ProviderContext, league: League): Promise<Game[]> {
  const meta = NAVER_LEAGUES[league.id];
  if (!meta) return [];
  const d = dateInZone(ctx.now(), 'Asia/Seoul');
  const url =
    `${BASE}/schedule/games?fields=basic,schedule&upperCategoryId=${meta.upperCategoryId}` +
    `&categoryId=${league.id}&fromDate=${d}&toDate=${d}&size=50`;

  let raw: unknown;
  try {
    raw = await ctx.fetchJson(url, NAVER_HEADERS);
  } catch (e) {
    throw wrap(e, 'naver listGames fetch failed');
  }

  try {
    const games = asArr(asObj(asObj(raw)?.result)?.games);
    if (!games) throw new ProviderError('parse', 'naver schedule: result.games not an array');

    const origin: GameOrigin = { leagueId: league.id, leagueName: league.name, sport: meta.sport };
    const out: Game[] = [];
    for (const g of games) {
      try {
        const obj = asObj(g);
        if (!obj) continue;
        const parsed = parseGame(obj, origin);
        if (!parsed) {
          ctx.log('naver: schedule entry missing gameId, skipped');
          continue;
        }
        out.push(parsed);
      } catch (inner) {
        ctx.log(`naver: skipped malformed schedule entry: ${String(inner)}`);
      }
    }
    return out;
  } catch (e) {
    throw wrap(e, 'naver listGames parse failed');
  }
}

function nativeGameId(game: Game): string {
  return game.id.split(':').slice(2).join(':');
}

/**
 * §2.5 fresh-game pin. The relay window carries no game-level status (its `statusCode`s are a
 * per-entry constant 0 and, for K League, a NUMERIC top-level 4), so phase/score come from
 * `/schedule/games/{gameId}` — `result.game` has exactly a `listGames` entry's shape, string
 * statusCode included, and is parsed by the SAME parser.
 *
 * Best effort by design: ANY failure (network, 404, JSON garbage, missing gameId) carries the
 * input game through instead of throwing. A status refresh that fails must never cost the
 * caller its play lines — only a relay failure is a real ProviderError.
 */
async function fetchFreshGame(ctx: ProviderContext, game: Game, gid: string): Promise<Game> {
  try {
    const raw = await ctx.fetchJson(`${BASE}/schedule/games/${gid}`, NAVER_HEADERS);
    const obj = asObj(asObj(asObj(raw)?.result)?.game);
    const fresh = obj ? parseGame(obj, game) : undefined;
    if (!fresh) {
      ctx.log(`naver detail: unusable result.game for ${gid}, carrying input game`);
      return game;
    }
    // Identity stays the caller's: the detail was fetched BY game.id, and a surprise gameId in
    // the body must not silently re-key the game (event ids are derived from it).
    return { ...fresh, id: game.id, startTimeUtc: fresh.startTimeUtc ?? game.startTimeUtc };
  } catch (e) {
    ctx.log(`naver detail: status refresh failed for ${gid} (${String(e)}), carrying input game`);
    return game;
  }
}

async function fetchPlays(ctx: ProviderContext, game: Game): Promise<PlaySnapshot> {
  const gid = nativeGameId(game);
  const fresh = await fetchFreshGame(ctx, game, gid);
  const url = `${BASE}/schedule/games/${gid}/relay`;

  let raw: unknown;
  try {
    raw = await ctx.fetchJson(url, NAVER_HEADERS);
  } catch (e) {
    throw wrap(e, 'naver fetchPlays fetch failed');
  }

  try {
    const data = asObj(asObj(asObj(raw)?.result)?.textRelayData);
    if (!data) {
      // Pre-game (and occasionally between windows) the relay endpoint answers
      // without textRelayData — CONTRACT §2.5 pins this as a normal empty
      // window, not a parse error (a follow before first pitch must not
      // enter an error-backoff loop). The game is still the FRESH one, which is
      // what lets a pre-game follow advance pre → in → post.
      ctx.log(`naver relay: no textRelayData yet for ${gid} (phase=${fresh.phase})`);
      return { game: fresh, events: [] };
    }

    // Route on the CALLER's league — never on anything the detail response said.
    if (game.leagueId === 'kleague') {
      return parseKLeagueRelay(ctx, fresh, data);
    }
    return parseKboRelay(ctx, fresh, data);
  } catch (e) {
    throw wrap(e, 'naver fetchPlays parse failed');
  }
}

// --- KBO relay ---------------------------------------------------------------

function parseKboRelay(
  ctx: ProviderContext,
  game: Game,
  data: Record<string, unknown>,
): PlaySnapshot {
  const gid = nativeGameId(game);
  const relays = asArr(data.textRelays) ?? [];
  const events: PlayEvent[] = [];
  // seqno is documented as globally monotonic across parent textRelays. If it ever
  // isn't, two options collide on id and the engine's first-wins dedup silently drops
  // the second — so make the violation loud rather than invisible (breaker m3b).
  const seenSeq = new Set<number>();

  for (const r of relays) {
    const parent = asObj(r);
    if (!parent) continue;
    const inn = asNum(parent.inn);
    const homeOrAway = asStr(parent.homeOrAway);
    const options = asArr(parent.textOptions) ?? [];
    const period =
      inn !== undefined ? (homeOrAway === '1' ? `B${inn}` : `T${inn}`) : undefined;

    for (const o of options) {
      try {
        const opt = asObj(o);
        if (!opt) continue;
        // Drop separators: type 99 or text of only '='. `asSeq`, not `asNum`: this
        // gateway may stringify numerics, and a string "99" separator would otherwise
        // leak as a play line (breaker m3a).
        if (asSeq(opt.type) === 99) continue;
        const rawText = asStr(opt.text) ?? '';
        if (/^=+$/.test(rawText.trim())) continue;
        const text = sanitizeText(rawText);
        if (!text) continue; // null/empty text ⇒ dropped (§2)
        const seq = asSeq(opt.seqno);
        if (seq === undefined) {
          ctx.log(`naver kbo: option with invalid seqno skipped (${gid})`);
          continue;
        }
        const gs = asObj(opt.currentGameState);
        const home = coerceScore(gs?.homeScore);
        const away = coerceScore(gs?.awayScore);
        const scoreAfter = home !== undefined && away !== undefined ? { home, away } : undefined;

        if (seenSeq.has(seq)) {
          ctx.log(`naver kbo: duplicate seqno ${seq} in ${gid} — line will be deduped by id`);
        }
        seenSeq.add(seq);

        events.push({
          id: `naver:${gid}:${seq}`,
          gameId: game.id,
          sequence: seq,
          clock: undefined,
          period,
          text,
          kind: 'play',
          scoreAfter,
        });
      } catch (inner) {
        ctx.log(`naver kbo: skipped malformed option: ${String(inner)}`);
      }
    }
  }

  events.sort((a, b) => a.sequence - b.sequence);

  // kind 'score' when scoreAfter differs from the previous (by seqno) option's.
  for (let i = 1; i < events.length; i++) {
    const cur = events[i]!;
    const prev = events[i - 1]!;
    if (
      cur.scoreAfter &&
      prev.scoreAfter &&
      (cur.scoreAfter.home !== prev.scoreAfter.home ||
        cur.scoreAfter.away !== prev.scoreAfter.away)
    ) {
      cur.kind = 'score';
    }
  }

  // `game` is already fresh from the detail endpoint — the relay's top-level
  // currentGameState is NOT consulted for the Game (§2.5: one authoritative source).
  return { game, events };
}

// --- K League relay ----------------------------------------------------------

function parseKLeagueRelay(
  ctx: ProviderContext,
  game: Game,
  data: Record<string, unknown>,
): PlaySnapshot {
  const gid = nativeGameId(game);
  const relays = asArr(data.textRelays) ?? [];
  const events: PlayEvent[] = [];

  for (const r of relays) {
    try {
      const obj = asObj(r);
      if (!obj) continue;
      const no = asSeq(obj.no);
      if (no === undefined) {
        ctx.log(`naver kleague: entry with invalid no skipped (${gid})`);
        continue;
      }
      const text = sanitizeText(obj.text);
      if (!text) continue; // null/empty text ⇒ dropped (§2)
      const half = asStr(obj.half) ?? asNum(obj.half)?.toString();
      const time = asStr(obj.time);
      const eventType = asStr(obj.eventType);
      const kind: PlayEventKind = eventType === 'GOAL' ? 'score' : 'play';

      events.push({
        id: `naver:${gid}:${no}`,
        gameId: game.id,
        sequence: no,
        clock: time && time !== '' ? (time.endsWith("'") ? time : `${time}'`) : undefined,
        period: half !== undefined ? `H${half}` : undefined,
        text,
        kind,
        scoreAfter: undefined,
      });
    } catch (inner) {
      ctx.log(`naver kleague: skipped malformed entry: ${String(inner)}`);
    }
  }

  // Fixture is NEWEST-FIRST — sort ascending by `no`.
  events.sort((a, b) => a.sequence - b.sequence);

  // The relay's top-level homeScore/awayScore/statusCode/statusInfo are DEAD as a Game source:
  // its statusCode is the numeric 4, never the schedule's 'RESULT', so phase could never advance
  // (breaker finding B1). `game` is fresh from the detail endpoint.
  return { game, events };
}

/** ProviderError passes through; anything else becomes a 'parse' shape surprise. */
function wrap(e: unknown, msg: string): ProviderError {
  if (e instanceof ProviderError) return e;
  return new ProviderError('parse', `${msg}: ${String(e)}`);
}

export const naverProvider: SportProvider = {
  id: 'naver',
  displayName: 'Naver Sports',
  requiresSecret: undefined,
  listLeagues,
  listGames,
  fetchPlays,
};
