import { describe, expect, it, vi } from 'vitest';

// followManager pulls in vscode transitively (diagnostics / relayChannel / settings).
// Nothing under test touches the API — only module load does — so a bare stub suffices.
vi.mock('vscode', () => ({
  EventEmitter: class {
    readonly event = () => ({ dispose: () => {} });
    fire(): void {}
    dispose(): void {}
  },
  window: {},
  workspace: {},
  env: { language: 'en' },
}));

import type { FollowedGameState, Game } from '../../src/core/contract';
import { MAX_FIELD_POSITION } from '../../src/core/contract';
import { gameLabel } from '../../src/ui/display';
import { sanitizeStates, snapshotOf, synthesizeGame } from '../../src/ui/followManager';

function versusGame(overrides: Partial<Game> = {}): Game {
  return {
    id: 'mlb:mlb:747000',
    providerId: 'mlb',
    leagueId: 'mlb',
    leagueName: 'MLB',
    sport: 'baseball',
    startTimeUtc: '2026-07-08T19:45:00Z',
    phase: 'in',
    statusText: 'Top 7th',
    statusShort: 'T7',
    format: 'versus',
    home: { id: '1', name: 'Cardinals', abbrev: 'STL', score: 2 },
    away: { id: '2', name: 'Cubs', abbrev: 'CHC', score: 3 },
    entrants: undefined,
    ...overrides,
  };
}

/** CONTRACT §14: a field contest — a field of entrants placing, no home/away at all. */
function fieldGame(overrides: Partial<Game> = {}): Game {
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
    entrants: [
      { id: '1', position: 1, name: 'Max Verstappen', abbrev: 'VER', detail: 'Red Bull', logo: undefined },
      { id: '2', position: 2, name: 'Lando Norris', abbrev: 'NOR', detail: 'McLaren', logo: undefined },
    ],
    ...overrides,
  };
}

/**
 * The real persistence path: `persist` clones the state and hands it to workspaceState,
 * which stores structured-cloneable JSON; `restore` reads it back through
 * `sanitizeStates`. JSON round-tripping reproduces that faithfully.
 */
function roundTrip(game: Game, lastKnownOverride?: Record<string, unknown>): FollowedGameState {
  const persisted = {
    gameId: game.id,
    providerId: game.providerId,
    leagueId: game.leagueId,
    followedAt: 1_760_000_000_000,
    postObservedAt: 0,
    lastKnown: { ...snapshotOf(game), ...lastKnownOverride },
  };
  const [restored] = sanitizeStates(JSON.parse(JSON.stringify([persisted])));
  if (!restored) throw new Error('sanitizeStates dropped the entry');
  return restored;
}

// --- CONTRACT §14: the persisted discriminator ------------------------------

describe('followManager persistence of the §14 discriminator', () => {
  it('a field contest keeps its contest name and leader across a reload — no TBD pair', () => {
    const restored = roundTrip(fieldGame());
    expect(restored.lastKnown.format).toBe('field');
    expect(restored.lastKnown.contestName).toBe('Belgian Grand Prix');
    expect(restored.lastKnown.leaderAbbrev).toBe('VER');
    expect(restored.lastKnown.leaderPosition).toBe(1);

    // `listLeagues` only knows the SERIES name; the persisted contest name wins.
    const game = synthesizeGame(restored, 'Formula 1', 'motorsport');
    expect(game.format).toBe('field');
    expect(game.home).toBeUndefined();
    expect(game.away).toBeUndefined();
    expect(game.leagueName).toBe('Belgian Grand Prix');
    expect(gameLabel(game, 'en')).toBe('Belgian Grand Prix · P1 VER');
    expect(gameLabel(game, 'ko')).toBe('Belgian Grand Prix · 1위 VER');
  });

  it('a field contest whose field is not ranked yet restores as the contest alone', () => {
    const unranked = fieldGame({
      entrants: [{ id: '1', position: undefined, name: 'Max Verstappen', abbrev: 'VER', detail: undefined, logo: undefined }],
    });
    const restored = roundTrip(unranked);
    expect(restored.lastKnown.leaderPosition).toBeUndefined();

    const game = synthesizeGame(restored, 'Formula 1', 'motorsport');
    expect(game.format).toBe('field');
    expect(game.entrants).toHaveLength(1); // §14: `entrants` is non-empty for a field game
    expect(gameLabel(game, 'en')).toBe('Belgian Grand Prix');
  });

  it('the sport is NOT consulted: a field contest on an unknown sport still restores as field', () => {
    // `restore` passes 'other' when `listLeagues` no longer knows the league — the old
    // sport-to-format table read that as a positive 'versus' and fabricated two sides.
    const game = synthesizeGame(roundTrip(fieldGame()), 'f1', 'other');
    expect(game.format).toBe('field');
    expect(game.home).toBeUndefined();
    expect(game.away).toBeUndefined();
  });

  it('a versus game restores exactly as before, with the sides it was persisted with', () => {
    const restored = roundTrip(versusGame());
    expect(restored.lastKnown.format).toBe('versus');
    expect(restored.lastKnown.contestName).toBeUndefined();
    expect(restored.lastKnown.leaderAbbrev).toBeUndefined();

    const game = synthesizeGame(restored, 'MLB', 'baseball');
    expect(game.format).toBe('versus');
    expect(game.entrants).toBeUndefined();
    expect(gameLabel(game, 'en')).toBe('CHC 3:2 STL');
  });

  it('a versus game persisted on a motorsport league is NOT re-derived into a field one', () => {
    const restored = roundTrip(versusGame({ sport: 'motorsport' }));
    const game = synthesizeGame(restored, 'Formula 1', 'motorsport');
    expect(game.format).toBe('versus');
    expect(gameLabel(game, 'en')).toBe('CHC 3:2 STL');
  });
});

// --- the v1.0.1 upgrade path ------------------------------------------------

describe('followManager restore of a pre-§14 entry (absent format)', () => {
  /** Exactly what v1.0.1 wrote: no `format`, no field extras. */
  const legacy = {
    gameId: 'mlb:mlb:747000',
    providerId: 'mlb',
    leagueId: 'mlb',
    followedAt: 1_760_000_000_000,
    postObservedAt: 0,
    lastKnown: { awayAbbrev: 'CHC', homeAbbrev: 'STL', awayScore: 3, homeScore: 2, statusShort: 'T7', phase: 'in' },
  };

  it('absent format is legacy, not malformed — it restores as versus with its sides intact', () => {
    const [restored] = sanitizeStates([legacy]);
    expect(restored?.lastKnown.format).toBeUndefined(); // not invented on the way in

    const game = synthesizeGame(restored as FollowedGameState, 'MLB', 'baseball');
    expect(game.format).toBe('versus');
    expect(game.home?.abbrev).toBe('STL');
    expect(game.away?.abbrev).toBe('CHC');
    expect(gameLabel(game, 'en')).toBe('CHC 3:2 STL');
  });

  it('an absent format on a motorsport league still restores as versus', () => {
    const [restored] = sanitizeStates([{ ...legacy, leagueId: 'f1' }]);
    const game = synthesizeGame(restored as FollowedGameState, 'Formula 1', 'motorsport');
    expect(game.format).toBe('versus');
    expect(game.entrants).toBeUndefined();
  });
});

// --- hostile workspaceState -------------------------------------------------

describe('followManager sanitize of the §14 extras (workspaceState is corruptible)', () => {
  const bad: Array<[string, unknown]> = [
    ['zero', 0],
    ['negative', -1],
    ['absurd magnitude', 1e308],
    ['numeric string', '3'],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['fractional', 1.5],
    ['just past the cap', MAX_FIELD_POSITION + 1],
    ['null', null],
    ['object', { position: 1 }],
  ];

  for (const [label, value] of bad) {
    it(`rejects a leaderPosition of ${label} without throwing`, () => {
      const restored = roundTrip(fieldGame(), { leaderPosition: value });
      expect(restored.lastKnown.leaderPosition).toBeUndefined();
      const game = synthesizeGame(restored, 'Formula 1', 'motorsport');
      // Unranked, exactly as `Entrant.position === undefined` is treated.
      expect(gameLabel(game, 'en')).toBe('Belgian Grand Prix');
    });
  }

  it('accepts the boundary positions 1 and MAX_FIELD_POSITION', () => {
    expect(roundTrip(fieldGame(), { leaderPosition: 1 }).lastKnown.leaderPosition).toBe(1);
    expect(roundTrip(fieldGame(), { leaderPosition: MAX_FIELD_POSITION }).lastKnown.leaderPosition).toBe(
      MAX_FIELD_POSITION,
    );
  });

  it('drops a format that is not a §14 discriminator, falling back to the legacy reading', () => {
    const restored = roundTrip(fieldGame(), { format: 'FIELD' });
    expect(restored.lastKnown.format).toBeUndefined();
    expect(synthesizeGame(restored, 'Formula 1', 'motorsport').format).toBe('versus');
  });

  it('caps a hostile contest name and leader abbrev instead of rendering them whole', () => {
    const restored = roundTrip(fieldGame(), { contestName: 'G'.repeat(500), leaderAbbrev: 'V'.repeat(50) });
    expect(restored.lastKnown.contestName).toHaveLength(80);
    expect(restored.lastKnown.leaderAbbrev).toHaveLength(5);
  });

  it('a blank contest name or leader abbrev is dropped, never persisted as empty', () => {
    const restored = roundTrip(fieldGame(), { contestName: '   ', leaderAbbrev: '' });
    expect(restored.lastKnown.contestName).toBeUndefined();
    expect(restored.lastKnown.leaderAbbrev).toBeUndefined();
    // The contest name falls back to the league name `restore` resolved.
    expect(synthesizeGame(restored, 'Formula 1', 'motorsport').leagueName).toBe('Formula 1');
  });
});

// --- snapshotOf -------------------------------------------------------------

describe('followManager snapshotOf', () => {
  it('records the leader by name when the entrant has no abbrev', () => {
    const snapshot = snapshotOf(
      fieldGame({
        entrants: [{ id: '1', position: 2, name: 'Verstappen', abbrev: '', detail: undefined, logo: undefined }],
      }),
    );
    expect(snapshot.leaderAbbrev).toBe('Verst'); // ≤ 5 chars, like Entrant.abbrev
    expect(snapshot.leaderPosition).toBe(2);
  });

  it('skips unranked entrants when choosing the leader (§14 leadEntrant rule)', () => {
    const snapshot = snapshotOf(
      fieldGame({
        entrants: [
          { id: '1', position: undefined, name: 'Pit lane', abbrev: 'PIT', detail: undefined, logo: undefined },
          { id: '2', position: 3, name: 'Charles Leclerc', abbrev: 'LEC', detail: undefined, logo: undefined },
        ],
      }),
    );
    expect(snapshot.leaderAbbrev).toBe('LEC');
    expect(snapshot.leaderPosition).toBe(3);
  });

  it('a versus snapshot carries no field extras at all', () => {
    const snapshot = snapshotOf(versusGame());
    expect(snapshot).toEqual({
      awayAbbrev: 'CHC',
      homeAbbrev: 'STL',
      awayScore: 3,
      homeScore: 2,
      statusShort: 'T7',
      phase: 'in',
      format: 'versus',
    });
  });
});
