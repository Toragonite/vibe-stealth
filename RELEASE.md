# Releasing Vibe Stealth

A runbook for publishing Vibe Stealth to the Open VSX registry and the VS Code
Marketplace. Follow it top to bottom. Every command below is taken from
`package.json` (`scripts.*`) or the `@vscode/vsce` / `ovsx` CLIs it depends on.

This is a first publication: the extension has never been on either registry, so
the one-time account setup in **Prerequisites** must be done before the first
release.

---

## 1. Pre-flight checklist

Run all five gates from the repository root. Do not publish unless the code gates
(compile, tests) are green; see the note below on how to read a live-API failure.

| Gate | Command | Green looks like |
|---|---|---|
| Typecheck | `npm run compile` | `tsc -p ./` exits 0, no output |
| Unit tests | `npx vitest run` | **403 passed / 403** |
| Offline + live probes | `npm run probe` | 14/14 hostile probes, **P15 PASS**, **P17 PASS** |
| Live end-to-end | `node scripts/probe.mjs` | **0 failures** |
| Package | `npx vsce package` | builds `vibe-stealth-<version>.vsix`, no error |

Notes:

- `npm run probe` runs three scripts in sequence:
  `node scripts/hostile-probes.mjs` (14 hostile probes, offline fixtures),
  `node scripts/probe-i18n-render.mjs` (P15, offline), and
  `node scripts/probe-logos.mjs` (P17). The first two are deterministic and
  offline — a failure there is a real regression.
- **`scripts/probe-logos.mjs` (P17) and `scripts/probe.mjs` hit live APIs and
  CDNs** (ESPN, Naver, Riot's public gateway, the logo CDNs). They can fail for
  reasons unrelated to the code: an off-season league with no games to drive, a
  CDN hiccup, or a transient upstream outage.
  - **How to tell a live flake from a real bug:** re-run the failing script once
    or twice. A real regression fails the same way every time and usually points
    at a parse or validation step; a live flake is intermittent, moves between
    runs, and names a network condition (a 5xx, a timeout, an empty off-season
    scoreboard, a single logo URL that 404s). If in doubt, confirm the offline
    gates (`hostile-probes.mjs`, `probe-i18n-render.mjs`, `npx vitest run`) are
    green — those never touch the network — and treat an isolated, non-repeating
    live failure as an upstream condition, not a release blocker.
- `npx vsce package` also runs `vscode:prepublish` (`npm run compile`) first, so
  a clean package implies a clean typecheck.

---

## 2. Prerequisites (one-time account setup)

The first publication needs publishing identities on both registries. These do
not exist yet — creating them is part of the first release.

### VS Code Marketplace
- A **publisher** named `toragonite` must exist on the Visual Studio Marketplace
  (this is the `publisher` field in `package.json`; it cannot be changed at
  publish time without editing the manifest). Create it from the Marketplace
  publisher-management page if it does not exist yet.
- A **Personal Access Token** from Azure DevOps, scoped to **Marketplace →
  Manage**, tied to the organization that owns the publisher. `vsce` reads it
  either interactively (`vsce login toragonite`) or from the `VSCE_PAT`
  environment variable.

### Open VSX
- A **namespace** named `toragonite` must exist on Open VSX, created once with
  `npx ovsx create-namespace toragonite`.
- An **Open VSX access token**, created from your Open VSX user settings. `ovsx`
  reads it from `-p <token>` or the `OVSX_PAT` environment variable.

### GitHub
- The repository `https://github.com/Toragonite/vibe-stealth` must be **public**
  before release, so the README's images and relative links resolve on both
  Marketplace listings. (`package.json` already points `repository`, `homepage`,
  and `bugs` at it.)

> Do not commit tokens or paste them into scripts. Keep them in your shell
> environment (`VSCE_PAT`, `OVSX_PAT`) or pass them per-command.

---

## 3. Release steps

### 3.1 Bump the version
The manifest is still at `0.7.1`. Set it to the release version — for the first
public release, `1.0.0`:

```
npm version 1.0.0 --no-git-tag-version
```

(`--no-git-tag-version` edits `package.json` only; the tag is created in 3.3
after the CHANGELOG is committed.)

### 3.2 Update the CHANGELOG
Confirm `CHANGELOG.md` has a `## [1.0.0] - <date>` section describing the
product as shipped, then commit:

```
git add package.json CHANGELOG.md
git commit -m "release: v1.0.0"
```

### 3.3 Tag
```
git tag v1.0.0
git push origin HEAD --tags
```

### 3.4 Build the package once, publish that same file to both registries
Build the `.vsix` first and publish the exact artifact you tested, rather than
letting each tool re-package:

```
npx vsce package
```

This produces `vibe-stealth-1.0.0.vsix`.

**Publish to Open VSX first.** Open VSX has no review queue, is easy to correct,
and is where VSCodium / Antigravity users install from — so exercise the release
there before touching the Marketplace:

```
npx ovsx publish vibe-stealth-1.0.0.vsix -p "$OVSX_PAT"
```

Install it in VSCodium/Antigravity, follow a live game, and confirm the tree,
relay, status bar, and logos behave. Leave it live for a few days.

**Then publish to the VS Code Marketplace**, using the same `.vsix`:

```
npx vsce publish --packagePath vibe-stealth-1.0.0.vsix
```

(`vsce` uses `VSCE_PAT` from the environment, or run `npx vsce login toragonite`
first.)

> `package.json` defines the release scripts used above:
> `npm run release:check` (every gate in one command), `npm run package`
> (`vsce package`), `npm run publish` and `npm run publish:ovsx`. The last two
> publish **the `.vsix` file matching the current version**, not a fresh build
> from the working tree, so the bytes you tested are the bytes you ship.
> There is deliberately no "publish everywhere at once" script: publish to Open
> VSX, let it run for a few days, then publish to the Marketplace.

### Script notes (read before using the `package.json` publish scripts)
- `npm run publish` and `npm run publish:ovsx` interpolate `$npm_package_version`
  into the `.vsix` filename. npm sets that variable only for `npm run`, so run
  them through npm — the same line pasted into a shell expands it to empty and
  points at `vibe-stealth-.vsix`, which does not exist.
- Run `npm run package` first. Both publish scripts expect
  `vibe-stealth-<version>.vsix` to already exist in the repo root.
- Both publish commands require their tokens (`VSCE_PAT` / `OVSX_PAT` or an
  interactive login) and the publisher/namespace from section 2 to already
  exist. None of that is configured yet, so running any publish script today
  fails immediately — set up section 2 first.

---

## 4. Post-release

### Verify the listings
- **Open VSX:** open the extension's page on `open-vsx.org` for the `toragonite`
  namespace, confirm the version is `1.0.0`, the README renders, and the icon and
  screenshots load (they only load if the GitHub repo is public).
- **VS Code Marketplace:** search for "Vibe Stealth" in the Extensions view of a
  real VS Code install, confirm `1.0.0` is offered, install it, and do a first
  manual run — the render of tree-row logos and live-state child rows cannot be
  verified headlessly (see `VERIFICATION.md`), so confirm them visually here.

### If something is wrong
- **Open VSX** has no unpublish for a single version through the CLI. Fix the
  problem, bump the patch version (`npm version patch`), and publish again — a
  higher version supersedes the broken one for new installs. Contact the Open VSX
  admins only if a version must be removed outright.
- **VS Code Marketplace:** you can unpublish a specific version with
  `npx vsce unpublish toragonite.vibe-stealth@<version>`, or remove the whole
  extension from the publisher-management page. In practice, prefer shipping a
  fixed higher version (`npm version patch` → republish) over unpublishing, so
  existing users get the fix on their next update.

---

## 5. Known-unverified surfaces

These paths are contract-pinned and unit-tested but have **not** been driven
against a live game end-to-end (see `VERIFICATION.md`). They may need a manual
check once a live game is available in each:

- **Naver KBO / K League relay** — live text relay driven end-to-end.
- **Soccer lineups (ESPN)** — the formation / starting-XI / bench state rows,
  which only populate once lineups are posted.
- **NHL** — live in-progress parsing (captured payloads were only pre/post).
- **PandaScore** — exercised only against synthetic fixtures; it needs a token
  and was not run against a live match.

Also note that several providers wrap **unofficial or public endpoints** (ESPN,
Naver, Riot's public LoL gateway key, the logo CDNs). Those can change shape or
disappear without notice, so a release can break through no fault of this
codebase. When a provider suddenly stops relaying, check the upstream endpoint
before assuming a regression.
