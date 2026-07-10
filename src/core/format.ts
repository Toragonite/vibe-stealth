/**
 * Relay-line and status-bar rendering (docs/CONTRACT.md §5, §9).
 *
 * Pure: the only clock is `FormatOptions.now()`, rendered in the host's local
 * time zone.
 */

import type { FormatOptions, Game, PlayEvent, RelayLocale, SportKind } from './contract';
import { t } from './i18n';
import { sanitizeText } from './util';

const SPORT_EMOJI: Record<SportKind, string> = {
  baseball: '⚾',
  basketball: '🏀',
  football: '🏈',
  hockey: '🏒',
  soccer: '⚽',
  esports: '🎮',
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
  const tag = opts.multiGame ? `[${game.away.abbrev}-${game.home.abbrev}] ` : '';
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

/** `AWY 3:2 HOM · T7` — no emoji, no color (§5). */
export function formatStatusBar(
  awayAbbrev: string,
  awayScore: number | undefined,
  homeScore: number | undefined,
  homeAbbrev: string,
  statusShort: string,
): string {
  const head = `${awayAbbrev} ${renderScore(awayScore)}:${renderScore(homeScore)} ${homeAbbrev}`;
  const status = typeof statusShort === 'string' ? statusShort.trim() : '';
  return status === '' ? head : `${head} · ${status}`;
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
