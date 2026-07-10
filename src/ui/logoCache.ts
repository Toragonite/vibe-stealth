/**
 * The extension's only image downloader (docs/CONTRACT.md §13.4).
 *
 * VS Code will not render a remote `https:` icon on a tree item, so every logo
 * is fetched once, validated, written under `globalStorageUri/logos/`, and then
 * handed to the tree as a `file:` Uri.
 *
 * This module is a security boundary. Nothing here trusts the URL it is given,
 * the bytes that come back, or the headers that describe them: `https:` only, a
 * static host allowlist, no redirects, a magic-byte sniff that decides the
 * format, a 512 KiB cap, a script guard on SVG, and a filename derived from a
 * hash of the URL rather than from its path.
 *
 * It is also best-effort. Every failure path ends the same way — log it,
 * remember the URL as dead for this session, return `undefined`, and let the
 * tree keep the icon it already has. A logo never breaks, blocks or errors the
 * tree (§13.4, §7).
 */

import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';

import type { LogoRef } from '../core/contract';
import { fnv1a32 } from '../core/util';

/** §13.4 rule 2. Exact hostname match — no wildcards, no parent-domain suffixes. */
const ALLOWED_HOSTS: ReadonlySet<string> = new Set([
  'a.espncdn.com',
  'assets.nhle.com',
  'www.mlbstatic.com',
  'static.lolesports.com',
  'sports-phinf.pstatic.net',
  'cdn.pandascore.co',
]);

/**
 * §13.4 rule 3, stage 1. Media types that cannot be one of our images, rejected
 * on the response headers alone so the body is never buffered (probe P16).
 *
 * This is NOT an accept-list inverted. `content-type` is a hint the server can
 * get wrong in either direction: `static.lolesports.com` labels genuine PNGs
 * `binary/octet-stream` (probe P17), and a hostile host can just as easily claim
 * `image/png` for an HTML body. A type absent from this set has earned nothing
 * but the right to be sniffed.
 */
const KNOWN_WRONG_TYPES: ReadonlySet<string> = new Set(['application/json', 'application/xhtml+xml']);
const KNOWN_WRONG_PREFIX = 'text/';

/** §13.4 rule 3, stage 2. The eight bytes that open every PNG. */
const PNG_MAGIC: readonly number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * §13.4 rule 3, stage 2. An SVG body, once a BOM and leading whitespace are
 * trimmed, opens with the XML declaration or the root element. Case-sensitive:
 * XML is, and `<SVG` is not an SVG.
 */
const SVG_PROLOGUE = new RegExp('^[\\uFEFF\\s]*(?:<\\?xml|<svg)');

/** §13.4 rule 4. Observed logos are 1.5 KB–377 KB (the LoL LYON crest); this leaves headroom. */
const MAX_BODY_BYTES = 512 * 1024;

/** §13.4 rule 4 / §1: the window spans the connection AND the full body read. */
const TIMEOUT_MS = 10_000;

/** §13.4 rule 5. A remote logo has no business carrying script. */
const SVG_SCRIPT_GUARD = /<script|<foreignObject|on\w+\s*=/i;

/** Sidecar mapping url → filename; a hash alone cannot recover the url it came from. */
const INDEX_FILE = 'index.json';

/** The only filenames `warmFromDisk` will adopt: `${fnv1a32(url)}.${'png'|'svg'}`. */
const CACHE_FILE_NAME = /^[0-9a-f]{8}\.(?:png|svg)$/;

/**
 * The filesystem surface this module uses, narrowed so tests can inject a fake.
 *
 * `readFile` is required by §13.4 rule 10 (the sidecar index is read back at
 * startup). `fs` is optional and only tests pass it.
 */
export interface LogoCacheFs {
  readdir(dir: string): Promise<string[]>;
  readFile(p: string): Promise<string>;
  mkdir(dir: string, o: { recursive: true }): Promise<unknown>;
  writeFile(p: string, data: Uint8Array): Promise<void>;
  rename(a: string, b: string): Promise<void>;
}

export interface LogoCacheDeps {
  /** Absolute path of the cache directory (the UI passes context.globalStorageUri.fsPath + '/logos'). */
  cacheDir: string;
  /** Injected for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injected for tests. Defaults to node:fs/promises. */
  fs?: LogoCacheFs;
  log(message: string): void;
}

/** A download the tree has already asked for; both handles are needed to cancel it. */
interface Inflight {
  controller?: AbortController;
  timer?: ReturnType<typeof setTimeout>;
}

const nodeFs: LogoCacheFs = {
  readdir: (dir) => fsp.readdir(dir),
  readFile: (p) => fsp.readFile(p, 'utf8'),
  mkdir: (dir, o) => fsp.mkdir(dir, o),
  writeFile: (p, data) => fsp.writeFile(p, data),
  rename: (a, b) => fsp.rename(a, b),
};

export class LogoCache implements vscode.Disposable {
  private readonly cacheDir: string;
  private readonly doFetch: typeof fetch;
  private readonly fs: LogoCacheFs;
  private readonly log: (message: string) => void;

  private readonly emitter = new vscode.EventEmitter<void>();
  /** Fires when a background download lands, so the tree can re-render. */
  readonly onDidChange: vscode.Event<void> = this.emitter.event;

  /** §13.4 rule 7: resolved urls, dead urls, and the one in-flight download per url. */
  private readonly hits = new Map<string, vscode.Uri>();
  private readonly failed = new Set<string>();
  private readonly inflight = new Map<string, Inflight>();

  /** Serializes sidecar writes so two landing downloads cannot interleave on the tmp file. */
  private indexWrites: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(deps: LogoCacheDeps) {
    this.cacheDir = deps.cacheDir;
    this.doFetch = deps.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
    this.fs = deps.fs ?? nodeFs;
    this.log = deps.log;
  }

  /**
   * SYNCHRONOUS (§13.5): the tree calls this from `getTreeItem`. A hit returns
   * file Uris; a miss returns `undefined` and schedules a background download
   * that will fire `onDidChange`. Never throws, never awaits, and never touches
   * the network on the calling stack.
   */
  resolve(ref: LogoRef): { light: vscode.Uri; dark: vscode.Uri } | undefined {
    try {
      if (this.disposed) return undefined;
      if (ref === null || typeof ref !== 'object') return undefined;

      const light = this.lookup(ref.light);
      // Kick the dark variant off too, but never wait on it (rule 8).
      const darkUri = typeof ref.dark === 'string' ? this.lookup(ref.dark) : undefined;

      if (light === undefined) return undefined;
      return { light, dark: darkUri ?? light };
    } catch (err) {
      this.safeLog(`logo: resolve failed — ${describe(err)}`);
      return undefined;
    }
  }

  /**
   * Adopt files a previous session downloaded: readdir for what actually exists,
   * the sidecar index for which url each file belongs to. No network. A missing
   * or corrupt index is an empty cache, never an error (§13.4 rule 10).
   */
  async warmFromDisk(): Promise<void> {
    if (this.disposed) return;
    let adopted = 0;
    try {
      const present = new Set(await this.fs.readdir(this.cacheDir));
      const raw = await this.fs.readFile(path.join(this.cacheDir, INDEX_FILE));
      const parsed: unknown = JSON.parse(raw);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return;

      for (const [url, name] of Object.entries(parsed as Record<string, unknown>)) {
        // A tampered index must not be able to point a url at an arbitrary path:
        // the name has to be exactly the one this cache would have written.
        if (typeof name !== 'string' || !present.has(name)) continue;
        if (!CACHE_FILE_NAME.test(name) || !name.startsWith(`${fnv1a32(url)}.`)) continue;
        if (validateUrl(url) === undefined) continue;
        this.hits.set(url, vscode.Uri.file(path.join(this.cacheDir, name)));
        adopted++;
      }
    } catch (err) {
      this.safeLog(`logo: cache warm skipped — ${describe(err)}`);
      return;
    }
    if (adopted > 0) {
      this.safeLog(`logo: adopted ${adopted} cached logo(s)`);
      this.fire();
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const pending of this.inflight.values()) {
      pending.controller?.abort();
      // A fetch that never settles would otherwise hold its abort timer — and
      // the event loop — for the full 10 s after the extension is torn down.
      if (pending.timer !== undefined) clearTimeout(pending.timer);
    }
    this.inflight.clear();
    this.emitter.dispose();
  }

  /** Cache hit, or `undefined` plus (at most) one scheduled download. Never throws. */
  private lookup(url: unknown): vscode.Uri | undefined {
    if (typeof url !== 'string' || url === '') return undefined;

    const hit = this.hits.get(url);
    if (hit !== undefined) return hit;
    // rule 7: a url that failed once is dead for the session — no retry storms.
    if (this.failed.has(url) || this.inflight.has(url)) return undefined;

    // Scheme and host are checked here, on the calling stack, so a bad url never
    // reaches fetch at all (rules 1 and 2).
    if (validateUrl(url) === undefined) {
      this.reject(url, 'url is not https, or host is not on the allowlist');
      return undefined;
    }

    this.inflight.set(url, {});
    // Not `void this.download(url)`: that would run fetch's synchronous prelude
    // on the tree's render stack. §13.5 says resolve() never touches the network.
    queueMicrotask(() => {
      void this.download(url);
    });
    return undefined;
  }

  private async download(url: string): Promise<void> {
    if (this.disposed) {
      this.inflight.delete(url);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    this.inflight.set(url, { controller, timer });

    try {
      const res = await this.doFetch(url, {
        method: 'GET',
        headers: { accept: 'image/png,image/svg+xml' },
        signal: controller.signal,
        // rule 2: a redirect cannot smuggle us off the allowlist. It is an error.
        redirect: 'error',
      });

      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);

      const contentType = res.headers.get('content-type');
      if (isKnownWrongType(contentType)) {
        // rule 3 stage 1, checked BEFORE the body is read: a hostile 10 MB
        // text/html response is rejected without ever being buffered (probe P16).
        throw new Error(`content-type ${JSON.stringify(contentType)} is a known-wrong family for an image`);
      }

      const declared = Number(res.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
        throw new Error(`content-length ${declared} exceeds ${MAX_BODY_BYTES}`);
      }

      // Under the same signal as the request, so the 10 s window spans the read.
      const body = new Uint8Array(await res.arrayBuffer());
      if (body.byteLength === 0) throw new Error('empty body');
      if (body.byteLength > MAX_BODY_BYTES) {
        throw new Error(`body ${body.byteLength} bytes exceeds ${MAX_BODY_BYTES}`);
      }

      // rule 3 stage 2: the bytes decide the format. Reaching here means only
      // that the header was not disqualifying — it is never evidence of a type.
      let ext: 'png' | 'svg';
      if (hasPngMagic(body)) {
        ext = 'png';
      } else {
        const text = new TextDecoder().decode(body);
        if (!SVG_PROLOGUE.test(text)) {
          throw new Error('body is neither a PNG nor an SVG (magic-byte sniff)');
        }
        // rule 5, on a body already sniffed as SVG.
        if (SVG_SCRIPT_GUARD.test(text)) {
          throw new Error('svg body contains script, foreignObject or an event handler attribute');
        }
        ext = 'svg';
      }

      if (this.disposed) return;

      // rule 6: the name comes from a hash of the url and the SNIFFED format —
      // never from the url's path, which the remote controls.
      const name = `${fnv1a32(url)}.${ext}`;
      const target = path.join(this.cacheDir, name);
      const tmp = `${target}.tmp`;
      await this.fs.mkdir(this.cacheDir, { recursive: true });
      await this.fs.writeFile(tmp, body);
      await this.fs.rename(tmp, target);

      this.hits.set(url, vscode.Uri.file(target));
      this.safeLog(`logo: cached ${url} → ${name} (${body.byteLength} B)`);
      this.queueIndexWrite();
      this.fire();
    } catch (err) {
      this.reject(url, describe(err));
    } finally {
      clearTimeout(timer);
      this.inflight.delete(url);
    }
  }

  /** Negative-cache a url for the rest of the session and say why (rule 7). */
  private reject(url: string, reason: string): void {
    this.failed.add(url);
    this.safeLog(`logo: rejected ${url} — ${reason}`);
  }

  /** Rewrite the whole sidecar index; failures are logged and forgotten. */
  private queueIndexWrite(): void {
    const dir = this.cacheDir;
    // Nothing in here may reject: a rejected link would poison the chain and
    // silently skip every later index write.
    this.indexWrites = this.indexWrites.then(async () => {
      if (this.disposed) return;
      try {
        const entries: Record<string, string> = {};
        for (const [url, uri] of this.hits) entries[url] = path.basename(uri.fsPath);
        const target = path.join(dir, INDEX_FILE);
        const tmp = `${target}.tmp`;
        await this.fs.writeFile(tmp, new TextEncoder().encode(JSON.stringify(entries)));
        await this.fs.rename(tmp, target);
      } catch (err) {
        this.safeLog(`logo: index write failed — ${describe(err)}`);
      }
    });
  }

  private fire(): void {
    try {
      this.emitter.fire();
    } catch (err) {
      this.safeLog(`logo: onDidChange listener threw — ${describe(err)}`);
    }
  }

  private safeLog(message: string): void {
    try {
      this.log(message);
    } catch {
      /* a broken diagnostics sink must never mask the real error */
    }
  }
}

/** rules 1 + 2. Also rejects embedded credentials and an explicit port. */
function validateUrl(url: string): URL | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  // Note: an `http:` url is REJECTED, not upgraded. Providers upgrade (§13.3).
  if (parsed.protocol !== 'https:') return undefined;
  if (!ALLOWED_HOSTS.has(parsed.hostname)) return undefined;
  if (parsed.port !== '' || parsed.username !== '' || parsed.password !== '') return undefined;
  return parsed;
}

/** rule 3 stage 1: strip `;` parameters, trim, lowercase, then match the wrong families. */
function isKnownWrongType(raw: string | null): boolean {
  if (typeof raw !== 'string') return false;
  const essence = raw.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (essence === '') return false;
  return essence.startsWith(KNOWN_WRONG_PREFIX) || KNOWN_WRONG_TYPES.has(essence);
}

/** rule 3 stage 2: `89 50 4E 47 0D 0A 1A 0A`, and nothing shorter. */
function hasPngMagic(body: Uint8Array): boolean {
  if (body.byteLength < PNG_MAGIC.length) return false;
  return PNG_MAGIC.every((byte, i) => body[i] === byte);
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === 'AbortError' || err.name === 'TimeoutError') return `timeout after ${TIMEOUT_MS}ms`;
    return `${err.name}: ${err.message}`;
  }
  return String(err);
}
