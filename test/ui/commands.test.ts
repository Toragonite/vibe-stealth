import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The two Quick Picks are the status bar's own click targets, so they must render the
 * same strings the tree does (CONTRACT §9: one locale per window). These tests drive the
 * real handlers through a vscode stub and read the items back.
 */

const settings = new Map<string, unknown>();
const registered = new Map<string, (...args: unknown[]) => unknown>();
/** Items handed to `showQuickPick` by the follow picker. */
let shownItems: Array<{ label: string }> = [];
/** Items assigned to the `createQuickPick` instance by the followed picker. */
let pickerItems: Array<{ label: string }> = [];
let quickPickResult: unknown;

vi.mock('vscode', () => ({
  ThemeIcon: class {
    constructor(readonly id: string) {}
  },
  commands: {
    registerCommand: (id: string, handler: (...args: unknown[]) => unknown) => {
      registered.set(id, handler);
      return { dispose: () => {} };
    },
  },
  window: {
    setStatusBarMessage: () => ({ dispose: () => {} }),
    showQuickPick: async (items: Array<{ label: string }>) => {
      shownItems = items;
      return quickPickResult;
    },
    showInputBox: async () => undefined,
    createQuickPick: () => ({
      title: '',
      placeholder: '',
      matchOnDescription: false,
      items: [] as Array<{ label: string }>,
      onDidAccept: () => ({ dispose: () => {} }),
      onDidTriggerItemButton: () => ({ dispose: () => {} }),
      onDidHide: () => ({ dispose: () => {} }),
      show(): void {
        pickerItems = this.items;
      },
      hide: () => {},
      dispose: () => {},
    }),
  },
  workspace: {
    getConfiguration: () => ({ get: (key: string) => settings.get(key) }),
  },
  env: { language: 'en' },
}));

import { IDS, type Game } from '../../src/core/contract';
import { registerCommands } from '../../src/ui/commands';

/** CONTRACT §14: a field contest — the shape whose label is locale-dependent. */
function fieldGame(): Game {
  return {
    id: 'espnRacing:f1:401700',
    providerId: 'espnRacing',
    leagueId: 'f1',
    leagueName: 'Belgian Grand Prix',
    sport: 'motorsport',
    startTimeUtc: '2026-07-26T13:00:00Z',
    phase: 'in',
    statusText: 'Lap 32/44',
    statusShort: 'L32',
    format: 'field',
    home: undefined,
    away: undefined,
    entrants: [{ id: '1', position: 1, name: 'Max Verstappen', abbrev: 'VER', detail: 'Red Bull', logo: undefined }],
  };
}

function setup(locale: 'en' | 'ko', followed = false): void {
  registered.clear();
  shownItems = [];
  pickerItems = [];
  quickPickResult = undefined;
  settings.clear();
  settings.set(IDS.settings.locale, locale);

  const game = fieldGame();
  const deps = {
    context: { secrets: { store: async () => {}, delete: async () => {} } },
    follow: {
      isFollowed: () => followed,
      follow: async () => {},
      unfollow: async () => {},
      get: () => undefined,
      list: () => [{ game, state: { gameId: game.id } }],
    },
    tree: {
      refresh: async () => {},
      ensureLoaded: async () => {},
      allGames: () => [game],
    },
    relay: { show: () => {}, clear: () => {} },
    diag: { log: () => {}, error: () => {} },
  };
  // The handlers only touch the members stubbed above; the real classes are vscode-bound.
  registerCommands(deps as unknown as Parameters<typeof registerCommands>[0]);
}

async function invoke(id: string): Promise<void> {
  const handler = registered.get(id);
  if (!handler) throw new Error(`command not registered: ${id}`);
  await handler();
}

describe('command Quick Picks are localized (CONTRACT §9/§14)', () => {
  beforeEach(() => {
    shownItems = [];
    pickerItems = [];
  });

  it('the follow picker renders the Korean leader form under locale ko', async () => {
    setup('ko');
    await invoke(IDS.commands.followGame);
    expect(shownItems.map((i) => i.label)).toEqual(['Belgian Grand Prix · 1위 VER']);
  });

  it('the followed picker renders the Korean leader form under locale ko', async () => {
    setup('ko');
    await invoke(IDS.commands.pickFollowed);
    expect(pickerItems.map((i) => i.label)).toEqual(['Belgian Grand Prix · 1위 VER']);
  });

  it('both pickers render the English form under locale en', async () => {
    setup('en');
    await invoke(IDS.commands.followGame);
    await invoke(IDS.commands.pickFollowed);
    expect(shownItems.map((i) => i.label)).toEqual(['Belgian Grand Prix · P1 VER']);
    expect(pickerItems.map((i) => i.label)).toEqual(['Belgian Grand Prix · P1 VER']);
  });

  it('a followed game keeps its star prefix alongside the localized label', async () => {
    setup('ko', true); // the starred branch formats the label independently
    await invoke(IDS.commands.followGame);
    expect(shownItems.map((i) => i.label)).toEqual(['$(star-full) Belgian Grand Prix · 1위 VER']);
  });
});
