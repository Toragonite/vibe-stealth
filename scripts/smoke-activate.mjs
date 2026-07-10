// Headless smoke test of the UI layer: stubs the `vscode` module, calls the real
// activate(), renders the tree, follows a live game, and prints the relay lines.
// The UI layer ships without unit tests, so this drives it end-to-end instead.
// Run: node scripts/smoke-activate.mjs [--follow <substring of game label>]
import { createRequire } from 'module';
import Module from 'module';
const require = createRequire(import.meta.url);

const argFollow = process.argv.includes('--follow')
  ? process.argv[process.argv.indexOf('--follow') + 1]
  : undefined;

// ---- vscode stub -----------------------------------------------------------
const disposables = [];
const commands = new Map();
const relay = [];
const diag = [];
const memento = new Map();
const secrets = new Map();
let statusBar = null;
let treeProvider = null;
const configDefaults = {
  'vibeStealth.locale': 'ko',
  'vibeStealth.pollSecondsLive': 10,
  'vibeStealth.pollSecondsScoreboard': 60,
  'vibeStealth.backfillLimit': 5,
  'vibeStealth.maxFollowedGames': 6,
  'vibeStealth.statusBar.enabled': true,
  'vibeStealth.relay.showEmoji': true,
  'vibeStealth.leagues.enabled': [],
};

class EventEmitter {
  constructor() { this.listeners = []; }
  get event() { return (fn) => { this.listeners.push(fn); return { dispose() {} }; }; }
  fire(v) { for (const l of this.listeners) l(v); }
  dispose() {}
}
class TreeItem {
  constructor(label, collapsibleState) { this.label = label; this.collapsibleState = collapsibleState; }
}
const channel = (name, sink) => ({
  name, append: (s) => sink.push(s.replace(/\n$/, '')), appendLine: (s) => sink.push(s),
  show() {}, clear() { sink.length = 0; }, dispose() {}, hide() {}, replace() {},
});

const Uri = {
  file: (p) => ({ scheme: 'file', fsPath: p, toString: () => 'file://' + p }),
  joinPath: (u, ...seg) => ({ scheme: 'file', fsPath: [u.fsPath, ...seg].join('/') }),
};
const vscode = {
  Uri,
  EventEmitter, TreeItem, Disposable: { from: (...d) => ({ dispose() {} }) },
  ThemeIcon: class { constructor(id) { this.id = id; } },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  StatusBarAlignment: { Left: 1, Right: 2 },
  env: { language: 'ko' },
  window: {
    createOutputChannel: (name) => channel(name, name.includes('Diagnostics') ? diag : relay),
    createStatusBarItem: () => (statusBar = { text: '', tooltip: '', command: '', show() { this.visible = true; }, hide() { this.visible = false; }, dispose() {} }),
    createTreeView: (id, opts) => { treeProvider = opts.treeDataProvider; return { visible: true, onDidChangeVisibility: () => ({ dispose() {} }), dispose() {} }; },
    registerTreeDataProvider: (id, p) => { treeProvider = p; return { dispose() {} }; },
    setStatusBarMessage: (m) => { diag.push(`[statusMsg] ${m}`); return { dispose() {} }; },
    showQuickPick: async () => undefined,
    showInputBox: async () => undefined,
    createQuickPick: () => ({ items: [], onDidAccept: () => ({ dispose() {} }), onDidHide: () => ({ dispose() {} }), show() {}, hide() {}, dispose() {} }),
  },
  commands: {
    registerCommand: (id, fn) => { commands.set(id, fn); return { dispose() {} }; },
    executeCommand: async (id, ...a) => commands.get(id)?.(...a),
  },
  workspace: {
    getConfiguration: () => ({ get: (k, d) => configDefaults[`vibeStealth.${k}`] ?? configDefaults[k] ?? d }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
  },
};
// getConfiguration('vibeStealth').get('pollSecondsLive') and get('statusBar.enabled') both flow here.
vscode.workspace.getConfiguration = (section) => ({
  get: (key, dflt) => {
    const full = section ? `${section}.${key}` : key;
    return full in configDefaults ? configDefaults[full] : dflt;
  },
});

const origLoad = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === 'vscode') return vscode;
  return origLoad.apply(this, arguments);
};

// ---- fake ExtensionContext -------------------------------------------------
const context = {
  subscriptions: disposables,
  extension: { packageJSON: { version: '0.1.0-smoke' } },
  globalStorageUri: Uri.file(process.env.SMOKE_STORAGE || '/tmp/vibe-smoke-storage'),
  workspaceState: { get: (k, d) => (memento.has(k) ? memento.get(k) : d), update: async (k, v) => void memento.set(k, v), keys: () => [...memento.keys()] },
  globalState: { get: (k, d) => d, update: async () => {}, keys: () => [], setKeysForSync() {} },
  secrets: { get: async (k) => secrets.get(k), store: async (k, v) => void secrets.set(k, v), delete: async (k) => void secrets.delete(k), onDidChange: () => ({ dispose() {} }) },
};

// ---- run -------------------------------------------------------------------
const ext = require('../out/extension.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The tree protocol: getChildren() yields opaque elements, getTreeItem() renders them.
const render = (node) => {
  const it = treeProvider.getTreeItem(node);
  const label = typeof it.label === 'string' ? it.label : (it.label?.label ?? String(it.label));
  const icon = it.iconPath && it.iconPath.light ? require('path').basename(it.iconPath.light.fsPath) : (it.iconPath && it.iconPath.id ? '$(' + it.iconPath.id + ')' : '');
  return { label, desc: it.description ?? '', ctx: it.contextValue, icon };
};

(async () => {
  console.log('→ activate()');
  await ext.activate(context);
  console.log(`  commands registered: ${commands.size}`);
  console.log(`  disposables: ${disposables.length}`);
  if (!treeProvider) throw new Error('no tree data provider registered');

  await sleep(2500); // let the fire-and-forget scoreboard load land

  console.log('\n→ tree: providers');
  const roots = (await treeProvider.getChildren()) ?? [];
  for (const r of roots) console.log(`  ${render(r).label}  (${render(r).ctx})`);

  // Walk provider → league → game, collecting games.
  const games = [];
  for (const r of roots) {
    const leagues = (await treeProvider.getChildren(r)) ?? [];
    for (const lg of leagues) {
      const gs = (await treeProvider.getChildren(lg)) ?? [];
      for (const g of gs) {
        const v = render(g);
        if (v.ctx === 'game' || v.ctx === 'followedGame') games.push({ node: g, view: v, league: render(lg).label, provider: render(r).label });
      }
    }
  }
  console.log(`\n→ tree: ${games.length} game nodes found (first render — logos not downloaded yet)`);
  for (const g of games.slice(0, 6)) console.log(`  [${g.provider}/${g.league}] ${g.view.label}  icon=${g.view.icon || '(none)'}`);

  // §13.5: a logo lands asynchronously, then onDidChange repaints. Re-render to see it.
  await sleep(6000);
  console.log('\n→ same rows after logo downloads landed:');
  for (const g of games.slice(0, 6)) {
    const v = render(g.node);
    console.log(`  [${g.provider}/${g.league}] ${v.label}  icon=${v.icon || '(none)'}`);
  }
  const withIcon = games.filter((g) => render(g.node).icon).length;
  console.log(`  → ${withIcon}/${games.length} game rows now carry a logo`);

  const target = argFollow
    ? games.find((g) => `${g.view.label} ${g.view.desc}`.includes(argFollow))
    : games[0];
  if (!target) { console.log(`\nno game matching "${argFollow}" — nothing to follow`); process.exit(0); }

  console.log(`\n→ followGame("${target.view.label}")`);
  relay.length = 0;
  await commands.get('vibeStealth.followGame')(target.node);
  await sleep(5000);

  console.log(`\n→ relay lines (${relay.length}):`);
  for (const l of relay.slice(-12)) console.log('  ' + l);
  console.log(`\n→ status bar: "${statusBar?.text ?? '(none)'}"  visible=${statusBar?.visible}`);
  console.log(`→ persisted follows: ${JSON.stringify(memento.get('vibeStealth.followedGames')?.length ?? 0)}`);

  // §11: walk the Following section → followed game → live-state child rows.
  console.log('\n→ live-state tree rows under the followed game:');
  const roots2 = (await treeProvider.getChildren()) ?? [];
  const following = roots2.find((r) => render(r).ctx === 'followingSection');
  if (!following) { console.log('  (no Following section)'); }
  else {
    const followedGames = (await treeProvider.getChildren(following)) ?? [];
    for (const fg of followedGames) {
      const v = render(fg);
      console.log(`  ${v.label}  [${v.ctx}]`);
      const rows = (await treeProvider.getChildren(fg)) ?? [];
      for (const row of rows) {
        const rv = render(row);
        const desc = rv.desc ? `  — ${rv.desc}` : '';
        console.log(`     ${rv.label}${desc}`);
        // one level deeper for collapsible lineup/draft nodes
        const sub = (await treeProvider.getChildren(row)) ?? [];
        for (const s of sub.slice(0, 3)) console.log(`        ${render(s).label}`);
        if (sub.length > 3) console.log(`        … (+${sub.length - 3})`);
      }
    }
  }
  if (diag.length) { console.log(`\n→ diagnostics (${diag.length}):`); for (const d of diag.slice(0, 6)) console.log('  ' + d); }

  console.log('\n→ deactivate()');
  await ext.deactivate?.();
  console.log('  ok — no crash');
  process.exit(0);
})().catch((e) => { console.error('\nSMOKE FAILED:', e); process.exit(1); });
