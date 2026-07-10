/**
 * The one and only network boundary (docs/CONTRACT.md §1, §9).
 *
 * GET + JSON only. Throws `ProviderError` and nothing else. No retries — the
 * poller (§4) owns retry policy, so a retry here would silently double the
 * request rate against unofficial endpoints.
 */

import { ProviderError } from './contract';

const TIMEOUT_MS = 10_000;
/**
 * §1 pins 16 MiB. The JSDoc on `ProviderContext.fetchJson` in contract.ts says
 * 8 MiB; CONTRACT.md is the behavioral pin and wins.
 */
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const PAYLOAD_HEAD_CHARS = 300;
/** A hostile `Retry-After` must not overflow the poller's timer. */
const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

type FetchResponse = Awaited<ReturnType<typeof fetch>>;

export function createFetchJson(opts: {
  version: string;
  log(msg: string): void;
  fetchImpl?: typeof fetch;
}): (url: string, headers?: Record<string, string>) => Promise<unknown> {
  const doFetch: typeof fetch = opts.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  const userAgent = `vibe-stealth-vscode/${opts.version}`;

  return async function fetchJson(url: string, headers?: Record<string, string>): Promise<unknown> {
    try {
      return await request(doFetch, userAgent, url, headers);
    } catch (err) {
      const wrapped =
        err instanceof ProviderError
          ? err
          : new ProviderError('network', `GET ${url} failed: ${describe(err)}`);
      safeLog(opts.log, `http ${wrapped.kind}: GET ${url} — ${wrapped.message}`);
      throw wrapped;
    }
  };
}

async function request(
  doFetch: typeof fetch,
  userAgent: string,
  url: string,
  extra?: Record<string, string>,
): Promise<unknown> {
  const controller = new AbortController();
  // The timeout window spans the connection AND the full body read (§1).
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    let res: FetchResponse;
    try {
      res = await doFetch(url, {
        method: 'GET',
        headers: buildHeaders(userAgent, extra),
        signal: controller.signal,
        redirect: 'follow',
      });
    } catch (err) {
      throw new ProviderError('network', `GET ${url} failed: ${describe(err)}`);
    }

    const status = res.status;
    if (status < 200 || status >= 300) throw mapStatus(status, res, url);

    let text: string;
    try {
      text = await res.text();
    } catch (err) {
      throw new ProviderError('network', `GET ${url} body read failed: ${describe(err)}`);
    }

    const bytes = utf8ByteLength(text);
    if (bytes > MAX_BODY_BYTES) {
      throw new ProviderError('unavailable', `GET ${url} body ${bytes} bytes exceeds ${MAX_BODY_BYTES}`);
    }

    try {
      return JSON.parse(text) as unknown;
    } catch (err) {
      throw new ProviderError(
        'parse',
        `GET ${url} returned invalid JSON: ${describe(err)}`,
        undefined,
        text.slice(0, PAYLOAD_HEAD_CHARS),
      );
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Caller extras override the defaults (Naver pins its own user-agent, §2.5). */
function buildHeaders(userAgent: string, extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    'user-agent': userAgent,
  };
  if (extra !== null && typeof extra === 'object') {
    for (const [key, value] of Object.entries(extra)) {
      if (key !== '' && typeof value === 'string') headers[key.toLowerCase()] = value;
    }
  }
  return headers;
}

/** 3xx (after redirect following) and 1xx have no pinned mapping — 'unavailable'. */
function mapStatus(status: number, res: FetchResponse, url: string): ProviderError {
  const where = `GET ${url} → HTTP ${status}`;
  if (status === 401 || status === 403) return new ProviderError('auth', where);
  if (status === 404) return new ProviderError('not-found', where);
  if (status === 429) {
    return new ProviderError('rate-limit', where, parseRetryAfter(headerOf(res, 'retry-after'), Date.now()));
  }
  if (status >= 500) return new ProviderError('network', where);
  return new ProviderError('unavailable', where);
}

function headerOf(res: FetchResponse, name: string): string | null {
  try {
    return res.headers.get(name);
  } catch {
    return null;
  }
}

/**
 * `Retry-After` is either integer seconds or an HTTP-date. Anything else — and
 * anything absurd enough to overflow a timer — is treated as absent.
 */
function parseRetryAfter(raw: string | null, nowMs: number): number | undefined {
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim();
  if (value === '') return undefined;

  let ms: number;
  if (/^\d+$/.test(value)) {
    ms = Number(value) * 1000;
  } else {
    const at = Date.parse(value);
    if (!Number.isFinite(at)) return undefined;
    ms = at - nowMs;
  }
  if (!Number.isFinite(ms)) return undefined;
  return Math.min(Math.max(0, Math.round(ms)), MAX_RETRY_AFTER_MS);
}

function utf8ByteLength(s: string): number {
  return typeof Buffer !== 'undefined' ? Buffer.byteLength(s, 'utf8') : new TextEncoder().encode(s).length;
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === 'AbortError' || err.name === 'TimeoutError') return `timeout after ${TIMEOUT_MS}ms`;
    return `${err.name}: ${err.message}`;
  }
  return String(err);
}

function safeLog(log: (msg: string) => void, message: string): void {
  try {
    log(message);
  } catch {
    /* a broken diagnostics sink must never mask the real error */
  }
}
