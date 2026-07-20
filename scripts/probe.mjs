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
  espn: ['fifa.world', 'usa.1', 'nba', 'ufc', 'cricket', 'mens-college-basketball'],
  // §14 additions. Tennis is two-sided; racing is the first 'field' contest.
  'espn-tennis': ['atp', 'wta'],
  'espn-racing': ['f1'],
};

/**
 * §14 invariant check, run against every LIVE game the probe sees: a game is
 * EITHER 'versus' with both sides, OR 'field' with a non-empty entrants list.
 * A provider that violates the pairing produces rows the UI is entitled to drop,
 * so catching it here — against real upstream payloads — is the point.
 */
function checkFormatInvariant(g) {
  if (g.format === 'versus') {
    if (!g.home || !g.away) return `versus game missing a side (home=${!!g.home} away=${!!g.away})`;
    if (g.entrants !== undefined) return 'versus game carries entrants';
    return undefined;
  }
  if (g.format === 'field') {
    if (!Array.isArray(g.entrants) || g.entrants.length === 0) return 'field game with empty/absent entrants';
    if (g.home !== undefined || g.away !== undefined) return 'field game carries home/away';
    const bad = g.entrants.find(
      (e) => e.position !== undefined && !(Number.isInteger(e.position) && e.position >= 1 && e.position <= 9999),
    );
    if (bad) return `entrant position out of [1,9999]: ${bad.position}`;
    return undefined;
  }
  return `unknown format ${JSON.stringify(g.format)}`;
}

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
        for (const g of games) {
          const violation = checkFormatInvariant(g);
          if (violation) {
            console.log(`  ! [${lid}] §14 INVARIANT VIOLATED by ${g.id}: ${violation}`);
            failures++;
          }
        }
        const render = (g) =>
          g.format === 'field'
            ? `${g.leagueName} P1=${g.entrants?.[0]?.abbrev ?? '–'} n=${g.entrants?.length ?? 0} (${g.phase}/${g.statusShort})`
            : `${g.away?.abbrev} ${g.away?.score ?? '–'}:${g.home?.score ?? '–'} ${g.home?.abbrev} (${g.phase}/${g.statusShort})`;
        console.log(`  [${lid}] ${games.length} games: ` + games.slice(0, 4).map(render).join(' | '));
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
