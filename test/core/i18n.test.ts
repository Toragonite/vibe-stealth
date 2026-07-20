import { describe, expect, it } from 'vitest';
import type { RelayLocale } from '../../src/core/contract';
import { registerMessages, resolveLocale, t, tEnum } from '../../src/core/i18n';

/** The §5 minimum key set, plus the correction suffix the formatter needs. */
const CORE_KEYS = [
  'backfillSkipped',
  'finalScore',
  'gameEnded',
  'connectionTrouble',
  'connectionRestored',
  'authRequired',
  'gameVanished',
  'autoUnfollowed',
  'staleGame',
  'followed',
  'unfollowed',
  'restoredFollow',
  'corrected',
] as const;

/** CONTRACT §12.7 — every provider-facing detail-level key, in en+ko parity. */
const DETAIL_KEYS = [
  'pitchLine',
  'pitchLineNoZone',
  'pitchLineNoSpeed',
  'pitchLineBare',
  'pitchType.four-seam-fastball',
  'pitchType.sinker',
  'pitchType.cutter',
  'pitchType.slider',
  'pitchType.sweeper',
  'pitchType.changeup',
  'pitchType.curveball',
  'pitchType.knuckle-curve',
  'pitchType.splitter',
  'pitchType.slurve',
  'pitchCall.ball',
  'pitchCall.called-strike',
  'pitchCall.swinging-strike',
  'pitchCall.foul',
  'pitchCall.foul-tip',
  'pitchCall.in-play,-out(s)',
  'pitchCall.in-play,-no-out',
  'pitchCall.in-play,-run(s)',
  'pitchCall.hit-by-pitch',
  'pitchCall.blocked-ball',
  'nhlShot.snap',
  'nhlShot.wrist',
  'nhlShot.slap',
  'nhlShot.backhand',
  'nhlShot.tip-in',
  'nhlShot.deflected',
  'nhlShot.wrap-around',
  'nhlZone.o',
  'nhlZone.d',
  'nhlZone.n',
  'nhlGoal',
  'nhlGoalNoAssist',
  'nhlAssists',
  'nhlEvent.shot-on-goal',
  'nhlEvent.missed-shot',
  'nhlEvent.blocked-shot',
  'nhlEvent.hit',
  'nhlEvent.takeaway',
  'nhlEvent.giveaway',
  'nhlPenaltyType.high-sticking',
  'nhlPenaltyType.tripping',
  'nhlPenaltyType.hooking',
  'nhlPenaltyType.slashing',
  'nhlPenaltyType.interference',
  'nhlPenaltyType.roughing',
  'nhlPenaltyType.cross-checking',
  'nhlPenaltyType.holding',
  'nhlPenaltyType.delaying-game',
  'nhlPenaltyType.too-many-men-on-the-ice',
  'nhlGoalFallback',
  'nhlPenalty',
  'nhlPenaltyBare',
  'nhlPeriodStart',
  'nhlPeriodEnd',
  'nhlPeriodNum',
  'nhlPeriodOT',
  'nhlPeriodSO',
  'nhlPeriodGeneric',
  'nhlGameOver',
  'nhlShootoutComplete',
  'nhlGoalieChange',
  'nhlUnknownEvent',
  'soccerEvent',
  'soccerEventType.goal',
  'soccerEventType.yellow-card',
  'soccerEventType.red-card',
  'soccerEventType.substitution',
  'soccerEventType.penalty',
  'lolKill',
  'lolKillAssist',
  'lolDeath',
  'lolObjective',
  'lolObjective.tower',
  'lolObjective.inhibitor',
  'lolObjective.baron',
  'lolObjective.cloud',
  'lolObjective.ocean',
  'lolObjective.infernal',
  'lolObjective.mountain',
  'lolObjective.hextech',
  'lolObjective.chemtech',
  'lolObjective.elder',
] as const;

/** CONTRACT §14 — the field-contest leader templates, in en+ko parity. */
const FIELD_KEYS = ['leaderPosition', 'leaderPositionBare'] as const;

const placeholders = (template: string): string[] =>
  [...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? '').sort();

describe('resolveLocale', () => {
  it('honours an explicit setting', () => {
    expect(resolveLocale('ko', 'en-US')).toBe('ko');
    expect(resolveLocale('en', 'ko-KR')).toBe('en');
  });

  it("'auto' follows the display language prefix", () => {
    expect(resolveLocale('auto', 'ko')).toBe('ko');
    expect(resolveLocale('auto', 'ko-KR')).toBe('ko');
    expect(resolveLocale('auto', 'en-US')).toBe('en');
    expect(resolveLocale('auto', 'kor')).toBe('ko'); // startsWith, per §9
    expect(resolveLocale('auto', 'korean-ish')).toBe('ko');
    expect(resolveLocale('auto', 'ja')).toBe('en');
  });

  it('degrades to en on hostile input', () => {
    expect(resolveLocale('', '')).toBe('en');
    expect(resolveLocale('fr', 'fr-FR')).toBe('en');
    expect(resolveLocale(undefined as unknown as string, undefined as unknown as string)).toBe('en');
    expect(resolveLocale('  KO  ', 'en')).toBe('ko');
    expect(resolveLocale('auto', '  KO-kr ')).toBe('ko');
  });
});

describe('t', () => {
  it('interpolates {name} placeholders', () => {
    expect(t('en', 'backfillSkipped', { n: 42 })).toBe('(42 earlier plays skipped)');
    expect(t('ko', 'backfillSkipped', { n: 42 })).toBe('(이전 플레이 42개 생략)');
    expect(t('en', 'finalScore', { away: 'STL', as: 3, hs: 2, home: 'DAL' })).toBe('Final — STL 3 : 2 DAL');
    expect(t('ko', 'finalScore', { away: 'STL', as: 3, hs: 2, home: 'DAL' })).toBe('경기 종료 — STL 3 : 2 DAL');
  });

  it('leaves unsupplied placeholders verbatim rather than rendering "undefined"', () => {
    expect(t('en', 'followed')).toBe('Following {game}');
    expect(t('en', 'followed', {})).toBe('Following {game}');
    expect(t('en', 'followed', { other: 'x' })).toBe('Following {game}');
  });

  it('does not let param values or prototype keys leak into the template', () => {
    expect(t('en', 'followed', { game: '$& {game}' })).toBe('Following $& {game}');
    expect(t('en', 'followed', JSON.parse('{"__proto__": "pwned"}'))).toBe('Following {game}');
  });

  it('renders non-finite numbers as the no-score dash', () => {
    expect(t('en', 'backfillSkipped', { n: NaN })).toBe('(– earlier plays skipped)');
  });

  it('falls back locale → en → key', () => {
    registerMessages('en', { onlyInEnglish: 'English only' });
    expect(t('ko', 'onlyInEnglish')).toBe('English only');
    expect(t('en', 'noSuchKeyAnywhere')).toBe('noSuchKeyAnywhere');
    expect(t('ko', 'noSuchKeyAnywhere')).toBe('noSuchKeyAnywhere');
    expect(t('en', '')).toBe('');
    expect(t('fr' as RelayLocale, 'gameEnded')).toBe('Game ended.');
  });

  it('registerMessages ignores non-string values and unknown locales', () => {
    registerMessages('en', { junk: 1 as unknown as string });
    expect(t('en', 'junk')).toBe('junk');
    registerMessages('fr' as RelayLocale, { gameEnded: 'Fini' });
    expect(t('en', 'gameEnded')).toBe('Game ended.');
    registerMessages('en', null as unknown as Record<string, string>);
    expect(t('en', 'gameEnded')).toBe('Game ended.');
  });
});

/** Asserts a key resolves in both locales, with matching placeholders and a real ko entry. */
const assertParity = (key: string): void => {
  const sentinel = '__MISSING_IN_KO__';
  const en = t('en', key);
  const ko = t('ko', key);
  expect(en, `${key} missing from en`).not.toBe(key);
  expect(ko, `${key} missing from ko`).not.toBe(key);
  expect(placeholders(ko), `${key} placeholder mismatch`).toEqual(placeholders(en));

  // A ko lookup miss silently falls back to en, so poison en to prove the ko
  // entry really exists, then restore it.
  registerMessages('en', { [key]: sentinel });
  expect(t('ko', key), `${key} only resolves via the en fallback`).not.toBe(sentinel);
  registerMessages('en', { [key]: en });
  expect(t('en', key)).toBe(en);
};

describe('en/ko parity', () => {
  it('every detail-level key (CONTRACT §12.7) exists in BOTH locales with identical placeholders', () => {
    for (const key of DETAIL_KEYS) assertParity(key);
  });

  it('every core key exists in BOTH locales with identical placeholders', () => {
    const sentinel = '__MISSING_IN_KO__';
    for (const key of CORE_KEYS) {
      // With no params, t() returns the raw template.
      const en = t('en', key);
      const ko = t('ko', key);
      expect(en, `${key} missing from en`).not.toBe(key);
      expect(ko, `${key} missing from ko`).not.toBe(key);
      expect(placeholders(ko), `${key} placeholder mismatch`).toEqual(placeholders(en));

      // A ko lookup miss silently falls back to en, so poison en to prove the
      // ko entry really exists, then restore it.
      registerMessages('en', { [key]: sentinel });
      expect(t('ko', key), `${key} only resolves via the en fallback`).not.toBe(sentinel);
      registerMessages('en', { [key]: en });
      expect(t('en', key)).toBe(en);
    }
  });

  it('every field-contest key (CONTRACT §14) exists in BOTH locales with identical placeholders', () => {
    for (const key of FIELD_KEYS) assertParity(key);
  });

  it('ko is actually Korean for the user-facing system lines', () => {
    expect(t('ko', 'connectionTrouble')).toBe('연결 문제 — 재시도 중…');
    expect(t('ko', 'gameVanished')).toBe('경기 정보를 찾을 수 없어 팔로우를 해제합니다');
    expect(t('ko', 'staleGame')).toBe(
      '12시간 동안 경기가 끝나지 않았습니다 — 피드가 멈춘 것으로 보여 팔로우를 해제합니다',
    );
    expect(t('ko', 'authRequired', { provider: 'PandaScore', command: 'Set PandaScore API Token' })).toBe(
      'PandaScore 인증 필요 — 명령 팔레트에서 Set PandaScore API Token 실행',
    );
  });
});

describe('field contests (CONTRACT §14)', () => {
  it('renders the leader position in both locales', () => {
    expect(t('en', 'leaderPosition', { n: 1, who: 'VER' })).toBe('P1 VER');
    expect(t('ko', 'leaderPosition', { n: 1, who: 'VER' })).toBe('1위 VER');
    expect(t('en', 'leaderPositionBare', { n: 12 })).toBe('P12');
    expect(t('ko', 'leaderPositionBare', { n: 12 })).toBe('12위');
  });

  it('never leaves a raw {placeholder} in either variant', () => {
    for (const loc of ['en', 'ko'] as const) {
      expect(t(loc, 'leaderPosition', { n: 3, who: 'NOR' })).not.toMatch(/\{[a-zA-Z]+\}/);
      expect(t(loc, 'leaderPositionBare', { n: 3 })).not.toMatch(/\{[a-zA-Z]+\}/);
    }
  });
});

describe('detail-level composed lines (CONTRACT §12.3-12.5)', () => {
  it('renders each pitchLine variant with the tokens present', () => {
    expect(t('en', 'pitchLine', { type: 'Sinker', mph: 94.2, zone: 5, call: 'Ball', balls: 2, strikes: 1 })).toBe(
      'Sinker 94.2 · zone 5 · Ball (2-1)',
    );
    // ko renders 존 (zone) and localized call/type; API prose never reaches here.
    expect(t('ko', 'pitchLine', { type: '싱커', mph: 94.2, zone: 5, call: '볼', balls: 2, strikes: 1 })).toBe(
      '싱커 94.2 · 존5 · 볼 (2-1)',
    );
    expect(t('en', 'pitchLineNoZone', { type: 'Sinker', mph: 94.2, call: 'Ball', balls: 2, strikes: 1 })).toBe(
      'Sinker 94.2 · Ball (2-1)',
    );
    expect(t('ko', 'pitchLineNoSpeed', { type: '슬라이더', zone: 3, call: '루킹 스트라이크', balls: 1, strikes: 2 })).toBe(
      '슬라이더 · 존3 · 루킹 스트라이크 (1-2)',
    );
    expect(t('en', 'pitchLineBare', { type: 'Slider', call: 'Foul', balls: 0, strikes: 2 })).toBe(
      'Slider · Foul (0-2)',
    );
  });

  it('never leaves a raw {placeholder} in any pitchLine variant', () => {
    const params = { type: 'X', mph: 90, zone: 4, call: 'Ball', balls: 1, strikes: 1 };
    for (const key of ['pitchLine', 'pitchLineNoZone', 'pitchLineNoSpeed', 'pitchLineBare']) {
      for (const loc of ['en', 'ko'] as const) {
        expect(t(loc, key, params), `${loc} ${key}`).not.toMatch(/\{[a-zA-Z]+\}/);
      }
    }
  });

  it('composes an NHL goal with a localized assists segment or the no-assist variant', () => {
    const koAssists = t('ko', 'nhlAssists', { names: '김철수, 이영희' });
    expect(t('ko', 'nhlGoal', { shotType: '스냅', scorer: '홍길동', total: 12, assists: koAssists })).toBe(
      '스냅 골 — 홍길동 (시즌 12호) (도움: 김철수, 이영희)',
    );
    expect(t('ko', 'nhlGoalNoAssist', { shotType: '스냅', scorer: '홍길동', total: 12 })).toBe(
      '스냅 골 — 홍길동 (시즌 12호)',
    );
    const enAssists = t('en', 'nhlAssists', { names: 'Jones' });
    expect(t('en', 'nhlGoal', { shotType: 'wrist', scorer: 'Smith', total: 3, assists: enAssists })).toBe(
      'wrist goal — Smith (season goal #3) (assists: Jones)',
    );
  });

  it('renders a soccer event with a localized type and pass-through player/team prose', () => {
    expect(t('en', 'soccerEvent', { type: 'Goal', player: 'Messi', team: 'Argentina' })).toBe(
      'Goal — Messi (Argentina)',
    );
    expect(t('ko', 'soccerEvent', { type: '골', player: 'Son', team: '토트넘' })).toBe('골 — Son (토트넘)');
  });
});

describe('LoL Esports kill feed (CONTRACT §12.6)', () => {
  it('renders each of the four kill-feed templates in both locales', () => {
    expect(t('en', 'lolKill', { killer: 'JarvanIV', victim: 'Naafiri' })).toBe('JarvanIV → Naafiri');
    expect(t('ko', 'lolKill', { killer: 'JarvanIV', victim: 'Naafiri' })).toBe('JarvanIV → Naafiri 처치');

    expect(t('en', 'lolKillAssist', { killer: 'Ziggs', victim: 'Akali', assists: 'Rumble, Yone' })).toBe(
      'Ziggs → Akali  [assists: Rumble, Yone]',
    );
    expect(t('ko', 'lolKillAssist', { killer: 'Ziggs', victim: 'Akali', assists: 'Rumble, Yone' })).toBe(
      'Ziggs → Akali 처치  [어시: Rumble, Yone]',
    );

    expect(t('en', 'lolDeath', { victim: 'Akali' })).toBe('Akali died');
    expect(t('ko', 'lolDeath', { victim: 'Akali' })).toBe('Akali 사망');

    expect(t('en', 'lolObjective', { team: 'BLUE', objective: 'Baron Nashor' })).toBe('BLUE took Baron Nashor');
    expect(t('ko', 'lolObjective', { team: 'BLUE', objective: '바론' })).toBe('BLUE 바론 획득');
  });

  it('never leaves a raw {placeholder} in any kill-feed template', () => {
    const cases: Array<[string, Record<string, string>]> = [
      ['lolKill', { killer: 'A', victim: 'B' }],
      ['lolKillAssist', { killer: 'A', victim: 'B', assists: 'C, D' }],
      ['lolDeath', { victim: 'B' }],
      ['lolObjective', { team: 'RED', objective: 'Tower' }],
    ];
    for (const [key, params] of cases) {
      for (const loc of ['en', 'ko'] as const) {
        expect(t(loc, key, params), `${loc} ${key}`).not.toMatch(/\{[a-zA-Z]+\}/);
      }
    }
  });

  it('localizes objective names via tEnum, passing an unknown drake through verbatim', () => {
    expect(tEnum('ko', 'lolObjective', 'chemtech')).toBe('화학공학 드래곤');
    expect(tEnum('en', 'lolObjective', 'chemtech')).toBe('Chemtech Drake');
    expect(tEnum('ko', 'lolObjective', 'baron')).toBe('바론');

    const unknown = tEnum('ko', 'lolObjective', 'voidling');
    expect(unknown).toBe('voidling');
    expect(unknown).not.toContain('{');
    expect(unknown).not.toMatch(/^lolObjective\./);
  });
});

describe('tEnum (CONTRACT §12.7)', () => {
  it('localizes a known enum value across every provider map', () => {
    expect(tEnum('ko', 'pitchType', 'Four-Seam Fastball')).toBe('포심 패스트볼');
    expect(tEnum('ko', 'pitchCall', 'Called Strike')).toBe('루킹 스트라이크');
    expect(tEnum('en', 'pitchType', 'Slider')).toBe('Slider');
    expect(tEnum('ko', 'nhlShot', 'tip-in')).toBe('팁인');
    expect(tEnum('ko', 'nhlZone', 'O')).toBe('공격 지역');
    expect(tEnum('ko', 'soccerEventType', 'yellow card')).toBe('경고');
  });

  it('normalizes case and whitespace before lookup', () => {
    // 'Called Strike' → 'called-strike': the pinned normalization the providers depend on.
    expect(tEnum('ko', 'pitchCall', 'called strike')).toBe('루킹 스트라이크');
    expect(tEnum('ko', 'pitchCall', 'CALLED STRIKE')).toBe('루킹 스트라이크');
    expect(tEnum('ko', 'pitchCall', '  Called   Strike  ')).toBe('루킹 스트라이크');
    expect(tEnum('ko', 'soccerEventType', 'Yellow Card')).toBe('경고');
    expect(tEnum('ko', 'nhlZone', 'o')).toBe('공격 지역');
  });

  it('passes the API English through on an UNKNOWN value — never a key, never a placeholder', () => {
    expect(tEnum('ko', 'pitchType', 'Eephus')).toBe('Eephus');
    expect(tEnum('en', 'pitchCall', 'Automatic Ball')).toBe('Automatic Ball');
    const miss = tEnum('ko', 'nhlShot', 'between-the-legs');
    expect(miss).toBe('between-the-legs');
    expect(miss).not.toContain('{');
    expect(miss).not.toMatch(/^nhlShot\./);
  });

  it('uses an explicit fallback for an unknown value, and ignores it for a known one', () => {
    expect(tEnum('en', 'pitchType', 'Nonsense', 'Fastball')).toBe('Fastball');
    expect(tEnum('ko', 'pitchType', 'Slider', 'Fastball')).toBe('슬라이더');
  });
});
