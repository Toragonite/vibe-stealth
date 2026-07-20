/**
 * Flat template registry (docs/CONTRACT.md §5, §9).
 *
 * Every core key exists in BOTH locales (test-enforced). A runtime lookup miss
 * falls back to `en`, then to the key itself. Template syntax is `{name}`.
 */

import type { RelayLocale } from './contract';

const EN: Record<string, string> = {
  backfillSkipped: '({n} earlier plays skipped)',
  finalScore: 'Final — {away} {as} : {hs} {home}',
  gameEnded: 'Game ended.',
  connectionTrouble: 'Connection trouble — retrying…',
  connectionRestored: 'Connection restored.',
  authRequired: '{provider} authentication required — run {command} from the Command Palette',
  gameVanished: 'Game is no longer available — unfollowing.',
  autoUnfollowed: 'Finished game unfollowed automatically.',
  staleGame: 'No update for 12 hours — the game feed looks stale; unfollowing.',
  followed: 'Following {game}',
  unfollowed: 'Unfollowed {game}',
  restoredFollow: 'Restored follow: {game}',
  corrected: '(corrected)',

  // ---- CONTRACT §14: field contests (motorsport) ------------------------------
  // The leading competitor of a field, rendered in the tree row and the status bar.
  // `leaderPositionBare` covers an entrant the feed gave neither an abbrev nor a
  // name, so a raw {who} can never render.
  leaderPosition: 'P{n} {who}',
  leaderPositionBare: 'P{n}',

  // ---- CONTRACT §12: detail-level, provider-composed lines --------------------
  // These are localized because the API carries no prose for them (pitch data is
  // pure structured fields). API prose (at-bat descriptions, soccer commentary)
  // is never routed through here — it is passed through verbatim (§12.1).
  //
  // pitchLine variants: `mph` (speed) and `zone` may each be absent. The provider
  // selects the variant matching which tokens are present, so a template only ever
  // references placeholders it is guaranteed to receive — a raw {placeholder} can
  // never render.
  pitchLine: '{type} {mph} · zone {zone} · {call} ({balls}-{strikes})',
  pitchLineNoZone: '{type} {mph} · {call} ({balls}-{strikes})',
  pitchLineNoSpeed: '{type} · zone {zone} · {call} ({balls}-{strikes})',
  pitchLineBare: '{type} · {call} ({balls}-{strikes})',

  // pitchType.* — MLB `details.type.description`; unknown descriptions pass through
  // via tEnum (never dropped, never a raw key).
  'pitchType.four-seam-fastball': 'Four-Seam Fastball',
  'pitchType.sinker': 'Sinker',
  'pitchType.cutter': 'Cutter',
  'pitchType.slider': 'Slider',
  'pitchType.sweeper': 'Sweeper',
  'pitchType.changeup': 'Changeup',
  'pitchType.curveball': 'Curveball',
  'pitchType.knuckle-curve': 'Knuckle Curve',
  'pitchType.splitter': 'Splitter',
  'pitchType.slurve': 'Slurve',

  // pitchCall.* — MLB `details.description`; unknown calls pass through via tEnum.
  'pitchCall.ball': 'Ball',
  'pitchCall.called-strike': 'Called Strike',
  'pitchCall.swinging-strike': 'Swinging Strike',
  'pitchCall.foul': 'Foul',
  'pitchCall.foul-tip': 'Foul Tip',
  'pitchCall.in-play,-out(s)': 'In play, out(s)',
  'pitchCall.in-play,-no-out': 'In play, no out',
  'pitchCall.in-play,-run(s)': 'In play, run(s)',
  'pitchCall.hit-by-pitch': 'Hit By Pitch',
  'pitchCall.blocked-ball': 'Blocked Ball',

  // nhlShot.* — NHL `details.shotType`; unknown shot types pass through via tEnum.
  'nhlShot.snap': 'snap',
  'nhlShot.wrist': 'wrist',
  'nhlShot.slap': 'slap',
  'nhlShot.backhand': 'backhand',
  'nhlShot.tip-in': 'tip-in',
  'nhlShot.deflected': 'deflected',
  'nhlShot.wrap-around': 'wrap-around',

  // nhlZone.* — NHL `details.zoneCode` (O/D/N).
  'nhlZone.o': 'offensive zone',
  'nhlZone.d': 'defensive zone',
  'nhlZone.n': 'neutral zone',

  // nhlGoal — immutable goal facts. The provider builds the `assists` param with
  // the nhlAssists helper (localized), or uses nhlGoalNoAssist when there are none.
  nhlGoal: '{shotType} goal — {scorer} (season goal #{total}){assists}',
  nhlGoalNoAssist: '{shotType} goal — {scorer} (season goal #{total})',
  nhlAssists: ' (assists: {names})',

  // nhlEvent.* — NHL detail-only play labels (§12.4). The whole line is provider-
  // composed (NHL sends no prose), so every label is localized — never an English literal.
  'nhlEvent.shot-on-goal': 'shot on goal',
  'nhlEvent.missed-shot': 'missed shot',
  'nhlEvent.blocked-shot': 'blocked shot',
  'nhlEvent.hit': 'hit',
  'nhlEvent.takeaway': 'takeaway',
  'nhlEvent.giveaway': 'giveaway',

  // nhlPenaltyType.* — NHL `details.descKey`; unknown descKeys pass through via tEnum.
  'nhlPenaltyType.high-sticking': 'high sticking',
  'nhlPenaltyType.tripping': 'tripping',
  'nhlPenaltyType.hooking': 'hooking',
  'nhlPenaltyType.slashing': 'slashing',
  'nhlPenaltyType.interference': 'interference',
  'nhlPenaltyType.roughing': 'roughing',
  'nhlPenaltyType.cross-checking': 'cross-checking',
  'nhlPenaltyType.holding': 'holding',
  'nhlPenaltyType.delaying-game': 'delay of game',
  'nhlPenaltyType.too-many-men-on-the-ice': 'too many men on the ice',

  // NHL composed status / penalty / goal lines (§12.1, §2.3) — all ours, all localized.
  nhlGoalFallback: 'Goal — {away} {as}, {home} {hs}',
  nhlPenalty: 'Penalty — {descKey}',
  nhlPenaltyBare: 'Penalty',
  nhlPeriodStart: 'Start of {period}',
  nhlPeriodEnd: 'End of {period}',
  nhlPeriodNum: 'P{n}',
  nhlPeriodOT: 'OT',
  nhlPeriodSO: 'SO',
  nhlPeriodGeneric: 'period',
  nhlGameOver: 'Game over',
  nhlShootoutComplete: 'Shootout complete',
  nhlGoalieChange: 'Goalie change',
  nhlUnknownEvent: '{key}',

  // soccerEvent — ESPN keyEvents. `type` is localized via soccerEventType; `player`
  // and `team` are API-supplied prose passed through verbatim.
  soccerEvent: '{type} — {player} ({team})',
  'soccerEventType.goal': 'Goal',
  'soccerEventType.yellow-card': 'Yellow Card',
  'soccerEventType.red-card': 'Red Card',
  'soccerEventType.substitution': 'Substitution',
  'soccerEventType.penalty': 'Penalty',

  // LoL Esports kill feed (§12.6) — every line is provider-composed (frame-diffed,
  // no API prose), so all of it is localized. A kill with credited assists uses
  // lolKillAssist (assists arrive already comma-joined); a death with no killer
  // credited (tower / minion / execute) uses lolDeath, never inventing a killer.
  lolKill: '{killer} → {victim}',
  lolKillAssist: '{killer} → {victim}  [assists: {assists}]',
  lolDeath: '{victim} died',
  lolObjective: '{team} took {objective}',

  // lolObjective.* — objective names via tEnum(locale,'lolObjective', value). An
  // unknown drake type passes its raw English through (§12.1), never a raw key.
  'lolObjective.tower': 'Tower',
  'lolObjective.inhibitor': 'Inhibitor',
  'lolObjective.baron': 'Baron Nashor',
  'lolObjective.cloud': 'Cloud Drake',
  'lolObjective.ocean': 'Ocean Drake',
  'lolObjective.infernal': 'Infernal Drake',
  'lolObjective.mountain': 'Mountain Drake',
  'lolObjective.hextech': 'Hextech Drake',
  'lolObjective.chemtech': 'Chemtech Drake',
  'lolObjective.elder': 'Elder Dragon',
};

const KO: Record<string, string> = {
  backfillSkipped: '(이전 플레이 {n}개 생략)',
  finalScore: '경기 종료 — {away} {as} : {hs} {home}',
  gameEnded: '경기가 종료되었습니다',
  connectionTrouble: '연결 문제 — 재시도 중…',
  connectionRestored: '연결이 복구되었습니다',
  authRequired: '{provider} 인증 필요 — 명령 팔레트에서 {command} 실행',
  gameVanished: '경기 정보를 찾을 수 없어 팔로우를 해제합니다',
  autoUnfollowed: '종료된 경기 팔로우 자동 해제',
  staleGame: '12시간 동안 경기가 끝나지 않았습니다 — 피드가 멈춘 것으로 보여 팔로우를 해제합니다',
  followed: '{game} 팔로우 시작',
  unfollowed: '{game} 팔로우 해제',
  restoredFollow: '{game} 팔로우 복원',
  corrected: '(수정)',

  // ---- CONTRACT §14: field contests (see EN comments) -------------------------
  leaderPosition: '{n}위 {who}',
  leaderPositionBare: '{n}위',

  // ---- CONTRACT §12: detail-level, provider-composed lines (see EN comments) ---
  pitchLine: '{type} {mph} · 존{zone} · {call} ({balls}-{strikes})',
  pitchLineNoZone: '{type} {mph} · {call} ({balls}-{strikes})',
  pitchLineNoSpeed: '{type} · 존{zone} · {call} ({balls}-{strikes})',
  pitchLineBare: '{type} · {call} ({balls}-{strikes})',

  'pitchType.four-seam-fastball': '포심 패스트볼',
  'pitchType.sinker': '싱커',
  'pitchType.cutter': '커터',
  'pitchType.slider': '슬라이더',
  'pitchType.sweeper': '스윗퍼',
  'pitchType.changeup': '체인지업',
  'pitchType.curveball': '커브',
  'pitchType.knuckle-curve': '너클커브',
  'pitchType.splitter': '스플리터',
  'pitchType.slurve': '슬러브',

  'pitchCall.ball': '볼',
  'pitchCall.called-strike': '루킹 스트라이크',
  'pitchCall.swinging-strike': '헛스윙',
  'pitchCall.foul': '파울',
  'pitchCall.foul-tip': '파울팁',
  'pitchCall.in-play,-out(s)': '인플레이 아웃',
  'pitchCall.in-play,-no-out': '인플레이',
  'pitchCall.in-play,-run(s)': '인플레이 득점',
  'pitchCall.hit-by-pitch': '몸에 맞는 볼',
  'pitchCall.blocked-ball': '블록된 볼',

  'nhlShot.snap': '스냅',
  'nhlShot.wrist': '리스트',
  'nhlShot.slap': '슬랩',
  'nhlShot.backhand': '백핸드',
  'nhlShot.tip-in': '팁인',
  'nhlShot.deflected': '디플렉션',
  'nhlShot.wrap-around': '랩어라운드',

  'nhlZone.o': '공격 지역',
  'nhlZone.d': '수비 지역',
  'nhlZone.n': '중립 지역',

  nhlGoal: '{shotType} 골 — {scorer} (시즌 {total}호){assists}',
  nhlGoalNoAssist: '{shotType} 골 — {scorer} (시즌 {total}호)',
  nhlAssists: ' (도움: {names})',

  'nhlEvent.shot-on-goal': '유효 슈팅',
  'nhlEvent.missed-shot': '빗나간 슈팅',
  'nhlEvent.blocked-shot': '블록된 슈팅',
  'nhlEvent.hit': '체크',
  'nhlEvent.takeaway': '스틸',
  'nhlEvent.giveaway': '턴오버',

  'nhlPenaltyType.high-sticking': '하이스틱',
  'nhlPenaltyType.tripping': '트리핑',
  'nhlPenaltyType.hooking': '후킹',
  'nhlPenaltyType.slashing': '슬래싱',
  'nhlPenaltyType.interference': '인터피어런스',
  'nhlPenaltyType.roughing': '러핑',
  'nhlPenaltyType.cross-checking': '크로스체킹',
  'nhlPenaltyType.holding': '홀딩',
  'nhlPenaltyType.delaying-game': '경기 지연',
  'nhlPenaltyType.too-many-men-on-the-ice': '인원 초과',

  nhlGoalFallback: '골 — {away} {as}, {home} {hs}',
  nhlPenalty: '페널티 — {descKey}',
  nhlPenaltyBare: '페널티',
  nhlPeriodStart: '{period} 시작',
  nhlPeriodEnd: '{period} 종료',
  nhlPeriodNum: '{n}피리어드',
  nhlPeriodOT: '연장',
  nhlPeriodSO: '승부치기',
  nhlPeriodGeneric: '피리어드',
  nhlGameOver: '경기 종료',
  nhlShootoutComplete: '승부치기 종료',
  nhlGoalieChange: '골리 교체',
  nhlUnknownEvent: '{key}',

  soccerEvent: '{type} — {player} ({team})',
  'soccerEventType.goal': '골',
  'soccerEventType.yellow-card': '경고',
  'soccerEventType.red-card': '퇴장',
  'soccerEventType.substitution': '교체',
  'soccerEventType.penalty': '페널티',

  // LoL Esports kill feed (§12.6, see EN comments).
  lolKill: '{killer} → {victim} 처치',
  lolKillAssist: '{killer} → {victim} 처치  [어시: {assists}]',
  lolDeath: '{victim} 사망',
  lolObjective: '{team} {objective} 획득',

  'lolObjective.tower': '타워',
  'lolObjective.inhibitor': '억제기',
  'lolObjective.baron': '바론',
  'lolObjective.cloud': '구름 드래곤',
  'lolObjective.ocean': '바다 드래곤',
  'lolObjective.infernal': '화염 드래곤',
  'lolObjective.mountain': '산 드래곤',
  'lolObjective.hextech': '마법공학 드래곤',
  'lolObjective.chemtech': '화학공학 드래곤',
  'lolObjective.elder': '장로 드래곤',
};

const registry: Record<RelayLocale, Map<string, string>> = {
  en: new Map(Object.entries(EN)),
  ko: new Map(Object.entries(KO)),
};

function narrow(locale: unknown): RelayLocale {
  return locale === 'ko' ? 'ko' : 'en';
}

/** 'auto' ⇒ ko iff the VS Code display language starts with 'ko'. */
export function resolveLocale(setting: string, displayLanguage: string): RelayLocale {
  const s = typeof setting === 'string' ? setting.trim().toLowerCase() : '';
  if (s === 'ko' || s === 'en') return s;
  const dl = typeof displayLanguage === 'string' ? displayLanguage.trim().toLowerCase() : '';
  return dl.startsWith('ko') ? 'ko' : 'en';
}

/** Merge caller-owned strings into a locale (the UI layer registers its own). */
export function registerMessages(locale: RelayLocale, map: Record<string, string>): void {
  if (locale !== 'en' && locale !== 'ko') return;
  if (map === null || typeof map !== 'object') return;
  const target = registry[locale];
  for (const [key, value] of Object.entries(map)) {
    if (key !== '' && typeof value === 'string') target.set(key, value);
  }
}

export function t(locale: RelayLocale, key: string, params?: Record<string, string | number>): string {
  if (typeof key !== 'string' || key === '') return '';
  const template = registry[narrow(locale)].get(key) ?? registry.en.get(key) ?? key;
  return interpolate(template, params);
}

/**
 * Provider-facing enum lookup (CONTRACT §12.7). Localizes a raw API value through a
 * `${prefix}.${normalized}` template map. Normalization: trim, lowercase, and collapse
 * every run of whitespace to a single '-' (so 'Called Strike' → 'called-strike',
 * 'Four-Seam Fastball' → 'four-seam-fastball', 'O' → 'o'). Existing hyphens are kept.
 *
 * On a MISS the API's own English is passed through (`fallback ?? apiValue`) — NEVER a
 * raw key and NEVER a raw {placeholder} (enum templates carry no placeholders). This is
 * the guarantee the MLB / NHL / soccer providers rely on for unknown pitch types,
 * calls, shot types, and event types.
 */
export function tEnum(locale: RelayLocale, prefix: string, apiValue: string, fallback?: string): string {
  const raw = typeof apiValue === 'string' ? apiValue : '';
  const key = `${prefix}.${normalizeEnumValue(raw)}`;
  const hit = registry[narrow(locale)].get(key) ?? registry.en.get(key);
  return hit ?? fallback ?? raw;
}

function normalizeEnumValue(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, '-');
}

/** Placeholders with no matching param are left verbatim — never rendered as 'undefined'. */
function interpolate(template: string, params?: Record<string, string | number>): string {
  if (params === null || typeof params !== 'object') return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? stringify(params[name]) : whole,
  );
}

function stringify(value: string | number | undefined): string {
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '–';
  return typeof value === 'string' ? value : String(value);
}
