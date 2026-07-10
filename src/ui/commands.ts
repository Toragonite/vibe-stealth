/**
 * Command handlers. CONTRACT §7: every handler runs inside a catch-all that writes to
 * the diagnostics channel. CONTRACT §6: no modal dialogs — failures surface as a
 * status-bar message pointing at the diagnostics output.
 *
 * `unfollowGame` is hidden from the palette in package.json (tree context only), but the
 * handler still degrades gracefully to the `pickFollowed` picker when invoked bare.
 */

import * as vscode from 'vscode';
import { IDS, type Game } from '../core/contract';
import { t } from '../core/i18n';
import { Diagnostics } from './diagnostics';
import { gameLabel, gameTitle } from './display';
import type { FollowManager } from './followManager';
import type { GamesTreeProvider, TreeNode } from './gamesTree';
import { RelayChannel } from './relayChannel';
import { readSettings } from './settings';
import { K } from './uiText';

const STATUS_MESSAGE_MS = 6_000;

export interface CommandDeps {
  context: vscode.ExtensionContext;
  follow: FollowManager;
  tree: GamesTreeProvider;
  relay: RelayChannel;
  diag: Diagnostics;
}

interface GameQuickPickItem extends vscode.QuickPickItem {
  game: Game;
}

interface FollowedQuickPickItem extends vscode.QuickPickItem {
  gameId: string;
}

export function registerCommands(deps: CommandDeps): vscode.Disposable[] {
  const { context, follow, tree, relay, diag } = deps;

  const message = (key: string, params?: Record<string, string | number>): void => {
    vscode.window.setStatusBarMessage(t(readSettings().locale, key, params), STATUS_MESSAGE_MS);
  };

  const register = (id: string, handler: (...args: unknown[]) => unknown): vscode.Disposable =>
    vscode.commands.registerCommand(id, async (...args: unknown[]) => {
      try {
        await handler(...args);
      } catch (err) {
        diag.error(`command:${id}`, err);
        message(K.commandFailed);
      }
    });

  const refreshGames = async (): Promise<void> => {
    await tree.refresh();
  };

  const followGame = async (arg?: unknown): Promise<void> => {
    // Invoked three ways: from the tree row's click command / inline star (arg = node),
    // and from the Command Palette (arg = undefined → QuickPick).
    const node = asNode(arg);
    const fromTree =
      gameFromNode(node) ??
      (node?.kind === 'followEntry' ? follow.get(node.gameId)?.game : undefined);
    if (fromTree) {
      if (!follow.isFollowed(fromTree.id)) await follow.follow(fromTree);
      relay.show(); // reveal the relay so a click visibly "does something"
      return;
    }

    await tree.ensureLoaded();
    const games = tree.allGames();
    if (games.length === 0) {
      message(K.pickFollowEmpty);
      return;
    }

    const locale = readSettings().locale;
    const items: GameQuickPickItem[] = games.map((game) => ({
      label: follow.isFollowed(game.id) ? `$(star-full) ${gameLabel(game)}` : gameLabel(game),
      description: game.statusText,
      detail: `${game.leagueName} · ${gameTitle(game)}`,
      game,
    }));

    const picked = await vscode.window.showQuickPick(items, {
      title: t(locale, K.pickFollowTitle),
      placeHolder: t(locale, K.pickFollowPlaceholder),
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (picked) {
      if (!follow.isFollowed(picked.game.id)) await follow.follow(picked.game);
      relay.show();
    }
  };

  const openRelay = (): void => {
    relay.show();
  };

  const clearRelay = (): void => {
    relay.clear();
    message(K.relayCleared);
  };

  const pickFollowed = (): void => {
    const entries = follow.list();
    if (entries.length === 0) {
      message(K.pickFollowedEmpty);
      return;
    }

    const locale = readSettings().locale;
    const unfollowButton: vscode.QuickInputButton = {
      iconPath: new vscode.ThemeIcon('star-full'),
      tooltip: t(locale, K.pickFollowedUnfollow),
    };

    const picker = vscode.window.createQuickPick<FollowedQuickPickItem>();
    picker.title = t(locale, K.pickFollowedTitle);
    picker.placeholder = t(locale, K.pickFollowedPlaceholder);
    picker.matchOnDescription = true;
    picker.items = entries
      .map((entry): FollowedQuickPickItem => ({
        label: gameLabel(entry.game),
        description: entry.game.statusText,
        detail: gameTitle(entry.game),
        buttons: [unfollowButton],
        gameId: entry.state.gameId,
      }))
      .reverse(); // most recently followed first — matches the status-bar scan order

    picker.onDidAccept(() => {
      picker.hide();
      relay.show();
    });
    picker.onDidTriggerItemButton((event) => {
      picker.hide();
      void follow.unfollow(event.item.gameId).catch((err) => diag.error('pickFollowed.unfollow', err));
    });
    picker.onDidHide(() => picker.dispose());
    picker.show();
  };

  const unfollowGame = async (arg?: unknown): Promise<void> => {
    const gameId = gameIdFromNode(asNode(arg));
    if (!gameId) {
      pickFollowed();
      return;
    }
    await follow.unfollow(gameId);
  };

  const setPandascoreToken = async (): Promise<void> => {
    const locale = readSettings().locale;
    const value = await vscode.window.showInputBox({
      title: t(locale, K.tokenTitle),
      prompt: t(locale, K.tokenPrompt),
      placeHolder: t(locale, K.tokenPlaceholder),
      password: true,
      ignoreFocusOut: true,
    });
    if (value === undefined) return; // cancelled

    const token = value.trim();
    if (token === '') {
      await context.secrets.delete(IDS.secrets.pandascoreToken);
      message(K.tokenCleared);
    } else {
      await context.secrets.store(IDS.secrets.pandascoreToken, token);
      message(K.tokenSaved);
    }
    await tree.refresh();
  };

  return [
    register(IDS.commands.refreshGames, refreshGames),
    register(IDS.commands.followGame, (arg) => followGame(arg)),
    register(IDS.commands.unfollowGame, (arg) => unfollowGame(arg)),
    register(IDS.commands.openRelay, openRelay),
    register(IDS.commands.clearRelay, clearRelay),
    register(IDS.commands.pickFollowed, pickFollowed),
    register(IDS.commands.setPandascoreToken, setPandascoreToken),
  ];
}

// ---------------------------------------------------------------------------
// Tree-argument narrowing — VS Code hands the tree element to context-menu commands.
// ---------------------------------------------------------------------------

function asNode(arg: unknown): TreeNode | undefined {
  if (arg && typeof arg === 'object' && typeof (arg as { kind?: unknown }).kind === 'string') {
    return arg as TreeNode;
  }
  return undefined;
}

function gameFromNode(node: TreeNode | undefined): Game | undefined {
  return node?.kind === 'game' ? node.game : undefined;
}

function gameIdFromNode(node: TreeNode | undefined): string | undefined {
  if (!node) return undefined;
  if (node.kind === 'game') return node.game.id;
  if (node.kind === 'followEntry') return node.gameId;
  return undefined;
}
