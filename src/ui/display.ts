/**
 * Shared display helpers for the UI layer. Score rendering matches CONTRACT §5/§6:
 * an undefined score renders as an en dash, never 'NaN' / 'undefined' / '0'.
 */

import type { Game } from '../core/contract';

/** U+2013 EN DASH — the pinned placeholder for an unknown score. */
export const EN_DASH = '–';

export function scoreText(score: number | undefined): string {
  return score === undefined ? EN_DASH : String(score);
}

/** CONTRACT §6 game label: `{away.abbrev} {as}:{hs} {home.abbrev}`. */
export function gameLabel(game: Game): string {
  return `${game.away.abbrev} ${scoreText(game.away.score)}:${scoreText(game.home.score)} ${game.home.abbrev}`;
}

/** Human title used in relay system lines and tooltips. */
export function gameTitle(game: Game): string {
  return `${game.away.name} vs ${game.home.name}`;
}

/** Tree/settings key for a league (CONTRACT §2: `${providerId}:${leagueId}`). */
export function leagueKey(providerId: string, leagueId: string): string {
  return `${providerId}:${leagueId}`;
}
