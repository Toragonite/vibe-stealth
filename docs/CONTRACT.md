# Vibe Stealth — Behavioral Contract v0.1.0 (frozen)

Companion to `src/core/contract.ts`. Types live there; behavior pins live here.
Implement EXACTLY this — the pins here are load-bearing, not suggestions.

Layering: `src/core/**` and `src/providers/**` MUST NOT import `vscode` (unit-testable with vitest).
Only `src/ui/**` and `src/extension.ts` may. No runtime npm dependencies — global `fetch` only.

## 1. HTTP (`src/core/http.ts` — implements `ProviderContext.fetchJson`)

- GET only. Timeout 10 s via AbortController — the window spans connection AND the full body
  read (`res.text()` under the same signal). Headers: `accept: application/json`,
  `user-agent: vibe-stealth-vscode/<package.json version>` plus caller extras.
- Response body > 16 MiB (byte length of text) ⇒ `ProviderError('unavailable')`.
  **Known limitation (breaker m2, accepted for v0.1):** "byte length of text" means the cap is
  checked AFTER `res.text()` has buffered the whole body, so a hostile endpoint delivering
  hundreds of MB inside the 10 s window materializes that string before the cap rejects it.
  The transient spike is bounded by the abort timeout, not by 16 MiB. A streaming reader with
  an early byte-count abort is the v0.2 fix; it requires rewording this pin.
- Status mapping: 401/403 → `auth`; 404 → `not-found`; 429 → `rate-limit` with `retryAfterMs`
  parsed from `Retry-After` (integer seconds, or HTTP-date ⇒ `max(0, date − now)`; unparsable
  ⇒ undefined); other 4xx → `unavailable`; 5xx → `network`; fetch/abort/timeout → `network`.
- `JSON.parse` failure → `parse` with `payloadHead` = first 300 chars.
- NO retries at this layer — the poller owns retry policy.

## 2. Providers (`src/providers/`)

Universal pins:
- Every field access on API JSON is defensive (optional chaining + type checks). A shape
  surprise NEVER throws raw — wrap in `ProviderError('parse', …)`. One malformed entry in a
  list is SKIPPED (log via ctx.log), not fatal to the whole response.
- Score coercion: accept number or numeric string; trim; `Number()`; result must be a finite
  integer with `0 ≤ n ≤ 999`, else `undefined`. Never NaN/negative/float/absurd ('1e9' ⇒ undefined).
- Providers MUST sort events by their sequence key ascending before returning (MLB
  `atBatIndex`, NHL `sortOrder`, PandaScore `position`, ESPN per §2.1). API array order is
  never trusted. Note: the trimmed fixtures are DELIBERATELY out of order — parser tests fail
  without the sort.
- Date parsing: accept ISO with or without seconds (`2026-07-07T18:15Z` is VALID — evidence:
  ESPN). Output `startTimeUtc` re-normalized with seconds. Unparsable ⇒ `undefined`, phase
  computation falls back to provider status fields only.
- Team names: strip control chars; empty name → abbrev → `'TBD'`. Abbrev: provided, else first
  3 chars of name uppercased. Unicode (accents, CJK) preserved as-is (evidence: 'CF Montréal').
- `PlayEvent.text`: trim; strip `[\u0000-\u001F\u007F]`; collapse internal newlines to '; ';
  hard-cap 500 chars (append '…'). Events with null/empty text are DROPPED (not emitted, id
  not remembered — if the API later fills text, the event emits then; late/out-of-order
  emission into an append-only channel is accepted).
- **`PlayEvent.text` MUST be a pure function of that event's own IMMUTABLE facts.** Providers
  are stateless and re-derive the whole event list on every poll, while §3.4 detects a
  correction as "same id, different normalized text". So any value that can change between
  polls — a running series score, a current inning, a live clock — must NOT appear in an
  event's text: it re-derives differently next poll and fires a FALSE correction that rewrites
  history. (Amended 2026-07-08: probed — `Game 1 — G2 1:0 T1` was "corrected" to
  `Game 1 — G2 1:1 T1` when map 2 finished, and since §3.4 allows only one correction per id,
  map 1's line stayed permanently wrong.) Mutable state belongs in `PlaySnapshot.game` (status
  bar, `scoreChanged`, the §3.8 final line) — never in event text. A provider that cannot
  determine a per-event fact from its payload MUST omit it rather than substitute a
  current-state proxy.
- **`PlaySnapshot.game` MUST be freshly derived from the fetchPlays response(s) — NEVER the
  input `game` object returned verbatim.** (Amended 2026-07-08 after breaker finding B1, which
  proved 5 of 6 providers froze `phase` at follow time: the poller's stop condition, the §3.8
  final line, and the post+10-min auto-unfollow are ALL gated on `snapshot.game.phase ===
  'post'`, so a finished game polled forever.) Rule: for every field the play response can
  supply — `phase`, both scores, `statusText`, `statusShort` — parse it fresh; for fields it
  genuinely cannot supply, carry the input game's value through. A provider whose play
  endpoint carries no status MUST make a second request that does (see §2.5). Each provider's
  §2.x section pins its authoritative status source; regression tests per provider MUST assert
  that a terminal payload yields `phase === 'post'`.
- `PlaySnapshot.events` is the FULL current list ordered by sequence asc — EXCEPT Naver,
  whose relay endpoint returns only the latest window (§2.5): there it is the full CURRENT
  WINDOW. Engine semantics are unaffected (dedup by id; vanished events ignored). Providers
  never diff, never dedupe across calls.
- League ids in tree keys are `${providerId}:${leagueId}` (e.g. `espn:eng.1`, `mlb:mlb`,
  `naver:kbo`, `lolesports:lck`).

### 2.1 ESPN (`espn.ts`) — key-free, unofficial
- Base `https://site.api.espn.com/apis/site/v2/sports/{path}`.
- Leagues (static list): `football/nfl` (football), `basketball/nba`, `basketball/wnba`
  (basketball), soccer: `soccer/fifa.world` (World Cup — live now), `soccer/eng.1`,
  `soccer/esp.1`, `soccer/ita.1`, `soccer/ger.1`, `soccer/fra.1`, `soccer/usa.1`,
  `soccer/uefa.champions`.
- Scoreboard `{path}/scoreboard` (NO date param — ESPN's current window already spans
  yesterday's late games). `events[]`: id, date, `status.type.state` ∈ {pre,in,post} (else
  phase 'unknown'), `status.type.shortDetail`/`detail` → statusText; competitors from
  `competitions[0].competitors[]` with `homeAway` ('home'/'away'); **score is a string**.
- Plays `{path}/summary?event={id}`:
  - football/basketball: `plays[]` → text from `.text`, period from `.period.number`
    (label `Q{n}` for basketball/football), clock `.clock.displayValue`,
    kind 'score' when `.scoringPlay === true`, scoreAfter from `awayScore/homeScore`
    (present on every play — evidence).
  - soccer: `commentary[]` → text `.text`, clock `.time.displayValue` (may be '' — evidence;
    stoppage time renders as `90'+7'`), sequence = native `.sequence` when a finite number
    (evidence: monotonic 0..103, chronological/oldest-first), else index after chronological
    normalization. Entries have NO native id (evidence: keys are exactly sequence/text/time).
    If `commentary` absent/empty fall back to `keyEvents[]` (`.text` — may be '' ⇒ drop,
    `.clock.displayValue`, native `.id` present); both absent (pre-game — evidence) ⇒
    `events: []`.
  - Chronological normalization guard (soccer): if the first entry's `sequence` (or parsed
    clock when sequence is absent) is greater than the last entry's, reverse the array before
    assigning sequences. Evidence says oldest-first today; the guard protects against ESPN
    flipping it.
  - football/basketball **sequence = array index** (evidence: `sequenceNumber` resets per
    at-bat, NOT usable; native `.id` was present on every play in fixtures).
  - **id**: native `.id` when present and non-empty. Otherwise derive as
    `fnv1a32(gameId + '|' + normText + '|' + k)` where normText = normalized text (§2 rules +
    collapse whitespace) and k = count of EARLIER entries (chronological order) with the same
    normText (occurrence ordinal). Stable under append-only growth AND front-insertion;
    repeated identical lines stay distinct. The array index MUST NOT appear in any derived id.
    (32-bit FNV-1a hex — deterministic, no crypto import.)
  - statusShort: pre ⇒ local start 'HH:MM' (or 'TBD'); in ⇒ from `status.period` /
    `status.displayClock` ('Q3', "67'"); post ⇒ 'FT' (soccer) / 'F' (others).
  - **Fresh game (§2 pin):** the summary response carries
    `header.competitions[0].status.type.state` and `header.competitions[0].competitors[].score`
    (string) + `.team.abbreviation` — live-probe evidence 2026-07-08, fixture
    `espn-summary-header-post.json`. `fetchPlays` MUST rebuild the Game from that header with
    the SAME logic as the scoreboard parse. Header absent/unparsable ⇒ carry the input game.
- ESPN is NOT used for MLB/NHL games (dedicated providers below); its `baseball/mlb` path is
  used only as fixture material, not registered as a league.

### 2.2 MLB StatsAPI (`mlb.ts`) — key-free, official
- Schedule: `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date={YYYY-MM-DD}` where the
  date is computed in **America/New_York** (league-local "today" — a KST user at 10:00 sees
  live ET-evening games; user-local date would skip them). Use
  `Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' })` for the date string.
- Game phase from `status.abstractGameState`: 'Preview'→pre, 'Live'→in, 'Final'→post, else unknown.
- Plays: `https://statsapi.mlb.com/api/v1.1/game/{gamePk}/feed/live`.
  - Emit one event per `liveData.plays.allPlays[]` entry WHERE `about.isComplete === true`
    AND `result.description` non-empty (in-progress at-bats churn text — do not emit until
    complete). sequence = `about.atBatIndex`; id = `mlb:{gamePk}:{atBatIndex}`.
  - kind 'score' when `about.isScoringPlay === true`; scoreAfter from `result.homeScore/awayScore`.
  - period label: `{inning}회{초|말}` is NOT built here — locale-neutral `T{n}`/`B{n}` from
    `about.halfInning` ('top'/'bottom'); formatter localizes.
  - Game status: from `gameData.status` + `liveData.linescore` (`currentInning`,
    `inningState`) → statusText 'Top 7th' style, statusShort 'T7'/'B7'; `inningState`
    'Middle'/'End' ⇒ statusShort 'M7'/'E7', statusText 'Middle 7th'/'End 7th'; pre: local
    start time; post: 'Final'.
- Doubleheaders: two gamePks same teams same date — already distinct games; no special-casing.

### 2.3 NHL (`nhl.ts`) — key-free, official
- Scoreboard: `https://api-web.nhle.com/v1/score/now`. `games[]`: id, `gameState` mapping
  FUT|PRE→pre, LIVE|CRIT→in, OFF|FINAL→post, else unknown; teams `homeTeam/awayTeam`
  (`abbrev`, `score`, name = `name.default` — the nickname, e.g. 'Stars'; accepted for v0.1,
  score/now carries no place name; `name` absent ⇒ fall back to `abbrev`); `startTimeUTC`.
- Plays: `https://api-web.nhle.com/v1/gamecenter/{id}/play-by-play`. `plays[]`:
  sequence = `sortOrder` (monotonic — evidence); id = String(`eventId`); period from
  `periodDescriptor.number` (label `P{n}`, 4→'OT', 5→'SO'); clock = `timeInPeriod`.
- NHL sends NO prose — template `typeDescKey` → text. REQUIRED templates (en, one line each):
  `goal` (with scorer from `details.scoringPlayerId` resolved via `rosterSpots[]`; if
  unresolvable: 'Goal — {away} {as}, {home} {hs}'), `shot-on-goal`, `missed-shot`,
  `blocked-shot`, `hit`, `faceoff`, `takeaway`, `giveaway`, `penalty` (with `details.descKey`),
  `period-start`, `period-end`, `game-end`, `shootout-complete`, `stoppage`, `goalie-change`.
  Unknown typeDescKey ⇒ text = typeDescKey with '-'→' ' (never dropped silently). kind:
  'score' for goal, 'status' for period-start/period-end/game-end/shootout-complete, else 'play'.
- Noise cap: v0.1 pins `faceoff`, `hit`, `takeaway`, `giveaway`, `blocked-shot`,
  `missed-shot`, `shot-on-goal`, `stoppage` DROPPED at the provider — only goal / penalty /
  period-start / period-end / game-end / shootout-complete / goalie-change are emitted. A
  verbosity setting is a v0.2 candidate and intentionally does not exist in this contract.
- scoreAfter only on goal events (`details.homeScore/awayScore`).
- **Fresh game (§2 pin):** the play-by-play response carries top-level `gameState`,
  `homeTeam.score`/`awayTeam.score`/`abbrev`, `periodDescriptor`, and `clock.timeRemaining`
  (live-probe evidence 2026-07-08, fixture `nhl-play-by-play.json`). `fetchPlays` MUST rebuild
  the Game from these with the same `gameState` mapping as the scoreboard.

### 2.4 PandaScore (`pandascore.ts`) — token required (free tier exists)
- `requiresSecret = 'pandascore.token'`. Provider is hidden from the tree while the secret is
  unset. Never read the token from settings — SecretStorage only.
- Header `authorization: Bearer {token}`.
- Leagues (static): `lol`, `csgo` (CS2), `dota2`, `valorant` (videogame slugs).
- Games: `https://api.pandascore.co/{slug}/matches?filter[status]=running,not_started&sort=begin_at&page[size]=25`
  → Game per match: teams from `opponents[]` (may have 0–2 entries — missing ⇒ 'TBD'),
  score from `results[]` (map count), phase: running→in, not_started→pre,
  finished/canceled→post; statusShort `G{n}` from games count when live else 'vs'.
- "Plays": PandaScore free tier has no play-by-play. `fetchPlays` re-fetches `/matches/{id}`
  and synthesizes EXACTLY ONE event class — map results: for each `match.games[]` entry with
  `finished === true`: id `ps:{matchId}:map{position}`, sequence = `position` (native, stable,
  monotonic), kind 'score', `scoreAfter: undefined`, text **`"Map {position}: {winnerName}"`**;
  winner resolved from `games[].winner.id` against `opponents[]` (PandaScore, unlike LoL
  Esports, DOES carry an immutable per-map winner); unresolvable ⇒ `"Map {position} finished"`.
  The running match score MUST NOT appear in the text (immutable-text pin, §2) — it is mutable
  and would fire false corrections as later maps finish.
  NO other synthesized events — score changes reach the UI via the Game diff
  (`scoreChanged`/status bar) and the match-end line comes from the engine's final-line pin
  (§3.8). Home/away orientation: PandaScore has no home/away — pin `opponents[0]` → home,
  `opponents[1]` → away, identically in `listGames` and `fetchPlays` (0–2 entries; missing ⇒
  'TBD' side, score undefined). This is a SCORE TICKER, not commentary — README must say so.
- 401/403 ⇒ ProviderError('auth'); UI shows one system line naming the fix command.

### 2.5 Naver Sports (`naver.ts`) — key-free, unofficial, Korean leagues
- Base `https://api-gw.sports.naver.com`. Pin: send header `user-agent: Mozilla/5.0` on every
  Naver call (probes succeeded with it; the default extension UA is unverified against this
  gateway).
- Leagues (static): `kbo` (baseball, KBO리그, upperCategoryId `kbaseball`), `kleague`
  (soccer, K리그1, upperCategoryId `kfootball`).
- listGames: `/schedule/games?fields=basic,schedule&upperCategoryId={cat}&categoryId={id}`
  `&fromDate={d}&toDate={d}&size=50` where d = date in **Asia/Seoul** (league-local rule,
  same rationale as MLB's America/New_York). Games under `result.games[]`:
  `gameId`, `homeTeamName/Code/Score`, `awayTeamName/Code/Score`, `stadium`,
  `gameDateTime` — **NO timezone suffix** ('2026-07-08T18:30:00', KST implied): parse as
  +09:00 → startTimeUtc. Phase from `statusCode`: RESULT→post; BEFORE|READY→pre;
  LIVE|STARTED→in; anything else → 'unknown' (evidence covers RESULT only — live mapping
  verified during gate-3 probes). statusText = `statusInfo` ('9회초', '경기종료' — already
  Korean; shown as-is in all locales, pinned acceptable). statusShort = statusInfo when
  ≤ 8 chars else first 8; pre ⇒ 'HH:MM' KST; post ⇒ 'F'.
- **Fresh game (§2 pin):** the relay window carries NO game-level status (live-probe evidence
  2026-07-08: `textRelayData` top keys have no status field; `textRelays[].statusCode` is
  always 0; K League's top-level `statusCode` is the NUMERIC 4, not the schedule's string).
  Therefore `fetchPlays` makes TWO requests: `GET /schedule/games/{gameId}` →
  `result.game` (the SAME shape as a `listGames` entry, with the string `statusCode`
  'RESULT' — verified for both kbo and kleague; fixtures `naver-{kbo,kleague}-game-detail.json`)
  parsed by the same game parser, plus the relay below for events. The detail request is the
  authoritative phase/score source; if it fails, carry the input game and still return the
  relay's events (a failed status refresh must not lose play lines).
- fetchPlays: `/schedule/games/{gameId}/relay` → `result.textRelayData`.
  - KBO (category `kbo`): flatten ALL `textRelays[].textOptions[]`; drop separator entries
    (`type === 99` or text matching /^=+$/); event per remaining option:
    id `naver:{gameId}:{seqno}`, sequence = `seqno` (global monotonic — evidence: 547),
    text = `.text`, period from parent textRelay `inn` + `homeOrAway` ('0' = away batting =
    top ⇒ 'T{inn}', '1' ⇒ 'B{inn}'), scoreAfter from `currentGameState.homeScore/awayScore`
    (string — coerce). kind 'score' when scoreAfter differs from the previous (by seqno)
    option's scoreAfter within the snapshot, else 'play'.
  - K League (category `kleague`): `textRelays[]` is FLAT and NEWEST-FIRST (evidence: no 62,
    61, 60…) — sort ascending by `no`. Event: id `naver:{gameId}:{no}`, sequence = `no`,
    text = `.text` (Korean prose), clock = `half`/`time` → "전반 12'" style left to the
    formatter — provider pins period = 'H{half}', clock = `{time}'` (apostrophe appended
    only when `time` does not already end with one — the field is inconsistent: '+7' vs
    "89'"). kind 'score' when
    `eventType === 'GOAL'` (unverified code — any unknown eventType ⇒ 'play', safe because
    score changes also surface via the Game diff). **STRUCK 2026-07-08 (breaker B1):** the
    relay's top-level `homeScore/awayScore/statusCode/statusInfo` are NOT a Game source —
    its `statusCode` is the numeric `4`, not the schedule's string `'RESULT'`, so mapping it
    silently froze the phase. The game-detail request above is the ONLY phase/score source.
    There must be exactly one mapping code path.
  - The relay endpoint returns only the LATEST window of events. PlaySnapshot = current
    window (see §2 pin). Older lines age out; the engine ignores vanished ids.
  - `result.textRelayData` ABSENT (pre-game — live-probe evidence 2026-07-08; possibly
    between windows) ⇒ NORMAL empty snapshot `{ game, events: [] }` + ctx.log note — NOT a
    parse error. A follow placed before first pitch must not enter an error-backoff loop.
- This endpoint is unofficial and undocumented: any 4xx other than 404/429 ⇒ treat per §4
  key-free auth rule (network-like backoff, never a permanent block).

### 2.6 LoL Esports (`lolesports.ts`) — key-free via public gateway key, unofficial
- Base `https://esports-api.lolesports.com/persisted/gw`. Header
  `x-api-key: 0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z` — the PUBLIC key embedded in the
  lolesports.com frontend (document in README as unofficial). `hl` param: 'ko-KR' when
  locale resolves ko, else 'en-US' (upstream localizes team/league/block names).
- Leagues (static, ids evidence-backed): `lck` (98767991310872058), `lpl`
  (98767991314006698), `lec` (98767991302996019), `msi` (98767991325878492), `worlds`
  (98767975604431411), `first_stand` (113464388705111224). sport 'esports'.
- listGames: `getSchedule?hl={hl}&leagueId={id}` → `data.schedule.events[]` where
  `type === 'match'`. Game id = `match.id`; phase: unstarted→pre, inProgress→in,
  completed→post, else unknown; teams from `match.teams[]` (code → abbrev, name), score =
  `result.gameWins` (number). startTime present with seconds. Only events within ±48 h of
  now are returned as games (the schedule spans a whole split — filter, or the tree drowns).
  statusText: pre ⇒ `BO{strategy.count}` + local start; in ⇒ `BO{count} · {aw}:{hw}`;
  post ⇒ 'Final'. statusShort: pre 'HH:MM'; in 'G{n}' (n = first inProgress game number from
  fetchPlays context, else gameWins sum + 1); post 'F'.
- fetchPlays: `getEventDetails?hl={hl}&id={matchId}` → `data.event`. Synthesize EXACTLY ONE
  event class (map-result pattern, same rationale as §2.4): for each `match.games[]` with
  `state === 'completed'`: id `lol:{matchId}:game{number}`, sequence = `number`, kind
  'score', text **`"Game {number} complete"`** — and `scoreAfter: undefined`.
  **The per-map winner is NOT derivable** (probed 2026-07-08: `games[].teams[]` carries only
  `{id, side}`; only the aggregate `teams[].result.gameWins` exists), so the series score after
  map N is unknowable for any N below the latest. Putting the *current* series score in the
  text violates the immutable-text pin above and provably fired false corrections. The series
  score reaches the user through the Game (status bar) and the §3.8 final line. NO per-kill
  events in v0.1 (the Live Stats window API is a v0.2 candidate — it carries per-map results
  and would let this line name a winner). Game snapshot refreshed from the same response.
- **Fresh game (§2 pin):** `getEventDetails` does NOT carry a usable state — `data.event.state`
  is `null` even for a completed match, and `teams[].result.outcome` is `null` too (live-probe
  evidence 2026-07-08, both a 3–2 and a 3–0 match). Derive phase from the match itself:
  win threshold `W = ceil(strategy.count / 2)`; `post` iff `max(gameWins) >= W`, OR (when
  `strategy.count` is missing/unparsable) every `games[].state` ∈ {completed, unneeded} with at
  least one 'completed'; `in` iff any `games[].state === 'inProgress'`; else carry the input
  game's phase. A swept series leaves the unplayed maps as `state: 'unneeded'` (fixture
  `lolesports-eventdetails-sweep.json`) — 'unneeded' is terminal, NOT pending. On post also set
  statusText 'Final', statusShort 'F', and refresh both scores from `gameWins`.
- The gateway key may be rotated by Riot at any time ⇒ 403 handled as key-free `auth`
  (network-like backoff), README documents the risk.

## 3. RelayEngine (`src/core/relay.ts`) — pure

- Constructor takes `RelayEngineOptions`; one engine instance per followed game.
- State: MAP of emitted id → normalized emitted text, set of corrected ids, last game
  snapshot, whether the final line has been emitted.
- Restore after reload creates a FRESH engine with empty state. The first ingest of a
  restored follow is a first-ever ingest governed by the backfill cap. Rationale:
  OutputChannel content does not survive reload; re-showing ≤ backfillLimit recent plays
  restores context and is sound for providers whose sequence is positional (ESPN). NO
  cross-reload dedup state is persisted.
- `ingest(snapshot)`:
  1. Candidates = events whose id is not in the emitted map.
  2. First-ever ingest with candidates.length > backfillLimit ⇒ emit only the LAST
     backfillLimit (by sequence), prepend one 'system' line "(N earlier plays skipped)" /
     "(이전 플레이 N개 생략)". Skipped ids ARE added to the emitted map (with their text).
  3. Later ingests: emit ALL candidates ordered by (sequence, id) — no cap (live drift is
     small; a mid-game API hiccup that returns is backfilled in full).
  4. Correction: applies ONLY to events with provider-native ids (MLB, NHL, ESPN plays with
     `.id`, PandaScore). For such an id already emitted whose normalized text (trim +
     collapse whitespace) differs from the stored text ⇒ re-emit once as kind 'correction'
     (same id, new text) and update the stored text. At most ONE correction per id per game
     (ignore further flapping). For derived-id events text is part of identity: an upstream
     text edit surfaces as one additional 'play' line; the stale line is not retracted or
     marked — accepted for v0.1.
  5. Events that vanished from the snapshot: ignored (no retraction lines).
  6. `scoreChanged` compares home.score/away.score with previous snapshot (undefined ≠ n
     counts as change only when both defined or becoming defined).
  7. `phaseTransition` set on any phase CHANGE (undefined on the first-ever ingest — pin).
  8. Final line: on the FIRST ingest where `game.phase === 'post'` — whether reached by
     transition, first-ever ingest, or 'unknown'/'pre' → 'post' — emit one 'system' line, at
     most once per engine instance: `finalScore(away,as,hs,home)` when at least one score is
     defined, else `gameEnded` (covers postponed/cancelled surfacing as 'post', no scores).
- Engine NEVER throws on weird input: empty events, duplicate ids in one snapshot (first
  wins), non-finite sequence (treat as previous max + 1 and log nothing — pure function).

## 4. PollScheduler (`src/core/poller.ts`)

- Injectable `{ setTimeout, clearTimeout, now }` for tests; global semaphore maxConcurrent 4.
- Per followed game loop: interval by phase — pre: 60 s (20 s when `startTimeUtc` within
  2 min or past); 'unknown': 60 s; in: `pollSecondsLive` (default 20, clamp 10–120) with
  ±10% jitter; post:
  stop the game's poll loop after ANY ingest whose snapshot phase is 'post' (transition NOT
  required — covers following an already-finished game); set `postObservedAt = now()` if 0.
- Never two in-flight fetches per game (skip tick if busy). Never poll a game whose provider
  is in auth-failure state.
- Failure policy (per game): consecutive-failure counter; delay = min(interval · 2^n, 300 s).
  On first failure of a streak with n ≥ 3, surface ONE system line (connection trouble); on
  recovery after a surfaced streak, ONE system line (restored). `rate-limit` ⇒ delay =
  max(retryAfterMs ?? 0, 60 000 ms) and counts as a failure. `unavailable` ⇒ same policy as
  `network` (counts toward the streak, exponential backoff, surfaced at n ≥ 3). `auth`: if the
  provider's `requiresSecret` is SET ⇒ mark provider blocked, system line naming
  `vibeStealth.setPandascoreToken`; if `requiresSecret` is undefined (key-free provider —
  ESPN serves transient 403s) ⇒ treat exactly like `network` (no permanent block, no token
  line). `not-found` 3× consecutive ⇒ system line + auto-unfollow. `parse` ⇒ same as network
  + ctx.log(payloadHead).
- Auto-unfollow MUST NOT depend on future poll ticks: on entering post, schedule a dedicated
  one-shot timer for `postObservedAt + 10 min` (injectable clock; cleared on manual
  unfollow), with a quiet system line. At activation, a restored follow with persisted
  `postObservedAt > 0` is auto-unfollowed immediately (quiet) — no poll loop or engine
  created. Restored follows older than 36 h are dropped at activation, aged on
  `FollowedGameState.followedAt` (NOT startTimeUtc — the persisted model has no start time;
  amended 2026-07-08 after conformance audit finding m3. A follow can only be placed from the
  current scoreboard window, so followedAt ≈ startTimeUtc, and any game that actually finished
  is already dropped by the postObservedAt rule). `followedAt === 0` ⇒ age unknown ⇒ keep.
- All numeric settings are read as `Math.round(Number(v))` then clamped to their pinned
  range; NaN ⇒ default.
- **Runaway guard (defense in depth; added 2026-07-08 after breaker finding B1).** Every
  provider here wraps an API that can change shape without warning; §2's fresh-game pin can
  therefore silently regress and a followed game would poll at live cadence forever. The
  poller MUST bound this independently of any provider: track `firstPollAt` (injected clock);
  if a game has been polled for more than **12 h** without ever ingesting phase 'post', stop
  the loop, `onSystemLine('staleGame')`, and `onAutoUnfollow()`. 12 h exceeds any real match
  (longest MLB extra-innings ≈ 7 h; a BO5 esports series ≈ 6 h) so it never fires on a healthy
  game. The guard is checked on each tick, so a wedged fetch cannot postpone it indefinitely.
- Scoreboard refresh (tree): separate loop, `pollSecondsScoreboard` (default 60, clamp
  30–600), runs ONLY while the tree view is visible; manual refresh always allowed. Each
  refresh fans out per enabled league through the same semaphore; one league failing renders
  an inline error node, others render normally.

## 5. Formatter (`src/core/format.ts`) + i18n (`src/core/i18n.ts`)

- Relay line: `HH:MM:SS │ {tag}{marker}{period+clock} │ {text}` where tag = `[AWY-HOM] ` only
  when > 1 game followed; marker: '★ ' for kind 'score', '⚠ ' for 'correction' + localized
  '(corrected)' suffix, '· ' otherwise; emoji sport prefix (⚾🏀🏈🏒⚽🎮) prepended to text
  when `relay.showEmoji` (default true). Timestamps from injected `now()`, local time.
- Period localization (ko): `T7`→'7회초', `B7`→'7회말', `Q3`→'3쿼터', `P2`→'2피리어드',
  `OT`→'연장', `SO`→'승부치기'|hockey '슛아웃', `HT`→'전반 종료', `FT`→'경기 종료'. en: as-is.
- i18n: `t(locale, key, params)` over a flat template map; EVERY key exists in BOTH en and ko
  (test-enforced); missing key at runtime falls back to en then to the key itself.
- System-line keys (minimum): `backfillSkipped(n)`, `finalScore(away,as,hs,home)`,
  `gameEnded`, `connectionTrouble`, `connectionRestored`, `authRequired(provider,command)`,
  `gameVanished`, `autoUnfollowed`, `staleGame`, `followed(game)`, `unfollowed(game)`,
  `restoredFollow(game)`.
- `authRequired` carries NO params from the poller (which knows neither the provider name nor
  the fix command); the UI substitutes `{provider}` and `{command}` before calling `t()`.
- Status bar text: `{away.abbrev} {as}:{hs} {home.abbrev} · {statusShort}` (scores '–' when
  undefined); NO emoji, NO color; tooltip lists all followed games with full names.

## 6. UI shell (`src/ui/`, `src/extension.ts`)

- IDs/settings/commands EXACTLY as `IDS` in contract.ts; package.json contributes match 1:1.
- Tree: Provider → League → Game. Followed games get `$(star-full)` icon + move to a pinned
  'Following' section at the root (top). Game label = `{away.abbrev} {as}:{hs} {home.abbrev}`,
  description = statusText. Empty league ⇒ collapsible node with one 'no games' child.
  Providers with `requiresSecret` unset secret ⇒ omitted entirely.
- Follow: tree context menu + command palette (palette path: QuickPick of today's games).
  Following an already-followed game is a no-op (status message, not error). Cap
  `maxFollowedGames` (default 6): refuse with actionable message.
- Relay output: ONE `LogOutputChannel`-style OutputChannel named 'Vibe Stealth Relay'
  (plain OutputChannel — we format our own lines). `openRelay` reveals with `preserveFocus`.
  Diagnostics go to a separate 'Vibe Stealth Diagnostics' channel, created lazily.
- Status bar: right side, priority 90, hidden when nothing followed or setting off. Game
  selection (exact): scan the followed array from the END (most recent first) through tiers,
  first hit wins — (1) phase 'in'; (2) phase 'post' within the 10-min lame-duck window;
  (3) phase 'pre' or 'unknown'. Re-evaluate on every RelayEmission, every
  follow/unfollow/auto-unfollow, and on settings change (so when the newest game ends while
  an older followed game is live, the bar moves to the live one). Before the first successful
  fetch after reload, render from `FollowedGameState.lastKnown`. Click ⇒ `pickFollowed`
  QuickPick (open relay / unfollow).
- Persistence: `workspaceState[IDS.state.followedGames]` = FollowedGameState[]; array order IS
  follow order (append on follow, remove on unfollow, re-follow moves to end); saved on every
  follow/unfollow and `lastKnown` advance (debounced 5 s); restored on activation (drop
  > 36 h old; `postObservedAt > 0` ⇒ immediate quiet auto-unfollow).
- Known limitation (pinned, documented in README): follows are workspace-scoped; two windows
  on the same folder run independent pollers (doubled request rate). `globalState` sharing is
  a v0.2 candidate.
- `@types/vscode` major.minor MUST equal the `engines.vscode` minimum (exact pin — vsce
  rejects a lockfile-resolved newer version at package time).
- Activation: `onStartupFinished` + tree view. Activation must not await network — kick off
  restore/refresh fire-and-forget with catch → diagnostics.
- ALL user-visible strings via i18n (locale setting 'auto' resolves from `vscode.env.language`
  startsWith 'ko'). NO modal dialogs anywhere; errors are status-bar background + system lines.
- Every disposable registered in `context.subscriptions`; poller fully stopped on deactivate.

## 7. Failure semantics outside specified paths

Any uncaught exception in a poll tick / tree refresh / command handler is caught at that
boundary, written to Diagnostics with stack, and NEVER crashes the extension host, never
shows a modal, never kills other games' loops. A provider throwing non-ProviderError is
wrapped as `parse`.

## 8. Hostile-probe list (verification will run these — build so they pass)

P1 Truncated/invalid JSON body ⇒ single `parse` error, backoff, no crash, other games unaffected.
P2 ESPN plays with null text + duplicate ids ⇒ no line for null-text, one line per unique id.
P3 Scores 'N/A' / '-1' / '3.5' / '1e9' ⇒ score undefined, UI shows '–', no NaN anywhere.
P4 Snapshot shrinks then re-grows with changed text ⇒ ≤ 1 correction line, no duplicate originals.
P5 Dates '2026-07-07T18:15Z', 'TBD', '' ⇒ parsed / phase-unknown, never a crash or 'Invalid Date' shown.
P6 429 with Retry-After: 120 ⇒ next poll ≥ 120 s (fake clock test).
P7 First snapshot with 5 000 events, backfillLimit 10 ⇒ exactly 11 lines (1 system + 10 plays).
P8 Unicode team 'CF Montréal', CJK text, emoji in play text ⇒ intact end-to-end, ≤ 500 chars.
P9 Terminal payload per provider ⇒ `fetchPlays` returns `game.phase === 'post'` (§2 fresh-game
   pin) — the poller then stops, the final line fires once, auto-unfollow arms.
P10 A provider that never reports 'post' (upstream shape regression) ⇒ the poller's 12 h
   runaway guard stops the loop, emits `staleGame`, and auto-unfollows.
P11 A key-free provider returning 403 ⇒ network backoff + `connectionTrouble` at n≥3; NO
   `authRequired` line, no permanent block (§4).
P12 A multi-map series polled once per finished map ⇒ each map emits exactly ONE line and NO
   correction is ever produced (immutable-text pin, §2). Applies to LoL Esports and PandaScore.

## 9. Module exports (pinned so parallel tasks link on first try)

- `src/core/contract.ts`, `src/core/util.ts` — the shared type contract and pure helpers; do not modify.
  util.ts: `fnv1a32`, `coerceScore`, `sanitizeText`, `normalizeWs`, `parseIsoUtc`,
  `clampInt`, `dateInZone` (all §2 behaviors — providers MUST use these, not re-implement).
- `src/core/http.ts`:
  `export function createFetchJson(opts: { version: string; log(msg: string): void; fetchImpl?: typeof fetch }): (url: string, headers?: Record<string, string>) => Promise<unknown>`
  (`fetchImpl` injectable for tests; default global fetch).
- `src/core/i18n.ts`:
  `export function resolveLocale(setting: string, displayLanguage: string): RelayLocale` ('auto' ⇒ ko iff displayLanguage starts with 'ko');
  `export function registerMessages(locale: RelayLocale, map: Record<string, string>): void` (UI layer registers its own strings at activation);
  `export function t(locale: RelayLocale, key: string, params?: Record<string, string | number>): string` (core §5 keys pre-registered in BOTH locales; lookup miss ⇒ en ⇒ key).
  Template syntax: `{name}` placeholders.
- `src/core/relay.ts`: `export function createRelayEngine(options: RelayEngineOptions): RelayEngine` (uses t() internally for its system lines).
- `src/core/format.ts`:
  `export function formatEventLine(event: PlayEvent, game: Game, opts: FormatOptions): string`;
  `export function formatStatusBar(awayAbbrev: string, awayScore: number | undefined, homeScore: number | undefined, homeAbbrev: string, statusShort: string): string`;
  `export function localizePeriod(period: string | undefined, sport: SportKind, locale: RelayLocale): string | undefined`.
- `src/core/poller.ts`: `export function createSemaphore(max: number): Semaphore`; `export function createGamePoller(options: GamePollerOptions): GamePoller`.
- Providers: `export const espnProvider / mlbProvider / nhlProvider: SportProvider`;
  `export const naverProvider / lolesportsProvider / pandascoreProvider: SportProvider`.
- `src/providers/index.ts`: `export function getProviders(): SportProvider[]`
  (display order: naver, lolesports, mlb, nhl, espn, pandascore);
  `export function getProvider(id: string): SportProvider | undefined`;
  `export const DEFAULT_LEAGUE_KEYS: string[]` (every league of every key-free provider).
- `src/extension.ts`: exports `activate` / `deactivate` only. `src/ui/**` internal structure is an implementation detail.
- Seam ownership note: RelayEngine system lines arrive already localized inside
  `RelayEmission.events`; poller system lines arrive as i18n KEYS via `onSystemLine` — the
  UI translates them (asymmetry pinned deliberately: the engine knows event shape, the
  poller does not).

## 10. Testing pins

- vitest; tests in `test/**`; fixtures in `test/fixtures/` (trimmed real payloads provided).
- Core: RelayEngine (dedup/backfill/correction/watermark/phase), poller with fake timers
  (intervals, backoff, semaphore, rate-limit), formatter (all locales × kinds), i18n parity.
- Providers: parser tests over fixtures + mutated fixtures (P2/P3/P5 shapes).
- No network in tests. Every ProviderError kind exercised at least once.

## 11. Live "current state" — bases/count, lineups, draft (v0.2)

A followed game's mutable current state, rendered as TREE CHILD ROWS under the game (user
chose the sidebar-tree surface over a webview). Types: `GameState` union in contract.ts.

### 11.1 The invariant (why this is separate from the relay)
- GameState is a SNAPSHOT that is REPLACED wholesale every poll. It is NEVER turned into
  PlayEvents and NEVER written to the relay Output channel. The relay is append-only and its
  text is immutable (§2 immutable-text pin, which the P12 correction bug enforced); a value
  that changes every poll must not go there. State lives only in the tree.
- Flow: `provider.fetchPlays` may set `PlaySnapshot.state` → `RelayEngine.ingest` copies it
  UNCHANGED onto `RelayEmission.state` (no diff, no emit) → `FollowManager` stashes it on the
  followed entry and refreshes the tree → the tree renders child rows from it.
- State is TRANSIENT: not persisted in `workspaceState`, not on `FollowedGameState.lastKnown`.
  After a reload it is simply re-fetched on the next poll (undefined until then).

### 11.2 When state is present
- Only for a FOLLOWED game whose `phase === 'in'` (bases/count/draft are live-only). pre/post
  ⇒ `state` undefined (the tree shows no state rows; the game row still renders normally).
- Only when `ctx.gameStateEnabled` is true for state that costs an EXTRA request (LoL). State
  that is free from the play payload (MLB, ESPN soccer) MAY always be populated; the UI skips
  rendering when the setting is off (§11.6).
- A parse failure of the state portion MUST NOT fail `fetchPlays`: on any state-shape surprise,
  set `state` undefined (ctx.log the reason) and still return game + events. State is a bonus,
  never load-bearing.

### 11.3 MLB baseball state (`mlb.ts`) — free, from the SAME `feed/live` payload
- `state = { kind: 'baseball', … }` built from `liveData.linescore` + `liveData.boxscore`
  (already fetched for plays — zero extra requests). Evidence: `mlb-feed-live-state.json`.
- `balls`/`strikes`/`outs` from `linescore.{balls,strikes,outs}` (coerce to int; clamp balls
  0–4, strikes 0–3, outs 0–3; missing ⇒ 0).
- `bases.{first,second,third}` = `linescore.offense.{first,second,third}.fullName` when that
  base object is present, else undefined (empty base). `atBat`/`onDeck` =
  `offense.{batter,onDeck}.fullName`; `pitcher` = `defense.pitcher.fullName` — each undefined
  if absent (e.g. between innings).
- Lineups: for each side, walk `boxscore.teams.{home,away}.battingOrder[]` (array of player
  ids), resolve each via `boxscore.teams.{side}.players['ID'+id]` → LineupSpot { order (1-based
  index), name = `person.fullName`, position = `position.abbreviation`, jersey =
  `jerseyNumber` when present }. Skip an id that doesn't resolve (log). Empty order ⇒ `[]`.
- home/away sides map to the same home/away as the Game.

### 11.4 ESPN soccer lineups (`espn.ts`) — free, from the SAME `summary` payload
- Only for soccer leagues. `state = { kind: 'soccer', … }` from `summary.rosters[]`. Evidence:
  `espn-summary-rosters.json`. Absent pre-game ⇒ `state` undefined.
- Match each roster entry to home/away by `roster.homeAway` ('home'/'away'); if absent, index
  0 ⇒ home, 1 ⇒ away (mirror the scoreboard's competitor order — VERIFY against fixture).
- `formation` = `roster.formation` (e.g. '4-2-3-1') or undefined.
- `starters` = entries with `starter === true`; `bench` = `starter === false`. Each →
  LineupSpot { order (1-based within its group, ordered as the API lists), name =
  `athlete.displayName`, position = `position.abbreviation`, jersey = `jersey` }.

### 11.5 LoL Esports draft (`lolesports.ts`) — ONE extra request, gated on `gameStateEnabled`
- Only when `ctx.gameStateEnabled` AND the match has an in-progress or most-recent game with a
  platform id. `getEventDetails` gives `match.games[]` with `{number, state, id}`; pick the
  game whose `state === 'inProgress'`, else the highest-`number` non-'unstarted' game. That
  `id` is the LIVESTATS game id.
- Fetch `https://feed.lolesports.com/livestats/v1/window/{gameId}?startingTime={ts}` — NO api-key
  header (public; probed). **`startingTime` is REQUIRED for live data** (amended 2026-07-09):
  without it the endpoint returns the frames from KICKOFF, whose gold/kills are all `0`, so a live
  game silently reported no gold and no kills. `ts` = `now - 60s`, floored to a 10-second boundary,
  formatted `YYYY-MM-DDTHH:MM:SSZ` (the API rejects sub-10s precision). It answers with ~57 frames
  covering the ~10 s after `ts`; take the LAST frame.
  Probed live during MSI BLG-vs-HLE: without the param, `blueGold: 0, blueKills: 0`; with it,
  `blueGold: 32516, blueKills: 15, redGold: 27082, redKills: 2`.
  On 204/404/no `gameMetadata` (draft not locked yet) ⇒ `state` undefined, not an error.
- `state = { kind: 'esports', … }` from `gameMetadata`. Evidence: `lolesports-window.json`.
  - `patch` = `gameMetadata.patchVersion` shortened to major.minor ('16.13.…' ⇒ '16.13') or undefined.
  - blue/red from `{blue,red}TeamMetadata.participantMetadata[]`: teamCode = the team's abbrev
    from the Game (blue ≈ away or home? the window has no side mapping to the esports match —
    pin: blue = the Game's `away` team code, red = `home`, matching the §2.6 teams[0]→away
    convention; if the codes can be cross-checked via summonerName prefix, prefer that, else
    use the convention and log). picks[] = { role = `role` lowercased, champion = `championId`
    (already a readable name), player = `summonerName` }.
  - Optional live totals from `frames[frames.length-1]`: `gold = {blue: blueTeam.totalGold,
    red: redTeam.totalGold}` and `kills` likewise, ONLY when both are finite and not both 0
    (the plain window returns early frames where they're 0 — don't show a fake 0-0). undefined otherwise.
- Because providers are stateless, the window is re-fetched each poll while live; draft is
  static so it re-parses to the same value (idempotent). Acceptable: 1 extra GET / poll for a
  followed live LoL game, and only when the setting is on.

### 11.6 Tree rendering (`gamesTree.ts`) — child rows under a followed game
- A followed game node (`followEntry`) with a non-undefined `state` becomes COLLAPSIBLE and
  yields state child rows; without state it stays a leaf. Non-followed games never show state.
- Rows are plain `TreeItem`s (label + optional description), no icons required. Suggested shape
  (labels via i18n; exact glyphs are the UI's choice):
  - baseball: a count/outs row (`{outs} out · {balls}-{strikes}`), a bases row (only occupied
    bases, e.g. `1B Rutschman · 2B Henderson`; omit entirely if none on), an at-bat/pitcher row
    (`타석 {atBat} · 투수 {pitcher}`), and a collapsible `라인업` node per team → the 9 spots
    (`{order} {position} {name}`).
  - soccer: a formation row per team, and a collapsible `선발` node per team → the XI.
  - esports: a blue row and a red row each collapsible → 5 picks (`{role} {champion} ({player})`),
    plus an optional patch/gold row.
- Rows refresh whenever a new emission updates the entry's state (fire the tree's change event
  for that node). Guard against a state row throwing — a bad state must not break the tree
  (§7): wrap child construction so one malformed field degrades to fewer rows, never a throw.
- The `gameState.enabled` setting (default true) hides ALL state rows when false and, combined
  with §11.2, stops the LoL extra request.

### 11.7 Settings & i18n
- New setting `vibeStealth.gameState.enabled` (boolean, default true) in package.json + IDS.
- New i18n keys (en+ko parity) for the row labels: at least `stateOut(n)`, `stateCount`,
  `stateBases`, `stateAtBat`, `statePitcher`, `stateLineup`, `stateStarters`, `stateFormation`,
  `stateBlue`, `stateRed`, `statePatch`, `stateGold`. Korean: 아웃/볼카운트/주자/타석/투수/
  라인업/선발/포메이션/블루/레드/패치/골드.

### 11.8 Tests
- Provider parser tests over the three new fixtures (`mlb-feed-live-state.json`,
  `espn-summary-rosters.json`, `lolesports-window.json`) + mutated variants: empty bases,
  missing batter, unresolvable lineup id, absent rosters (pre-game ⇒ undefined), window with no
  gameMetadata (⇒ undefined), all-zero frame (⇒ no gold shown), non-integer counts (clamped).
- A pin test that `RelayEngine.ingest` copies `snapshot.state` to `emission.state` untouched
  and emits ZERO events for a state-only change.
- P13 (hostile): a followed live game whose `fetchPlays` throws while building state ⇒ events
  still returned, `state` undefined, no crash.

## 12. Detail level — pitch-by-pitch and structured events (v0.3)

New setting `vibeStealth.detail`: `'summary'` (DEFAULT — today's behavior) | `'detailed'`.
Exposed to providers as `ctx.detail` (live getter, like `gameStateEnabled`).

### 12.1 The i18n rule that makes this work
Probed 2026-07-09: MLB StatsAPI supports `?language=es` but NOT `ko` (falls back to English);
ESPN supports `lang=es` but `lang=ko` returns a broken payload (`commentary: null`). **API prose
can never be Korean.** Therefore:
- **Text the PROVIDER composes from structured fields is localized** via `t(ctx.locale, key, params)`.
  Pitch data carries no prose at all, so those lines are ours by necessity — and thus Korean-capable.
- **Text the API supplies as prose is passed through verbatim** (MLB at-bat `result.description`,
  ESPN soccer `commentary[].text`, Naver's already-Korean relay). Never machine-translate.
- User decision (2026-07-09): keep the API prose (maximum information: "grounds out softly,
  catcher Haase to first baseman Devers") and localize only the structured lines. A ko user
  therefore sees Korean pitch lines above an English at-bat result. This is intentional.
- Providers gain access to `t()` for this. They still MUST NOT import `vscode`.

### 12.2 The immutable-text invariant still governs (§2)
Every detailed line's text must be a pure function of that event's own IMMUTABLE facts. A pitch's
type/speed/zone/call and the count BEFORE it was thrown are immutable (§12.3). The running score
and the current inning are NOT — they must not appear in a pitch line. Same false-correction trap
as P12; P14 tests it.

### 12.3 MLB pitch-by-pitch (`mlb.ts`)
- `detail === 'summary'` ⇒ exactly today's events (one per completed at-bat). No change.
- `detail === 'detailed'` ⇒ additionally emit one event per PITCH, before its at-bat's result line.
  Source: `allPlays[].playEvents[]` where `isPitch === true`. Evidence: `mlb-pitch-events.json`.
  - id: `mlb:{gamePk}:{atBatIndex}:p{playEvent.index}` — stable, immutable.
  - sequence: at-bat events must sort BEFORE the at-bat result. Pin: `sequence = atBatIndex * 1000
    + playEvent.index` for pitches, and `atBatIndex * 1000 + 999` for the at-bat result line.
    (Both stay monotonic; `index` is < 999 in every observed at-bat.)
  - kind: `'play'`. `scoreAfter`: undefined (a pitch doesn't set the score; the result line does).
  - period: same `T{n}`/`B{n}` as the at-bat.
  - text, composed and LOCALIZED — key `pitchLine` with params
    `{type, mph, zone, call, balls, strikes}`:
    - en: `'{type} {mph} · zone {zone} · {call} ({balls}-{strikes})'`
    - ko: `'{type} {mph} · 존{zone} · {call} ({balls}-{strikes})'`
    - `type` from `details.type.description` ('Sinker'), localized through a `pitchType.*` map
      (ko: 싱커/커터/포심 패스트볼/슬라이더/체인지업/커브/스플리터/싱커…); UNKNOWN type ⇒ pass the
      English description through unchanged (never drop the line).
    - `call` from `details.description` ('Called Strike'/'Ball'/'Foul'/'Swinging Strike'/
      'In play, out(s)'…), localized through a `pitchCall.*` map (ko: 루킹 스트라이크/볼/파울/
      헛스윙/타격…); unknown ⇒ pass through.
    - `mph` = `pitchData.startSpeed` rounded to 1 decimal; omit the token entirely when absent.
    - `zone` = `pitchData.zone` (1–14; 1–9 in the strike zone, 11–14 outside); omit when absent.
    - `balls`/`strikes` = the count **BEFORE** this pitch (amended 2026-07-09 after a live check).
      The payload's `count` is POST-pitch, and on the pitch that ends an at-bat it overflows to a
      count baseball does not have: a strikeout swing reads `0-3`, a walk reads `4-2`. Measured on
      a full live game: **13 of 155 pitches (8.4 %) displayed an impossible count.** Broadcast
      convention is the pre-pitch count ("swinging strikeout on 1-2"), and it reconstructs exactly
      — the pre-pitch count of pitch *n* is the `count` of pitch *n-1* within the same at-bat, and
      `0-0` for the first. Do NOT clamp the post-pitch value: clamping would render a strikeout as
      `0-2` and a walk as `3-2`, silently wrong in a different way. Carry the previous pitch's
      count forward instead. Non-pitch `playEvents` (pickoffs, timeouts) do not advance it.
  - A pitch whose payload lacks type AND call is SKIPPED (nothing meaningful to say), logged.
  - Pickoffs / step-offs (`isPitch !== true`) are never emitted.
- Backfill: a detailed at-bat can add ~4 lines. The §3.3 backfill cap is unchanged and still
  counts LINES, so following mid-game stays bounded.

### 12.4 NHL detailed events (`nhl.ts`)
- `summary` ⇒ today's set (goal / penalty / period-start / period-end / game-end /
  shootout-complete / goalie-change). No change.
- `detailed` ⇒ additionally emit `shot-on-goal`, `missed-shot`, `blocked-shot`, `hit`, `takeaway`,
  `giveaway` (still NOT `faceoff`/`stoppage` — pure noise). All are provider-composed, so all are
  localized. Enrich from `details`: `shotType` ('snap'/'wrist'/'slap'/'backhand'/'tip-in'/'deflected'
  — localized map, unknown passes through), `zoneCode` ('O'/'D'/'N' → 공격/수비/중립 지역).
- Goals gain their available detail in BOTH levels (it is immutable): scorer season total
  (`scoringPlayerTotal`) and assists (`assist1PlayerId`/`assist2PlayerId` resolved via `rosterSpots`).
  ko: `'{shotType} 골 — {scorer} (시즌 {total}호){assists}'`; en mirrors it. Unresolvable ⇒ the
  existing §2.3 fallback.

### 12.5 ESPN soccer detailed events (`espn.ts`)
- `summary` ⇒ today's `commentary[]` prose (unchanged — it IS the rich text).
- `detailed` ⇒ ALSO emit `keyEvents[]` as provider-composed, localized lines, interleaved by clock.
  Evidence: keyEvents carry `type: {id, text, type}` ('goal'), `team.displayName`,
  `participants[].athlete.displayName`, `clock.displayValue`, `scoringPlay`.
  - id: native `.id`. sequence: reuse the commentary sequence space — pin `sequence = 100000 +
    parsedClockMinutes * 100 + n` so key events sort near their minute without colliding with
    commentary indices. kind: `'score'` when `scoringPlay === true`, else `'play'`.
  - text via key `soccerEvent` with `{type, player, team}`; `type` localized through an
    `soccerEventType.*` map (goal/yellow card/red card/substitution/penalty — ko 골/경고/퇴장/교체/
    페널티); unknown type ⇒ use the API's `type.text` verbatim.
  - Duplicate suppression: a keyEvent whose minute+player already appears in a commentary line is
    still emitted (different id) — accepted; the two views complement each other.

### 12.6 LoL Esports kill feed (`lolesports.ts`) — `detailed` only
Probed 2026-07-09 against a live MSI game; the v0.3 claim that this was impossible was WRONG on
both counts and is corrected here.

**What the feed actually gives.** `livestats/v1/window/{gameId}?startingTime={ts}` returns ~10 s of
frames at ~6 Hz. Each frame carries, per participant, cumulative `kills` / `deaths` / `assists`,
and per team `towers`, `inhibitors`, `barons`, and a `dragons[]` array of drake types. **Diffing
consecutive frames yields the killer, the victim and the assisters** — verified over a real
teamfight:
```
08:27:37  JarvanIV(BLG Xun) → Naafiri   [assists: Akali, Shen]
08:27:38  Ziggs(HLE Gumayusi) → Akali   [assists: Rumble, Naafiri, Yone, Rell]
08:29:41  BLUE dragon — chemtech
```

**Gapless coverage is possible.** `startingTime` addresses ANY past instant, and consecutive 10 s
windows tile with a +0.1–0.3 s seam — measured: zero kills lost, zero duplicated, across window
boundaries. So the provider does not need to observe every instant live; it re-reads the interval
it has not yet covered.

**The state this needs, and why it does not violate the stateless pin.** §2's rule forbids a
provider from DIFFING or DEDUPING across calls — that is the engine's job (§3.4), and breaking it
is what caused P12. Remembering *where to resume reading a cursor* is neither. Naver already has a
comparable exception (its relay returns only the latest window). Pin:
- `fetchPlays` keeps a per-`gameId` cursor: the `rfc460Timestamp` of the last frame it consumed.
  It lives in a module-level `Map<gameId, string>`, is dropped when the game leaves `in`, and is
  NEVER consulted to decide whether an event is new — the engine still dedupes by id.
- Each poll advances the cursor by requesting `ceil(pollSeconds / 10)` windows, starting at the
  cursor floored to a 10 s boundary. At the default 20 s poll that is **2 windows**, so a live LoL
  game costs 3 requests per poll instead of 2 (+50%). Cap the catch-up at **6 windows** (60 s) per
  poll so a resumed follow cannot stampede.
- FIRST poll of a game (no cursor): read exactly ONE window at `now − 60 s`. Do not replay the
  whole match — §3.3's backfill cap governs what the user sees anyway.

**Events.** Emitted only when `ctx.detail === 'detailed'` AND `ctx.gameStateEnabled` (the setting
that already gates this endpoint). Text is provider-composed, so it is localized (§12.1).
- id — immutable, and stable when the same window is re-read (verified):
  `lol:{gameId}:k:{frameTimestamp}:{sortedVictimIds}` for a kill,
  `lol:{gameId}:o:{frameTimestamp}:{side}:{objective}` for an objective.
- sequence: `Date.parse(frameTimestamp)` (ms). Monotonic within a game and never collides with the
  map-result events, whose sequence is a small map `number` — pin: map-result sequence stays as it
  is, and because kill sequences are epoch-ms they always sort after. Ties broken by id (§3.4).
- kind `'score'` for a kill or a baron/dragon/inhibitor, `'play'` for a tower.
- `scoreAfter`: undefined. The series score is unrelated and MUST NOT appear in the text (§2
  immutable-text pin — the running kill count is mutable, the kill itself is not).
- text keys: `lolKill` {killer, victim}, `lolKillAssist` {killer, victim, assists},
  `lolObjective` {team, objective}. Objective names via `tEnum(locale,'lolObjective', …)` —
  tower / inhibitor / baron / and drake types (cloud, ocean, infernal, mountain, hextech,
  chemtech, elder). Unknown drake ⇒ its raw English passes through (§12.1).
- A death with NO participant's `kills` incrementing is an execution / tower / minion kill: emit
  `lolDeath` {victim}, never inventing a killer.

**Failure paths — all silent, none fatal.** The window answers `204` before a game's first frame
(surfaces as `ProviderError('parse')` — empty body), `400` for a non-10 s-boundary or future
`startingTime`, and `204` again when asked past the last frame of a finished game. Every one of
these ⇒ no kill events this poll, cursor unchanged, `state` and the map-result events unaffected.
A kill-feed failure must never fail `fetchPlays`.

### 12.7 Settings, i18n, tests
- `vibeStealth.detail`: enum `['summary','detailed']`, default `'summary'`, NLS-described.
  `ProviderContext.detail: 'summary' | 'detailed'` (live getter).
- i18n keys (en+ko parity, provider-facing): `pitchLine`, `pitchType.*`, `pitchCall.*`,
  `nhlShot.*`, `nhlZone.*`, `nhlGoal`, `soccerEvent`, `soccerEventType.*`.
  Unknown enum member ⇒ pass the API's own English through; NEVER drop a line and never render a
  raw `{placeholder}`.
- P14 (hostile): the same at-bat polled twice as its count advances ⇒ each pitch emits exactly
  ONE line and ZERO corrections (immutable-text pin, §2 / §12.2).
- Tests: `detail: 'summary'` reproduces today's event lists byte-for-byte (regression guard);
  `'detailed'` adds pitches in the pinned order (all pitches of at-bat N precede N's result line
  and precede at-bat N+1); a pitch with no type/call is skipped; unknown pitch type/call passes
  through untranslated; ko locale renders 존/루킹 스트라이크.

## 13. Team & league logos (v0.4)

Real logos on tree rows. Setting `vibeStealth.logos.enabled` (boolean, default true).

### 13.1 Why a disk cache, not a remote URL
`TreeItem.iconPath` takes a `Uri`, but VS Code does not fetch remote `https:` icons for tree
items — only local files render. So a logo is DOWNLOADED ONCE, written under
`context.globalStorageUri/logos/`, and referenced as a `file:` Uri. Side benefits: works offline
after the first fetch, one request per distinct URL for the life of the install, and light/dark
variants come free via `iconPath: {light, dark}`.

### 13.2 Domain (contract.ts)
```ts
export interface LogoRef { light: string; dark?: string; }   // absolute https URLs
```
- `TeamSide.logo?: LogoRef` and `League.logo?: LogoRef`. Both OPTIONAL everywhere; a provider
  that has no logo simply omits it and nothing downstream changes.
- Providers only supply URLs. They never fetch images (`ctx.fetchJson` is JSON-only).

### 13.2b Request small images (amended 2026-07-09)
A tree icon paints at ~16 px, but the CDNs serve 500 px masters — ESPN's largest crest is 227 KB,
and a composite (§13.4b) embeds TWO of them as base64, inflating ~1.35×. Measured: a full live
tree cached **12 MB**, and the worst pair reached **495 KB** against the 512 KiB cap, so a
slightly larger crest would have silently degraded that row to one logo. The fix is not a bigger
cap; it is to **ask for a smaller image**. Probed 2026-07-09:

| host | resize | 227 KB master becomes |
|---|---|---|
| `a.espncdn.com` | `https://a.espncdn.com/combiner/i?img={path}&w=64&h=64&transparent=true` | **2.2 KB** |
| `sports-phinf.pstatic.net` | append `?type=f64_64` | 20.9 KB → **5.7 KB** |
| `assets.nhle.com`, `www.mlbstatic.com` | (SVG — already 1.5–9 KB, resolution-independent) | unchanged |
| `static.lolesports.com` | no resize parameter exists | unchanged (up to 377 KB) |

Providers MUST emit the resized URL where the host supports it (§13.3). `LOGO_PX = 64` is the
pinned target. The allowlist is unchanged — `a.espncdn.com` already covers the combiner path.
Because the URL is the cache key, changing it re-downloads once and never again.

### 13.3 Provider sources (all probed 2026-07-09)
- **ESPN**: team `competitors[].team.logo`; league `leagues[0].logos[].href` (the entry whose
  `rel` contains 'dark' is the dark variant when present; `logos[]` may be EMPTY on scoreboards —
  evidence — so treat a missing array as "no logo", never an error).
  **RESIZE (§13.2b):** rewrite an `https://a.espncdn.com/i/{path}` URL to
  `https://a.espncdn.com/combiner/i?img=/{path}&w=64&h=64&transparent=true`. A URL already
  containing `/combiner/i` is rewritten by replacing/appending `w` and `h` query params. A URL on
  a.espncdn.com in any other shape is passed through unresized (never dropped).
- **NHL**: `{home,away}Team.logo` (SVG, `_light`) and `.darkLogo` when present (may be null).
- **MLB**: statsapi carries no logo. DERIVE `https://www.mlbstatic.com/team-logos/{teamId}.svg`
  from `teams.{home,away}.team.id` (schedule) / `gameData.teams.{home,away}.id` (feed). No dark
  variant. A derived URL is a guess — a 404 must degrade silently (§13.5).
- **Naver**: `homeTeamEmblemUrl` / `awayTeamEmblemUrl` (already https PNG on
  `sports-phinf.pstatic.net`). KBO and K리그 both.
  **RESIZE (§13.2b):** append `?type=f64_64` when the URL has no query string; if it already has
  one, leave it alone (never clobber an existing param).
- **LoL Esports** (no resize parameter exists — its crests stay full size, up to 377 KB):
  league `image` and team `match.teams[].image` — the API returns `http://`;
  UPGRADE to `https://` (probed: https serves the same asset, HTTP 200 image/png). A team with
  no opponent yet has the literal `team-tbd.png` placeholder — accept it, it is a real image.
- **PandaScore**: `opponents[].opponent.image_url` when present; `videogame`/league image if the
  payload carries one. Optional — omit when absent.

### 13.4 The cache (`src/ui/logoCache.ts`) — the only place that fetches images
- `resolve(ref: LogoRef): { light: Uri; dark: Uri } | undefined` — SYNCHRONOUS. Returns a cached
  file Uri pair, or `undefined` on a miss, and kicks off a background download for the miss.
- `onDidChange: Event<void>` — fires when a download lands, so the tree can re-render that row.
- Download rules (ALL mandatory; a violation ⇒ discard, log, negative-cache):
  1. Scheme must be `https:`. `http:` URLs are upgraded before they reach here (§13.3); a
     surviving `http:` is rejected.
  2. Host must be in a static allowlist: `a.espncdn.com`, `assets.nhle.com`, `www.mlbstatic.com`,
     `static.lolesports.com`, `sports-phinf.pstatic.net`, `cdn.pandascore.co`. No wildcards, no
     redirects to a non-allowlisted host (`redirect: 'error'`).
  3. **Format is decided by MAGIC BYTES, not by `content-type`** (amended 2026-07-09 after probe
     P17: `static.lolesports.com` serves genuine PNGs as `binary/octet-stream`, so an exact
     content-type gate silently dropped every LoL team logo — while a hostile host could just as
     easily *claim* `image/png` for an HTML body. The header is a hint; the bytes are the truth.)
     - EARLY REJECT, before reading the body: if `content-type` is present and its type/subtype is
       a known-wrong family — `text/*`, `application/json`, `application/xhtml+xml` — abort without
       buffering. This is what keeps P16 (a 10 MB `text/html` body) cheap.
     - Then read the body under the size cap and SNIFF:
       - PNG iff the first 8 bytes are `89 50 4E 47 0D 0A 1A 0A`.
       - SVG iff the body, decoded as UTF-8 and left-trimmed of BOM/whitespace, starts with
         `<?xml` or `<svg`.
       - Anything else ⇒ reject.
     - The file extension comes from the SNIFFED format, never from `content-type` or the URL.
  4. Body ≤ 512 KiB (observed range 1.5 KB–377 KB; the LoL LYON crest is 377 KB). 10 s timeout,
     same AbortController shape as §1. A `content-length` exceeding the cap ⇒ reject before reading.
  5. SVG guard: reject a body matching `/<script|<foreignObject|on\w+\s*=/i`. VS Code renders
     tree icons as images so scripts do not execute, but a remote SVG has no business carrying
     them; a hit means the asset is not what we think it is.
- Filename: `${fnv1a32(url)}.${ext}` where ext is `png` | `svg` from the SNIFFED format. NEVER
  from the URL path (path traversal). Write atomically (temp + rename).
- In-memory: `Map<url, Uri>` for hits and a `Set<url>` for permanent failures (no retry storms).
  On startup, an existing cache file is adopted without re-downloading (stat only).
- `dark` absent ⇒ both `light` and `dark` resolve to the same Uri.
- Everything here is best-effort: ANY failure ⇒ `undefined` ⇒ the tree keeps today's icon. A
  logo must never break, block, or error the tree.

### 13.4b Why a game row shows ONE crest (decided 2026-07-09)
A game has two teams, so the first build composed both crests into one icon. It shipped
unreadable, and the reason is a hard constraint worth recording so nobody retries it:

- `TreeItem` exposes exactly one image slot (`iconPath`). `label` and `description` are plain
  strings — `MarkdownString` carries `supportThemeIcons`, `TreeItem.label` does not — so `$(id)`
  in a label renders literally and an "emoji-style" inline crest is impossible. There is no second
  slot to put the away team in.
- VS Code styles that slot with `background-size: 16px` in a `16×22` box (workbench rule
  `.custom-view-tree-node-item-icon`). That pins the WIDTH to 16 px and lets the height follow the
  aspect ratio, so any canvas wider than it is tall shrinks. A `48×24` side-by-side composite paints
  as `16×8` and each crest lands at **7.3 px**.
- Rasterizing the alternatives inside a true `16×22` slot: side-by-side 7.3 px (unreadable);
  a `16×22` vertical stack 11 px but clipped; a `24×24` diagonal overlap ~10 px, legible but
  cluttered; a single crest **16 px**, sharp.

**Decision: a game row shows the HOME team's crest at full slot size.** The away team is already in
the row's own label (`AWY 0:0 HOM`) and in the tooltip. Sharpness beats cramming two logos into a
16 px square. `resolvePair` and the SVG composition it required are removed — no pair cache keys,
no `index.json` pair entries, no base64 embedding.

### 13.5 Tree rendering (`gamesTree.ts`)
- **`getTreeItem` MUST NOT await the network.** It calls the synchronous `resolve()`; on a miss it
  returns today's icon and the background fetch fires `onDidChange`, which triggers a re-render.
  This mirrors the §6 rule that activation never awaits network.
- League node: `iconPath` = the league logo when resolved, else today's icon.
- Game node (followed or not): `iconPath` = `resolve(game.home.logo)` — the HOME team's crest,
  filling the slot (§13.4b). The star that previously marked a followed game is redundant — the
  pinned "Following" section, the `followedGame` contextValue and the inline unfollow action
  already say it — so the logo takes the icon slot. The "Following" section header keeps
  `star-full`.
- `logos.enabled === false` ⇒ `resolve()` is never called, nothing is downloaded, and every node
  keeps the v0.3 icon. Toggling it re-renders.
- Provider nodes and state rows keep their current icons (no logo).

### 13.6 Tests
- Pure-unit over the cache's URL validation: http rejected; non-allowlisted host rejected;
  wrong content-type rejected; oversize rejected; SVG with `<script` rejected; a good PNG accepted
  and filename = `fnv1a32(url).png`. Inject the fetch and the filesystem — no real network, no
  real disk in tests.
- Provider tests: each provider populates `logo` from its fixture (ESPN empty `logos[]` ⇒ league
  logo undefined; NHL `darkLogo: null` ⇒ dark omitted; LoL `http://` ⇒ upgraded to `https://`;
  MLB derives from teamId).
- P16 (hostile): a logo host that returns 200 with `content-type: text/html` and a 10 MB body ⇒
  nothing written to disk, no throw, tree unaffected.
