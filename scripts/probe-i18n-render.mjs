// P15: render every provider-COMPOSED line through the PRODUCTION i18n registry.
//
// Why this exists: provider unit tests register their own i18n templates, which hides
// param-name drift between src/core/i18n.ts and a provider's t() call. That drift ships
// raw `{placeholder}` text to users while the whole test suite stays green. This probe
// loads the real registry and the real compiled providers, so it cannot be fooled.
//
// Run: node scripts/probe-i18n-render.mjs
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { readFileSync } = require('fs');
const { mlbProvider } = require('../out/providers/mlb.js');
const { nhlProvider } = require('../out/providers/nhl.js');
const { espnProvider } = require('../out/providers/espn.js');

const load = (f) => JSON.parse(readFileSync(new URL(`../test/fixtures/${f}`, import.meta.url), 'utf8'));
const ctx = (locale, payload) => ({
  locale, gameStateEnabled: false, detail: 'detailed',
  now: () => 0, log: () => {}, getSecret: async () => undefined, fetchJson: async () => payload,
});
const G = (o) => ({
  id: 'x:y:1', providerId: 'p', leagueId: 'l', leagueName: 'L', sport: 'baseball',
  startTimeUtc: undefined, phase: 'in', statusText: 's', statusShort: 's',
  home: { id: 'h', name: 'H', abbrev: 'HOM', score: 0 },
  away: { id: 'a', name: 'A', abbrev: 'AWY', score: 0 }, ...o,
});

const cases = [
  ['MLB pitches', mlbProvider, load('mlb-pitch-events.json'), G({ providerId: 'mlb', leagueId: 'mlb', sport: 'baseball' })],
  ['NHL detailed', nhlProvider, load('nhl-play-by-play.json'), G({ providerId: 'nhl', leagueId: 'nhl', sport: 'hockey' })],
  ['soccer keyEvents', espnProvider, load('espn-summary-soccer-post.json'), G({ providerId: 'espn', leagueId: 'fifa.world', sport: 'soccer' })],
];

let defects = 0;
for (const [name, prov, payload, game] of cases) {
  const en = (await prov.fetchPlays(ctx('en', payload), game)).events.map((e) => e.text);
  const ko = (await prov.fetchPlays(ctx('ko', payload), game)).events.map((e) => e.text);

  const placeholders = [...en, ...ko].filter((t) => /\{[a-zA-Z]+\}/.test(t));
  // A provider that composes text must produce SOME ko line differing from its en twin.
  // (API prose lines are identical by design — we only require at least one difference.)
  const localizes = en.some((t, i) => t !== ko[i]);

  console.log(`${name}: ${en.length} events`);
  console.log(`   raw placeholders: ${placeholders.length}${placeholders.length ? '  ← ' + placeholders[0] : ''}`);
  console.log(`   ko differs from en: ${localizes}${localizes ? '' : '  ← localization NOT applied'}`);
  console.log(`   en: ${(en[0] ?? '(none)').slice(0, 64)}`);
  console.log(`   ko: ${(ko[0] ?? '(none)').slice(0, 64)}`);
  if (placeholders.length) defects++;
  if (!localizes) defects++;
}

console.log(defects === 0 ? '\nP15 PASS — no raw placeholders, every provider localizes' : `\nP15 FAIL — ${defects} defect(s)`);
process.exit(defects ? 1 : 0);
