import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderError } from '../../src/core/contract';
import { createFetchJson } from '../../src/core/http';

const URL = 'https://example.test/api';

type FetchImpl = typeof fetch;

function make(fetchImpl: FetchImpl, log: (m: string) => void = () => {}) {
  return createFetchJson({ version: '0.1.0', log, fetchImpl });
}

const jsonOk = (body: string, init?: ResponseInit): FetchImpl =>
  vi.fn(async () => new Response(body, { status: 200, ...init })) as unknown as FetchImpl;

const status = (code: number, headers?: Record<string, string>): FetchImpl =>
  vi.fn(async () => new Response('nope', { status: code, headers })) as unknown as FetchImpl;

/** Asserts kind and that the thrown value is our error class, not a raw one. */
async function kindOf(p: Promise<unknown>): Promise<ProviderError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ProviderError);
    return err as ProviderError;
  }
  throw new Error('expected a rejection');
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('createFetchJson — happy path', () => {
  it('parses JSON and issues a GET with the pinned headers', async () => {
    const impl = jsonOk('{"a":[1,2]}');
    const fetchJson = make(impl);
    expect(await fetchJson(URL)).toEqual({ a: [1, 2] });

    const [url, init] = (impl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe(URL);
    expect(init.method).toBe('GET');
    expect(init.headers).toMatchObject({
      accept: 'application/json',
      'user-agent': 'vibe-stealth-vscode/0.1.0',
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('lets caller headers override the defaults (Naver pins its own UA)', async () => {
    const impl = jsonOk('1');
    await make(impl)(URL, { 'User-Agent': 'Mozilla/5.0', 'x-api-key': 'k' });
    const [, init] = (impl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(init.headers).toEqual({
      accept: 'application/json',
      'user-agent': 'Mozilla/5.0',
      'x-api-key': 'k',
    });
  });
});

describe('createFetchJson — status mapping', () => {
  it.each([
    [401, 'auth'],
    [403, 'auth'],
    [404, 'not-found'],
    [400, 'unavailable'],
    [402, 'unavailable'],
    [418, 'unavailable'],
    [451, 'unavailable'],
    [500, 'network'],
    [502, 'network'],
    [503, 'network'],
    [302, 'unavailable'],
  ])('%i → %s', async (code, kind) => {
    const err = await kindOf(make(status(code))(URL));
    expect(err.kind).toBe(kind);
  });

  it('never retries', async () => {
    const impl = status(500);
    await kindOf(make(impl)(URL));
    expect(impl).toHaveBeenCalledTimes(1);
  });

  it('logs the failure to the diagnostics sink', async () => {
    const log = vi.fn();
    await kindOf(make(status(404), log)(URL));
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toContain('not-found');
  });

  it('survives a diagnostics sink that throws', async () => {
    const err = await kindOf(
      make(status(404), () => {
        throw new Error('channel disposed');
      })(URL),
    );
    expect(err.kind).toBe('not-found');
  });
});

describe('createFetchJson — 429 Retry-After', () => {
  it('parses integer seconds (P6 feeds this to the poller)', async () => {
    const err = await kindOf(make(status(429, { 'retry-after': '120' }))(URL));
    expect(err.kind).toBe('rate-limit');
    expect(err.retryAfterMs).toBe(120_000);
  });

  it('parses an HTTP-date as max(0, date − now)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse('2026-07-08T00:00:00Z'));
    const future = await kindOf(make(status(429, { 'retry-after': 'Wed, 08 Jul 2026 00:02:00 GMT' }))(URL));
    expect(future.retryAfterMs).toBe(120_000);

    const past = await kindOf(make(status(429, { 'retry-after': 'Tue, 07 Jul 2026 00:00:00 GMT' }))(URL));
    expect(past.retryAfterMs).toBe(0);
  });

  it('treats absent and unparsable values as undefined', async () => {
    expect((await kindOf(make(status(429))(URL))).retryAfterMs).toBeUndefined();
    expect((await kindOf(make(status(429, { 'retry-after': 'soon' }))(URL))).retryAfterMs).toBeUndefined();
    expect((await kindOf(make(status(429, { 'retry-after': '' }))(URL))).retryAfterMs).toBeUndefined();
    expect((await kindOf(make(status(429, { 'retry-after': '   ' }))(URL))).retryAfterMs).toBeUndefined();
    expect((await kindOf(make(status(429, { 'retry-after': '0' }))(URL))).retryAfterMs).toBe(0);
  });

  it('clamps an absurd value rather than overflowing the poller timer', async () => {
    // 10^20 seconds. Parses as digits, so it must be clamped, not dropped.
    const err = await kindOf(make(status(429, { 'retry-after': '1'.padEnd(21, '0') }))(URL));
    expect(err.retryAfterMs).toBe(86_400_000);
  });

  it('never yields a negative or non-finite delay for junk input', async () => {
    // Legacy Date.parse is engine-dependent for these; the invariant is not.
    for (const raw of ['-5', '1.5', '1e3', '+5', 'PT2M', '9'.repeat(400)]) {
      const err = await kindOf(make(status(429, { 'retry-after': raw }))(URL));
      const ms = err.retryAfterMs;
      expect(ms === undefined || (Number.isFinite(ms) && ms >= 0 && ms <= 86_400_000), raw).toBe(true);
    }
  });
});

describe('createFetchJson — body handling', () => {
  it('maps invalid JSON to parse with a ≤300-char payload head (P1)', async () => {
    const body = `{"truncated": [1,2,3${'x'.repeat(500)}`;
    const err = await kindOf(make(jsonOk(body))(URL));
    expect(err.kind).toBe('parse');
    expect(err.payloadHead).toHaveLength(300);
    expect(err.payloadHead).toBe(body.slice(0, 300));
  });

  it('keeps a short payload head short', async () => {
    const err = await kindOf(make(jsonOk('<html>oops</html>'))(URL));
    expect(err.kind).toBe('parse');
    expect(err.payloadHead).toBe('<html>oops</html>');
  });

  it('rejects a body over 16 MiB by BYTE length, not char length', async () => {
    // 6M × 3 bytes = 18 MB > 16 MiB, though only 6M UTF-16 units.
    const big = '가'.repeat(6_000_000);
    const impl = vi.fn(async () => ({
      status: 200,
      headers: new Headers(),
      text: async () => big,
    })) as unknown as FetchImpl;
    const err = await kindOf(make(impl)(URL));
    expect(err.kind).toBe('unavailable');
  });

  it('accepts a body just under the cap', async () => {
    const impl = vi.fn(async () => ({
      status: 200,
      headers: new Headers(),
      text: async () => `"${'a'.repeat(1_000_000)}"`,
    })) as unknown as FetchImpl;
    expect(await make(impl)(URL)).toHaveLength(1_000_000);
  });

  it('maps a body-read failure to network (the read is inside the timeout window)', async () => {
    const impl = vi.fn(async () => ({
      status: 200,
      headers: new Headers(),
      text: async () => {
        throw new TypeError('terminated');
      },
    })) as unknown as FetchImpl;
    const err = await kindOf(make(impl)(URL));
    expect(err.kind).toBe('network');
    expect(err.message).toContain('body read failed');
  });
});

describe('createFetchJson — transport failures', () => {
  it('maps a rejected fetch to network', async () => {
    const impl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as FetchImpl;
    expect((await kindOf(make(impl)(URL))).kind).toBe('network');
  });

  it('aborts after 10 s and maps the abort to network', async () => {
    vi.useFakeTimers();
    let seen: AbortSignal | undefined;
    const impl = vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          seen = init?.signal ?? undefined;
          seen?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    ) as unknown as FetchImpl;

    const pending = kindOf(make(impl)(URL));
    await vi.advanceTimersByTimeAsync(9_999);
    expect(seen?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(seen?.aborted).toBe(true);

    const err = await pending;
    expect(err.kind).toBe('network');
    expect(err.message).toContain('timeout after 10000ms');
  });

  it('clears the abort timer on success (no dangling handle)', async () => {
    vi.useFakeTimers();
    await make(jsonOk('true'))(URL);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('wraps a fetchImpl that returns garbage instead of crashing', async () => {
    const impl = vi.fn(async () => undefined) as unknown as FetchImpl;
    expect((await kindOf(make(impl)(URL))).kind).toBe('network');
  });
});
