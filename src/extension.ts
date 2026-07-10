/**
 * Vibe Stealth — activation entry point (CONTRACT §6, §9).
 *
 * Activation is synchronous and never awaits the network: the follow restore and the
 * first scoreboard load are kicked off fire-and-forget with `.catch` → diagnostics.
 * Every disposable lands in `context.subscriptions`; `deactivate` stops all pollers and
 * flushes the debounced follow-state save.
 */

import * as vscode from 'vscode';
import { IDS, type ProviderContext } from './core/contract';
import { createFetchJson } from './core/http';
import { createSemaphore } from './core/poller';
import { registerCommands } from './ui/commands';
import { Diagnostics } from './ui/diagnostics';
import { FollowManager } from './ui/followManager';
import { GamesTreeProvider, type TreeNode } from './ui/gamesTree';
import { LogoCache } from './ui/logoCache';
import { RelayChannel } from './ui/relayChannel';
import { affectsVibeStealth, readSettings } from './ui/settings';
import { StatusBar } from './ui/statusBar';
import { registerUiMessages } from './ui/uiText';

/** CONTRACT §4: one global fetch gate shared by the pollers and the scoreboard fan-out. */
const MAX_CONCURRENT_FETCHES = 4;

let followManager: FollowManager | undefined;

export function activate(context: vscode.ExtensionContext): void {
  registerUiMessages();

  const diag = new Diagnostics();
  const relay = new RelayChannel();
  context.subscriptions.push(diag, relay);

  const fetchJson = createFetchJson({
    version: extensionVersion(context),
    log: (message) => diag.log(`[http] ${message}`),
  });

  // ONE ProviderContext for the whole extension. `locale` is a getter so a settings
  // change reaches providers without rebuilding the object.
  const ctx: ProviderContext = {
    get locale() {
      return readSettings().locale;
    },
    // Getter: a gameState toggle takes effect on the next poll without a reload (CONTRACT §11.2).
    get gameStateEnabled() {
      return readSettings().gameStateEnabled;
    },
    // Getter: a detail change takes effect on the next poll (CONTRACT §12.7).
    get detail() {
      return readSettings().detail;
    },
    fetchJson,
    // `secrets.get` returns a Thenable; ProviderContext pins a Promise.
    getSecret: async (key) => context.secrets.get(key),
    log: (message) => diag.log(message),
    now: () => Date.now(),
  };

  const semaphore = createSemaphore(MAX_CONCURRENT_FETCHES);
  const follow = new FollowManager(context, relay, diag, ctx, semaphore);

  // CONTRACT §13: the ONLY place that fetches logo images. Cache files live under
  // globalStorageUri/logos. Activation never awaits the warm — it is fire-and-forget.
  const logos = new LogoCache({
    cacheDir: vscode.Uri.joinPath(context.globalStorageUri, 'logos').fsPath,
    log: (message) => diag.log(`[logos] ${message}`),
  });
  context.subscriptions.push(logos);
  void logos.warmFromDisk().catch((err) => diag.error('logos.warm', err));

  const tree = new GamesTreeProvider(ctx, semaphore, follow, diag, logos);
  const statusBar = new StatusBar(follow);
  context.subscriptions.push(follow, tree, statusBar);
  followManager = follow;

  const view = vscode.window.createTreeView<TreeNode>(IDS.gamesView, {
    treeDataProvider: tree,
    showCollapseAll: true,
  });
  context.subscriptions.push(view);
  tree.attach(view);

  context.subscriptions.push(
    follow.onDidChange(() => {
      statusBar.update();
      tree.scheduleRerender();
    }),
  );

  // CONTRACT §6: a provider gated on a secret appears/disappears as the secret changes.
  context.subscriptions.push(
    context.secrets.onDidChange((e) => {
      if (e.key !== IDS.secrets.pandascoreToken) return;
      follow.clearProviderBlocks();
      void tree.refresh().catch((err) => diag.error('secrets.refresh', err));
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!affectsVibeStealth(e)) return;
      statusBar.update();
      if (e.affectsConfiguration(IDS.settings.pollSecondsScoreboard)) tree.rescheduleAuto();
      if (e.affectsConfiguration(IDS.settings.enabledLeagues)) {
        void tree.refresh().catch((err) => diag.error('config.refresh', err));
      } else {
        tree.scheduleRerender();
      }
    }),
  );

  context.subscriptions.push(...registerCommands({ context, follow, tree, relay, diag }));

  statusBar.update();

  void follow
    .restore()
    .then(() => statusBar.update())
    .catch((err) => diag.error('restore', err));
  void tree.refresh().catch((err) => diag.error('initialRefresh', err));
}

export async function deactivate(): Promise<void> {
  const follow = followManager;
  followManager = undefined;
  if (!follow) return;
  try {
    follow.stopAll();
    await follow.flush();
  } catch {
    // Diagnostics may already be disposed; a failing shutdown must stay silent.
  }
}

function extensionVersion(context: vscode.ExtensionContext): string {
  const version: unknown = context.extension.packageJSON?.version;
  return typeof version === 'string' && version !== '' ? version : '0.0.0';
}
