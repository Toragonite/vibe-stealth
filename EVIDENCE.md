# Vibe Stealth — Measured Behavior of Its Dependencies

Vibe Stealth sits on top of six sports APIs — Naver Sports, LoL Esports, MLB StatsAPI, NHL,
ESPN, PandaScore — and on a handful of VS Code tree-view surfaces. Several of those APIs are
unofficial and none of them are documented for this use. Everything in this file was measured
against the real endpoints and the real editor, not read from a specification, and each
measurement is followed by the piece of code it explains.

This document exists because the code contains decisions that look arbitrary or even wrong until
you know what was measured. Requesting a logo through a resize parameter, deciding an image's
format from its first eight bytes, showing one team crest on a row that describes two teams,
sending a `startingTime` on every live-stats request, printing the count from the *previous*
pitch — each of these is a workaround for observed behavior, and a future change that looks
harmless can silently break a provider. The relay does not throw when a provider degrades; it
just goes quiet. Regressions here are invisible, so they are written down.

Section references such as §12.3 point into [docs/CONTRACT.md](docs/CONTRACT.md), the behavioral
contract these findings amended.

---

## 1. The APIs, as measured

### 1.1 LoL Esports live stats — `feed.lolesports.com/livestats/v1/window/{gameId}`

Public, no API key. Everything below was probed against a live MSI game.

**`startingTime` is required, not optional.** Without the parameter the endpoint answers with the
frames from *kickoff*, where every cumulative total is `0`. A live game therefore reported no gold
and no kills, forever, with a perfectly successful HTTP 200. Measured on the same in-progress
BLG-vs-HLE game, seconds apart:

| request | `blueGold` | `blueKills` | `redGold` | `redKills` |
|---|---|---|---|---|
| no `startingTime` | `0` | `0` | `0` | `0` |
| `startingTime` = now − 60 s | `32516` | `15` | `27082` | `2` |

The provider now anchors to `now − 60 s`, floored to a 10-second boundary (§11.5).

**Boundary behavior, every case probed:**

| request | response |
|---|---|
| `startingTime` off a 10 s boundary | **HTTP 400** |
| `startingTime` in the future | **HTTP 400** |
| before a game's first frame, or past a finished game's last frame | **HTTP 204** (empty body) |
| valid | 200, ~57 frames over ~10 s (~6 Hz) |

Through `createFetchJson` a 204 arrives as `ProviderError('parse')` (empty body) and a 400 as
`ProviderError('unavailable')`. Both are swallowed by the kill-feed path: no kill events that
poll, cursor unchanged, map-result events and draft state unaffected (§12.6). A kill-feed failure
must never fail `fetchPlays`.

**The feed does carry the killer**, though no field is named that. Every frame carries, per
participant, cumulative `kills` / `deaths` / `assists`, and per team `towers`, `inhibitors`,
`barons` and a `dragons[]` array of drake types. Diffing consecutive frames names everyone
involved. Extracted from a real teamfight:

```
08:27:37  JarvanIV(BLG Xun) → Naafiri   [assists: Akali, Shen]
08:27:38  Ziggs(HLE Gumayusi) → Akali   [assists: Rumble, Naafiri, Yone, Rell]
08:29:41  BLUE dragon — chemtech
```

A death with no participant's `kills` incrementing is an execution, a tower kill or a minion kill;
the line names the victim and never invents a killer.

**Gapless coverage is possible**, which is what makes a kill feed viable from a provider that polls
every 20 seconds and can only ever see a 10-second window. `startingTime` addresses *any* past
instant, and consecutive 10 s windows tile with a **+0.1–0.3 s seam**. Measured across window
boundaries, each window diffed independently: **zero kills lost, zero duplicated.** The provider
never needs to observe an instant live — it re-reads the interval it has not yet covered.

The cursor this requires (the `rfc460Timestamp` of the last frame consumed, per game id) is not a
diff and not a dedupe, so §2's stateless pin is intact; the engine still dedupes by id.

**Replayed end-to-end against the live API**, driving the compiled provider and the real
`RelayEngine` at 20 s per poll:

```
폴링 1 (08:27:40): 0줄          ← first poll reads one window at now-60s, no kills in it
폴링 2 (08:28:00): 4줄
   🎮 Akali(BLG Knight) → Rumble 처치  [어시: Shen]
   🎮 JarvanIV(BLG Xun) → Naafiri 처치  [어시: Akali, Shen]
   🎮 Akali(BLG Knight) → Rell 처치  [어시: JarvanIV, Shen]
   🎮 Ziggs(HLE Gumayusi) → Akali 처치  [어시: Rumble, Naafiri, Yone, Rell]
폴링 3 (08:28:20): 2줄
   🎮 Gnar(BLG Bin) → Ziggs 처치  [어시: JarvanIV]
   🎮 JarvanIV(BLG Xun) → Yone 처치  [어시: Cassiopeia, Shen]
```

Over 4 min 40 s of replay: **9 kills, 1 tower, 1 chemtech dragon, 0 duplicate ids, 0 corrections.**
This matches what a hand-written probe extracted from the raw frames, kill for kill, in order.
With `detail: 'summary'` the same run emits 0 kills and fetches one window (for the draft); with
`gameState.enabled: false` it contacts the live-stats host **0 times**.

**The series score is not in the feed.** `games[].teams[]` carries only `{id, side}` — LoL Esports
does not expose a per-map winner. PandaScore, by contrast, carries an immutable
`games[].winner.id`. This asymmetry is why the two providers' map-result lines differ (§1.6, and
the immutable-text invariant in §3.1 below).

A drake type Riot adds later renders its raw English name, by design (§12.1).

### 1.2 MLB StatsAPI — `playEvents[].count` is the count *after* the pitch

The `count` on a pitch event is the state of the at-bat once that pitch has been thrown. On the
pitch that ends an at-bat it therefore overflows into a count baseball does not have: a swinging
strikeout reads `(0-3)`, a walk reads `(4-2)`. Measured across one full live game (gamePk 824251):
**13 of 155 pitches — 8.4% — displayed an impossible count.**

Broadcast convention is the *pre*-pitch count ("swinging strikeout on 1-2"), and it reconstructs
exactly: the pre-pitch count of pitch *n* is the `count` of pitch *n−1* within the same at-bat, and
`0-0` for the first pitch. Non-pitch `playEvents` (pickoffs, timeouts) do not advance it.

Clamping the post-pitch value into a legal range is **wrong**, and wrong in a way that hides:
clamping coincides with the truth on a strikeout swing (`0-3` clamps to `0-2`, which happens to be
the pre-pitch count only when the batter had two strikes) and diverges on a walk (`4-2` clamps to
`3-2`, silently misreporting the pitch). The provider carries the previous pitch's count forward
instead (§12.3).

### 1.3 Language support — no API on the list can produce Korean prose

Probed 2026-07-09:

| API | `es` | `ko` |
|---|---|---|
| MLB StatsAPI (`?language=`) | honored | silently falls back to English |
| ESPN (`lang=`) | honored | returns a broken payload: `commentary: null` |

Neither can produce Korean prose. The relay therefore splits its text by origin (§12.1):

- Text the **provider composes** from structured fields is localized through `t(locale, key, params)`.
  Pitch data carries no prose at all, so those lines are ours by necessity, and Korean-capable.
- Text the **API supplies as prose** is passed through verbatim — MLB at-bat `result.description`,
  ESPN soccer `commentary[].text`, Naver's already-Korean relay. Never machine-translated.

A Korean user consequently reads Korean pitch lines above an English at-bat result. That asymmetry
is a deliberate choice to keep the API's richer text ("grounds out softly, catcher Haase to first
baseman Devers"), not an oversight.

### 1.4 Naver Sports — the relay window carries no game status

`textRelays[].statusCode` is always `0` in the relay window, and K League's top-level code is the
**numeric** `4`, not the string `'RESULT'` that the schedule endpoint returns. Reading status from
the relay is not merely unreliable, it is a type mismatch that reads as "not finished" forever.

`GET /schedule/games/{gameId}` → `result.game` returns the schedule shape, with the string
`statusCode`. Verified for both KBO and K리그. That endpoint is the authoritative phase source, and
the Naver provider makes that second request precisely because its play endpoint carries no status
(§2.5). Naver is also the one provider whose `PlaySnapshot.events` is the current *window* rather
than the full list; engine semantics are unaffected, since it dedupes by id and ignores vanished
events.

### 1.5 Where each provider's phase actually lives

Probed 2026-07-08, after a class of bugs (§3.2) that came from guessing:

| Provider | Authoritative status source |
|---|---|
| ESPN | `header.competitions[0].status.type.state` → `post` |
| NHL | top-level `gameState: 'OFF'`, plus team scores |
| MLB | `feed/live` status (the control case: it was always correct) |
| LoL | `event.state` is **null even for a completed match**, as is `teams[].result.outcome` ⇒ unusable. Derive instead: `max(gameWins) ≥ ceil(strategy.count / 2)`. A swept series leaves its unplayed maps as `state: 'unneeded'` — terminal, not pending |
| Naver | the relay window carries no status (§1.4); the game-detail endpoint does |

The LoL row is worth dwelling on: the obvious field exists, is populated on the object you would
expect, and is `null` at exactly the moment you need it.

### 1.6 Logo CDNs

**`content-type` cannot be trusted, in either direction.** `static.lolesports.com` serves genuine
PNG team logos labelled `binary/octet-stream`. (Its *league* images come as `image/png`, which is
why only the team logos broke.) Downloading one and reading its first eight bytes gives
`89504e470d0a1a0a` — the PNG signature. A content-type gate rejected every LoL team logo:

```
FAIL lolesports:msi home T1
     https://static.lolesports.com/teams/1726801573959_539px-T1_2019_full_allmode.png
     content-type binary/octet-stream
FAIL lolesports:msi away LYON
     content-type binary/octet-stream; 376725B > 256KiB
FAIL — 3/47 rejected
```

The lesson is not "trust `binary/octet-stream`". The header is a hint the server can get wrong in
either direction: it can mislabel a real PNG, and a hostile host can just as easily *claim*
`image/png` for an HTML body. The cache therefore decides format by **magic bytes** (§13.4) — PNG
iff the first eight bytes are `89 50 4E 47 0D 0A 1A 0A`, SVG iff the body left-trimmed of BOM and
whitespace starts with `<?xml` or `<svg`, anything else rejected — with a cheap early reject on
known-wrong families (`text/*`, `application/json`, `application/xhtml+xml`) *before* the body is
read, so a 10 MB HTML body is never buffered. The file extension comes from the sniffed format,
never from `content-type` or the URL path. That rule is strictly stricter than a content-type gate
and it unbreaks the real assets:

```
PASS — all 47 logos pass the cache's rules
```

**The CDNs resize on request, and it matters by three orders of magnitude.** A tree icon paints at
about 16 px, but the CDNs serve 500 px masters — ESPN's largest crest is 227 KB. This was measured
when a row icon still embedded *two* crests as base64 data URIs (an inflation of about 1.35× on top
of the raw bytes; the single-crest row of §2 came later). A full live tree cached **12 MB**, the
largest icon built reached **455 KB** against the 512 KiB cap, and the theoretical worst pair —
227 KB + 148 KB — came to **495 KB**, leaving 17 KB of headroom before a row would have silently
degraded to a lone crest. The fix is not a bigger cap; it is to ask for a smaller image. Probed
2026-07-09:

| host | resize | a 227 KB master becomes |
|---|---|---|
| `a.espncdn.com` | `combiner/i?img={path}&w=64&h=64&transparent=true` | **2.2 KB** |
| `sports-phinf.pstatic.net` | append `?type=f64_64` | 20.9 KB → **5.7 KB** |
| `assets.nhle.com`, `www.mlbstatic.com` | SVG — resolution-independent | unchanged (1.5–9 KB) |
| `static.lolesports.com` | no resize parameter exists | unchanged (up to 377 KB) |

`LOGO_PX = 64` is the pinned target. Providers emit the resized URL (§13.2b, §13.3), and do so
conservatively: a URL that does not match the expected shape passes through unresized rather than
being dropped or mangled — a big logo beats a broken one. Because the URL is the cache key,
changing it re-downloads once and never again. Measured on the live tree afterwards:

```
캐시 총량:   12 MB  →  2.2 MB
최대 아이콘: 455 KB →  120 KB
HT vs LT:    57 KB →   12 KB
상한 초과로 실패한 아이콘: 0
66/66 game rows carry a logo
```

Those rewritten URLs were then re-checked against the real CDNs: all of them still return
`200 image/png`.

Two smaller shape facts, both probed: LoL Esports returns its image URLs as `http://` and the same
asset is served over `https://` (HTTP 200, `image/png`), so the provider upgrades the scheme; and a
LoL team with no opponent yet carries the literal `team-tbd.png` placeholder, which is a real image
and is accepted as one.

---

## 2. The VS Code surfaces, as measured

**A tree row has exactly one image slot.** `TreeItem` exposes `label` (plain string), `description`
(plain string), `iconPath` (**one** image) and `tooltip` — verified against `@types/vscode`.
`MarkdownString` carries `supportThemeIcons`; `TreeItem.label` does not, so a `$(id)` codicon
reference in a label renders as the literal text `$(id)`. There is no second slot and no
"emoji-style" inline crest.

**That slot's geometry pins the width, not the height.** VS Code's workbench CSS, read out of the
installed app bundle:

```css
.custom-view-tree-node-item-icon { background-size: 16px; width: 16px; height: 22px; }
```

`background-size: 16px` pins the **width** to 16 px and lets the height follow the source's aspect
ratio. Any canvas wider than it is tall therefore shrinks. Rasterizing the candidates inside a true
`16×22` slot:

| layout | resulting crest size | verdict |
|---|---|---|
| `48×24` two crests side by side | **7.3 px** | unreadable |
| `16×22` vertical stack | 11 px | fills the slot but clips both crests |
| `24×24` diagonal overlap | ~10 px | legible but cluttered |
| `24×24` single crest | **16 px** | sharp |

This is why **a game row shows one crest — the home team's — at full slot size** (§13.4b), even
though a game has two teams. The away team is already in the row's own label (`AWY 0:0 HOM`) and in
the tooltip. Sharpness beats cramming two logos into a 16 px square. It is a hard constraint of the
slot, not a rendering bug to be worked around, and it is recorded here so nobody retries the
composite.

**VS Code does not fetch remote `https:` icons for tree items** — only local files render. That is
the entire reason `logoCache` exists: a logo is downloaded once, written under
`context.globalStorageUri/logos/`, and referenced as a `file:` Uri (§13.1). The side benefits are
real (offline after the first fetch, one request per distinct URL for the life of the install,
light/dark variants free via `iconPath: {light, dark}`) but they are not the reason.

**`package.nls` resolves by IDE display language, not by our setting.** `package.nls.ko.json`
localizes the command palette, context menus, the view title and the setting descriptions — but VS
Code picks the NLS bundle from the editor's own display language, ignoring `vibeStealth.locale`
entirely. On a machine with no Korean language pack (verified: the target Antigravity install has
none) those strings stay English while the tree and the relay are Korean. Setting the display
language to Korean makes both follow. There is no API to override this per-extension.

---

## 3. Invariants the code depends on

Each of these was established by a bug. They are not style preferences; violating one produces a
failure that the test suite, as written, will not catch.

### 3.1 Event text must be a pure function of that event's own immutable facts

Providers are stateless and re-derive the whole event list on every poll, while the engine (§3.4)
detects a correction as "same id, different normalized text". So any value that can change between
polls — a running series score, a current inning, a live clock — must not appear in an event's
text.

The bug that proved it: a LoL map-result line embedded the *running* series score, so its text
re-derived differently every poll.

```
poll1: [ 'score:Game 1 — G2 1:0 T1' ]
poll2: [ 'correction:Game 1 — G2 1:1 T1', 'score:Game 2 — G2 1:1 T1' ]
poll3: [ 'correction:Game 2 — G2 2:1 T1', 'score:Game 3 — G2 2:1 T1' ]
```

The engine emitted a **false correction** claiming game 1 had ended 1:1 — and because only one
correction per id is allowed, game 1's line stayed permanently wrong for the rest of the series.
The contract, not the code, was at fault: §2.4 and §2.6 had explicitly instructed the behavior.

Mutable state belongs in `PlaySnapshot.game` (the status bar, `scoreChanged`, the §3.8 final-score
line). A provider that cannot determine a per-event fact from its payload must omit it rather than
substitute a current-state proxy — which is why the LoL map line names no winner (the API exposes
none, §1.1) while the PandaScore line does (its `games[].winner.id` is immutable). Locked in as
probe P12, and again for detailed lines as P14: the same at-bat polled twice as its count advances
emits exactly one line per pitch and zero corrections.

### 3.2 `PlaySnapshot.game` must be freshly derived, never the input object returned verbatim

`fetchPlays` returned the **input** `game` object verbatim in five of six providers, so a followed
game that finished never reached `phase: 'post'`. The poller's stop condition, the §3.8 final-score
line, and the post + 10 min auto-unfollow are *all* gated on `snapshot.game.phase === 'post'`.
Reproduced before fixing:

```
ESPN           phase=in    score=1-2              FROZEN
NHL            phase=in    score=3-2 (feed=4-2)   FROZEN
LoL            phase=in    score=0-2              FROZEN
NaverKBO       phase=in    score=5-3              FROZEN
NaverKLeague   phase=in    score=1-2              FROZEN
MLB(control)   phase=post  score=2-5              ok
FROZEN (never reach post): 5
```
```
fetch ticks in 2 simulated hours: 361      autoUnfollow fired: 0
```

A finished game would re-poll unofficial endpoints every ~20 s forever (≈36 requests/min at the
12-game cap), never print its final line, never auto-unfollow, and freeze its status-bar score.

Fixing it required knowing where each API actually keeps its status — the table in §1.5 above. The
first proposed LoL fix was wrong (`event.state` is `null` even for a completed match) and only
probing the live API caught that. The contract's §2 fresh-game pin, and §2.1/§2.3/§2.5/§2.6, were
amended together with the K League sentence that *caused* the bug by instructing the provider to
read status from the relay window. After the fix:

```
ESPN           phase=post  score=90-94   events=1
NHL            phase=post  score=3-4     events=1
LoL(sweep)     phase=post  score=0-3     events=3
NaverKBO       phase=post  score=10-2    events=24
NaverKLeague   phase=post  score=1-2     events=8
MLB(control)   phase=post  score=2-5     events=0
FROZEN (never reach post): 0
```
```
fetch ticks in 2 simulated hours: 1        autoUnfollow fired: 1
```

Events are preserved in every case — a status refresh never costs a play line. The rule: for every
field the play response can supply (`phase`, both scores, `statusText`, `statusShort`), parse it
fresh; carry the input game's value through only for fields the response genuinely cannot supply. A
provider whose play endpoint carries no status must make a second request that does. Each
provider's §2.x section pins its authoritative source, and a per-provider regression test asserts
that a terminal payload yields `phase === 'post'`.

### 3.3 The 12-hour runaway guard, because every provider wraps an API that can change shape

A provider-level fix cannot prevent §3.2's class from recurring: all six providers wrap APIs that
can change shape without warning, and the fresh-game pin can silently regress. The poller bounds it
independently (§4): a game polled for more than **12 h** without ever ingesting `post` stops its
loop, emits a `staleGame` system line, and auto-unfollows.

The bound is checked *before* the fetch on every tick, and every armed delay — including a 300 s
backoff or a 24 h `Retry-After` — is clamped to the deadline, so no wedged fetch and no long sleep
can postpone it. 12 h exceeds any real match (the longest MLB extra-innings game is ≈ 7 h; a BO5
esports series ≈ 6 h), so it never fires on a healthy game. Verified by probe P10, and by P6b,
where a 24 h `Retry-After` is clamped to exactly `43200000ms`.

### 3.4 Provider-composed text must be rendered through the production i18n registry, or raw placeholders ship

The detail feature was built across three modules — the i18n vocabulary, the MLB pitch parser, and
the NHL/soccer parsers. The suite went green at 293 tests while raw placeholders shipped to users:

```
MLB pitches: 14 events
   raw placeholders: 22
   en: Sinker {mph} · zone {zone} · Called Strike (0-1)
   ko: Sinker {mph} · 존{zone} · Called Strike (0-1)     ← and no Korean at all
```

Two independent defects. The i18n templates declared `{mph}` / `{zone}`; the provider passed
`speed` / `zoneText`, so neither substituted. And the provider's private enum helper built lookup
keys without normalizing (`pitchType.Sinker`), so every Korean lookup missed. **The unit tests
passed because they registered their own templates** — the exact thing that hid the drift. Any test
that supplies its own i18n vocabulary is blind to this class by construction.

`scripts/probe-i18n-render.mjs` (P15) closes it: it renders every provider-composed line through
the real compiled providers and the **real production i18n registry**, and fails on any surviving
`{placeholder}` or any locale that produces no Korean.

```
MLB pitches:  raw placeholders: 0 | en: Sinker 90.8 · zone 6 · Called Strike (0-1)
                                    ko: 싱커 90.8 · 존6 · 루킹 스트라이크 (0-1)
NHL detailed: raw placeholders: 0 | en: Start of P1   ko: 1피리어드 시작
soccer:       raw placeholders: 0 | commentary prose stays English by design (§12.1)

P15 PASS — no raw placeholders, every provider localizes
```

The same probe exposed that NHL's own composed lines (period, penalty, game-over, the goal
fallback) had never been localized at all, and that the trimmed NHL fixture contained no hits and
no shots — so the whole detailed path and the enriched-goal path were untested. A richer fixture
(`nhl-detailed-plays.json`, with a scorer resolvable through `rosterSpots`) now drives both.

### 3.5 The presence of `isProviderBlocked` is the poller's only "this provider is keyed" discriminator

`followManager` passed `isProviderBlocked` for *every* provider, but the poller uses that option's
**presence** as its sole test for whether a provider takes the keyed auth path. The key-free branch
was therefore dead in production: a transient ESPN/Naver/Riot 403 — an expected event for those
endpoints — took the keyed path, emitting a spurious "set your token" line and idling at a flat
60 s instead of backing off exponentially. The poller's own unit test passed because it exercised
the key-free path by *omitting* the option, which is exactly the wiring `followManager` failed to
reproduce. Fixed in [src/ui/followManager.ts](src/ui/followManager.ts) by passing the callback only
when `provider.requiresSecret` is set, and verified by probe P11.

### 3.6 The UI substitutes i18n params, so the UI must actually pass them

The `authRequired` line rendered raw `{provider}` / `{command}` placeholders. The poller sends the
key with no params by design (§9 assigns substitution to the UI), and the UI forwarded the undefined
params straight into `t()`. The one line whose job is to name the fix command named nothing. Fixed
by substituting `provider.displayName` and the palette title, via a new i18n key
`ui.command.setToken`.

### 3.7 Restored follows age on `followedAt`, not on `startTimeUtc`

The 36 h restore-drop keys on `followedAt` even though §4 originally said `startTimeUtc` — because
`FollowedGameState` never persisted a start time. This was a contract data-model gap rather than a
coding error, so §4 was amended to match the persisted model instead of the code being changed to
chase a field that does not exist. A follow can only be placed from the current scoreboard window,
so `followedAt ≈ startTimeUtc`, and any game that actually finished is already dropped by the
`postObservedAt` rule. `followedAt === 0` means the age is unknown, and the follow is kept.

### 3.8 Smaller invariants, each with its bug

- **A skewed host clock is not the only cause of an empty league.** A diagnostic that blamed the
  host clock for empty LCK/LPL/LEC leagues was a false positive: those leagues were simply
  off-season. It now reports the distance to the nearest match (`nearest 24d away`) and mentions
  the clock only when that distance is absurd (> 48 h skew).
- **Sequence numbers are parsed as sequence numbers.** The KBO separator filter used `asNum`, so a
  stringified `"99"` would leak a separator into the relay as a play line. It now uses `asSeq`.
- **A duplicated `seqno` is logged, not silently swallowed.** Two events sharing a `seqno` collide
  on id and the engine's first-wins dedup drops the second without a trace. It is now logged.
- **The 16 MiB HTTP cap is checked after `res.text()` has buffered the whole body.** This is what
  the contract text pins, so it was recorded as an accepted limitation in §1 with the streaming fix
  deferred, rather than being silently reinterpreted. It remains the honest description of the
  code.

---

## 4. How to verify

Every gate below is a command in `package.json`. Each result quoted anywhere in this document was
produced by executing the command shown against the build in this tree; nothing here is transcribed
from an assertion made in the source.

```
npm run release:check     # compile && vitest run && npm run probe && node scripts/probe.mjs && vsce package
npm run probe             # node scripts/hostile-probes.mjs && probe-i18n-render.mjs && probe-logos.mjs
node scripts/probe.mjs    # the live end-to-end probe, on its own
```

| Gate | Command | What it proves |
|---|---|---|
| Typecheck | `npm run compile` (`tsc -p ./`) | the build is sound |
| Unit tests | `npx vitest run` | parser, engine, poller, formatter and cache behavior over fixtures |
| Hostile probes | `node scripts/hostile-probes.mjs` | the contract survives inputs designed to break it (table below) |
| i18n render (P15) | `node scripts/probe-i18n-render.mjs` | every provider-composed line renders through the **production** registry with no `{placeholder}` and real Korean (§3.4) |
| Logo pipeline (P17) | `node scripts/probe-logos.mjs` | every `LogoRef` the real providers emit passes the cache's own rules against the real CDNs (§1.6) |
| Live end-to-end | `node scripts/probe.mjs` | provider parse → `RelayEngine` → formatter, against production endpoints |
| Live game state | `node scripts/probe-state.mjs` | `PlaySnapshot.state` populated from a real in-progress game (§11) |
| Headless UI smoke | `node scripts/smoke-activate.mjs --follow G2` | `activate()` → tree → follow → relay → `deactivate()`, no crash |
| Package | `npx vsce package` | the `.vsix` contains only what ships (`src/`, `test/`, `docs/`, `scripts/` excluded; 32 files, 87.62 KB when first measured) |

**Which of these touch the live network, and can therefore fail for reasons unrelated to the
code.** `probe.mjs`, `probe-logos.mjs` (P17) and `probe-state.mjs` drive the real compiled providers
against the real APIs and CDNs; a league that is off-season, a game that has not started, an API
that is briefly 503, or a CDN that changes a URL shape will fail them without any code change. Read
their failures before assuming a regression. `hostile-probes.mjs` and `probe-i18n-render.mjs` (P15)
are hermetic: they inject a stub `fetchJson` and load fixtures, so they fail only for code reasons.
`smoke-activate.mjs` stubs the `vscode` module and drives the real `activate()`.

Last full run of the gates: typecheck clean, **397 unit tests**, 14 hostile-probe checks, P15 pass,
P17 47/47, live relay probe 0 failures, `vsce package` clean. (The hostile suite reported 13 checks
when it covered P1–P12 — P6 has two variants — and grew as P13 and P14 were added.)

### The hostile probes — designed to break the contract, not confirm it

`scripts/hostile-probes.mjs` (§8). Observed values are the script's own output.

| # | Probe | Observed |
|---|---|---|
| P1 | Truncated JSON body | `ProviderError(parse)`, `payloadHead="{"events":[{"id""`, no crash |
| P2 | Null text + duplicate ids in one snapshot | null text dropped; `emitted=2`, first-wins (`["first","second"]`) |
| P3 | Scores `N/A -1 3.5 1e9 '' {} NaN Infinity` | all → `undefined`; status bar `AWY –:– HOM · Q4`; no `NaN` anywhere |
| P4 | Correction storm (text flips 3×) | `corrections=1` — the ≤1-per-id pin holds *across* ingests |
| P5 | Dates `2026-07-07T18:15Z`, `TBD`, `''`, `2026-13-45T99:99Z`, naive | seconds-less ISO parses; rest → `undefined`; never `Invalid Date` |
| P6 | HTTP 429 `Retry-After: 120` | armed delay exactly `120000ms` |
| P6b | HTTP 429 `Retry-After: 99999999999` | armed delay `43200000ms` (24 h cap, clamped to the 12 h guard) — **not** Node's 1 ms 32-bit wrap |
| P7 | First ingest of 5 000 events, `backfillLimit: 10` | exactly `11` lines (1 system + last 10), 3 ms |
| P8 | `CF Montréal ⚽ 롯데 자이언츠 9회말 🎉` + 600× CJK | unicode intact, hard-capped at 500 chars, line renders |
| P9 | Terminal payload per provider | `phase='post'`, score refreshed, events preserved (§3.2) |
| P10 | Provider stuck at `phase:'in'` forever | 12 h guard: loop stops, `staleGame` ×1, auto-unfollow ×1, **0 timers armed** |
| P11 | Key-free provider returns 403 | `connectionTrouble` + backoff `[36s, 88s, 173s, 300s, 300s…]`; **no** `authRequired`, no permanent block |
| P12 | BO5 series polled once per finished map | 3 lines, `corrections=0`, texts `["Game 1 complete","Game 2 complete","Game 3 complete"]` |
| P13 | A state build that throws inside `fetchPlays` | events still returned, `state` undefined, no crash |

Two further hostile cases live in the unit suite rather than in that script, because they need an
injected clock or an injected filesystem: **P14** — the same at-bat polled twice as its count
advances emits exactly one line per pitch and `corrections=0` (`test/providers/mlb.test.ts`, the
immutable-text pin of §3.1) — and **P16** — a logo host returning 200 with
`content-type: text/html` and a 10 MB body writes nothing to disk, throws nothing, and leaves the
tree unaffected, rejected before the body is ever buffered (`test/ui/logoCache.test.ts`).

### What the live probes look like when they pass

`node scripts/probe.mjs` — NHL, a finished game (note the final-score line, which only appears
because `phase` reached `post`):

```
[nhl] picked nhl:nhl:2025030416 (post) → 17 events, emitted 7 lines
  17:55:00 │ · │ 🏒 (이전 플레이 12개 생략)
  17:55:00 │ ★ 3피리어드 18:52 │ 🏒 Goal — Nikolaj Ehlers (CAR 3, VGK 0)
  17:55:00 │ · │ 🏒 경기 종료 — CAR 3 : 0 VGK
```

`node scripts/probe-state.mjs` — MLB, against a real in-progress game:

```
=== MLB ===
  CHI 9:7 BAL (In Progr)
  count 1-1 · 0 out
  bases: (empty)
  at bat: Pete Crow-Armstrong   pitcher: Tyler Wells
  home lineup (9): 1 SS Gunnar Henderson | 2 C Adley Rutschman | 3 LF Taylor Ward …
```

`node scripts/smoke-activate.mjs` — stubs the `vscode` module, calls the real `activate()`, walks
the tree through `getChildren` / `getTreeItem`, follows a game, and prints the relay. Run against a
live MSI series, mid-match:

```
→ activate()            commands registered: 7, disposables: 16
→ tree: 67 game nodes   [Naver Sports/KBO리그] HT 0:0 LT  경기전
                        [LoL Esports/MSI] G2 2:1 T1  BO5 · 2:1
→ followGame("G2 2:1 T1")
   18:18:24 │ · │ 🎮 G2 Esports vs T1 팔로우 시작
   18:18:24 │ ★ │ 🎮 Game 1 complete
   18:18:24 │ ★ │ 🎮 Game 2 complete
   18:18:24 │ ★ │ 🎮 Game 3 complete
→ status bar: "G2 2:1 T1 · G4"  visible=true
→ persisted follows: 1
→ deactivate()          ok — no crash
```

That smoke test is what surfaced the false-correction storm of §3.1: its first run printed
`Game 1 — G2 2:1 T1` for every map. No unit test had caught it.

The same headless run also exercises the game-state pipeline end to end — real API → provider
`fetchPlays` populates `PlaySnapshot.state` → `RelayEngine.ingest` passes it through untouched
(zero events emitted for a state-only change) → `FollowManager` stashes it on the entry → the tree
renders localized child rows, with the empty bases row correctly omitted:

```
CHC 9:7 BAL  [followedGame]
   볼카운트  — 0-0 · 아웃 1
   타석  — Alex Bregman
   투수  — Tyler Wells
   라인업 · CHC   → 1 CF Pete Crow-Armstrong · 2 3B Alex Bregman · … (+6)
   라인업 · BAL   → 1 SS Gunnar Henderson · 2 C Adley Rutschman · … (+6)
```

And the logo pipeline, against the real network and disk — a first `resolve()` misses and returns
`undefined` while a background download runs, and a second resolves to the cached `file:` Uri:

```
NHL svg:                1st resolve → undefined (background download)
LoL png (octet-stream): 1st resolve → undefined (background download)
비허용 호스트:            rejected — url is not https, or host is not on the allowlist

[log] cached assets.nhle.com/.../BUF_light.svg → 2ba8dccf.svg (9192 B)
[log] cached assets.nhle.com/.../BUF_dark.svg  → 5bba37c5.svg (9171 B)
[log] cached static.lolesports.com/.../T1.png  → 7c435988.png (16197 B)   ← sniffed, not trusted

NHL svg:                2nd resolve → light=2ba8dccf.svg dark=5bba37c5.svg
LoL png:                2nd resolve → light=7c435988.png dark=7c435988.png
비허용 호스트:            2nd resolve → undefined
```

This also demonstrates the §13.5 contract that `getTreeItem` never awaits the network: the first
render shows rows without logos, and the rows re-render once the downloads land.

```
→ 66 game nodes (first render — logos not downloaded yet)
  [Naver Sports/KBO리그] HT 0:0 LT  icon=(none)

→ same rows after logo downloads landed:
  [Naver Sports/KBO리그] HT 0:0 LT  icon=ce111e37.png
  [LoL Esports/MSI] LYON 3:0 TSW    icon=501e63e5.png
  → 65/66 game rows now carry a logo
```

The one row without a logo is an ESPN fixture whose competitor carries no `team.logo`. It keeps its
default icon, which is exactly the pinned degradation.

---

## 5. What is not verified

Stated plainly, because an untested path that *looks* covered is worse than one known to be
uncovered.

- **KBO and K리그 relays, soccer lineups, NHL, and PandaScore have never been driven against a live
  game.** Soccer lineups and the LoL draft were parser-tested over real trimmed fixtures
  (`espn-summary-rosters.json`, `lolesports-window.json`) and their raw endpoints were probed by
  hand, but no live soccer game with posted lineups existed at build time to drive `fetchPlays` end
  to end. PandaScore is exercised only against synthetic fixtures, because it needs a token: its
  provider is correct by construction and by review, not by live probe.
- **No live-phase fixtures exist for ESPN, NHL or Naver.** Every captured payload is `pre` or
  `post`; live parsing is contract-pinned but evidence-thin. The live probe hit an in-progress MSI
  match successfully, which is the only in-phase evidence in the suite.
- **The LoL 6-window catch-up cap (60 s) is unit-tested only**, never exercised against a real
  ten-minute-stale follow. It exists so that resuming a follow cannot stampede the live-stats host.
- **The VS Code UI layer has no unit tests** — a deliberate choice: its correctness comes from the
  contract, from review, and from the headless smoke test. `src/ui/**` was audited line by line
  against §6 (no modals, disposables, the three-tier status-bar scan, persistence) and exercised
  headlessly, but never inside a real extension host. The smoke test stubs `vscode`, so it proves
  the wiring, not VS Code's own behavior. A manual F5 run should still exercise: follow → reload
  window → restore, and following an *already finished* game (the born-post path).
- **VS Code's actual paint of a `file:` PNG or SVG in a tree row cannot be observed headlessly.**
  The rasterization measurements in §2 use the real slot geometry read from the shipped CSS, and
  the smoke test proves `iconPath` is set to the cached file Uri — but the render itself must be
  confirmed visually.
- **The `feed.lolesports.com` livestats endpoint is undocumented and unversioned.** If Riot changes
  it, the LoL draft and kill feed degrade to "no state" and no events (never an error, §11.2), and
  the relay is unaffected. That degradation is by design, but it is silent — this document is where
  you find out what the endpoint used to do.
