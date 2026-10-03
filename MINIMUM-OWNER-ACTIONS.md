# Minimum owner actions

The app can be built, installed, and run locally without production accounts. Codex has completed the
local toolchain setup, backend and database scaffolding, demo environment, Windows packaging, and
official BepInEx baseline retrieval. The larger `OWNER-INPUTS.md` worksheet is a production reference,
not a prerequisite for local use.

## Needed from the owner before installation features are enabled

- [x] **Approved by owner on 2026-09-14:** official BepInEx 5.4.23.4 Windows x64.
  The candidate was downloaded from the official BepInEx GitHub release. Its ZIP SHA-256 is
  `f881201b79da03e513bf97cdf39607ffa7f9e0d31a519b1aeeca8eb60f8309e7`; it contains
  `winhttp.dll`, `doorstop_config.ini`, and `BepInEx/core/BepInEx.dll`.
- [x] **Confirmed by owner on 2026-09-14:** the menu publisher granted the owner full access and
  permission. Preserve the publisher's original authorization with the project's release records.

## Needed only when the owner authorizes a live backend

Fill in these non-secret values:

```text
Public API hostname (example: api.iiengine.app):
Discord application client ID:
Discord server/guild ID:
Discord member role ID(s), comma-separated:
Discord developer/admin role ID(s), comma-separated:
Support/contact email:
```

Perform these account-only steps:

1. Create or select a Discord application and add
   `https://<Public API hostname>/v1/auth/discord/callback` as an OAuth redirect.
2. Put the Discord client secret directly into the backend host's secret-variable screen. Do not paste
   it into chat or commit it.
3. Sign in to the chosen backend host and GitHub when prompted. Codex can configure the services,
   variables, migrations, and workflows after access is available and deployment is authorized.

The NVIDIA API key is optional. Without it, every feature except AI help remains available. Windows
code signing is also optional for private testing; it is recommended before a public release to reduce
SmartScreen warnings.

## Normal menu update workflow (confirm-before-apply)

Engine reads the live verified menu metadata (`menuversion.json` + release DLL).
It does **not** silently overwrite the player's plugins folder.

1. Engine may prefetch / warm the verified package cache in the background (no game write).
2. Home shows **Update ii Menu** / **Install ii Menu** when the on-disk menu differs from the verified release.
3. The player clicks that CTA. Only then does Engine write `ii.Reborn.dll` into `BepInEx/plugins`.
4. **Launch with ii** soft-launches with whatever menu is already installed; it never auto-applies a newer release.

Code map: soft launch `ensureInstallationForLaunch`; confirmed apply `applyMenuUpdate` / `ensureInstallation`; prefetch `prefetchLatestMenu` (Home / App).

Production installation will still require an Ed25519-signed manifest for fully trusted channels.
The signing private key stays only in GitHub Actions; the desktop contains only the public verification key.
