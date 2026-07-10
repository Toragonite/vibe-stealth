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

// Display order (§9): naver, lolesports, mlb, nhl, espn, pandascore.
const PROVIDERS: SportProvider[] = [
  naverProvider,
  lolesportsProvider,
  mlbProvider,
  nhlProvider,
  espnProvider,
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
];
