import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => {
  class EventEmitter<T> {
    private listeners: Array<(e: T) => void> = [];
    readonly event = (listener: (e: T) => void) => {
      this.listeners.push(listener);
      return { dispose: () => { this.listeners = this.listeners.filter((l) => l !== listener); } };
    };
    fire(e: T): void {
      for (const listener of [...this.listeners]) listener(e);
    }
    dispose(): void {
      this.listeners = [];
    }
  }
  return {
    EventEmitter,
    Uri: {
      file: (p: string) => ({ scheme: 'file', fsPath: p, path: p, toString: () => `file://${p}` }),
    },
    Disposable: class Disposable {
      constructor(private readonly fn: () => void) {}
      dispose(): void {
        this.fn();
      }
    },
  };
});

import { fnv1a32 } from '../../src/core/util';
import { LogoCache, type LogoCacheFs } from '../../src/ui/logoCache';

const CACHE_DIR = '/storage/logos';
const PNG_URL = 'https://a.espncdn.com/i/teamlogos/nba/500/scoreboard/sa.png';
const SVG_URL = 'https://assets.nhle.com/logos/nhl/svg/BUF_light.svg';
const SVG_DARK_URL = 'https://assets.nhle.com/logos/nhl/svg/BUF_dark.svg';
/** The exact url probe P17 found rejected: a real PNG served as `binary/octet-stream`. */
const LOL_URL = 'https://static.lolesports.com/teams/1726801573959_539px-T1_2019_full_allmode.png';

const PNG_MAGIC = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_BYTES = new Uint8Array([...PNG_MAGIC, 0x00, 0x01]);

/** A well-formed-enough PNG of exactly `bytes` length: real magic, zero-padded. */
function pngOfSize(bytes: number): Uint8Array {
  const body = new Uint8Array(bytes);
  body.set(PNG_MAGIC, 0);
  return body;
}

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

/** Drain every pending microtask so a scheduled background download has settled. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function makeFs(over: Partial<LogoCacheFs> = {}) {
  return {
    readdir: vi.fn(async (): Promise<string[]> => []),
    readFile: vi.fn(async (): Promise<string> => {
      throw Object.assign(new Error('no such file'), { name: 'ENOENT' });
    }),
    mkdir: vi.fn(async (): Promise<unknown> => undefined),
    writeFile: vi.fn(async (): Promise<void> => undefined),
    rename: vi.fn(async (): Promise<void> => undefined),
    ...over,
  };
}

function response(init: {
  status?: number;
  contentType?: string | null;
  body?: Uint8Array;
  contentLength?: string;
}) {
  const headers = new Map<string, string>();
  if (init.contentType !== null && init.contentType !== undefined) headers.set('content-type', init.contentType);
  if (init.contentLength !== undefined) headers.set('content-length', init.contentLength);
  const body = init.body ?? PNG_BYTES;
  return {
    status: init.status ?? 200,
    headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
    arrayBuffer: vi.fn(async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)),
  };
}

type Harness = {
  cache: LogoCache;
  fetchImpl: ReturnType<typeof vi.fn>;
  fs: ReturnType<typeof makeFs>;
  logs: string[];
};

function makeCache(
  respond: (url: string) => unknown = () => response({ contentType: 'image/png' }),
  fsOver: Partial<LogoCacheFs> = {},
): Harness {
  const logs: string[] = [];
  const fetchImpl = vi.fn(async (url: string, _init?: RequestInit) => respond(url));
  const fs = makeFs(fsOver);
  const cache = new LogoCache({
    cacheDir: CACHE_DIR,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    fs: fs as unknown as LogoCacheFs,
    log: (m) => logs.push(m),
  });
  return { cache, fetchImpl, fs, logs };
}

describe('LogoCache — url validation (§13.4 rules 1–2)', () => {
  it('rejects an http: url instead of upgrading it', async () => {
    const { cache, fetchImpl, logs } = makeCache();
    expect(cache.resolve({ light: 'http://a.espncdn.com/i/teamlogos/nba/500/sa.png' })).toBeUndefined();
    await settle();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(logs.join('\n')).toContain('rejected');
  });

  it('rejects a host that is not on the allowlist, including look-alike subdomains', async () => {
    const { cache, fetchImpl } = makeCache();
    for (const url of [
      'https://evil.example.com/sa.png',
      'https://a.espncdn.com.evil.example/sa.png',
      'https://evil.a.espncdn.com/sa.png',
      'https://espncdn.com/sa.png',
    ]) {
      expect(cache.resolve({ light: url })).toBeUndefined();
    }
    await settle();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects credentials and an explicit port on an allowlisted host', async () => {
    const { cache, fetchImpl } = makeCache();
    expect(cache.resolve({ light: 'https://user:pw@a.espncdn.com/sa.png' })).toBeUndefined();
    expect(cache.resolve({ light: 'https://a.espncdn.com:8443/sa.png' })).toBeUndefined();
    await settle();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('passes redirect: "error" so a redirect cannot leave the allowlist', async () => {
    const { cache, fetchImpl } = makeCache();
    cache.resolve({ light: PNG_URL });
    await settle();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeDefined();
  });
});

describe('LogoCache — content-type early reject (§13.4 rule 3, stage 1)', () => {
  it.each([
    ['text/html'],
    ['text/html; charset=utf-8'],
    ['  TEXT/PLAIN '],
    ['text/xml'],
    ['application/json'],
    ['application/json; charset=utf-8'],
    ['application/xhtml+xml'],
  ])('rejects %s on the headers, without buffering the body', async (contentType) => {
    // The body is a perfectly good PNG: the header alone disqualifies it, and
    // that decision has to be made before arrayBuffer() is ever reached.
    const res = response({ contentType, body: PNG_BYTES });
    const { cache, fs, logs } = makeCache(() => res);
    cache.resolve({ light: PNG_URL });
    await settle();

    expect(res.arrayBuffer).not.toHaveBeenCalled();
    expect(fs.writeFile).not.toHaveBeenCalled();
    expect(cache.resolve({ light: PNG_URL })).toBeUndefined();
    expect(logs.join('\n')).toContain('known-wrong family');
  });

  it('does not early-reject a content-type outside the wrong families', async () => {
    const res = response({ contentType: 'binary/octet-stream', body: PNG_BYTES });
    const { cache } = makeCache(() => res);
    cache.resolve({ light: LOL_URL });
    await settle();
    expect(res.arrayBuffer).toHaveBeenCalledTimes(1);
  });
});

describe('LogoCache — magic-byte sniff (§13.4 rule 3, stage 2)', () => {
  it('accepts a real PNG served as binary/octet-stream (probe P17 regression)', async () => {
    const { cache, fs } = makeCache(() => response({ contentType: 'binary/octet-stream', body: PNG_BYTES }));
    expect(cache.resolve({ light: LOL_URL })).toBeUndefined();
    await settle();

    const name = `${fnv1a32(LOL_URL)}.png`;
    expect(fs.writeFile).toHaveBeenNthCalledWith(1, path.join(CACHE_DIR, `${name}.tmp`), PNG_BYTES);
    expect(cache.resolve({ light: LOL_URL })?.light.fsPath).toBe(path.join(CACHE_DIR, name));
  });

  it('accepts a PNG with no content-type header at all', async () => {
    const { cache } = makeCache(() => response({ contentType: null, body: PNG_BYTES }));
    cache.resolve({ light: PNG_URL });
    await settle();
    expect(cache.resolve({ light: PNG_URL })?.light.fsPath).toBe(
      path.join(CACHE_DIR, `${fnv1a32(PNG_URL)}.png`),
    );
  });

  it('rejects an HTML body claiming to be image/png — the header is not trusted either way', async () => {
    const html = utf8('<!doctype html>\n<html><body>login required</body></html>');
    const { cache, fs, logs } = makeCache(() => response({ contentType: 'image/png', body: html }));
    cache.resolve({ light: PNG_URL });
    await settle();

    expect(fs.writeFile).not.toHaveBeenCalled();
    expect(fs.rename).not.toHaveBeenCalled();
    expect(cache.resolve({ light: PNG_URL })).toBeUndefined();
    expect(logs.join('\n')).toContain('neither a PNG nor an SVG');
  });

  it('rejects bytes that are neither PNG nor SVG, whatever the content-type says', async () => {
    const { cache, fs } = makeCache(() => response({ contentType: 'binary/octet-stream', body: new Uint8Array(64) }));
    cache.resolve({ light: LOL_URL });
    await settle();
    expect(fs.writeFile).not.toHaveBeenCalled();
  });

  it('rejects a truncated PNG signature (7 of the 8 magic bytes)', async () => {
    const { cache, fs } = makeCache(() =>
      response({ contentType: 'image/png', body: PNG_MAGIC.subarray(0, 7) }),
    );
    cache.resolve({ light: PNG_URL });
    await settle();
    expect(fs.writeFile).not.toHaveBeenCalled();
  });

  it('sniffs an SVG behind a UTF-8 BOM and an <?xml declaration', async () => {
    const body = new Uint8Array([
      0xef, 0xbb, 0xbf,
      ...utf8('<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg"/>'),
    ]);
    const { cache } = makeCache(() => response({ contentType: 'image/svg+xml', body }));
    cache.resolve({ light: SVG_URL });
    await settle();
    expect(cache.resolve({ light: SVG_URL })?.light.fsPath).toBe(
      path.join(CACHE_DIR, `${fnv1a32(SVG_URL)}.svg`),
    );
  });

  it('sniffs an SVG behind leading whitespace', async () => {
    const body = utf8('\n\n  \t<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>');
    const { cache } = makeCache(() => response({ contentType: 'binary/octet-stream', body }));
    cache.resolve({ light: SVG_URL });
    await settle();
    expect(cache.resolve({ light: SVG_URL })?.light.fsPath).toBe(
      path.join(CACHE_DIR, `${fnv1a32(SVG_URL)}.svg`),
    );
  });

  it('accepts image/png; charset=utf-8 (parameters are stripped) with PNG bytes', async () => {
    const { cache, fs } = makeCache(() => response({ contentType: '  IMAGE/PNG; charset=utf-8 ' }));
    cache.resolve({ light: PNG_URL });
    await settle();
    expect(fs.rename).toHaveBeenCalledTimes(2); // the image, then the sidecar index
    expect(cache.resolve({ light: PNG_URL })?.light.fsPath).toBe(
      path.join(CACHE_DIR, `${fnv1a32(PNG_URL)}.png`),
    );
  });
});

describe('LogoCache — size cap (§13.4 rule 4)', () => {
  it('accepts a 400 KiB PNG, under the 512 KiB cap', async () => {
    const big = pngOfSize(400 * 1024);
    const { cache, fs } = makeCache(() => response({ contentType: 'image/png', body: big }));
    cache.resolve({ light: PNG_URL });
    await settle();
    expect(fs.writeFile).toHaveBeenNthCalledWith(1, expect.stringContaining('.png.tmp'), big);
    expect(cache.resolve({ light: PNG_URL })?.light.fsPath).toBe(
      path.join(CACHE_DIR, `${fnv1a32(PNG_URL)}.png`),
    );
    // Explicit timeout: this case really does build and hash a 400 KiB buffer, and
    // it is the only test in the suite that does. It fitted inside vitest's 5 s
    // default when the suite ran in ~1.7 s, but the suite now runs ~24 s and this
    // case began timing out on roughly two runs in three under parallel load — a
    // gate that fails at random is worse than no gate, because it teaches you to
    // ignore it. The work itself is unchanged; only the budget is stated.
  }, 30_000);

  it('rejects a 600 KiB PNG, over the 512 KiB cap', async () => {
    const { cache, fs, logs } = makeCache(() =>
      response({ contentType: 'image/png', body: pngOfSize(600 * 1024) }),
    );
    cache.resolve({ light: PNG_URL });
    await settle();
    expect(fs.writeFile).not.toHaveBeenCalled();
    expect(cache.resolve({ light: PNG_URL })).toBeUndefined();
    expect(logs.join('\n')).toContain('exceeds 524288');
  });

  it('rejects an oversize body declared only by content-length, before reading it', async () => {
    const res = response({ contentType: 'image/png', contentLength: '999999' });
    const { cache, fs } = makeCache(() => res);
    cache.resolve({ light: PNG_URL });
    await settle();
    expect(res.arrayBuffer).not.toHaveBeenCalled();
    expect(fs.writeFile).not.toHaveBeenCalled();
  });

  it('rejects an empty body', async () => {
    const { cache, fs } = makeCache(() => response({ contentType: 'image/png', body: new Uint8Array(0) }));
    cache.resolve({ light: PNG_URL });
    await settle();
    expect(fs.writeFile).not.toHaveBeenCalled();
  });
});

describe('LogoCache — response validation (§13.4 rules 3–5)', () => {
  it('rejects a non-200 status', async () => {
    const { cache, fs } = makeCache(() => response({ status: 404, contentType: 'image/png' }));
    cache.resolve({ light: PNG_URL });
    await settle();
    expect(fs.writeFile).not.toHaveBeenCalled();
  });

  it.each([
    ['<script', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'],
    ['<foreignObject', '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><b>x</b></foreignObject></svg>'],
    ['on\\w+=', '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><path d="M0 0"/></svg>'],
  ])('rejects an svg body containing %s', async (_label, svg) => {
    const { cache, fs } = makeCache(() => response({ contentType: 'image/svg+xml', body: utf8(svg) }));
    cache.resolve({ light: SVG_URL });
    await settle();
    expect(fs.writeFile).not.toHaveBeenCalled();
    expect(cache.resolve({ light: SVG_URL })).toBeUndefined();
  });

  it('runs the script guard on a body sniffed as SVG despite an octet-stream label', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
    const { cache, fs, logs } = makeCache(() => response({ contentType: 'binary/octet-stream', body: utf8(svg) }));
    cache.resolve({ light: SVG_URL });
    await settle();
    expect(fs.writeFile).not.toHaveBeenCalled();
    expect(logs.join('\n')).toContain('svg body contains script');
  });

  it('accepts a clean svg', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>';
    const { cache } = makeCache(() => response({ contentType: 'image/svg+xml', body: utf8(svg) }));
    cache.resolve({ light: SVG_URL });
    await settle();
    expect(cache.resolve({ light: SVG_URL })?.light.fsPath).toBe(
      path.join(CACHE_DIR, `${fnv1a32(SVG_URL)}.svg`),
    );
  });

  it('is not fooled by a body read that rejects mid-stream', async () => {
    const { cache, fs, logs } = makeCache(() => ({
      status: 200,
      headers: { get: (n: string) => (n.toLowerCase() === 'content-type' ? 'image/png' : null) },
      arrayBuffer: async () => {
        throw new Error('socket hang up');
      },
    }));
    cache.resolve({ light: PNG_URL });
    await settle();
    expect(fs.writeFile).not.toHaveBeenCalled();
    expect(logs.join('\n')).toContain('socket hang up');
  });
});

describe('LogoCache — filenames and atomic writes (§13.4 rule 6)', () => {
  it('writes to ${hash}.png.tmp then renames, ignoring the url path entirely', async () => {
    const { cache, fs } = makeCache();
    expect(cache.resolve({ light: PNG_URL })).toBeUndefined();
    await settle();

    const name = `${fnv1a32(PNG_URL)}.png`;
    const target = path.join(CACHE_DIR, name);
    expect(fs.mkdir).toHaveBeenCalledWith(CACHE_DIR, { recursive: true });
    expect(fs.writeFile).toHaveBeenNthCalledWith(1, `${target}.tmp`, PNG_BYTES);
    expect(fs.rename).toHaveBeenNthCalledWith(1, `${target}.tmp`, target);
    expect(name).not.toContain('sa');
  });

  it('derives the extension from the sniffed format, not the content-type or the url', async () => {
    // A `.png` url, served with `content-type: image/png`, carrying SVG bytes: lands as `.svg`.
    const { cache } = makeCache(() =>
      response({ contentType: 'image/png', body: utf8('<svg xmlns="http://www.w3.org/2000/svg"></svg>') }),
    );
    cache.resolve({ light: PNG_URL });
    await settle();
    expect(cache.resolve({ light: PNG_URL })?.light.fsPath).toBe(
      path.join(CACHE_DIR, `${fnv1a32(PNG_URL)}.svg`),
    );
  });

  it('writes the sidecar index atomically, mapping url to filename', async () => {
    const { cache, fs } = makeCache();
    cache.resolve({ light: PNG_URL });
    await settle();

    const indexCall = fs.writeFile.mock.calls.find(([p]) => String(p).endsWith('index.json.tmp'));
    expect(indexCall).toBeDefined();
    expect(JSON.parse(new TextDecoder().decode(indexCall![1] as Uint8Array))).toEqual({
      [PNG_URL]: `${fnv1a32(PNG_URL)}.png`,
    });
    expect(fs.rename).toHaveBeenCalledWith(
      path.join(CACHE_DIR, 'index.json.tmp'),
      path.join(CACHE_DIR, 'index.json'),
    );
  });
});

describe('LogoCache — memoization and failure semantics (§13.4 rules 7, 9)', () => {
  it('never refetches a url that failed once this session', async () => {
    const { cache, fetchImpl } = makeCache(() => response({ contentType: 'text/html' }));
    cache.resolve({ light: PNG_URL });
    await settle();
    expect(cache.resolve({ light: PNG_URL })).toBeUndefined();
    cache.resolve({ light: PNG_URL });
    await settle();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('keeps at most one in-flight download per url', async () => {
    const { cache, fetchImpl } = makeCache();
    cache.resolve({ light: PNG_URL });
    cache.resolve({ light: PNG_URL });
    cache.resolve({ light: PNG_URL });
    await settle();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('returns undefined on the first call and the Uri after onDidChange fires', async () => {
    const { cache } = makeCache();
    const fired = new Promise<void>((resolve) => cache.onDidChange(() => resolve()));

    expect(cache.resolve({ light: PNG_URL })).toBeUndefined();
    await fired;

    const resolved = cache.resolve({ light: PNG_URL });
    expect(resolved?.light.fsPath).toBe(path.join(CACHE_DIR, `${fnv1a32(PNG_URL)}.png`));
  });

  it('never throws, awaits, or fetches on the calling stack', async () => {
    const { cache, fetchImpl } = makeCache(() => {
      throw new Error('fetch exploded synchronously');
    });
    expect(cache.resolve({ light: PNG_URL })).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled(); // nothing touched the network during resolve()
    await settle();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(cache.resolve({ light: PNG_URL })).toBeUndefined(); // and it is now negative-cached
  });

  it('survives a malformed LogoRef and a throwing log sink', async () => {
    const cache = new LogoCache({
      cacheDir: CACHE_DIR,
      fetchImpl: (async () => response({ contentType: 'image/png' })) as unknown as typeof fetch,
      fs: makeFs() as unknown as LogoCacheFs,
      log: () => {
        throw new Error('diagnostics channel disposed');
      },
    });
    for (const ref of [undefined, null, {}, { light: 42 }, { light: '' }, { light: 'not a url' }]) {
      expect(() => cache.resolve(ref as never)).not.toThrow();
      expect(cache.resolve(ref as never)).toBeUndefined();
    }
    await settle();
  });
});

describe('LogoCache — light/dark pairing (§13.4 rule 8)', () => {
  it('returns dark identical to light when ref.dark is absent', async () => {
    const { cache } = makeCache();
    cache.resolve({ light: PNG_URL });
    await settle();
    const resolved = cache.resolve({ light: PNG_URL })!;
    expect(resolved.dark).toBe(resolved.light);
  });

  it('never blocks on the dark variant: light resolved + dark pending ⇒ dark = light', async () => {
    const { cache } = makeCache((url) =>
      url === SVG_DARK_URL
        ? new Promise(() => {}) // dark never lands
        : response({ contentType: 'image/svg+xml', body: utf8('<svg/>') }),
    );
    cache.resolve({ light: SVG_URL, dark: SVG_DARK_URL });
    await settle();

    const resolved = cache.resolve({ light: SVG_URL, dark: SVG_DARK_URL })!;
    expect(resolved.light.fsPath).toBe(path.join(CACHE_DIR, `${fnv1a32(SVG_URL)}.svg`));
    expect(resolved.dark).toBe(resolved.light);
    cache.dispose();
  });

  it('returns the dark file once it lands', async () => {
    const { cache } = makeCache(() => response({ contentType: 'image/svg+xml', body: utf8('<svg/>') }));
    cache.resolve({ light: SVG_URL, dark: SVG_DARK_URL });
    await settle();
    const resolved = cache.resolve({ light: SVG_URL, dark: SVG_DARK_URL })!;
    expect(resolved.dark.fsPath).toBe(path.join(CACHE_DIR, `${fnv1a32(SVG_DARK_URL)}.svg`));
    expect(resolved.dark).not.toBe(resolved.light);
  });
});

describe('LogoCache — warmFromDisk (§13.4 rule 10)', () => {
  const name = `${fnv1a32(PNG_URL)}.png`;

  it('adopts a file listed in the index without touching the network', async () => {
    const { cache, fetchImpl } = makeCache(undefined, {
      readdir: vi.fn(async () => [name, 'index.json']),
      readFile: vi.fn(async () => JSON.stringify({ [PNG_URL]: name })),
    });
    await cache.warmFromDisk();
    expect(cache.resolve({ light: PNG_URL })?.light.fsPath).toBe(path.join(CACHE_DIR, name));
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not throw on a corrupt index.json and re-downloads instead', async () => {
    const { cache, fetchImpl } = makeCache(undefined, {
      readdir: vi.fn(async () => [name]),
      readFile: vi.fn(async () => '{ this is not json'),
    });
    await expect(cache.warmFromDisk()).resolves.toBeUndefined();
    expect(cache.resolve({ light: PNG_URL })).toBeUndefined();
    await settle();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['an absent index', { readFile: vi.fn(async (): Promise<string> => { throw new Error('ENOENT'); }) }],
    ['an unreadable directory', { readdir: vi.fn(async (): Promise<string[]> => { throw new Error('EACCES'); }) }],
    ['a non-object index', { readFile: vi.fn(async () => '[1,2,3]') }],
    ['a null index', { readFile: vi.fn(async () => 'null') }],
  ])('does not throw on %s', async (_label, fsOver) => {
    const { cache } = makeCache(undefined, {
      readdir: vi.fn(async () => [name]),
      readFile: vi.fn(async () => JSON.stringify({ [PNG_URL]: name })),
      ...(fsOver as Partial<LogoCacheFs>),
    });
    await expect(cache.warmFromDisk()).resolves.toBeUndefined();
  });

  it('ignores index entries that do not name the file this cache would have written', async () => {
    const { cache } = makeCache(undefined, {
      readdir: vi.fn(async () => [name, 'evil.png', '..', 'stale.png']),
      readFile: vi.fn(async () =>
        JSON.stringify({
          // filename does not match fnv1a32(url) — a tampered index
          [PNG_URL]: 'evil.png',
          // traversal attempt
          [SVG_URL]: '../../../../etc/passwd',
          // url that would never pass validation
          'http://a.espncdn.com/x.png': `${fnv1a32('http://a.espncdn.com/x.png')}.png`,
          // file listed in the index but absent from disk
          [SVG_DARK_URL]: `${fnv1a32(SVG_DARK_URL)}.svg`,
        }),
      ),
    });
    await cache.warmFromDisk();
    expect(cache.resolve({ light: PNG_URL })).toBeUndefined();
    expect(cache.resolve({ light: SVG_URL })).toBeUndefined();
    cache.dispose();
  });
});

describe('LogoCache — P16 (hostile: 200 + text/html + 10 MB body)', () => {
  it('writes nothing, never throws, and never buffers the body', async () => {
    const hostile = response({
      status: 200,
      contentType: 'text/html',
      body: new Uint8Array(10 * 1024 * 1024),
    });
    const { cache, fs, logs } = makeCache(() => hostile);

    expect(() => cache.resolve({ light: PNG_URL })).not.toThrow();
    await settle();

    // The content-type is checked before the body is touched, so the 10 MB
    // never reaches memory.
    expect(hostile.arrayBuffer).not.toHaveBeenCalled();
    expect(fs.writeFile).not.toHaveBeenCalled();
    expect(fs.rename).not.toHaveBeenCalled();
    expect(cache.resolve({ light: PNG_URL })).toBeUndefined();
    expect(logs.join('\n')).toContain('known-wrong family');
  });
});
