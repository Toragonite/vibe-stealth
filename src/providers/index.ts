/**
 * Provider registry. Display order and DEFAULT_LEAGUE_KEYS are pinned by
 * docs/CONTRACT.md §9. The ESPN/MLB/NHL providers are built by a parallel task
 * with the export names imported below (§9); until they land this file will not
 * compile — that is expected and does not affect the provider parser tests,
 * which never import this module.
 */
import { SportProvider } from '../core/contract';
import { espnProvider } from './espn';
import { mlbProvider } from './mlb';
import { nhlProvider } from './nhl';
import { naverProvider } from './naver';
import { lolesportsProvider } from './lolesports';
import { pandascoreProvider } from './pandascore';
import { espnTennisProvider } from './espnTennis';
import { espnRacingProvider } from './espnRacing';

// Display order (§9): naver, lolesports, mlb, nhl, espn, then the §14 additions
// (tennis, motorsport), then pandascore — which stays last because it is the one
// secret-gated provider and is hidden until a token is set.
const PROVIDERS: SportProvider[] = [
  naverProvider,
  lolesportsProvider,
  mlbProvider,
  nhlProvider,
  espnProvider,
  espnTennisProvider,
  espnRacingProvider,
  pandascoreProvider,
];

export function getProviders(): SportProvider[] {
  return PROVIDERS.slice();
}

export function getProvider(id: string): SportProvider | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

/**
 * Every `${providerId}:${leagueId}` of the five KEY-FREE providers (PandaScore
 * requires a secret and is excluded). League ids are the static, contract-pinned
 * ids (§2.1–2.6); tree keys follow the `espn:eng.1` form (§2).
 */
export const DEFAULT_LEAGUE_KEYS: string[] = [
  // naver (§2.5)
  'naver:kbo',
  'naver:kleague',
  // lolesports (§2.6)
  'lolesports:lck',
  'lolesports:lpl',
  'lolesports:lec',
  'lolesports:msi',
  'lolesports:worlds',
  'lolesports:first_stand',
  // mlb (§2.2)
  'mlb:mlb',
  // nhl (§2.3)
  'nhl:nhl',
  // espn (§2.1)
  'espn:nfl',
  'espn:nba',
  'espn:wnba',
  'espn:fifa.world',
  'espn:eng.1',
  'espn:esp.1',
  'espn:ita.1',
  'espn:ger.1',
  'espn:fra.1',
  'espn:usa.1',
  'espn:uefa.champions',
  'espn:ufc',
  'espn:cricket',
  'espn:mens-college-basketball',
  // espn-tennis (§14)
  'espn-tennis:atp',
  'espn-tennis:wta',
  // espn-racing (§14)
  'espn-racing:f1',
];

/**
 * Valid league keys that are deliberately NOT enabled by default. `espn:college-football`
 * resolves ~99 games on a single Saturday and the tree renders one row per game with no
 * truncation (premortem P2), so switching it on for everyone would bury the other leagues.
 * It stays fully supported — a user opts in by adding the key to `vibeStealth.leagues.enabled`.
 */
export const OPT_IN_LEAGUE_KEYS: string[] = ['espn:college-football'];
