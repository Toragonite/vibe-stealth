import { describe, expect, it } from 'vitest';
import type { Entrant, Game, LogoRef } from '../../src/core/contract';
import {
  contestName,
  EN_DASH,
  gameLabel,
  gameLine,
  gameLogo,
  gameStanding,
  gameTitle,
  leagueKey,
  scoreText,
} from '../../src/ui/display';

const HOME_LOGO: LogoRef = { light: 'https://a.espncdn.com/stl.png' };
const VER_LOGO: LogoRef = { light: 'https://a.espncdn.com/ver.png' };

function game(overrides: Partial<Game> = {}): Game {
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
    home: { id: '1', name: 'Cardinals', abbrev: 'STL', score: 2, logo: HOME_LOGO },
    away: { id: '2', name: 'Cubs', abbrev: 'CHC', score: 3 },
    entrants: undefined,
    ...overrides,
  };
}

/** CONTRACT §14: a field contest — N entrants placing, no home/away at all. */
function fieldGame(overrides: Partial<Game> = {}): Game {
  return {
    id: 'espn:f1:401600',
    providerId: 'espn',
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
      entrant({ id: '1', position: 1, name: 'Max Verstappen', abbrev: 'VER', detail: 'Red Bull', logo: VER_LOGO }),
      entrant({ id: '4', position: 2, name: 'Lando Norris', abbrev: 'NOR', detail: '+4.213' }),
    ],
    ...overrides,
  };
}

function entrant(overrides: Partial<Entrant> = {}): Entrant {
  return { id: '1', position: 1, name: 'Max Verstappen', abbrev: 'VER', detail: undefined, logo: undefined, ...overrides };
}

describe('scoreText', () => {
  it('renders an en dash for an unknown score, never "undefined" or 0', () => {
    expect(scoreText(3)).toBe('3');
    expect(scoreText(0)).toBe('0');
    expect(scoreText(undefined)).toBe(EN_DASH);
  });
});

describe('gameLabel', () => {
  it('keeps the pinned two-sided shape for a versus game (§6)', () => {
    expect(gameLabel(game())).toBe('CHC 3:2 STL');
    expect(gameLabel(game(), 'ko')).toBe('CHC 3:2 STL');
    expect(gameLabel(game({ home: { id: '1', name: 'Cardinals', abbrev: 'STL', score: undefined } }))).toBe(
      `CHC 3:${EN_DASH} STL`,
    );
  });

  it('renders a field contest as contest + leader, never as a fake score (§14)', () => {
    expect(gameLabel(fieldGame())).toBe('Belgian Grand Prix · P1 VER');
    expect(gameLabel(fieldGame(), 'ko')).toBe('Belgian Grand Prix · 1위 VER');
    expect(gameLabel(fieldGame())).not.toContain(':');
  });

  it('renders the contest alone while the field is unranked', () => {
    const unranked = fieldGame({ entrants: [entrant({ position: undefined }), entrant({ position: undefined })] });
    expect(gameLabel(unranked)).toBe('Belgian Grand Prix');
    expect(gameLabel(unranked, 'ko')).toBe('Belgian Grand Prix');
  });

  it('degrades a malformed game rather than throwing (§14)', () => {
    // 'field' with an empty / absent entrant list.
    expect(gameLabel(fieldGame({ entrants: [] }))).toBe('Belgian Grand Prix');
    expect(gameLabel(fieldGame({ entrants: undefined }))).toBe('Belgian Grand Prix');
    // 'versus' missing one or both sides.
    expect(gameLabel(game({ home: undefined }))).toBe('MLB');
    expect(gameLabel(game({ away: undefined }))).toBe('MLB');
    expect(gameLabel(game({ home: undefined, away: undefined }))).toBe('MLB');
    // Nothing nameable either — the status text is the last resort, never a blank row.
    expect(gameLabel(game({ home: undefined, leagueName: '  ' }))).toBe('Top 7th');
    expect(gameLabel(fieldGame({ entrants: [], leagueName: '' }))).toBe('Lap 32/44');
  });
});

describe('gameLine', () => {
  it('uses full names for a versus game and the §14 label for a field one', () => {
    expect(gameLine(game(), 'en')).toBe('Cubs 3:2 Cardinals');
    expect(gameLine(fieldGame(), 'en')).toBe('Belgian Grand Prix · P1 VER');
    expect(gameLine(fieldGame(), 'ko')).toBe('Belgian Grand Prix · 1위 VER');
  });

  it('degrades a malformed game to the contest name', () => {
    expect(gameLine(game({ away: undefined }), 'en')).toBe('MLB');
    expect(gameLine(fieldGame({ entrants: [] }), 'en')).toBe('Belgian Grand Prix');
  });
});

describe('gameTitle', () => {
  it('pairs the two sides, and names the contest for a field event', () => {
    expect(gameTitle(game())).toBe('Cubs vs Cardinals');
    expect(gameTitle(fieldGame())).toBe('Belgian Grand Prix');
    expect(gameTitle(fieldGame({ entrants: [] }))).toBe('Belgian Grand Prix');
  });

  it('never renders "undefined vs undefined" for a malformed versus game', () => {
    const title = gameTitle(game({ home: undefined, away: undefined }));
    expect(title).toBe('MLB');
    expect(title).not.toContain('undefined');
  });
});

describe('gameStanding', () => {
  it('is the score for a versus game and the leader for a field one', () => {
    expect(gameStanding(game(), 'en')).toBe('3:2');
    expect(gameStanding(fieldGame(), 'en')).toBe('P1 VER');
    expect(gameStanding(fieldGame(), 'ko')).toBe('1위 VER');
  });

  it('is empty when the game has neither, so the caller can drop the fragment', () => {
    expect(gameStanding(game({ home: undefined }), 'en')).toBe('');
    expect(gameStanding(fieldGame({ entrants: [] }), 'en')).toBe('');
    expect(gameStanding(fieldGame({ entrants: [entrant({ position: undefined })] }), 'en')).toBe('');
  });
});

describe('gameLogo', () => {
  it('picks the home crest for a versus game and the leader portrait for a field one (§13.4b)', () => {
    expect(gameLogo(game())).toBe(HOME_LOGO);
    expect(gameLogo(fieldGame())).toBe(VER_LOGO);
  });

  it('is undefined when there is no crest to show', () => {
    expect(gameLogo(game({ home: { id: '1', name: 'Cardinals', abbrev: 'STL', score: 2 } }))).toBeUndefined();
    expect(gameLogo(game({ home: undefined }))).toBeUndefined();
    expect(gameLogo(fieldGame({ entrants: [] }))).toBeUndefined();
    expect(gameLogo(fieldGame({ entrants: [entrant({ position: undefined, logo: VER_LOGO })] }))).toBeUndefined();
  });
});

describe('contestName', () => {
  it('prefers the league name and falls back to the status text', () => {
    expect(contestName(fieldGame())).toBe('Belgian Grand Prix');
    expect(contestName(game())).toBe('MLB');
    expect(contestName(game({ leagueName: '   ' }))).toBe('Top 7th');
    expect(contestName(game({ leagueName: '', statusText: '' }))).toBe('');
  });
});

describe('leagueKey', () => {
  it('joins provider and league (CONTRACT §2)', () => {
    expect(leagueKey('espn', 'eng.1')).toBe('espn:eng.1');
  });
});
