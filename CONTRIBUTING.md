# Contributing to Vibe Stealth

Thanks for your interest in Vibe Stealth — a VS Code extension that relays live
sports and esports as quiet text inside your editor. This guide covers how to
build and test it, and the design rules a change must respect.

By participating you agree to abide by our [Code of Conduct](./CODE_OF_CONDUCT.md).

> **Not affiliated with any league or provider.** Vibe Stealth is an unofficial
> client of ESPN, MLB StatsAPI, the NHL API, Naver Sports, Riot's LoL Esports
> gateway, and PandaScore. It is not endorsed by or sponsored by any of them or
> by any league or team. Please keep that in mind for any change that touches how
> the extension talks to those services.

## Prerequisites

- **Node.js** and npm (the toolchain targets `@types/node` 22).
- **VS Code** at or above the `engines.vscode` minimum in `package.json`
  (currently `^1.90.0`). A compatible fork (VSCodium, Cursor, Antigravity) works
  too.

## Building

```
npm install
npm run compile
```

- `npm run compile` runs `tsc -p ./` and emits to `out/`. `npm run watch`
  recompiles on change.
- To run the extension, open the repository in VS Code and press **F5**. This
  launches the **Extension Development Host** — a second VS Code window with the
  extension loaded. Click the Vibe Stealth icon in that window's activity bar,
  expand a league, and follow a live game to exercise the relay, tree, status
  bar, and logos.
- To build an installable package, `npm run package` produces
  `vibe-stealth-<version>.vsix`, which you can install with **Extensions:
  Install from VSIX…**.

## Testing

There are two kinds of checks: deterministic offline ones, and probes that hit
live APIs. **Know which is which before you conclude a failure is your fault.**

### Offline, deterministic — a failure here is a real regression

```
npx vitest run
```

The unit tests run against trimmed fixtures under `test/fixtures/` and never
touch the network. They cover the relay engine, the poller (with fake timers),
the formatter and i18n, and every provider parser. If a test here goes red, your
change broke something — fix it before opening a PR.

The `npm run probe` gate runs three scripts in sequence:

```
npm run probe
```

- `scripts/hostile-probes.mjs` — the numbered hostile probes (truncated JSON,
  absurd scores, Unicode, correction storms, and so on), against offline
  fixtures. **Deterministic — a failure is a real regression.**
- `scripts/probe-i18n-render.mjs` (**P15**) — offline i18n/render parity.
  **Deterministic — a failure is a real regression.**
- `scripts/probe-logos.mjs` (**P17**) — the logo downloader against **live**
  CDNs (see below).

### Live — a failure may be the world, not your change

```
npm run probe          # its P17 stage hits live CDNs
node scripts/probe.mjs # live end-to-end against the real APIs
```

`scripts/probe-logos.mjs` (P17) and `scripts/probe.mjs` reach real services:
ESPN, Naver, Riot's public gateway, MLB StatsAPI, the NHL API, and the logo
CDNs. They can fail for reasons that have **nothing to do with your change**:

- an **off-season** league with no live game to drive,
- a **CDN hiccup** or a single logo URL that 404s,
- a transient upstream **5xx or timeout**, or an empty scoreboard.

**How to tell a live flake from a regression:**

1. **Re-run the failing script once or twice.** A real regression fails the
   **same way every time** and usually points at a parse or validation step. A
   live flake is intermittent, **moves between runs**, and names a network
   condition (a 5xx, a timeout, an empty off-season scoreboard, one logo that
   404s).
2. **Confirm the offline gates are green.** `npx vitest run`,
   `scripts/hostile-probes.mjs`, and `scripts/probe-i18n-render.mjs` never touch
   the network. If those pass and only a live probe fails intermittently, treat
   it as an upstream condition, not a blocker for your change.

When in doubt, say so in the PR: note which gate failed, whether it reproduced,
and whether the offline gates were green. See [`RELEASE.md`](./RELEASE.md) for
the full gate list and how a release reads a live-API failure.

## Design rules a change must respect

Behavior is pinned in [`docs/CONTRACT.md`](./docs/CONTRACT.md). **That document
is the source of truth** — when code and prose disagree, the contract wins, and
a behavior change is only valid once the contract is amended to match (see
below). Three rules matter most, because breaking them causes bugs that unit
tests alone don't always catch:

1. **Providers are stateless. They never diff or dedupe across polls.** A
   provider re-derives the whole event list from the API on every poll and
   returns it. Deduplication, correction detection, and backfill are the relay
   engine's job, not the provider's. Don't add per-provider memory of what was
   already emitted.

2. **An event's text must be a pure function of that event's own immutable
   facts.** Because providers are stateless and the engine flags "same id,
   different text" as a *correction*, any value that changes between polls — a
   running series score, the current inning, a live clock — must **not** appear
   in an event's text. Put mutable state in the game snapshot (status bar,
   score-changed, the final line) instead. This exact trap has bitten this
   codebase before (a LoL series score in event text fired false corrections
   that permanently rewrote an earlier line); the contract's P12/P14 probes
   guard it, so honor it up front.

3. **A provider failure must degrade, never crash the tree.** Every field access
   on API JSON is defensive; a shape surprise becomes a wrapped `ProviderError`,
   not a raw throw. One malformed entry in a list is skipped, not fatal to the
   response. Optional extras (live game state) are a bonus that must never be
   load-bearing: if building state fails, return the game and events anyway with
   state undefined.

Also note the layering rule: `src/core/**` and `src/providers/**` must **not**
import `vscode` (they are unit-testable with vitest); only `src/ui/**` and
`src/extension.ts` may. And there are **zero runtime npm dependencies** — the
code uses only global `fetch` and the VS Code API. Don't add a runtime
dependency.

### New provider behavior must be justified by a probe, not an assumption

Every upstream here is either undocumented (ESPN, Naver, Riot's gateway) or
official-but-unversioned (MLB StatsAPI, NHL). **You cannot assume a field's
shape, presence, or meaning — you have to observe it against the real API.** If
your change relies on a field or endpoint behavior, capture a probe (a trimmed
real payload as a fixture, or a `scripts/probe*.mjs` run) that establishes it,
and cite that evidence. The contract is full of "evidence:" and "probed:" notes
for exactly this reason — new behavior should add to that trail, not guess.

## Opening a pull request

- Fill in the [pull request template](./.github/PULL_REQUEST_TEMPLATE.md).
- Run the gates: `npm run compile`, `npx vitest run`, `npm run probe`. Note in
  the PR whether any live-API probe was affected and whether it reproduced.
- If your change alters pinned behavior, **amend `docs/CONTRACT.md` in the same
  PR** and say so — an undocumented behavior change is not mergeable.
- Cite the probe that established any new provider behavior.

## Reporting bugs and requesting features

Use the issue templates: a [bug report](./.github/ISSUE_TEMPLATE/bug_report.yml)
or a [feature request](./.github/ISSUE_TEMPLATE/feature_request.yml). For a bug,
the contents of the **Vibe Stealth Diagnostics** output channel and whether the
game was actually **live** are the two most useful things you can include — many
behaviors (live game state, the LoL kill feed) are live-only by design.

Security issues go through **private reporting** — see
[`SECURITY.md`](./SECURITY.md), not the public issue tracker.
