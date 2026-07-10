/**
 * Settings reader. Every numeric setting follows the CONTRACT §4 rule
 * (`Math.round(Number(v))`, NaN ⇒ default, then clamp) via `clampInt`.
 * Users can hand-edit settings.json, so every value is treated as hostile input.
 */

import * as vscode from 'vscode';
import { IDS, type DetailLevel, type RelayLocale } from '../core/contract';
import { clampInt } from '../core/util';
import { resolveLocale } from '../core/i18n';

export interface UiSettings {
  locale: RelayLocale;
  /** Clamped 10–120, default 20. */
  pollSecondsLive: number;
  /** Clamped 30–600, default 60. */
  pollSecondsScoreboard: number;
  /** Clamped 0–100, default 10. */
  backfillLimit: number;
  /** Clamped 1–12, default 6. */
  maxFollowedGames: number;
  statusBarEnabled: boolean;
  showEmoji: boolean;
  /** Default true — render live current-state child rows under a followed game. */
  gameStateEnabled: boolean;
  /** 'summary' (default) | 'detailed' — CONTRACT §12 relay granularity. */
  detail: DetailLevel;
  /** Default true — render real team/league logos on tree rows (CONTRACT §13). */
  logosEnabled: boolean;
  /** `${providerId}:${leagueId}` keys. undefined ⇒ the built-in default set applies. */
  enabledLeagues: string[] | undefined;
}

const LOCALE_CHOICES = new Set(['auto', 'en', 'ko']);
const DETAIL_CHOICES = new Set<DetailLevel>(['summary', 'detailed']);

export function readSettings(): UiSettings {
  const c = vscode.workspace.getConfiguration();

  const rawLocale = c.get(IDS.settings.locale);
  const localeChoice = typeof rawLocale === 'string' && LOCALE_CHOICES.has(rawLocale) ? rawLocale : 'auto';

  const rawDetail = c.get(IDS.settings.detail);
  const detail: DetailLevel =
    typeof rawDetail === 'string' && DETAIL_CHOICES.has(rawDetail as DetailLevel) ? (rawDetail as DetailLevel) : 'summary';

  const rawLeagues = c.get(IDS.settings.enabledLeagues);
  const leagues = Array.isArray(rawLeagues)
    ? rawLeagues
        .filter((v): v is string => typeof v === 'string' && v.trim() !== '')
        .map((v) => v.trim())
    : [];

  return {
    locale: resolveLocale(localeChoice, vscode.env.language),
    pollSecondsLive: clampInt(c.get(IDS.settings.pollSecondsLive), 10, 120, 20),
    pollSecondsScoreboard: clampInt(c.get(IDS.settings.pollSecondsScoreboard), 30, 600, 60),
    backfillLimit: clampInt(c.get(IDS.settings.backfillLimit), 0, 100, 10),
    maxFollowedGames: clampInt(c.get(IDS.settings.maxFollowedGames), 1, 12, 6),
    statusBarEnabled: c.get(IDS.settings.statusBarEnabled) !== false,
    showEmoji: c.get(IDS.settings.relayShowEmoji) !== false,
    gameStateEnabled: c.get(IDS.settings.gameStateEnabled) !== false,
    logosEnabled: c.get(IDS.settings.logosEnabled) !== false,
    detail,
    enabledLeagues: leagues.length > 0 ? leagues : undefined,
  };
}

/** True when a configuration change touched any Vibe Stealth setting. */
export function affectsVibeStealth(e: vscode.ConfigurationChangeEvent): boolean {
  return Object.values(IDS.settings).some((key) => e.affectsConfiguration(key));
}
