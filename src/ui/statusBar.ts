/**
 * Compact score item (CONTRACT §5 text format, §6 placement and selection rules).
 * Right side, priority 90, hidden when nothing is followed or the setting is off.
 */

import * as vscode from 'vscode';
import { IDS, type RelayLocale } from '../core/contract';
import { formatStatusBar } from '../core/format';
import { t } from '../core/i18n';
import { scoreText } from './display';
import type { FollowEntry, FollowManager } from './followManager';
import { readSettings } from './settings';
import { K } from './uiText';

/** CONTRACT §6: a finished game keeps the bar for ten more minutes. */
const LAME_DUCK_MS = 10 * 60 * 1000;

/**
 * CONTRACT §6 selection: scan the follow array from the END through three tiers,
 * first hit wins — (1) live, (2) finished inside the lame-duck window, (3) pre/unknown.
 *
 * The contract does not name a winner when every follow is a finished game whose
 * lame-duck window has closed (a state that only exists between the last emission and
 * the auto-unfollow one-shot, plus right after following an already-final game, where
 * `postObservedAt` is still 0). Falling back to the most recent follow keeps the bar
 * showing something truthful rather than blanking while follows still exist.
 */
export function selectStatusGame(entries: readonly FollowEntry[], now: number): FollowEntry | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry?.game.phase === 'in') return entry;
  }
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (
      entry?.game.phase === 'post' &&
      entry.state.postObservedAt > 0 &&
      now - entry.state.postObservedAt < LAME_DUCK_MS
    ) {
      return entry;
    }
  }
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry?.game.phase === 'pre' || entry?.game.phase === 'unknown') return entry;
  }
  return entries[entries.length - 1];
}

export class StatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;

  constructor(private readonly follow: FollowManager) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
    this.item.name = 'Vibe Stealth';
    this.item.command = IDS.commands.pickFollowed;
  }

  /** Re-evaluated on every emission, every follow change, and on settings change. */
  update(): void {
    const settings = readSettings();
    const entries = this.follow.list();
    if (!settings.statusBarEnabled || entries.length === 0) {
      this.item.hide();
      return;
    }

    const target = selectStatusGame(entries, Date.now());
    if (!target) {
      this.item.hide();
      return;
    }

    const game = target.game;
    this.item.text = formatStatusBar(
      game.away.abbrev,
      game.away.score,
      game.home.score,
      game.home.abbrev,
      game.statusShort,
    );
    this.item.tooltip = buildTooltip(entries, settings.locale);
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }
}

function buildTooltip(entries: readonly FollowEntry[], locale: RelayLocale): string {
  const lines = [t(locale, K.statusBarTooltip)];
  for (const entry of entries) {
    const g = entry.game;
    lines.push(
      `${g.away.name} ${scoreText(g.away.score)}:${scoreText(g.home.score)} ${g.home.name} · ${g.statusText}`,
    );
  }
  lines.push('', t(locale, K.statusBarHint));
  return lines.join('\n');
}
