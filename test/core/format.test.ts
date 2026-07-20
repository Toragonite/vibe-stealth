import { describe, expect, it } from 'vitest';
import { MAX_FIELD_POSITION } from '../../src/core/contract';
import type { Entrant, FormatOptions, Game, PlayEvent, SportKind } from '../../src/core/contract';
import {
  formatEventLine,
  formatLeader,
  formatStatusBar,
  leadEntrant,
  localizePeriod,
  statusBarText,
} from '../../src/core/format';

/** Fixed instant; the formatter renders it in whatever zone the host runs in. */
const AT = Date.parse('2026-07-08T19:45:07Z');

const pad2 = (n: number): string => String(n).padStart(2, '0');
const localStamp = (ms: number): string => {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
};

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
    home: { id: '1', name: 'Cardinals', abbrev: 'STL', score: 2 },
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
      entrant({ id: '1', position: 1, name: 'Max Verstappen', abbrev: 'VER', detail: 'Red Bull' }),
      entrant({ id: '4', position: 2, name: 'Lando Norris', abbrev: 'NOR', detail: '+4.213' }),
    ],
    ...overrides,
  };
}

function entrant(overrides: Partial<Entrant> = {}): Entrant {
  return { id: '1', position: 1, name: 'Max Verstappen', abbrev: 'VER', detail: undefined, logo: undefined, ...overrides };
}

function event(overrides: Partial<PlayEvent> = {}): PlayEvent {
  return {
    id: 'mlb:747000:42',
    gameId: 'mlb:mlb:747000',
    sequence: 42,
    clock: undefined,
    period: 'T7',
    text: 'Strikeout swinging.',
    kind: 'play',
    scoreAfter: undefined,
    ...overrides,
  };
}

function opts(overrides: Partial<FormatOptions> = {}): FormatOptions {
  return { locale: 'en', showEmoji: false, multiGame: false, now: () => AT, ...overrides };
}

describe('formatEventLine', () => {
  it('renders the pinned skeleton with a local HH:MM:SS stamp', () => {
    expect(formatEventLine(event(), game(), opts())).toBe(`${localStamp(AT)} │ · T7 │ Strikeout swinging.`);
  });

  it('marks score, correction and everything else', () => {
    const base = opts();
    expect(formatEventLine(event({ kind: 'score' }), game(), base)).toContain('│ ★ T7 │');
    expect(formatEventLine(event({ kind: 'play' }), game(), base)).toContain('│ · T7 │');
    expect(formatEventLine(event({ kind: 'status' }), game(), base)).toContain('│ · T7 │');
    expect(formatEventLine(event({ kind: 'system' }), game(), base)).toContain('│ · T7 │');
    expect(formatEventLine(event({ kind: 'correction' }), game(), base)).toContain('│ ⚠ T7 │');
  });

  it('appends a localized (corrected) suffix to correction lines only', () => {
    expect(formatEventLine(event({ kind: 'correction' }), game(), opts())).toBe(
      `${localStamp(AT)} │ ⚠ T7 │ Strikeout swinging. (corrected)`,
    );
    expect(formatEventLine(event({ kind: 'correction' }), game(), opts({ locale: 'ko' }))).toBe(
      `${localStamp(AT)} │ ⚠ 7회초 │ Strikeout swinging. (수정)`,
    );
    expect(formatEventLine(event(), game(), opts())).not.toContain('(corrected)');
  });

  it('adds the [AWY-HOM] tag only in multi-game mode', () => {
    expect(formatEventLine(event(), game(), opts({ multiGame: true }))).toContain('│ [CHC-STL] · T7 │');
    expect(formatEventLine(event(), game(), opts())).not.toContain('[CHC-STL]');
  });

  it('tags a field contest with its contest initials instead of two sides (§14)', () => {
    const multi = opts({ multiGame: true });
    expect(formatEventLine(event(), fieldGame(), multi)).toContain('│ [BGP] · T7 │');
    expect(formatEventLine(event(), fieldGame({ leagueName: 'Monaco' }), multi)).toContain('[MONAC]');
    expect(formatEventLine(event(), fieldGame({ leagueName: 'Formula 1' }), multi)).toContain('[F1]');
    expect(formatEventLine(event(), fieldGame(), opts())).not.toContain('[BGP]');
  });

  it('drops the tag rather than rendering a stub when a malformed game names nothing', () => {
    const multi = opts({ multiGame: true });
    // 'field' with no entrants and no contest name; 'versus' with no sides at all.
    expect(formatEventLine(event(), fieldGame({ leagueName: '   ', entrants: [] }), multi)).toContain('│ · T7 │');
    expect(formatEventLine(event(), game({ home: undefined, away: undefined }), multi)).toContain('│ · T7 │');
  });

  it('prefixes the sport emoji when enabled, and nothing for sport "other"', () => {
    const withEmoji = opts({ showEmoji: true });
    const cases: Array<[SportKind, string]> = [
      ['baseball', '⚾'],
      ['basketball', '🏀'],
      ['football', '🏈'],
      ['hockey', '🏒'],
      ['soccer', '⚽'],
      ['esports', '🎮'],
      ['tennis', '🎾'],
      ['mma', '🥊'],
      ['cricket', '🏏'],
      ['volleyball', '🏐'],
      ['motorsport', '🏎'],
    ];
    for (const [sport, emoji] of cases) {
      expect(formatEventLine(event(), game({ sport }), withEmoji)).toContain(`│ ${emoji} Strikeout swinging.`);
    }
    expect(formatEventLine(event(), game({ sport: 'other' }), withEmoji)).toBe(
      `${localStamp(AT)} │ · T7 │ Strikeout swinging.`,
    );
  });

  it('joins period and clock, and collapses the segment when both are absent', () => {
    const g = game({ sport: 'basketball' });
    expect(formatEventLine(event({ period: 'Q3', clock: '04:12' }), g, opts())).toContain('│ · Q3 04:12 │');
    expect(formatEventLine(event({ period: 'Q3', clock: undefined }), g, opts())).toContain('│ · Q3 │');
    expect(formatEventLine(event({ period: undefined, clock: '04:12' }), g, opts())).toContain('│ · 04:12 │');
    expect(formatEventLine(event({ period: undefined, clock: undefined }), g, opts())).toBe(
      `${localStamp(AT)} │ · │ Strikeout swinging.`,
    );
    // Soccer's clock may arrive empty (ESPN evidence) — treat it as absent.
    expect(formatEventLine(event({ period: undefined, clock: '  ' }), g, opts())).toContain('│ · │');
  });

  it('localizes the period segment for ko', () => {
    expect(formatEventLine(event({ period: 'B9' }), game(), opts({ locale: 'ko' }))).toContain('│ · 9회말 │');
  });

  it('keeps unicode, CJK and emoji intact and never exceeds 500 chars of text (P8)', () => {
    const text = 'CF Montréal 득점! 김하성 홈런 ⚾🎉';
    const line = formatEventLine(event({ text }), game(), opts({ showEmoji: true }));
    expect(line).toContain(`⚾ ${text}`);

    // Exactly at the cap: emoji and CJK survive untouched.
    const atCap = '가'.repeat(498) + '🎉'; // 500 UTF-16 units
    expect(formatEventLine(event({ text: atCap }), game(), opts()).split(' │ ')[2]).toBe(atCap);

    const capped = formatEventLine(event({ text: '가'.repeat(600) }), game(), opts());
    const body = capped.split(' │ ')[2] ?? '';
    expect(body).toHaveLength(500);
    expect(body).toBe('가'.repeat(499) + '…');
  });

  it('never lets a hostile newline or control char reach the channel', () => {
    const line = formatEventLine(event({ text: `two\nlines${String.fromCharCode(0x07)}` }), game(), opts());
    expect(line).toBe(`${localStamp(AT)} │ · T7 │ two; lines`);
    expect(line).not.toContain('\n');
  });

  it('degrades to 00:00:00 rather than "NaN:NaN:NaN" when the clock is broken', () => {
    expect(formatEventLine(event(), game(), opts({ now: () => NaN }))).toMatch(/^00:00:00 │/);
    expect(formatEventLine(event(), game(), opts({ now: () => Infinity }))).toMatch(/^00:00:00 │/);
  });
});

describe('formatStatusBar', () => {
  it('renders the pinned shape', () => {
    expect(formatStatusBar('CHC', 3, 2, 'STL', 'T7')).toBe('CHC 3:2 STL · T7');
    expect(formatStatusBar('LAD', 0, 0, 'SFG', 'Final')).toBe('LAD 0:0 SFG · Final');
  });

  it('shows an en-dash for unknown scores and never "NaN" (P3)', () => {
    expect(formatStatusBar('CHC', undefined, undefined, 'STL', '19:45')).toBe('CHC –:– STL · 19:45');
    expect(formatStatusBar('CHC', 3, undefined, 'STL', 'T7')).toBe('CHC 3:– STL · T7');
    expect(formatStatusBar('CHC', NaN, -1, 'STL', 'T7')).toBe('CHC –:– STL · T7');
    expect(formatStatusBar('CHC', 3.5, Infinity, 'STL', 'T7')).toBe('CHC –:– STL · T7');
  });

  it('omits the separator when statusShort is empty', () => {
    expect(formatStatusBar('CHC', 3, 2, 'STL', '')).toBe('CHC 3:2 STL');
    expect(formatStatusBar('CHC', 3, 2, 'STL', '   ')).toBe('CHC 3:2 STL');
  });
});

describe('leadEntrant', () => {
  it('takes the first entrant carrying a usable position, without re-sorting', () => {
    expect(leadEntrant(fieldGame().entrants)?.abbrev).toBe('VER');
    // Unranked entries ahead of the ranked ones are skipped, not sorted around.
    const mixed = [entrant({ position: undefined, abbrev: 'HAM' }), entrant({ position: 3, abbrev: 'LEC' })];
    expect(leadEntrant(mixed)?.abbrev).toBe('LEC');
  });

  it('rejects a position that is not a 1-based integer', () => {
    for (const position of [0, -1, 1.5, NaN, Infinity, -Infinity]) {
      expect(leadEntrant([entrant({ position })]), `position ${position}`).toBeUndefined();
    }
    // A numeric-looking string is not a number, however plausible it renders.
    for (const position of ['1', null]) {
      const hostile = entrant({ position: position as unknown as number });
      expect(leadEntrant([hostile]), `position ${String(position)}`).toBeUndefined();
    }
  });

  it('§14: treats the range [1, MAX_FIELD_POSITION] as a boundary, not a shape check', () => {
    // Every value on this line passes `Number.isInteger(p) && p >= 1` — a shape-only
    // check would take one as the leader and render `P1e+308`. The bound is what
    // makes the test about MEANING rather than form.
    for (const position of [MAX_FIELD_POSITION + 1, 1e308, Number.MAX_SAFE_INTEGER]) {
      expect(leadEntrant([entrant({ position })]), `position ${position}`).toBeUndefined();
    }
    // Both ends of the valid range are in; one step outside either end is out.
    expect(leadEntrant([entrant({ position: MAX_FIELD_POSITION })])?.position).toBe(MAX_FIELD_POSITION);
    expect(leadEntrant([entrant({ position: 1 })])?.position).toBe(1);
    expect(leadEntrant([entrant({ position: 0 })])).toBeUndefined();
  });

  it('skips an out-of-range position exactly as it skips an unranked one', () => {
    const hostile = [0, -1, 1.5, NaN, Infinity, -Infinity, '1', null, undefined, 1e308].map((position, i) =>
      entrant({ id: String(i), position: position as unknown as number, name: `D${i}`, abbrev: `D${i}` }),
    );
    hostile.push(entrant({ id: 'ok', position: 7, name: 'Real Driver', abbrev: 'RLD' }));
    expect(leadEntrant(hostile)?.abbrev).toBe('RLD');
    // Nothing meaningless survives into the rendered line.
    expect(formatLeader(hostile, 'en')).toBe('P7 RLD');
  });

  it('returns undefined for an unranked, empty, absent or hostile field', () => {
    expect(leadEntrant([entrant({ position: undefined })])).toBeUndefined();
    expect(leadEntrant([])).toBeUndefined();
    expect(leadEntrant(undefined)).toBeUndefined();
    expect(leadEntrant('nope' as unknown as Entrant[])).toBeUndefined();
    expect(leadEntrant([undefined as unknown as Entrant, entrant({ position: 2 })])?.position).toBe(2);
  });
});

describe('formatLeader', () => {
  it('renders the leader in both locales', () => {
    expect(formatLeader(fieldGame().entrants, 'en')).toBe('P1 VER');
    expect(formatLeader(fieldGame().entrants, 'ko')).toBe('1위 VER');
  });

  it('falls back to the name, then to the bare position — never a raw {who}', () => {
    expect(formatLeader([entrant({ abbrev: '  ', name: 'Max Verstappen' })], 'en')).toBe('P1 Max Verstappen');
    const bare = formatLeader([entrant({ abbrev: '', name: '' })], 'ko');
    expect(bare).toBe('1위');
    expect(bare).not.toMatch(/\{[a-zA-Z]+\}/);
  });

  it('is undefined when nothing is ranked yet', () => {
    expect(formatLeader([entrant({ position: undefined })], 'en')).toBeUndefined();
    expect(formatLeader([], 'en')).toBeUndefined();
  });
});

describe('statusBarText (CONTRACT §5, §14)', () => {
  it('keeps the pinned two-sided shape for a versus game', () => {
    expect(statusBarText(game(), 'en')).toBe('CHC 3:2 STL · T7');
    expect(statusBarText(game(), 'ko')).toBe('CHC 3:2 STL · T7');
    expect(statusBarText(game({ away: { id: '2', name: 'Cubs', abbrev: 'CHC', score: undefined } }), 'en')).toBe(
      'CHC –:2 STL · T7',
    );
  });

  it('shows the leader and the status for a field contest — never a fake score', () => {
    expect(statusBarText(fieldGame(), 'en')).toBe('P1 VER · L32');
    expect(statusBarText(fieldGame(), 'ko')).toBe('1위 VER · L32');
    expect(statusBarText(fieldGame(), 'en')).not.toContain(':');
  });

  it('falls back to the status alone when the field is not ranked yet', () => {
    const unranked = fieldGame({ entrants: [entrant({ position: undefined }), entrant({ position: undefined })] });
    expect(statusBarText(unranked, 'en')).toBe('L32');
    expect(statusBarText(unranked, 'ko')).toBe('L32');
  });

  it('degrades a malformed game to the status instead of throwing (§14)', () => {
    expect(statusBarText(fieldGame({ entrants: [] }), 'en')).toBe('L32');
    expect(statusBarText(fieldGame({ entrants: undefined }), 'en')).toBe('L32');
    expect(statusBarText(game({ home: undefined }), 'en')).toBe('T7');
    expect(statusBarText(game({ away: undefined }), 'en')).toBe('T7');
    expect(statusBarText(game({ home: undefined, away: undefined }), 'ko')).toBe('T7');
    // Nothing renderable at all — an empty string, never 'undefined' or a throw.
    expect(statusBarText(fieldGame({ entrants: [], statusShort: '' }), 'en')).toBe('');
  });
});

describe('localizePeriod', () => {
  it('passes through in en', () => {
    for (const p of ['T7', 'B7', 'Q3', 'P2', 'OT', 'SO', 'HT', 'FT', 'G2', 'H1']) {
      expect(localizePeriod(p, 'baseball', 'en')).toBe(p);
    }
  });

  it('maps every pinned label in ko', () => {
    expect(localizePeriod('T7', 'baseball', 'ko')).toBe('7회초');
    expect(localizePeriod('B7', 'baseball', 'ko')).toBe('7회말');
    expect(localizePeriod('M7', 'baseball', 'ko')).toBe('7회중');
    expect(localizePeriod('E7', 'baseball', 'ko')).toBe('7회종');
    expect(localizePeriod('Q3', 'basketball', 'ko')).toBe('3쿼터');
    expect(localizePeriod('P2', 'hockey', 'ko')).toBe('2피리어드');
    expect(localizePeriod('H1', 'soccer', 'ko')).toBe('전반');
    expect(localizePeriod('H2', 'soccer', 'ko')).toBe('후반');
    expect(localizePeriod('OT', 'hockey', 'ko')).toBe('연장');
    expect(localizePeriod('HT', 'soccer', 'ko')).toBe('전반 종료');
    expect(localizePeriod('FT', 'soccer', 'ko')).toBe('경기 종료');
    expect(localizePeriod('G2', 'esports', 'ko')).toBe('2세트');
  });

  it('disambiguates SO by sport', () => {
    expect(localizePeriod('SO', 'hockey', 'ko')).toBe('슛아웃');
    expect(localizePeriod('SO', 'baseball', 'ko')).toBe('승부치기');
  });

  it('handles absent, empty and unrecognized labels', () => {
    expect(localizePeriod(undefined, 'baseball', 'ko')).toBeUndefined();
    expect(localizePeriod('', 'baseball', 'ko')).toBeUndefined();
    expect(localizePeriod('   ', 'baseball', 'ko')).toBeUndefined();
    expect(localizePeriod(null as unknown as string, 'baseball', 'ko')).toBeUndefined();
    expect(localizePeriod("67'", 'soccer', 'ko')).toBe("67'");
    expect(localizePeriod('H3', 'soccer', 'ko')).toBe('H3');
    expect(localizePeriod('Q', 'basketball', 'ko')).toBe('Q');
    expect(localizePeriod('T99999', 'baseball', 'ko')).toBe('T99999');
    expect(localizePeriod('t7', 'baseball', 'ko')).toBe('t7');
    expect(localizePeriod(' Q3 ', 'basketball', 'ko')).toBe('3쿼터');
  });
});
