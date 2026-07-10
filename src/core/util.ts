/**
 * Shared pure helpers pinned by docs/CONTRACT.md §2 (universal provider pins).
 * These are contract infrastructure: behavior changes require a docs/CONTRACT.md
 * amendment. Tests live in test/core/util.test.ts.
 */

/** 32-bit FNV-1a over UTF-16 code units, lowercase hex, zero-padded to 8. */
export function fnv1a32(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Contract §2 score coercion: number or numeric string → finite integer in
 * [0, 999], else undefined. Never NaN / negative / float / absurd ('1e9').
 */
export function coerceScore(v: unknown): number | undefined {
  if (typeof v !== 'number' && typeof v !== 'string') return undefined;
  const raw = typeof v === 'string' ? v.trim() : v;
  if (raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > 999) return undefined;
  return n;
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = new RegExp(String.raw`[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]`, 'g');

/**
 * Contract §2 text rules: non-string/empty → undefined; collapses newlines to
 * '; ', strips C0/C1 control chars, trims, caps at 500 chars with '…'.
 */
export function sanitizeText(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const stripped = v.replace(CONTROL_CHARS, '');
  if (stripped.trim().length === 0) return undefined;
  let s = stripped.replace(/\s*(?:\r\n|\r|\n)+\s*/g, '; ').trim();
  if (s.length > 500) s = s.slice(0, 499) + '…';
  return s;
}

/** Whitespace-normalized form used for correction comparison and derived ids. */
export function normalizeWs(s: string): string {
  return s.trim().replace(/\s+/g, ' ');
}

/**
 * Contract §2 date rule: accepts ISO-8601 with a zone designator, WITH OR
 * WITHOUT seconds ('2026-07-07T18:15Z' is valid — ESPN evidence). Returns the
 * instant re-normalized as 'YYYY-MM-DDTHH:MM:SSZ', or undefined. Inputs
 * without a zone designator return undefined — callers that know the zone
 * (Naver = KST) must append it before calling.
 */
export function parseIsoUtc(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const trimmed = v.trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(trimmed)) {
    return undefined;
  }
  const d = new Date(trimmed);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Contract §4 numeric-setting rule: Math.round(Number(v)); NaN → dflt; clamp. */
export function clampInt(v: unknown, min: number, max: number, dflt: number): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

/** 'YYYY-MM-DD' for the given instant in an IANA time zone (league-local dates). */
export function dateInZone(epochMs: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(epochMs));
}
