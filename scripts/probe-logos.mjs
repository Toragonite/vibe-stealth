// P17: live end-to-end check of the logo pipeline (CONTRACT §13).
// Drives the REAL compiled providers against the REAL APIs, collects every LogoRef
// they emit, and validates each URL against the cache's own rules: https, allowlisted
// host, exact content-type, size cap. A URL a provider emits that the cache would
// reject is a silent "no logo" for the user — this probe makes that loud.
//
// Run: node scripts/probe-logos.mjs
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { createFetchJson } = require('../out/core/http.js');
const { getProviders } = require('../out/providers/index.js');

// Mirrors src/ui/logoCache.ts §13.4 rules 1–5.
const ALLOWED_HOSTS = new Set([
  'a.espncdn.com', 'assets.nhle.com', 'www.mlbstatic.com',
  'static.lolesports.com', 'sports-phinf.pstatic.net', 'cdn.pandascore.co',
]);
const MAX_BYTES = 512 * 1024;
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const SVG_PROLOGUE = new RegExp('^[\\uFEFF\\s]*(?:<\\?xml|<svg)');

/** §13.4 rule 3: content-type is a hint; the bytes decide. */
function isKnownWrongType(raw) {
  const t = (raw ?? '').split(';')[0].trim().toLowerCase();
  return t.startsWith('text/') || t === 'application/json' || t === 'application/xhtml+xml';
}
function sniff(buf) {
  const b = new Uint8Array(buf);
  if (b.length >= 8 && PNG_MAGIC.every((v, i) => b[i] === v)) return 'png';
  const text = new TextDecoder().decode(buf.slice(0, 512));
  return SVG_PROLOGUE.test(text) ? 'svg' : undefined;
}

const ctx = {
  locale: 'en', gameStateEnabled: false, detail: 'summary',
  fetchJson: createFetchJson({ version: 'logo-probe', log: () => {} }),
  getSecret: async () => undefined, log: () => {}, now: () => Date.now(),
};

/** Collect every distinct logo URL a provider emits, tagged by where it came from. */
const found = new Map(); // url -> label

async function collect() {
  for (const p of getProviders()) {
    if (p.requiresSecret) continue;
    let leagues = [];
    try { leagues = await p.listLeagues(ctx); } catch { continue; }
    for (const lg of leagues) {
      if (lg.logo) found.set(lg.logo.light, `${p.id}:${lg.id} league`);
      let games = [];
      try { games = await p.listGames(ctx, lg); } catch { continue; }
      for (const g of games.slice(0, 2)) {
        for (const [side, team] of [['home', g.home], ['away', g.away]]) {
          if (!team.logo) continue;
          found.set(team.logo.light, `${p.id}:${lg.id} ${side} ${team.abbrev} (light)`);
          if (team.logo.dark) found.set(team.logo.dark, `${p.id}:${lg.id} ${side} ${team.abbrev} (dark)`);
        }
      }
    }
  }
}

async function validate(url, label) {
  const problems = [];
  let u;
  try { u = new URL(url); } catch { return ['unparsable URL']; }
  if (u.protocol !== 'https:') problems.push(`scheme ${u.protocol}`);
  if (!ALLOWED_HOSTS.has(u.hostname)) problems.push(`host NOT allowlisted: ${u.hostname}`);
  if (problems.length) return problems; // don't fetch what the cache would refuse

  try {
    const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return [`HTTP ${res.status}`];
    const ct = res.headers.get('content-type') ?? '';
    if (isKnownWrongType(ct)) return [`known-wrong content-type ${ct}`];
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) problems.push(`${buf.byteLength}B > 512KiB`);
    if (buf.byteLength === 0) problems.push('empty body');
    const fmt = sniff(buf);
    if (!fmt) problems.push(`magic-byte sniff: neither PNG nor SVG (content-type ${ct || 'none'})`);
    if (fmt === 'svg') {
      const text = new TextDecoder().decode(buf);
      if (/<script|<foreignObject|on\w+\s*=/i.test(text)) problems.push('SVG script guard tripped');
    }
    if (!problems.length) console.log(`  ok   ${String(buf.byteLength).padStart(6)}B ${(fmt ?? '?').padEnd(4)} ${label}`);
  } catch (e) {
    problems.push(`fetch failed: ${e.name}`);
  }
  return problems;
}

await collect();
console.log(`\ncollected ${found.size} distinct logo URLs from live providers\n`);
if (found.size === 0) { console.log('P17 FAIL — no provider emitted a logo'); process.exit(1); }

let bad = 0;
for (const [url, label] of found) {
  const problems = await validate(url, label);
  if (problems.length) { bad++; console.log(`  FAIL ${label}\n       ${url}\n       ${problems.join('; ')}`); }
}
console.log(bad === 0 ? `\nP17 PASS — all ${found.size} logos pass the cache's rules` : `\nP17 FAIL — ${bad}/${found.size} rejected`);
process.exit(bad ? 1 : 0);
