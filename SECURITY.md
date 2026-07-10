# Security Policy

Vibe Stealth is a VS Code extension that relays live sports and esports as text.
This document describes exactly what it touches, what it deliberately does not,
and how to report a vulnerability privately.

## Security model

Vibe Stealth is intentionally small in what it can reach. The following is the
complete picture of its trust boundaries.

### Secrets — one, and only one

- The extension stores **exactly one secret: a PandaScore API token**, and only
  if you choose to set one (via the **Vibe Stealth: Set PandaScore API Token**
  command). Everything else works with no credentials at all.
- That token is written to and read from VS Code's **`SecretStorage`**, never
  from settings, workspace state, or any file the extension writes. It is never
  logged, never sent anywhere except to PandaScore's own API as the
  `Authorization: Bearer …` header, and never read from the extension's settings.
- The extension reads **no other credential** of any kind — no OAuth tokens, no
  cookies, no environment variables, no other host's API keys.

### The embedded Riot gateway key is not a credential

- To reach Riot's public LoL Esports gateway, the extension sends a fixed
  `x-api-key` header. **This is the same public key that `lolesports.com` ships
  to every browser** that loads the site; it is embedded in the site's frontend
  and identifies the public web gateway, not a user.
- It grants no account access, carries no user identity, and is not a secret.
  It is checked into the source in `src/providers/lolesports.ts` on purpose and
  documented as public. Riot may rotate it at any time, which would break LoL
  Esports relay until an update ships — that is the only consequence.
- Do not report the presence of this key as a leaked credential. It is the
  documented, intended mechanism for an unofficial key-free client, exactly as a
  browser uses it.

### Network — JSON from a fixed set of hosts, images from an allowlist

- The extension makes **GET requests only**, over HTTPS, with a 10-second
  timeout, and never follows a redirect to another host.
- It fetches **JSON** from the fixed set of upstream APIs it supports: ESPN,
  MLB StatsAPI, the NHL API, Naver Sports, Riot's LoL Esports gateway, and
  (only when you provide a token) PandaScore. These hosts are hard-coded per
  provider; the extension does not fetch JSON from arbitrary or user-supplied
  URLs.
- It downloads **images** (team and league logos) only from an **exact host
  allowlist** — `a.espncdn.com`, `assets.nhle.com`, `www.mlbstatic.com`,
  `static.lolesports.com`, `sports-phinf.pstatic.net`, and `cdn.pandascore.co`.
  The image downloader (`src/ui/logoCache.ts`) is the only code that fetches
  binary content, and it is written as a security boundary:
  - HTTPS only, exact hostname match (no wildcards, no parent-domain suffixes).
  - `redirect: 'error'` — a redirect cannot smuggle the fetch off the allowlist.
  - The **image format is decided by magic bytes**, not by the server's
    `content-type` header (which a server can get wrong in either direction).
    A body that is neither a PNG nor an SVG by its bytes is rejected.
  - A **512 KiB** size cap and a 10-second timeout.
  - SVG bodies are additionally screened for embedded `<script>`,
    `<foreignObject>`, and inline event-handler attributes, and rejected if any
    are present.
  - Cache filenames are derived from a hash of the source URL and the sniffed
    format, and files are written atomically.

### Disk — only inside the extension's own storage

- The extension writes **only inside its own global storage directory** (the
  per-extension `globalStorageUri` that VS Code assigns it): cached logo images
  and their URL→filename sidecar. It does not write into your workspace, your
  home directory, or anywhere else on disk.
- Followed-game state is kept in VS Code's workspace state, not in files the
  extension manages.

### What it never does

- No telemetry, no analytics, no phone-home. The only network traffic is the
  upstream sports/esports APIs and the logo CDNs listed above.
- No arbitrary code execution, no shell-out, no dynamic `require`/`import` of
  remote code. There are **zero runtime npm dependencies** — the extension uses
  only the global `fetch` and the VS Code API.

## Supported versions

Vibe Stealth is a single actively developed extension; security fixes go to the
**latest released version**. There are no separately maintained release lines.
If you are affected by a security issue, update to the latest version first —
that is where the fix will land.

| Version | Supported |
|---|---|
| Latest release | ✅ |
| Any older version | ❌ (please update) |

## Reporting a vulnerability

Please report security issues **privately**, not in a public issue.

Use GitHub's **private vulnerability reporting** on this repository:

1. Go to <https://github.com/Toragonite/vibe-stealth/security/advisories/new>
   (or open the repository's **Security** tab and choose **Report a
   vulnerability**).
2. Describe the issue, the version affected, and — if you can — the steps to
   reproduce it and the impact you observed.

Please include, where relevant:

- The extension version and your VS Code (or fork) version and OS.
- Which part of the extension is involved (for example the logo downloader, a
  specific provider, or secret handling).
- A minimal reproduction, and any payload or host that triggers the behavior.

Please give a reasonable window for a fix before any public disclosure. This is
a volunteer, unofficial project, so response times are best-effort; you will get
an acknowledgement as soon as the maintainer sees the report.

## Scope notes

Vibe Stealth is an **unofficial** client of several third-party APIs and is not
affiliated with, endorsed by, or sponsored by MLB, the NHL, ESPN, Naver, Riot
Games / LoL Esports, PandaScore, or any league or team. Reports about the
behavior or availability of those upstream services are outside what this
project can fix — but a way the extension mishandles a hostile or malformed
upstream *response* is very much in scope, and worth reporting.
