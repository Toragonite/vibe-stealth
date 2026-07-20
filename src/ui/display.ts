/**
 * Shared display helpers for the UI layer. Score rendering matches CONTRACT §5/§6:
 * an undefined score renders as an en dash, never 'NaN' / 'undefined' / '0'.
 *
 * Every helper here takes a `Game` of EITHER shape (CONTRACT §14) and must survive a
 * malformed one — a 'versus' game missing a side, or a 'field' game whose entrants are
 * empty or all unranked — by degrading to the contest name, never by throwing.
 */

import type { Game, LogoRef, RelayLocale } from '../core/contract';
import { formatLeader, leadEntrant } from '../core/format';

/** U+2013 EN DASH — the pinned placeholder for an unknown score. */
export const EN_DASH = '–';

export function scoreText(score: number | undefined): string {
  return score === undefined ? EN_DASH : String(score);
}

/**
 * CONTRACT §6 game label: `{away.abbrev} {as}:{hs} {home.abbrev}`.
 * CONTRACT §14 field label: `{contest} · P1 VER`, or the contest alone when the field
 * is not ranked yet — a field contest must never render as a fake two-sided score.
 *
 * `locale` defaults to `en` for the call sites that have no locale in hand.
 */
export function gameLabel(game: Game, locale: RelayLocale = 'en'): string {
  if (game.format === 'field') return joinContest(game, formatLeader(game.entrants, locale));
  const { home, away } = game;
  if (!home || !away) return contestName(game);
  return `${away.abbrev} ${scoreText(away.score)}:${scoreText(home.score)} ${home.abbrev}`;
}

/**
 * The same row with full names instead of abbrevs — the status-bar tooltip's line per
 * followed game. A field contest has no two names to pair, so it reuses the §14 label.
 */
export function gameLine(game: Game, locale: RelayLocale): string {
  if (game.format === 'field') return gameLabel(game, locale);
  const { home, away } = game;
  if (!home || !away) return contestName(game);
  return `${away.name} ${scoreText(away.score)}:${scoreText(home.score)} ${home.name}`;
}

/** Human title used in relay system lines and tooltips. */
export function gameTitle(game: Game): string {
  if (game.format === 'field') return contestName(game);
  const { home, away } = game;
  if (!home || !away) return contestName(game);
  return `${away.name} vs ${home.name}`;
}

/**
 * The score fragment of a tooltip: `3:2` for a versus game, `P1 VER` for a field one.
 * Empty when the game carries neither — the caller drops the fragment rather than
 * rendering a dangling separator.
 */
export function gameStanding(game: Game, locale: RelayLocale): string {
  if (game.format === 'field') return formatLeader(game.entrants, locale) ?? '';
  const { home, away } = game;
  if (!home || !away) return '';
  return `${scoreText(away.score)}:${scoreText(home.score)}`;
}

/**
 * CONTRACT §13.4b: the single 16px crest a game row gets — the HOME side for a versus
 * game, the leader's portrait for a field one (the entrant the row's label names).
 */
export function gameLogo(game: Game): LogoRef | undefined {
  if (game.format === 'field') return leadEntrant(game.entrants)?.logo;
  return game.home?.logo;
}

/**
 * The contest's own name. `Game` carries no event-name field, so a field contest is
 * identified by its league name (a motorsport provider puts the race there); the status
 * text is the last resort so a row is never blank.
 */
export function contestName(game: Game): string {
  const name = trimmed(game.leagueName);
  return name !== '' ? name : trimmed(game.statusText);
}

function joinContest(game: Game, tail: string | undefined): string {
  const contest = contestName(game);
  if (tail === undefined || tail === '') return contest;
  return contest === '' ? tail : `${contest} · ${tail}`;
}

function trimmed(value: string | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Tree/settings key for a league (CONTRACT §2: `${providerId}:${leagueId}`). */
export function leagueKey(providerId: string, leagueId: string): string {
  return `${providerId}:${leagueId}`;
}
