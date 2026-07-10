import { describe, expect, it } from 'vitest';
import {
  clampInt,
  coerceScore,
  dateInZone,
  fnv1a32,
  normalizeWs,
  parseIsoUtc,
  sanitizeText,
} from '../../src/core/util';

const ctl = (code: number): string => String.fromCharCode(code);

describe('fnv1a32', () => {
  it('is deterministic, 8 lowercase hex chars', () => {
    const h = fnv1a32('hello');
    expect(h).toMatch(/^[0-9a-f]{8}$/);
    expect(fnv1a32('hello')).toBe(h);
  });

  it('separates inputs that differ only by an occurrence ordinal', () => {
    expect(fnv1a32('g|Goal|0')).not.toBe(fnv1a32('g|Goal|1'));
  });

  it('handles empty input and non-BMP code points', () => {
    expect(fnv1a32('')).toBe('811c9dc5');
    expect(fnv1a32('⚾ 홈런 🎉')).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('coerceScore', () => {
  it('accepts numbers and numeric strings in [0, 999]', () => {
    expect(coerceScore(0)).toBe(0);
    expect(coerceScore(7)).toBe(7);
    expect(coerceScore('7')).toBe(7);
    expect(coerceScore(' 12 ')).toBe(12);
    expect(coerceScore(999)).toBe(999);
  });

  it('rejects the P3 hostile set', () => {
    expect(coerceScore('N/A')).toBeUndefined();
    expect(coerceScore('-1')).toBeUndefined();
    expect(coerceScore('3.5')).toBeUndefined();
    expect(coerceScore('1e9')).toBeUndefined();
    expect(coerceScore(1000)).toBeUndefined();
    expect(coerceScore(NaN)).toBeUndefined();
    expect(coerceScore(Infinity)).toBeUndefined();
    expect(coerceScore('')).toBeUndefined();
    expect(coerceScore('   ')).toBeUndefined();
    expect(coerceScore(null)).toBeUndefined();
    expect(coerceScore(undefined)).toBeUndefined();
    expect(coerceScore({})).toBeUndefined();
    expect(coerceScore([])).toBeUndefined();
    expect(coerceScore(true)).toBeUndefined();
  });
});

describe('sanitizeText', () => {
  it('drops non-strings and empty results', () => {
    expect(sanitizeText(undefined)).toBeUndefined();
    expect(sanitizeText(42)).toBeUndefined();
    expect(sanitizeText('')).toBeUndefined();
    expect(sanitizeText('   \n  ')).toBeUndefined();
  });

  it('collapses newlines to "; " and strips control chars', () => {
    expect(sanitizeText('a\nb')).toBe('a; b');
    expect(sanitizeText('a\r\nb')).toBe('a; b');
    expect(sanitizeText(`a${ctl(0x07)}b`)).toBe('ab');
    expect(sanitizeText(`x${ctl(0x00)}${ctl(0x1f)}y`)).toBe('xy');
    expect(sanitizeText(`café${ctl(0x9f)}`)).toBe('café');
    expect(sanitizeText('  padded  ')).toBe('padded');
  });

  it('preserves unicode, CJK and emoji (P8)', () => {
    const s = 'CF Montréal — 홈런! ⚾🎉';
    expect(sanitizeText(s)).toBe(s);
  });

  it('caps at 500 chars with an ellipsis', () => {
    const out = sanitizeText('x'.repeat(600));
    expect(out).toHaveLength(500);
    expect(out?.endsWith('…')).toBe(true);
  });

  it('leaves a 500-char string untouched', () => {
    const exact = 'x'.repeat(500);
    expect(sanitizeText(exact)).toBe(exact);
  });
});

describe('normalizeWs', () => {
  it('trims and collapses internal whitespace runs', () => {
    expect(normalizeWs('  a   b \t c ')).toBe('a b c');
    expect(normalizeWs('a b')).toBe('a b');
    expect(normalizeWs('')).toBe('');
  });
});

describe('parseIsoUtc', () => {
  it('accepts ISO with and without seconds', () => {
    expect(parseIsoUtc('2026-07-07T18:15Z')).toBe('2026-07-07T18:15:00Z');
    expect(parseIsoUtc('2026-07-08T19:45:00Z')).toBe('2026-07-08T19:45:00Z');
    expect(parseIsoUtc('2026-07-08T19:45:00.123Z')).toBe('2026-07-08T19:45:00Z');
    expect(parseIsoUtc(' 2026-07-08T19:45:00Z ')).toBe('2026-07-08T19:45:00Z');
  });

  it('normalizes offsets to UTC', () => {
    expect(parseIsoUtc('2026-07-08T18:30:00+09:00')).toBe('2026-07-08T09:30:00Z');
    expect(parseIsoUtc('2026-07-08T18:30:00+0900')).toBe('2026-07-08T09:30:00Z');
  });

  it('rejects the P5 hostile set and zone-less input', () => {
    expect(parseIsoUtc('TBD')).toBeUndefined();
    expect(parseIsoUtc('')).toBeUndefined();
    expect(parseIsoUtc(undefined)).toBeUndefined();
    expect(parseIsoUtc(null)).toBeUndefined();
    expect(parseIsoUtc(1_752_000_000_000)).toBeUndefined();
    expect(parseIsoUtc('2026-07-08T18:30:00')).toBeUndefined();
    expect(parseIsoUtc('2026-13-45T99:99:99Z')).toBeUndefined();
  });
});

describe('clampInt', () => {
  it('rounds, clamps and defaults on non-finite input', () => {
    expect(clampInt(20, 10, 120, 20)).toBe(20);
    expect(clampInt('35', 10, 120, 20)).toBe(35);
    expect(clampInt(19.6, 10, 120, 20)).toBe(20);
    expect(clampInt(5, 10, 120, 20)).toBe(10);
    expect(clampInt(9999, 10, 120, 20)).toBe(120);
    expect(clampInt('abc', 10, 120, 20)).toBe(20);
    expect(clampInt(undefined, 10, 120, 20)).toBe(20);
    expect(clampInt(Infinity, 10, 120, 20)).toBe(20);
    expect(clampInt(-Infinity, 10, 120, 20)).toBe(20);
  });
});

describe('dateInZone', () => {
  it('returns the league-local date, not the host-local one', () => {
    // 2026-07-08T02:00Z — already the 8th in Seoul, still the 7th in New York.
    const at = Date.parse('2026-07-08T02:00:00Z');
    expect(dateInZone(at, 'Asia/Seoul')).toBe('2026-07-08');
    expect(dateInZone(at, 'America/New_York')).toBe('2026-07-07');
    expect(dateInZone(at, 'UTC')).toBe('2026-07-08');
  });
});
