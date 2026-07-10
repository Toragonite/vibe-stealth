# Pull request

## What this changes

<!-- A short description of the change and why. Link any related issue. -->

## Gates

Run these from the repository root and check what passed:

- [ ] `npm run compile` — typecheck is clean (`tsc -p ./` exits 0)
- [ ] `npx vitest run` — unit tests pass (offline, deterministic)
- [ ] `npm run probe` — hostile probes + P15 (offline) pass; P17 (live logos) run

<!-- The offline gates (vitest, hostile-probes.mjs, probe-i18n-render.mjs) are
     deterministic: a failure there is a real regression. See RELEASE.md and
     CONTRIBUTING.md for how to read a live-probe failure. -->

## Live-API impact

- [ ] This change affects a **live-API** path (a provider request/parse, the
      logo downloader, or a live probe — `scripts/probe-logos.mjs` / `scripts/probe.mjs`)
- [ ] If so, I ran the affected live probe and noted the result below (and whether
      an intermittent failure reproduced — a one-off live flake is an upstream
      condition, not necessarily a regression)

<!-- Notes on the live-probe run, if any: -->

## Contract

`docs/CONTRACT.md` is the source of truth for behavior.

- [ ] This change does **not** alter pinned behavior, **or**
- [ ] It does, and I amended `docs/CONTRACT.md` **in this PR** to match

<!-- If you amended the contract, summarize what pin changed and why. -->

## New provider behavior

- [ ] This PR does not add or change provider behavior, **or**
- [ ] It does, and the new behavior is justified by a **probe against the real
      API** (a captured fixture or a `scripts/probe*.mjs` run) rather than an
      assumption — cited here:

<!-- Cite the probe / fixture / evidence that established the new behavior: -->

## Design rules respected

- [ ] Providers stay **stateless** — no diffing or deduping across polls
- [ ] Every event's `text` is a pure function of that event's **immutable** facts
      (no running score, current inning, or live clock in event text)
- [ ] A provider failure **degrades** (wrapped `ProviderError`, skipped entry,
      state undefined) — it never crashes the tree
- [ ] No `vscode` import added under `src/core/**` or `src/providers/**`
- [ ] No new runtime npm dependency (global `fetch` + VS Code API only)
