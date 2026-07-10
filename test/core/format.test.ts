import { describe, expect, it } from 'vitest';
import type { FormatOptions, Game, PlayEvent, SportKind } from '../../src/core/contract';
import { formatEventLine, formatStatusBar, localizePeriod } from '../../src/core/format';

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
    home: { id: '1', name: 'Cardinals', abbrev: 'STL', score: 2 },
    away: { id: '2', name: 'Cubs', abbrev: 'CHC', score: 3 },
    ...overrides,
  };
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

  it('prefixes the sport emoji when enabled, and nothing for sport "other"', () => {
    const withEmoji = opts({ showEmoji: true });
    const cases: Array<[SportKind, string]> = [
      ['baseball', '⚾'],
      ['basketball', '🏀'],
      ['football', '🏈'],
      ['hockey', '🏒'],
      ['soccer', '⚽'],
      ['esports', '🎮'],
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
