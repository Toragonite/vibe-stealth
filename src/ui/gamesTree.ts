/**
 * The 'vibeStealth.games' tree: pinned Following section → Provider → League → Game.
 *
 * CONTRACT pins implemented here:
 *  §4  scoreboard refresh fans out per enabled league through the shared semaphore;
 *      one league failing renders an inline error node while the others render
 *      normally; the auto-refresh loop runs ONLY while the view is visible, and the
 *      manual refresh command always works.
 *  §6  followed games get a `$(star-full)` icon and a pinned 'Following' root section;
 *      empty league ⇒ one 'no games' child; providers whose `requiresSecret` secret is
 *      unset are omitted entirely.
 *  §7  a throw inside a refresh or a `getChildren` never escapes to the extension host.
 */

import * as vscode from 'vscode';
import {
  IDS,
  ProviderError,
  type DraftPick,
  type Game,
  type GameState,
  type League,
  type LineupSpot,
  type ProviderContext,
  type ProviderErrorKind,
  type RelayLocale,
  type Semaphore,
  type SportProvider,
} from '../core/contract';
import { t } from '../core/i18n';
import { DEFAULT_LEAGUE_KEYS, getProviders } from '../providers';
import { Diagnostics } from './diagnostics';
import { gameLabel, gameTitle, leagueKey, scoreText } from './display';
import type { FollowManager } from './followManager';
import type { LogoCache } from './logoCache';
import { readSettings, type UiSettings } from './settings';
import { K } from './uiText';

/** Coalesces the burst of tree invalidations a multi-game relay produces. */
const RERENDER_DEBOUNCE_MS = 250;

export type TreeNode =
  | { kind: 'following' }
  | { kind: 'provider'; provider: SportProvider }
  | { kind: 'league'; provider: SportProvider; league: League; key: string }
  | { kind: 'game'; game: Game; key: string }
  | { kind: 'followEntry'; gameId: string }
  // CONTRACT §11.6 live-state child rows under a followed game.
  | { kind: 'stateRow'; id: string; text: string; description?: string }
  | { kind: 'lineup'; id: string; label: string; spots: LineupSpot[] }
  | { kind: 'draft'; id: string; label: string; picks: DraftPick[] }
  | { kind: 'message'; key: string; text: string; icon: string | undefined };

interface LeagueTarget {
  provider: SportProvider;
  league: League;
  key: string;
}

type LeagueResult = { games: Game[] } | { error: string };

export class GamesTreeProvider implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  /** Providers whose secret requirement (if any) is satisfied right now. */
  private providers: SportProvider[] = [];
  private readonly leagues = new Map<string, League[]>();
  private readonly board = new Map<string, LeagueResult>();

  private readonly disposables: vscode.Disposable[] = [];
  private inFlight: Promise<void> | undefined;
  private loaded = false;
  private visible = false;
  private lastRefreshAt = 0;
  private autoTimer: ReturnType<typeof setTimeout> | undefined;
  private rerenderTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(
    private readonly ctx: ProviderContext,
    private readonly semaphore: Semaphore,
    private readonly follow: FollowManager,
    private readonly diag: Diagnostics,
    private readonly logos: LogoCache,
  ) {
    // CONTRACT §13.5: a landed logo download repaints its row. Reuses the same
    // cache-only rerender path the follow manager fires — never touches the network.
    this.disposables.push(this.logos.onDidChange(() => this.scheduleRerender()));
  }

  // -------------------------------------------------------------------------
  // View lifecycle
  // -------------------------------------------------------------------------

  attach(view: vscode.TreeView<TreeNode>): void {
    this.visible = view.visible;
    this.disposables.push(
      view.onDidChangeVisibility((e) => {
        this.visible = e.visible;
        if (!e.visible) {
          this.clearAutoTimer();
          return;
        }
        if (Date.now() - this.lastRefreshAt >= this.intervalMs()) {
          void this.refresh();
        }
        this.scheduleAuto();
      }),
    );
    if (this.visible) this.scheduleAuto();
  }

  private intervalMs(): number {
    return readSettings().pollSecondsScoreboard * 1000;
  }

  /** CONTRACT §4: the scoreboard loop only ticks while the view is visible. */
  private scheduleAuto(): void {
    this.clearAutoTimer();
    if (!this.visible || this.disposed) return;
    this.autoTimer = setTimeout(() => {
      this.autoTimer = undefined;
      void this.refresh().finally(() => this.scheduleAuto());
    }, this.intervalMs());
  }

  private clearAutoTimer(): void {
    if (this.autoTimer === undefined) return;
    clearTimeout(this.autoTimer);
    this.autoTimer = undefined;
  }

  /** Called when `pollSecondsScoreboard` changes. */
  rescheduleAuto(): void {
    this.scheduleAuto();
  }

  /** Redraw from cache — no network. Used for follow changes and locale changes. */
  scheduleRerender(): void {
    if (this.rerenderTimer !== undefined || this.disposed) return;
    this.rerenderTimer = setTimeout(() => {
      this.rerenderTimer = undefined;
      this.emitter.fire(undefined);
    }, RERENDER_DEBOUNCE_MS);
  }

  dispose(): void {
    this.disposed = true;
    this.clearAutoTimer();
    if (this.rerenderTimer !== undefined) clearTimeout(this.rerenderTimer);
    for (const d of this.disposables) d.dispose();
    this.emitter.dispose();
  }

  // -------------------------------------------------------------------------
  // Data loading
  // -------------------------------------------------------------------------

  /** Never rejects: a failed refresh renders as error nodes, not as a broken tree. */
  refresh(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.doRefresh().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  async ensureLoaded(): Promise<void> {
    if (!this.loaded) await this.refresh();
  }

  private async doRefresh(): Promise<void> {
    try {
      const settings = readSettings();
      this.providers = await this.availableProviders();
      await this.loadLeagues();

      const targets = this.enabledLeagues(settings);
      await Promise.all(targets.map((target) => this.loadLeagueGames(target, settings.locale)));

      // Drop cache entries for leagues no longer enabled/visible.
      const live = new Set(targets.map((target) => target.key));
      for (const key of [...this.board.keys()]) {
        if (!live.has(key)) this.board.delete(key);
      }
      this.lastRefreshAt = Date.now();
    } catch (err) {
      this.diag.error('tree.refresh', err);
    } finally {
      this.loaded = true;
      this.emitter.fire(undefined);
    }
  }

  private async loadLeagueGames(target: LeagueTarget, locale: RelayLocale): Promise<void> {
    const release = await this.semaphore.acquire();
    try {
      const games = await target.provider.listGames(this.ctx, target.league);
      this.board.set(target.key, { games: Array.isArray(games) ? games : [] });
    } catch (err) {
      this.diag.error(`listGames:${target.key}`, err);
      this.board.set(target.key, { error: leagueErrorMessage(err, target.provider, locale) });
    } finally {
      release();
    }
  }

  /** CONTRACT §6: a provider with an unset required secret is omitted entirely. */
  private async availableProviders(): Promise<SportProvider[]> {
    const out: SportProvider[] = [];
    for (const provider of getProviders()) {
      if (!provider.requiresSecret) {
        out.push(provider);
        continue;
      }
      try {
        const secret = await this.ctx.getSecret(provider.requiresSecret);
        if (secret && secret.trim() !== '') out.push(provider);
      } catch (err) {
        this.diag.error(`secret:${provider.id}`, err);
      }
    }
    return out;
  }

  private async loadLeagues(): Promise<void> {
    await Promise.all(
      this.providers.map(async (provider) => {
        try {
          this.leagues.set(provider.id, await provider.listLeagues(this.ctx));
        } catch (err) {
          this.diag.error(`listLeagues:${provider.id}`, err);
          if (!this.leagues.has(provider.id)) this.leagues.set(provider.id, []);
        }
      }),
    );
  }

  /**
   * CONTRACT §6: the tree shows the leagues named by `vibeStealth.leagues.enabled`;
   * an empty array means DEFAULT_LEAGUE_KEYS.
   *
   * DEFAULT_LEAGUE_KEYS covers only key-free providers (CONTRACT §9), so a secret-gated
   * provider can never appear in it. Applying the default set literally to PandaScore
   * would leave it with zero enabled leagues the moment its secret is set — the provider
   * would be dropped and `setPandascoreToken` would do nothing visible. When the setting
   * is at its default, a secret-gated provider that is visible has all of its leagues on.
   * An explicit setting is always honoured verbatim.
   */
  private enabledLeagues(settings: UiSettings): LeagueTarget[] {
    const explicit = settings.enabledLeagues ? new Set(settings.enabledLeagues) : undefined;
    const defaults = new Set(DEFAULT_LEAGUE_KEYS);
    const out: LeagueTarget[] = [];
    for (const provider of this.providers) {
      for (const league of this.leagues.get(provider.id) ?? []) {
        const key = leagueKey(provider.id, league.id);
        const enabled = explicit ? explicit.has(key) : provider.requiresSecret !== undefined || defaults.has(key);
        if (enabled) out.push({ provider, league, key });
      }
    }
    return out;
  }

  /** Today's games across the enabled leagues — the palette follow QuickPick source. */
  allGames(): Game[] {
    const out: Game[] = [];
    for (const target of this.enabledLeagues(readSettings())) {
      const result = this.board.get(target.key);
      if (result && !('error' in result)) out.push(...result.games);
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // TreeDataProvider
  // -------------------------------------------------------------------------

  async getChildren(node?: TreeNode): Promise<TreeNode[]> {
    try {
      if (!node) {
        await this.ensureLoaded();
        return this.rootNodes();
      }
      switch (node.kind) {
        case 'following':
          return this.follow
            .list()
            .map((entry): TreeNode => ({ kind: 'followEntry', gameId: entry.state.gameId }));
        case 'provider':
          return this.enabledLeagues(readSettings())
            .filter((target) => target.provider.id === node.provider.id)
            .map((target): TreeNode => ({ kind: 'league', ...target }));
        case 'league':
          return this.leagueChildren(node.key);
        case 'followEntry':
          return this.stateChildNodes(node.gameId, readSettings().locale);
        case 'lineup':
          return lineupSpotRows(node.id, node.spots);
        case 'draft':
          return draftPickRows(node.id, node.picks);
        default:
          return [];
      }
    } catch (err) {
      this.diag.error('tree.getChildren', err);
      return [];
    }
  }

  private rootNodes(): TreeNode[] {
    const out: TreeNode[] = [];
    if (this.follow.list().length > 0) out.push({ kind: 'following' });
    const enabled = this.enabledLeagues(readSettings());
    for (const provider of this.providers) {
      if (enabled.some((target) => target.provider.id === provider.id)) {
        out.push({ kind: 'provider', provider });
      }
    }
    return out;
  }

  private leagueChildren(key: string): TreeNode[] {
    const locale = readSettings().locale;
    const result = this.board.get(key);
    if (!result) {
      return [{ kind: 'message', key: `loading:${key}`, text: t(locale, K.loading), icon: 'loading~spin' }];
    }
    if ('error' in result) {
      return [{ kind: 'message', key: `error:${key}`, text: result.error, icon: 'error' }];
    }
    if (result.games.length === 0) {
      return [{ kind: 'message', key: `empty:${key}`, text: t(locale, K.noGames), icon: undefined }];
    }
    return result.games.map((game): TreeNode => ({ kind: 'game', game, key }));
  }

  /**
   * CONTRACT §11.6: the live-state child rows of a followed game. Empty when the
   * `gameState.enabled` setting is off, the entry has no state (pre/post, wrong sport),
   * or the game is not followed — non-followed games NEVER show state. Never throws.
   */
  private stateChildNodes(gameId: string, locale: RelayLocale): TreeNode[] {
    if (!readSettings().gameStateEnabled) return [];
    const entry = this.follow.get(gameId);
    if (!entry || !entry.liveState) return [];
    try {
      return buildStateNodes(entry.liveState, entry.game, gameId, locale);
    } catch (err) {
      this.diag.error('tree.stateChildren', err);
      return [];
    }
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    const locale = readSettings().locale;
    switch (node.kind) {
      case 'following': {
        const item = new vscode.TreeItem(t(locale, K.following), vscode.TreeItemCollapsibleState.Expanded);
        item.id = 'section:following';
        item.contextValue = 'followingSection';
        item.iconPath = new vscode.ThemeIcon('star-full');
        return item;
      }
      case 'provider': {
        const item = new vscode.TreeItem(
          node.provider.displayName,
          vscode.TreeItemCollapsibleState.Expanded,
        );
        item.id = `provider:${node.provider.id}`;
        item.contextValue = 'provider';
        return item;
      }
      case 'league': {
        const item = new vscode.TreeItem(node.league.name, vscode.TreeItemCollapsibleState.Collapsed);
        item.id = `league:${node.key}`;
        item.contextValue = 'league';
        const result = this.board.get(node.key);
        if (result && !('error' in result) && result.games.length > 0) {
          item.description = String(result.games.length);
        }
        // CONTRACT §13.5: the league logo on a hit; today's icon on a miss/disabled.
        this.applyLogo(item, () => (node.league.logo ? this.logos.resolve(node.league.logo) : undefined));
        return item;
      }
      case 'game': {
        const item = this.gameItem(node.game, `game:${node.key}:${node.game.id}`, locale);
        // A plain left-click follows the game and opens the relay — the robust path
        // when a fork's tree context menu / inline hover icons don't cooperate.
        item.command = {
          command: IDS.commands.followGame,
          title: 'Follow',
          arguments: [node],
        };
        return item;
      }
      case 'followEntry': {
        const entry = this.follow.get(node.gameId);
        if (!entry) {
          const item = new vscode.TreeItem(node.gameId, vscode.TreeItemCollapsibleState.None);
          item.id = `follow:${node.gameId}`;
          item.contextValue = 'followedGame';
          return item;
        }
        const item = this.gameItem(entry.game, `follow:${node.gameId}`, locale, true);
        // CONTRACT §11.6: a followed game carrying live state becomes collapsible; a leaf otherwise.
        if (this.stateChildNodes(node.gameId, locale).length > 0) {
          item.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
        }
        // Already followed — a click just re-opens the relay.
        item.command = { command: IDS.commands.followGame, title: 'Open relay', arguments: [node] };
        return item;
      }
      case 'stateRow': {
        const item = new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
        item.id = node.id;
        item.contextValue = 'stateRow';
        if (node.description) item.description = node.description;
        return item;
      }
      case 'lineup':
      case 'draft': {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Collapsed);
        item.id = node.id;
        item.contextValue = node.kind;
        return item;
      }
      case 'message': {
        const item = new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
        item.id = `msg:${node.key}`;
        item.contextValue = 'message';
        if (node.icon) item.iconPath = new vscode.ThemeIcon(node.icon);
        return item;
      }
    }
  }

  private gameItem(game: Game, id: string, locale: RelayLocale, forceFollowed = false): vscode.TreeItem {
    const followed = forceFollowed || this.follow.isFollowed(game.id);
    const item = new vscode.TreeItem(gameLabel(game), vscode.TreeItemCollapsibleState.None);
    item.id = id;
    item.description = game.statusText;
    // Drives the inline follow/unfollow menu items pinned in package.json.
    item.contextValue = followed ? 'followedGame' : 'game';
    if (followed) item.iconPath = new vscode.ThemeIcon('star-full');
    // CONTRACT §13.5 / §13.4b: the HOME crest fills the one 16px icon slot — for followed
    // games too (the pinned Following section + contextValue already convey follow state).
    // Two crests in one 16px square render at ~7-10px each; the away team is in the row's
    // label and tooltip instead. On a miss/disabled the star (followed) or default stays.
    this.applyLogo(item, () => (game.home.logo ? this.logos.resolve(game.home.logo) : undefined));
    item.tooltip = gameTooltip(game, locale);
    return item;
  }

  /**
   * CONTRACT §13.5 / §7: set `iconPath` to the resolved logo ONLY on a synchronous cache
   * hit; a miss, a disabled setting, or any throw leaves today's icon untouched. Never
   * awaits the network — the cache resolvers are synchronous and best-effort; a background
   * download for a miss fires `onDidChange`, which repaints the row.
   *
   * `resolve` is the SINGLE owner of the `logosEnabled` gate + try/catch, so the league and
   * game call sites cannot drift apart.
   */
  private applyLogo(
    item: vscode.TreeItem,
    resolve: () => { light: vscode.Uri; dark: vscode.Uri } | undefined,
  ): void {
    if (!readSettings().logosEnabled) return;
    try {
      const resolved = resolve();
      if (resolved) item.iconPath = { light: resolved.light, dark: resolved.dark };
    } catch (err) {
      this.diag.error('tree.logo', err);
    }
  }
}

// ---------------------------------------------------------------------------
// Live "current state" tree rows (CONTRACT §11.6)
// ---------------------------------------------------------------------------

/**
 * Builds the top-level state child rows for one followed game. Each row is added inside
 * its own guard so a single malformed field degrades to fewer rows, never a throw (§11.6/§7).
 * `lineup`/`draft` nodes carry their raw spots/picks and expand lazily via getChildren.
 */
function buildStateNodes(state: GameState, game: Game, gameId: string, locale: RelayLocale): TreeNode[] {
  const out: TreeNode[] = [];
  const base = `state:${gameId}`;
  const add = (fn: () => TreeNode | undefined): void => {
    try {
      const node = fn();
      if (node) out.push(node);
    } catch {
      // A malformed field drops just this row (§11.6) — the rest still render.
    }
  };

  switch (state.kind) {
    case 'baseball':
      buildBaseballNodes(state, game, base, locale, add);
      break;
    case 'soccer':
      buildSoccerNodes(state, game, base, locale, add);
      break;
    case 'esports':
      buildEsportsNodes(state, base, locale, add);
      break;
  }
  return out;
}

function buildBaseballNodes(
  state: Extract<GameState, { kind: 'baseball' }>,
  game: Game,
  base: string,
  locale: RelayLocale,
  add: (fn: () => TreeNode | undefined) => void,
): void {
  // Count / outs.
  add(() => ({
    kind: 'stateRow',
    id: `${base}:count`,
    text: t(locale, K.stateCount),
    description: `${state.balls}-${state.strikes} · ${t(locale, K.stateOut, { n: state.outs })}`,
  }));

  // Occupied bases only — omit the row entirely when nobody is on.
  add(() => {
    const parts: string[] = [];
    if (state.bases.first) parts.push(`1B ${state.bases.first}`);
    if (state.bases.second) parts.push(`2B ${state.bases.second}`);
    if (state.bases.third) parts.push(`3B ${state.bases.third}`);
    if (parts.length === 0) return undefined;
    return { kind: 'stateRow', id: `${base}:bases`, text: t(locale, K.stateBases), description: parts.join(' · ') };
  });

  add(() =>
    state.atBat ? { kind: 'stateRow', id: `${base}:atbat`, text: t(locale, K.stateAtBat), description: state.atBat } : undefined,
  );
  add(() =>
    state.pitcher
      ? { kind: 'stateRow', id: `${base}:pitcher`, text: t(locale, K.statePitcher), description: state.pitcher }
      : undefined,
  );

  // A collapsible 라인업 node per team (skip a side whose order isn't posted yet).
  add(() =>
    state.lineups.away.length > 0
      ? { kind: 'lineup', id: `${base}:lineup:away`, label: `${t(locale, K.stateLineup)} · ${game.away.abbrev}`, spots: state.lineups.away }
      : undefined,
  );
  add(() =>
    state.lineups.home.length > 0
      ? { kind: 'lineup', id: `${base}:lineup:home`, label: `${t(locale, K.stateLineup)} · ${game.home.abbrev}`, spots: state.lineups.home }
      : undefined,
  );
}

function buildSoccerNodes(
  state: Extract<GameState, { kind: 'soccer' }>,
  game: Game,
  base: string,
  locale: RelayLocale,
  add: (fn: () => TreeNode | undefined) => void,
): void {
  const sides = [
    { key: 'away', side: state.away, abbrev: game.away.abbrev },
    { key: 'home', side: state.home, abbrev: game.home.abbrev },
  ] as const;
  for (const { key, side, abbrev } of sides) {
    add(() =>
      side.formation
        ? { kind: 'stateRow', id: `${base}:formation:${key}`, text: `${t(locale, K.stateFormation)} · ${abbrev}`, description: side.formation }
        : undefined,
    );
    add(() =>
      side.starters.length > 0
        ? { kind: 'lineup', id: `${base}:xi:${key}`, label: `${t(locale, K.stateStarters)} · ${abbrev}`, spots: side.starters }
        : undefined,
    );
  }
}

function buildEsportsNodes(
  state: Extract<GameState, { kind: 'esports' }>,
  base: string,
  locale: RelayLocale,
  add: (fn: () => TreeNode | undefined) => void,
): void {
  add(() =>
    state.blue.picks.length > 0
      ? { kind: 'draft', id: `${base}:blue`, label: draftSideLabel(t(locale, K.stateBlue), state.blue.teamCode), picks: state.blue.picks }
      : undefined,
  );
  add(() =>
    state.red.picks.length > 0
      ? { kind: 'draft', id: `${base}:red`, label: draftSideLabel(t(locale, K.stateRed), state.red.teamCode), picks: state.red.picks }
      : undefined,
  );
  add(() => (state.patch ? { kind: 'stateRow', id: `${base}:patch`, text: t(locale, K.statePatch), description: state.patch } : undefined));
  add(() =>
    state.gold
      ? { kind: 'stateRow', id: `${base}:gold`, text: t(locale, K.stateGold), description: `${state.gold.blue} · ${state.gold.red}` }
      : undefined,
  );
}

/** The 5 spots under a baseball 라인업 / soccer 선발 node. Each row guarded independently. */
function lineupSpotRows(parentId: string, spots: LineupSpot[]): TreeNode[] {
  const out: TreeNode[] = [];
  spots.forEach((spot, i) => {
    try {
      out.push({ kind: 'stateRow', id: `${parentId}:${i}`, text: formatSpot(spot) });
    } catch {
      // Skip a malformed spot rather than break the lineup.
    }
  });
  return out;
}

/** The 5 picks under a blue/red draft node. */
function draftPickRows(parentId: string, picks: DraftPick[]): TreeNode[] {
  const out: TreeNode[] = [];
  picks.forEach((pick, i) => {
    try {
      out.push({ kind: 'stateRow', id: `${parentId}:${i}`, text: formatPick(pick) });
    } catch {
      // Skip a malformed pick rather than break the draft.
    }
  });
  return out;
}

/** '{order} {position} {name}', dropping empty parts so a missing position leaves no gap. */
function formatSpot(spot: LineupSpot): string {
  return [String(spot.order), spot.position, spot.name].map((p) => p.trim()).filter((p) => p !== '').join(' ');
}

/** '{role} {champion} ({player})', omitting an unknown role or player. */
function formatPick(pick: DraftPick): string {
  const head = [pick.role, pick.champion].map((p) => p.trim()).filter((p) => p !== '').join(' ');
  return pick.player.trim() !== '' ? `${head} (${pick.player.trim()})` : head;
}

function draftSideLabel(sideName: string, teamCode: string): string {
  return teamCode.trim() !== '' ? `${sideName} · ${teamCode}` : sideName;
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

function gameTooltip(game: Game, locale: RelayLocale): string {
  const lines = [
    gameTitle(game),
    `${game.leagueName} · ${scoreText(game.away.score)}:${scoreText(game.home.score)}`,
    game.statusText,
  ];
  if (game.phase === 'pre' && game.startTimeUtc) {
    const start = new Date(game.startTimeUtc);
    if (!Number.isNaN(start.getTime())) {
      const time = start.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
      lines.push(t(locale, K.startsAt, { time }));
    }
  }
  return lines.join('\n');
}

function errorKind(err: unknown): ProviderErrorKind | undefined {
  if (err instanceof ProviderError) return err.kind;
  // Defensive: survives a duplicated module instance where `instanceof` fails.
  if (err && typeof err === 'object' && (err as { name?: unknown }).name === 'ProviderError') {
    const kind = (err as { kind?: unknown }).kind;
    if (typeof kind === 'string') return kind as ProviderErrorKind;
  }
  return undefined;
}

/**
 * CONTRACT §4: a 403 from a key-free provider is transient, not a credentials problem —
 * only a secret-gated provider may tell the user to set a token.
 */
export function leagueErrorMessage(err: unknown, provider: SportProvider, locale: RelayLocale): string {
  const kind = errorKind(err);
  if (kind === 'auth') {
    return t(locale, provider.requiresSecret ? K.errAuthSecret : K.errAuthKeyFree);
  }
  return t(locale, kind ? `ui.error.${kind}` : K.errUnknown);
}
