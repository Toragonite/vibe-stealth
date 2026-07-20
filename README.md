# Vibe Stealth — Live Sports & Esports Text Relay

![Vibe Stealth](https://raw.githubusercontent.com/Toragonite/vibe-stealth/master/media/banner.png)

**Follow the game without leaving your editor.** Vibe Stealth turns live sports and esports into a quiet text ticker inside VS Code: no video, no sound, no extra window stealing focus — just short play-by-play lines streaming into an Output Channel, plus a compact score in your status bar. Pick a game from the activity-bar tree, follow it, and keep coding while the relay runs in the background.

Built for people who want to know the score without opening a browser tab, a stream, or a second monitor.

> Not yet published to the Visual Studio Marketplace. You can build a `.vsix` from source with `npm run package` and install it via **Extensions: Install from VSIX…**.

## Features

- **Live Games tree** in the activity bar — browse leagues, see games in progress, follow with one click or from the Command Palette.
- **Text play-by-play relay** — followed games stream formatted lines into a dedicated "Vibe Stealth Relay" Output Channel, timestamped and (optionally) emoji-tagged by sport.
- **Live game state in the tree** — expand a followed live game to see bases/count, lineups, or the champion draft update on every poll, right there in the sidebar (no webview, no popup).
- **Two verbosity levels** — the default `summary` stays quiet (one line per at-bat, only the key events); `detailed` adds pitch-by-pitch baseball, NHL shots/hits, soccer key events, and a League of Legends kill feed.
- **Real team & league logos** — actual crests on tree rows, downloaded once and cached locally, then reused offline (can be turned off).
- **Compact status bar score** — the most relevant followed game (live first, then recently finished, then upcoming) shown as `AWY 3:2 HOM · Q4` with no color or emoji, so it stays out of the way.
- **Korean-first coverage** — real KBO 문자중계 (pitch-by-pitch text relay) and K League 1 event relay, straight from Naver Sports, natively in Korean.
- **Key-free by default** — KBO, K League, LCK/LPL/LEC/MSI/Worlds/First Stand, MLB, NHL, ESPN's soccer/NFL/NBA/WNBA coverage, and the tennis, Formula 1, UFC, cricket and college basketball leagues added in 1.1.0 all work with zero setup.
- **Optional esports score ticker** — add a free PandaScore API token to also track LoL, Valorant, CS2, and Dota 2 match/map scores.
- **Backfill on join** — following a game already in progress shows you the last few plays for context, not the entire history.
- **Workspace-aware persistence** — followed games survive a window reload.

## Supported leagues

| Provider | Leagues | What you get | Access |
|---|---|---|---|
| **Naver Sports** | KBO리그 ⚾, K리그1 ⚽ | Real Korean **문자중계**: KBO is genuine pitch-by-pitch text relay; K League is event-level relay (goals, cards, key moments). Natively Korean. | Key-free, **unofficial** |
| **LoL Esports** | LCK, LPL, LEC, MSI, Worlds, First Stand 🎮 | Series/map score ticker (Game 1, Game 2… with map wins). In `detailed` mode, a live kill feed (see [Detail level](#detail-level)). | Key-free (Riot's public web gateway key), **unofficial** |
| **MLB StatsAPI** | MLB ⚾ | Official at-bat play-by-play and, in `detailed` mode, pitch-by-pitch | Key-free, **official** |
| **NHL** | NHL 🏒 | Official goals, penalties, period boundaries, game end; `detailed` adds shots, hits, takeaways and giveaways | Key-free, **official** |
| **ESPN** | NFL 🏈, NBA 🏀, WNBA 🏀, FIFA World Cup ⚽, Premier League, La Liga, Serie A, Bundesliga, Ligue 1, MLS, UEFA Champions League | Play-by-play / commentary feed, scoring plays highlighted; `detailed` soccer adds structured key events | Key-free, **unofficial** |
| **Tennis** | ATP Tour, WTA Tour 🎾 | Singles and doubles — a pair reads `Hao-Ching Chan / Miyu Kato` and abbreviates to `CH/KA`. The score is **sets won** — a 6-2, 7-5 win reads `2:0` — and the per-set games (`6-2, 7-5`) appear in the status text. The relay is one line per completed set plus a match-final line, composed by the extension. **No point-by-point** — there is no upstream play-by-play for tennis. | Key-free, **unofficial** |
| **Motorsport** | Formula 1 🏎 | One row per **session** of a race weekend — Practice 1, Practice 2, Practice 3, Qualifying, Sprint, the Race — so a practice session is never labelled as the Grand Prix. A session is a field of ~22 drivers, not two sides, so the row shows the contest and the current leader (`Belgian Grand Prix — Practice 1 · P1 VER`) instead of a score. The relay carries session start, session end, and a result line naming the top three. **No position-change stream.** | Key-free, **unofficial** |
| **ESPN** | UFC 🥊 | One row per **fight card**, not per bout — upstream models a fight night as a single event. The row is named after the card's **main event**; the relay covers every bout on the card, one result line each. | Key-free, **unofficial** |
| **ESPN** | Cricket 🏏 | **Score and status only.** The upstream summary endpoint returns data but carries no plays and no commentary, so a followed match refreshes its score and status while its relay stays empty. | Key-free, **unofficial** |
| **ESPN** | College Football 🏈, Men's College Basketball 🏀 | Play-by-play feed, scoring plays highlighted — the same treatment as NFL and NBA. College Football is **not on by default**; see [Turning on College Football](#turning-on-college-football). | Key-free, **unofficial** |
| **PandaScore** | LoL, CS2, Dota 2, Valorant 🎮 | **Score ticker only** (map results) — no per-round or per-kill commentary | Requires a free API token, unofficial |

League ids used in `vibeStealth.leagues.enabled` are `provider:league` — for example `naver:kbo`, `lolesports:lck`, `mlb:mlb`, `nhl:nhl`, `espn:eng.1`, `espn:ufc`, `espn:cricket`, `espn-tennis:atp`, `espn-racing:f1`, `pandascore:lol`.

### Turning on College Football

`espn:college-football` is fully supported but ships **off**. A single Saturday resolves around 99 games, and the tree draws one row per game with no truncation, so leaving it on would bury every other league.

To switch it on, add the league id to `vibeStealth.leagues.enabled` in your settings:

```json
"vibeStealth.leagues.enabled": ["espn:college-football"]
```

That setting is a full allowlist, not an addition: once it is non-empty, only the ids you list appear in the tree. So list the other leagues you want alongside it — for example `["espn:college-football", "mlb:mlb", "naver:kbo"]`.

## Quick start

1. Click the Vibe Stealth icon in the activity bar.
2. Expand a provider and league, and pick a live or upcoming game.
3. Click a game row (or run **Follow Game** from the Command Palette) — the relay opens automatically and lines start streaming in.
4. Click the status bar score any time to jump back to a followed game or unfollow it.
5. Want LoL/Valorant/CS2/Dota 2 score tracking too? Run **Vibe Stealth: Set PandaScore API Token (enables esports)** and paste a free token from your PandaScore account. The PandaScore section of the tree stays hidden until a token is set.

## How the relay looks

<img src="https://raw.githubusercontent.com/Toragonite/vibe-stealth/master/media/screenshots/sidebar.png" alt="Vibe Stealth sidebar tree" width="285" align="right" />

The activity-bar tree lists every league and game; a followed live game (here `LAA 1:5 TEX`, Bottom 6th) expands to show live state and both lineups, with real team crests on each row.

The followed game's play-by-play streams into the Output Channel:

![Vibe Stealth relay output](https://raw.githubusercontent.com/Toragonite/vibe-stealth/master/media/screenshots/output.png)

The same lines in ASCII, for reference:

```
19:32:05 │ · T7 │ ⚾ J. Soto strikes out swinging.
19:33:41 │ ★ T7 │ ⚾ B. Harper homers (12) to left field. NYY 4, PHI 3.
20:14:57 │ ★ B9 │ ⚾ 최정, 우월 2점 홈런! (SSG 5, LG 3)
21:02:10 │ ★ G3 │ 🎮 Game 3 complete
```

`★` marks a scoring play, `·` marks a routine play, `⚠` marks a corrected line. The `[AWY-HOM]` team tag only appears when you're following more than one game at once, so a single followed game stays clean. The sport emoji prefix can be turned off with `vibeStealth.relay.showEmoji`.

## Live game state

Follow a game that's currently in progress and its tree row becomes expandable — under it you'll find live "current state" rows that refresh on every poll, right in the sidebar tree (not a separate panel or webview):

- **⚾ Baseball (MLB, KBO)** — balls-strikes-outs, which runners are on base (by name), the current batter and pitcher, and both teams' full batting orders as a collapsible lineup node.
- **⚽ Soccer (ESPN leagues)** — each team's formation, starting XI, and bench, sourced from ESPN. This appears once lineups are officially posted, which is usually shortly before kickoff — it won't show for a game that hasn't reached that point yet.
- **🎮 League of Legends (LoL Esports)** — the champion draft for both teams (role, champion, player) and the patch version, plus live gold and kill totals once the match data reports them.

Honest limits:

- State only appears for a game you're **following** that is **currently live**. Pre-game and finished games show the normal game row with no state rows.
- **Only baseball, soccer and LoL have state rows.** Tennis, motorsport, UFC, cricket, American football and basketball games do not expand — there is nothing under them. What a tennis or a motorsport row can say, it says on the row itself: the per-set games (`6-2, 7-5`) in a tennis row's status text, and the current leader (`P1 VER`) in a motorsport row's label, both re-rendered on every poll.
- These are plain text rows, not a graphical bases diagram or pitch tracker — Vibe Stealth stays a text relay.
- LoL's draft only shows once that game's picks are locked in; there's nothing to show during champion select itself.
- Controlled by `vibeStealth.gameState.enabled` (default on). Turning it off also stops the one extra network request LoL Esports otherwise makes per poll to fetch draft/gold data. Baseball and soccer state come for free from data already fetched for the relay, so only the on/off switch — not that request saving — affects them.

## Detail level

`vibeStealth.detail` controls how much play-by-play you get. It defaults to `summary`; set it to `detailed` for the full firehose. Detailed produces several times more lines per game, and costs one extra request per poll for a live LoL game (3 instead of 2).

**⚾ MLB** — `summary` emits one line per completed at-bat. `detailed` adds one line per pitch (type, speed, strike-zone number, call, and the count *before* the pitch) ahead of the at-bat result:

```
summary                                              detailed
─────────────────────────────────────────           ───────────────────────────────────
Ernie Clement singles on a line drive to             Sinker 90.8 · zone 6 · Called Strike (0-0)
left fielder Heliot Ramos.                           Sweeper 84.0 · zone 14 · Swinging Strike (0-1)
                                                     … one line per pitch …
                                                     Ernie Clement singles on a line drive to
                                                     left fielder Heliot Ramos.
```

**🏒 NHL** — `summary` is goals, penalties, period boundaries and game end. `detailed` adds shots, hits, takeaways and giveaways (still not faceoffs or stoppages — pure noise):

```
summary                                              detailed adds
─────────────────────────────────────────           ───────────────────────────────────
snap goal — Mavrik Bourque (season goal #20)         hit — offensive zone
(assists: Esa Lindell, Ilya Lyubushkin)              takeaway — offensive zone
                                                     shot on goal — wrist · neutral zone
```

**⚽ Soccer (ESPN)** — `detailed` adds structured key events (goals, cards, substitutions) alongside the prose commentary, so you get both the narrative line and a compact tagged event.

**🎮 League of Legends** — `detailed` turns on a live kill feed: every kill with the killer, victim and assisters, plus towers, inhibitors, barons and dragons by drake type:

```
🎮 JarvanIV(BLG Xun) → Naafiri  [assists: Akali, Shen]
🎮 Ziggs(HLE Gumayusi) → Akali  [assists: Rumble, Naafiri, Yone, Rell]
🎮 BLG took Chemtech Drake
```

Note this is also what makes a live LoL game relay anything play-by-play at all — see [Honest limits](#honest-limits).

**🎾 Tennis, 🏎 motorsport, 🥊 UFC and 🏏 cricket ignore the setting.** None of them has an upstream play-by-play feed to turn up, so `detailed` produces exactly the same lines as `summary`: completed sets and a match result for tennis, session boundaries and a podium for motorsport, one result line per bout for a UFC card, and nothing at all for cricket.

## Logos

With `vibeStealth.logos.enabled` on (the default), tree rows show real team and league crests. Each logo is downloaded once, then cached locally under the extension's global storage and reused offline; toggling the setting off downloads nothing and falls back to plain icons.

The downloader is the only part of the extension that fetches binary content, and it is deliberately strict: https-only, an exact host allowlist, no redirects to other hosts, a 512 KiB size cap, a 10-second timeout, and image-format decided by **magic bytes** rather than the server's `content-type` header (which a server can get wrong in either direction). SVGs are additionally screened for embedded scripts.

**Tennis and motorsport rows carry no image.** Where a team game shows a crest, these rows fall back to a plain icon — singles, doubles and race sessions alike. The upstream does have player headshots and driver portraits, but they are served from hosts that are not on the allowlist above, so the extension does not fetch them.

A game row shows the **home** team's crest. VS Code gives a tree item a single 16 px icon slot, so composing two crests into it rendered each at roughly 7–10 px — unreadable. Sharpness won: the away team is already in the row's label (`AWY 0:0 HOM`) and tooltip.

## Language

Vibe Stealth speaks English and Korean. `vibeStealth.locale` (`auto` \| `en` \| `ko`, default `auto`) sets the relay language; `auto` follows the VS Code display language.

**The relay is bilingual by design, and honestly so.** Some upstream feeds cannot produce Korean prose no matter what — MLB StatsAPI accepts `?language=es` but falls back to English for `ko`, and ESPN accepts `lang=es` but returns an empty `commentary` for `ko`. So Vibe Stealth splits the difference:

- **Text the extension composes from structured fields is localized.** Pitch lines, NHL events, the LoL kill feed, all tree state rows, and every system line render in your chosen language. Tennis, motorsport and UFC fall entirely on this side of the split: those upstreams carry no prose at all, so **every** relay line for them is composed here from the structured score and therefore localized — set lines, match results, session boundaries, podiums and bout results alike.
- **Prose the API supplies is passed through verbatim, never machine-translated.** MLB at-bat descriptions and ESPN soccer commentary stay in English.
- **Naver's KBO / K League relay is natively Korean** to begin with.
- **Names stay as the feed spells them.** A tournament, race or team name from ESPN is not translated, and the session suffix on a motorsport row's name (`— Practice 1`) is pinned to English so the row reads the same in both languages. The relay's own session lines are localized (`연습주행 1 시작`).

In practice a Korean user reading a live MLB game sees Korean pitch lines above an English at-bat result. This is intentional — keeping the API's own rich prose beats a worse machine translation of it.

**Menus and settings are a separate switch.** The command palette entries, context menus, view title and setting descriptions are also localized (`package.nls.ko.json`), but VS Code resolves *those* by the **IDE display language**, not by `vibeStealth.locale`. If you want the menus in Korean, run **Configure Display Language** from the Command Palette and choose Korean.

## Settings

| Setting | Type | Default | Range | Effect |
|---|---|---|---|---|
| `vibeStealth.locale` | string | `"auto"` | `auto` \| `en` \| `ko` | Language for relay system lines and UI labels. `auto` follows the VS Code display language. |
| `vibeStealth.pollSecondsLive` | number | `20` | `10`–`120` | Seconds between play-by-play polls for a followed **live** game. |
| `vibeStealth.pollSecondsScoreboard` | number | `60` | `30`–`600` | Seconds between scoreboard refreshes while the Live Games view is visible. |
| `vibeStealth.backfillLimit` | number | `10` | `0`–`100` | When you follow a game already in progress, at most this many recent plays are backfilled. |
| `vibeStealth.maxFollowedGames` | number | `6` | `1`–`12` | Maximum number of simultaneously followed games. |
| `vibeStealth.statusBar.enabled` | boolean | `true` | — | Show the compact score of the most recently followed game in the status bar. |
| `vibeStealth.relay.showEmoji` | boolean | `true` | — | Prefix relay lines with a sport emoji. |
| `vibeStealth.gameState.enabled` | boolean | `true` | — | Show live game state (bases/count and batting order, soccer formation and starting XI, or LoL draft) as tree rows under a followed live game. Turning it off also stops LoL Esports' extra per-poll request for draft/gold data. |
| `vibeStealth.detail` | string | `"summary"` | `summary` \| `detailed` | How much play-by-play detail to relay. `detailed` adds pitch-by-pitch baseball, NHL shots/hits, soccer key events, and a LoL kill feed — several times more lines, and one extra request per poll for a live LoL game. |
| `vibeStealth.logos.enabled` | boolean | `true` | — | Show real team and league logos on tree rows. Each logo is downloaded once, cached locally, and reused offline. Off ⇒ plain icons, nothing downloaded. |
| `vibeStealth.leagues.enabled` | array of string | `[]` | — | Leagues shown in the tree, as `provider:league` ids (e.g. `espn:eng.1`, `mlb:mlb`, `nhl:nhl`, `espn-tennis:atp`, `espn-racing:f1`, `pandascore:lol`). Empty means the built-in default set; a non-empty list is an allowlist and replaces it. `espn:college-football` is supported but outside the default set — list it here to switch it on. |

## Commands

| Command | Title |
|---|---|
| `vibeStealth.refreshGames` | Refresh Games |
| `vibeStealth.followGame` | Follow Game (start text relay) |
| `vibeStealth.unfollowGame` | Unfollow Game |
| `vibeStealth.openRelay` | Open Relay Output |
| `vibeStealth.clearRelay` | Clear Relay Output |
| `vibeStealth.pickFollowed` | Followed Games… |
| `vibeStealth.setPandascoreToken` | Set PandaScore API Token (enables esports) |

All commands are listed under the **Vibe Stealth** category in the Command Palette.

## Honest limits

- **Unofficial endpoints can break without notice.** ESPN, Naver Sports, and the LoL Esports gateway are undocumented and unofficial — they can change shape, rate-limit, or go away at any time. MLB StatsAPI and the NHL API are official but still unauthenticated public endpoints, offered as-is.
- **The LoL Esports gateway key is Riot's public web key**, taken from the lolesports.com frontend. It is not a secret, but Riot may rotate it at any time, which would break LoL/LCK/LPL/LEC/MSI/Worlds relay until an update ships.
- **Follows are per-workspace.** Two VS Code windows open on the same folder run independent pollers and double the request rate against upstream APIs. Shared follows across windows are a future candidate.
- **PandaScore is a score ticker, not commentary.** Its free/public endpoints don't expose play-by-play, so you'll see map/game results (e.g. "Map 3: T1") rather than kill-by-kill or round-by-round events.
- **Cricket is a score ticker too.** Its upstream summary endpoint answers, but the response carries no plays and no commentary, so a followed cricket match keeps refreshing its score and status in the tree and status bar while its relay stays empty. Nothing is being dropped — there is nothing there to relay.
- **A UFC row is a whole fight card, not one bout.** The upstream models a fight night as a single event, so the row is named after the card's main event while the relay covers every bout on the card, one result line each.
- **Tennis has no point-by-point.** The upstream carries no play-by-play, so the relay is one line per completed set plus the match result — not games, not points. The per-set games live in the row's status text.
- **Motorsport does not report position changes.** You will never see "Hamilton up to P3". Providers here never compare one poll against the previous one, and a single response carries only the current running order, so a change line could not be derived honestly. What you get instead is the leader on the row, refreshed each poll, plus session-start, session-end and a top-three result line in the relay.
- **College Football ships off.** `espn:college-football` is fully supported but not enabled by default — around 99 games resolve on a single Saturday and the tree draws one row per game, which would bury every other league. See [Turning on College Football](#turning-on-college-football).
- **A tennis tournament shows at most 12 matches.** One tournament has returned 124 of them across its draws, so the tree keeps the 12 most relevant per tournament — live first, then recently finished, then upcoming — and logs how many it dropped. The 12 slots are spread round-robin across the tournament's draws, singles first, so a Grand Slam cannot fill them all with doubles.
- **Joining a live game backfills at most `vibeStealth.backfillLimit` plays**, not the full history, so very early events from before you followed won't appear.
- **A live LoL Esports game emits no relay lines until its first map completes** — unless `vibeStealth.detail` is `detailed`, which turns on the per-kill/objective feed. In `summary`, LoL is a one-line-per-completed-map ticker.
- Polling intervals are rate-limited by design (10–120 s live, 30–600 s scoreboard). Please don't route around them — aggressive polling risks getting the underlying endpoints blocked for everyone.

## Disclaimer & license

Vibe Stealth is **not affiliated with, endorsed by, or sponsored by** MLB, the NHL, ESPN, Naver, Riot Games / LoL Esports, PandaScore, the ATP, the WTA, Formula 1, the UFC, the NCAA, or any league or team. All team and league names and logos belong to their respective owners.

MIT — see [LICENSE](./LICENSE).
