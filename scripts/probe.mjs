// Gate-3 runtime verification: drives the COMPILED pipeline (providers →
// RelayEngine → formatter) against the real APIs. Run: node scripts/probe.mjs
// Verification instrument — not shipped (scripts/ is .vscodeignored).
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { createFetchJson } = require('../out/core/http.js');
const { createRelayEngine } = require('../out/core/relay.js');
const { formatEventLine } = require('../out/core/format.js');
const { getProviders } = require('../out/providers/index.js');

const ctx = {
  locale: 'ko',
  fetchJson: createFetchJson({ version: '0.1.0-probe', log: (m) => console.error('[http]', m) }),
  getSecret: async () => undefined,
  log: (m) => console.error('[diag]', m),
  now: () => Date.now(),
};

const wanted = {
  naver: ['kbo', 'kleague'],
  lolesports: ['msi', 'lck'],
  mlb: ['mlb'],
  nhl: ['nhl'],
  espn: ['fifa.world', 'usa.1', 'nba'],
};

let failures = 0;
for (const p of getProviders()) {
  if (p.requiresSecret) {
    console.log(`\n=== ${p.id}: skipped (requires secret)`);
    continue;
  }
  try {
    const leagues = await p.listLeagues(ctx);
    console.log(`\n=== ${p.id}: ${leagues.length} leagues`);
    for (const lid of wanted[p.id] ?? []) {
      const league = leagues.find((l) => l.id === lid);
      if (!league) {
        console.log(`  ! league ${lid} MISSING`);
        failures++;
        continue;
      }
      try {
        const games = await p.listGames(ctx, league);
        console.log(
          `  [${lid}] ${games.length} games: ` +
            games
              .slice(0, 4)
              .map(
                (g) =>
                  `${g.away.abbrev} ${g.away.score ?? '–'}:${g.home.score ?? '–'} ${g.home.abbrev} (${g.phase}/${g.statusShort})`,
              )
              .join(' | '),
        );
        const pick =
          games.find((g) => g.phase === 'in') ??
          games.find((g) => g.phase === 'post') ??
          games[0];
        if (!pick) continue;
        const snap = await p.fetchPlays(ctx, pick);
        const engine = createRelayEngine({ backfillLimit: 5, locale: 'ko' });
        const em = engine.ingest(snap);
        console.log(
          `  [${lid}] picked ${pick.id} (${pick.phase}) → ${snap.events.length} events, emitted ${em.events.length} lines`,
        );
        for (const e of em.events.slice(-7)) {
          console.log(
            '    ' +
              formatEventLine(e, em.game, {
                locale: 'ko',
                showEmoji: true,
                multiGame: false,
                now: () => Date.now(),
              }),
          );
        }
      } catch (err) {
        console.log(`  [${lid}] ERROR ${err?.name}/${err?.kind ?? ''}: ${err?.message}`);
        failures++;
      }
    }
  } catch (err) {
    console.log(`\n=== ${p.id}: listLeagues ERROR ${err?.name}/${err?.kind ?? ''}: ${err?.message}`);
    failures++;
  }
}
console.log(`\nprobe done, failures: ${failures}`);
process.exit(failures > 0 ? 1 : 0);
