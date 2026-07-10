// Live end-to-end probe of the §11 game-state pipeline: real APIs → compiled
// providers → PlaySnapshot.state. Run: node scripts/probe-state.mjs
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { createFetchJson } = require('../out/core/http.js');
const { mlbProvider } = require('../out/providers/mlb.js');
const { espnProvider } = require('../out/providers/espn.js');
const { lolesportsProvider } = require('../out/providers/lolesports.js');

const ctx = {
  locale: 'en',
  gameStateEnabled: true,
  fetchJson: createFetchJson({ version: 'state-probe', log: () => {} }),
  getSecret: async () => undefined,
  log: (m) => console.error('  [diag]', m),
  now: () => Date.now(),
};

const pickLive = (games) => games.find((g) => g.phase === 'in');

(async () => {
  // ---- MLB: bases / count / lineup ----
  console.log('=== MLB ===');
  const mlbLeagues = await mlbProvider.listLeagues(ctx);
  const mlbGames = await mlbProvider.listGames(ctx, mlbLeagues[0]);
  const mlbLive = pickLive(mlbGames);
  if (mlbLive) {
    const snap = await mlbProvider.fetchPlays(ctx, mlbLive);
    const s = snap.state;
    console.log(`  ${mlbLive.away.abbrev} ${mlbLive.away.score}:${mlbLive.home.score} ${mlbLive.home.abbrev} (${mlbLive.statusShort})`);
    if (s?.kind === 'baseball') {
      const bases = [s.bases.first && `1B ${s.bases.first}`, s.bases.second && `2B ${s.bases.second}`, s.bases.third && `3B ${s.bases.third}`].filter(Boolean).join(' · ') || '(empty)';
      console.log(`  count ${s.balls}-${s.strikes} · ${s.outs} out`);
      console.log(`  bases: ${bases}`);
      console.log(`  at bat: ${s.atBat ?? '–'}   pitcher: ${s.pitcher ?? '–'}`);
      console.log(`  home lineup (${s.lineups.home.length}): ${s.lineups.home.slice(0, 3).map((l) => `${l.order} ${l.position} ${l.name}`).join(' | ')}${s.lineups.home.length > 3 ? ' …' : ''}`);
    } else console.log('  NO baseball state:', s);
  } else console.log('  (no live MLB game right now)');

  // ---- ESPN soccer: formation / XI ----
  console.log('\n=== ESPN soccer ===');
  const espnLeagues = await espnProvider.listLeagues(ctx);
  let soccerShown = false;
  for (const lg of espnLeagues.filter((l) => l.sport === 'soccer')) {
    const games = await espnProvider.listGames(ctx, lg);
    const live = pickLive(games);
    if (!live) continue;
    const snap = await espnProvider.fetchPlays(ctx, live);
    console.log(`  [${lg.id}] ${live.away.abbrev} ${live.away.score}:${live.home.score} ${live.home.abbrev}`);
    const s = snap.state;
    if (s?.kind === 'soccer') {
      console.log(`  home ${s.home.formation ?? '?'} · ${s.home.starters.length} starters: ${s.home.starters.slice(0, 3).map((p) => `${p.position} ${p.name}`).join(', ')} …`);
      console.log(`  away ${s.away.formation ?? '?'} · ${s.away.starters.length} starters`);
    } else console.log('  NO soccer state (lineups not posted?):', s?.kind ?? s);
    soccerShown = true;
    break;
  }
  if (!soccerShown) console.log('  (no live soccer game with lineups right now)');

  // ---- LoL: draft ----
  console.log('\n=== LoL Esports ===');
  const lolLeagues = await lolesportsProvider.listLeagues(ctx);
  let lolShown = false;
  for (const lg of lolLeagues) {
    const games = await lolesportsProvider.listGames(ctx, lg);
    const live = pickLive(games);
    if (!live) continue;
    const snap = await lolesportsProvider.fetchPlays(ctx, live);
    console.log(`  [${lg.id}] ${live.away.abbrev} ${live.away.score}:${live.home.score} ${live.home.abbrev}`);
    const s = snap.state;
    if (s?.kind === 'esports') {
      console.log(`  patch ${s.patch ?? '?'}`);
      console.log(`  Blue ${s.blue.teamCode}: ${s.blue.picks.map((p) => `${p.champion}`).join(' / ')}`);
      console.log(`  Red  ${s.red.teamCode}: ${s.red.picks.map((p) => `${p.champion}`).join(' / ')}`);
      if (s.gold) console.log(`  gold: blue ${s.gold.blue} / red ${s.gold.red}`);
    } else console.log('  NO draft state (picks not locked / no live game):', s?.kind ?? s);
    lolShown = true;
    break;
  }
  if (!lolShown) console.log('  (no live LoL game right now — draft only shows during a live game)');
})().catch((e) => { console.error('PROBE FAILED:', e); process.exit(1); });
