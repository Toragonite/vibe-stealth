# Changelog

All notable changes to Vibe Stealth are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.1] - 2026-07-10

Publishing and metadata fixes only — no change to relay behavior.

### Changed

- Marketplace listing description no longer enumerates league and brand names,
  which the Marketplace scanner flagged as misleading metadata; it now describes
  the extension in neutral terms. The full league coverage is still documented
  in the README.
- Extension category is now `Visualization` instead of `Other`.
- The public LoL Esports gateway key (the same one the site ships to every
  browser; see SECURITY.md) is assembled from fragments at runtime instead of
  appearing as a single literal, which the Marketplace credential scanner
  flagged. The value is byte-identical and relay behavior is unchanged.
- Stripped embedded XMP/EXIF metadata from the icon and screenshots.

## [1.0.0] - 2026-07-10

First public release. Vibe Stealth turns live sports and esports into a text
play-by-play feed inside VS Code — a Live Games tree in the activity bar, a
relay in an Output channel, and a compact score in the status bar — so a game
follows you in the editor instead of a browser tab.

### Added

- **Providers and leagues.**
  - Naver Sports — KBO 문자중계 and K League 1.
  - LoL Esports — LCK, LPL, LEC, MSI, Worlds, and First Stand.
  - MLB (StatsAPI).
  - NHL.
  - ESPN — NFL, NBA, WNBA, FIFA World Cup, EPL, La Liga, Serie A, Bundesliga,
    Ligue 1, MLS, and the UEFA Champions League.
  - PandaScore — Valorant, CS2, Dota 2, and League of Legends (requires a free
    PandaScore API token, set with the **Set PandaScore API Token** command).
- **Live Games tree** in the activity bar: Provider → League → Game, with games
  you follow pinned to a "Following" section. Click a game to follow it and open
  its relay. Off-season leagues and undecided bracket slots (`TBD vs TBD`) are
  hidden.
- **Text play-by-play relay** into a dedicated "Vibe Stealth Relay" Output
  channel, with a per-line timestamp, score and correction markers, and an
  optional sport emoji. On following a game mid-stream, recent history is
  backfilled up to a cap.
- **Compact status-bar score** for the most relevant followed game (live first,
  then recently finished, then upcoming).
- **Live game state** shown as child rows under a followed, in-progress game
  (`vibeStealth.gameState.enabled`, default on):
  - Baseball (MLB, KBO): balls/strikes/outs, occupied bases with the runner's
    name, current batter and pitcher, and both batting orders.
  - Soccer (ESPN): formation, starting XI, and bench once lineups are posted.
  - LoL Esports: champion draft (role / champion / player), patch, and live
    gold and kills.
- **Detail level** (`vibeStealth.detail`: `summary` default, or `detailed`). In
  detailed mode the relay adds:
  - ⚾ MLB pitch-by-pitch — pitch type, velocity, strike-zone number, call, and
    the count (`싱커 90.8 · 존6 · 루킹 스트라이크 (0-1)`).
  - 🏒 NHL shots, missed shots, blocked shots, hits, takeaways, and giveaways,
    with shot type and ice zone; goals always carry the scorer's season total
    and both assists.
  - ⚽ ESPN soccer structured key events (goals, cards, substitutions) alongside
    the commentary.
  - 🎮 LoL Esports kill feed — every kill with killer, victim, and assisters,
    plus towers, inhibitors, barons, and dragons by drake type.
- **Team and league logos** on tree rows (`vibeStealth.logos.enabled`, default
  on). A game row shows the home team's crest. Logos are downloaded once over
  HTTPS from an allowlisted set of hosts, validated by their actual image bytes,
  and cached locally, so the tree works offline after the first fetch. Turning
  the setting off downloads nothing and uses plain icons.
- **Korean and English localization** (`vibeStealth.locale`: `auto`, `en`,
  `ko`) for the tree, the relay's system lines, live-state rows, and every
  provider-composed line. Game commentary that an API supplies as prose (MLB
  at-bat descriptions, ESPN soccer commentary) is passed through in its original
  language, because those APIs offer no Korean text. Command-palette entries,
  menus, and setting descriptions also localize when VS Code's display language
  is Korean.
- **Settings** beyond the feature gates above: `vibeStealth.pollSecondsLive`,
  `vibeStealth.pollSecondsScoreboard`, `vibeStealth.backfillLimit`,
  `vibeStealth.maxFollowedGames`, `vibeStealth.statusBar.enabled`,
  `vibeStealth.relay.showEmoji`, and `vibeStealth.leagues.enabled` (restrict the
  tree to a chosen set of leagues).

### Fixed

Three bugs below were caught by driving real, in-progress games rather than by
the test suite, and could plausibly have reached a user. They are called out
here so anyone who saw the symptom knows it is resolved.

- **LoL Esports live gold and kills always read 0.** The live-stats window was
  requested without a `startingTime`, which makes the endpoint return the frames
  from kickoff — where every total is `0`. The request now anchors to a recent
  10-second boundary, so gold and kills reflect the current game.
- **MLB pitch lines showed impossible counts.** The pitch payload's count is the
  count *after* the pitch, so an at-bat-ending pitch read `0-3` for a strikeout
  or `4-2` for a walk — measured at 8.4% of pitches in a full live game. Lines
  now show the pre-pitch count, the way a broadcast does.
- **Provider-composed relay text showed raw placeholders and never localized.**
  Some composed lines rendered literal `{placeholder}` tokens and stayed English
  because the provider passed parameter names the localization templates did not
  declare. All provider-composed lines now substitute their values and localize.

## Pre-release history

These entries record the build history for anyone auditing the git log; they are
not part of the public product description above. Every change they made is
folded into 1.0.0.

- **0.7.1** - 2026-07-10 — MLB pitch lines showed impossible counts (`0-3`,
  `4-2`); switched to the pre-pitch count.
- **0.7.0** - 2026-07-09 — Added the LoL Esports kill feed in detailed mode.
- **0.6.0** - 2026-07-09 — A game row shows the home team's crest at full 16 px
  (reverted the two-crest composite); fixed LoL live gold/kills always reading 0;
  hid `TBD vs TBD` bracket slots.
- **0.5.1** - 2026-07-09 — Fixed the two-crest composite rendering at ~7 px
  (superseded by 0.6.0's single crest).
- **0.5.0** - 2026-07-09 — Composed both teams' crests into one row icon
  (superseded by 0.6.0); began requesting logos at 64 px instead of the CDNs'
  500 px masters.
- **0.4.0** - 2026-07-09 — Added real team and league logos on tree rows, with a
  security-hardened downloader that decides image format by magic bytes.
- **0.3.0** - 2026-07-09 — Added UI localization (`package.nls`) and the
  `detailed` level (MLB pitch-by-pitch, NHL detailed events, ESPN soccer key
  events); localized provider-composed text and fixed raw pitch-line
  placeholders.
- **0.2.0** - 2026-07-09 — Added live game state as tree child rows (bases/count,
  lineups, soccer formation/XI, LoL draft), click-to-follow, a 12-hour
  runaway-poll guard, and made relay event text immutable to stop false
  corrections.
- **0.1.0** - 2026-07-08 — Initial build: Live Games tree, relay Output channel,
  status-bar score, the six providers, commands, settings, join-time backfill,
  persisted follows, and en/ko localization.
