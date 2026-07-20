/**
 * Relay-line and status-bar rendering (docs/CONTRACT.md §5, §9).
 *
 * Pure: the only clock is `FormatOptions.now()`, rendered in the host's local
 * time zone.
 */

import { MAX_FIELD_POSITION } from './contract';
import type { Entrant, FormatOptions, Game, PlayEvent, RelayLocale, SportKind } from './contract';
import { t } from './i18n';
import { sanitizeText } from './util';

const SPORT_EMOJI: Record<SportKind, string> = {
  baseball: '⚾',
  basketball: '🏀',
  football: '🏈',
  hockey: '🏒',
  soccer: '⚽',
  esports: '🎮',
  tennis: '🎾',
  mma: '🥊',
  cricket: '🏏',
  volleyball: '🏐',
  motorsport: '🏎',
  other: '',
};

/** Rendered for any score that is not a plausible integer count (§P3: never 'NaN'). */
const NO_SCORE = '–';

/**
 * `HH:MM:SS │ {tag}{marker}{period+clock} │ {text}`
 *
 * When neither period nor clock is known the middle field collapses to the
 * marker alone (right-trimmed) rather than leaving a dangling separator.
 */
export function formatEventLine(event: PlayEvent, game: Game, opts: FormatOptions): string {
  const stamp = formatLocalTime(opts.now());
  const tag = opts.multiGame ? gameTag(game) : '';
  const marker = event.kind === 'score' ? '★ ' : event.kind === 'correction' ? '⚠ ' : '· ';

  const period = localizePeriod(event.period, game.sport, opts.locale);
  const clock = typeof event.clock === 'string' ? event.clock.trim() : '';
  const when = [period, clock].filter((part): part is string => typeof part === 'string' && part !== '').join(' ');
  const middle = `${tag}${marker}${when}`.trimEnd();

  // Already sanitized by the provider; re-running the same rule keeps a hostile
  // newline or control char out of the append-only channel for free (§P8).
  let text = sanitizeText(event.text) ?? '';
  if (opts.showEmoji) {
    const emoji = SPORT_EMOJI[game.sport] ?? '';
    if (emoji !== '') text = `${emoji} ${text}`;
  }
  if (event.kind === 'correction') text = `${text} ${t(opts.locale, 'corrected')}`;

  return `${stamp} │ ${middle} │ ${text}`;
}

/**
 * The `[AWY-HOM] ` multi-game tag. A field contest (§14) has no two sides to name, so it
 * tags with the contest's initials instead. Empty when neither shape yields anything.
 */
function gameTag(game: Game): string {
  const label = game.format === 'field' ? contestTag(game.leagueName) : versusTag(game);
  return label === '' ? '' : `[${label}] `;
}

function versusTag(game: Game): string {
  const away = trimmed(game.away?.abbrev);
  const home = trimmed(game.home?.abbrev);
  return away === '' && home === '' ? '' : `${away}-${home}`;
}

/** `Belgian Grand Prix` → `BGP`; a single word keeps its first 5 chars (`Monaco` → `MONAC`). */
function contestTag(name: string): string {
  const words = trimmed(name).split(/\s+/).filter((word) => word !== '');
  if (words.length === 0) return '';
  const initials = words.map((word) => word[0] ?? '').join('');
  return (initials.length >= 2 ? initials : (words[0] ?? '')).toUpperCase().slice(0, 5);
}

/**
 * The leading competitor of a field contest (§14) — the FIRST entrant carrying a usable
 * position. Providers sort the field, so scanning forward past unranked entries picks the
 * leader without re-sorting. undefined when nothing is ranked yet (pre-session) or the
 * game carries no entrants at all (a malformed 'field' game).
 */
export function leadEntrant(entrants: readonly Entrant[] | undefined): Entrant | undefined {
  if (!Array.isArray(entrants)) return undefined;
  for (const entrant of entrants) {
    if (!entrant) continue;
    if (isFieldPosition(entrant.position)) return entrant;
  }
  return undefined;
}

/**
 * §14: a usable position is an integer in [1, MAX_FIELD_POSITION].
 *
 * The UPPER bound is a value-semantics rule, not decoration — do not "simplify" it
 * away. `Number.isInteger(1e308)` is true and `1e308 >= 1` is true, so a shape-only
 * check accepts 1e308 as a rank and renders it as `P1e+308`: structurally perfect,
 * semantically meaningless. A position outside the range is not a position, so it is
 * skipped exactly as an unranked (`undefined`) one is.
 */
function isFieldPosition(position: number | undefined): boolean {
  return (
    typeof position === 'number' &&
    Number.isInteger(position) &&
    position >= 1 &&
    position <= MAX_FIELD_POSITION
  );
}

/** `P1 VER` (ko: `1위 VER`), or undefined when the field is not ranked yet (§14). */
export function formatLeader(
  entrants: readonly Entrant[] | undefined,
  locale: RelayLocale,
): string | undefined {
  const leader = leadEntrant(entrants);
  if (!leader) return undefined;
  const n = leader.position ?? 0;
  const who = trimmed(leader.abbrev) || trimmed(leader.name);
  // Two templates so an entrant with neither abbrev nor name can never render a raw {who}.
  return who === '' ? t(locale, 'leaderPositionBare', { n }) : t(locale, 'leaderPosition', { n, who });
}

/** `AWY 3:2 HOM · T7` — no emoji, no color (§5). */
export function formatStatusBar(
  awayAbbrev: string,
  awayScore: number | undefined,
  homeScore: number | undefined,
  homeAbbrev: string,
  statusShort: string,
): string {
  return withStatus(`${awayAbbrev} ${renderScore(awayScore)}:${renderScore(homeScore)} ${homeAbbrev}`, statusShort);
}

/**
 * The status-bar text for either contest shape (§5, §14): `AWY 3:2 HOM · T7` for a versus
 * game, `P1 VER · L32` for a field one. A malformed game — 'versus' missing a side, 'field'
 * with nothing ranked — degrades to the status alone rather than inventing a score.
 */
export function statusBarText(game: Game, locale: RelayLocale): string {
  if (game.format === 'field') return withStatus(formatLeader(game.entrants, locale) ?? '', game.statusShort);
  const { home, away } = game;
  if (!home || !away) return withStatus('', game.statusShort);
  return formatStatusBar(away.abbrev, away.score, home.score, home.abbrev, game.statusShort);
}

function withStatus(head: string, statusShort: string): string {
  const status = trimmed(statusShort);
  if (head === '') return status;
  return status === '' ? head : `${head} · ${status}`;
}

function trimmed(value: string | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Locale-neutral period labels (`T7`, `Q3`, `P2`, `OT`, `G2`…) → display form.
 * `en` passes through; an unrecognized label passes through in every locale.
 */
export function localizePeriod(
  period: string | undefined,
  sport: SportKind,
  locale: RelayLocale,
): string | undefined {
  if (typeof period !== 'string') return undefined;
  const label = period.trim();
  if (label === '') return undefined;
  if (locale !== 'ko') return label;

  switch (label) {
    case 'OT':
      return '연장';
    case 'SO':
      return sport === 'hockey' ? '슛아웃' : '승부치기';
    case 'HT':
      return '전반 종료';
    case 'FT':
      return '경기 종료';
    case 'H1':
      return '전반';
    case 'H2':
      return '후반';
  }

  const numbered = /^([TBMEQPG])(\d{1,3})$/.exec(label);
  const prefix = numbered?.[1];
  const digits = numbered?.[2];
  if (prefix === undefined || digits === undefined) return label;
  const n = Number(digits);

  switch (prefix) {
    case 'T':
      return `${n}회초`;
    case 'B':
      return `${n}회말`;
    case 'M':
      return `${n}회중`;
    case 'E':
      return `${n}회종`;
    case 'Q':
      return `${n}쿼터`;
    case 'P':
      return `${n}피리어드`;
    case 'G':
      return `${n}세트`;
    default:
      return label;
  }
}

function renderScore(score: number | undefined): string {
  return typeof score === 'number' && Number.isInteger(score) && score >= 0 ? String(score) : NO_SCORE;
}

function formatLocalTime(epochMs: number): string {
  if (!Number.isFinite(epochMs)) return '00:00:00';
  const d = new Date(epochMs);
  if (Number.isNaN(d.getTime())) return '00:00:00';
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}
