# Desktop and manifest release runbook

Automatic app updates are disabled. No silent updater or scheduled release publication is included. Perform this runbook only after local acceptance and explicit owner approval.

Menu DLL updates inside a player's Gorilla Tag install are confirm-before-apply (Launch soft-continues; **Update ii Menu** / **Install ii Menu** writes after an explicit click). That is separate from publishing a new ii Engine desktop installer.

Before publishing any GitHub Release, record the exact commit SHA in the release body and update `docs/release-baseline.md`. Do not treat unsigned Windows RC artifacts as releases.

## Trust configuration

Maintainers must supply a complete, tested BepInEx **5.4.23.4** Windows x64 baseline including its root bootstrap files and approved SHA-256 inventory. The reference core archive is incomplete. BepInEx 6 or a guessed replacement must not be substituted.

The signed menu manifest contains schema/version/channel, publication/expiry, minimum Engine version, official download/release URLs, canonical filename `ii.s.Stupid.Menu.dll`, SHA-256, byte size, baseline ID and compatibility-catalog version. Rust verifies Ed25519 against a pinned public key. Sign the UTF-8 compact JSON object with keys sorted lexicographically, excluding the `signature` field; include the detached signature as base64. Keep private signing keys in an owner-controlled signing system, never the desktop or source tree. Supply a reviewed fixed public-key pin and test key rotation before enabling the publisher.

The transitional stable API cross-checks the official GitHub latest release and visibly reports **Unsigned manifest**. It does not pretend the TLS endpoint is a signature. Beta/developer publishing remains unavailable until its signed channel configuration exists; backend entitlement checks still apply.

## Build and review

1. Run all local and Windows CI checks against a fixed source revision. Complete native fixture, tray, vault, game-discovery, install/repair/restore and DPI acceptance. Resolve PROGRESS.md gaps first.
2. Set the reviewed public HTTPS backend origin consistently for Vite and Rust. Review the packaged CSP to allow only that API and necessary safe image origins. Never embed provider secrets.
3. Run `corepack pnpm package` on a Windows MSVC/SDK/WebView2 build host to create MSI and NSIS installers. Verify each installer on a clean supported Windows VM, including uninstall behavior and retained user backups.
4. If configured by the owner, Authenticode-sign artifacts using a protected code-signing certificate and timestamp service. Clearly identify unsigned development installers. Do not invent a certificate.
5. Generate SHA-256 checksums, dependency SBOM, license notices, source archive and corresponding-source instructions. Verify exact artifact names and inspect package contents for excluded secrets, fixture DLLs, InstallId, logs and local databases.
6. Draft release notes covering behavior, known limits, privacy changes and manual update instructions. Create/publish a GitHub release only after separate owner approval. Include MSI/NSIS, checksums, SBOM and the matching GPL source.
7. Draft an app-update announcement for channel **1548890452328194188**. Posting is a separate owner-authorized action; local builds and CI never send it. Link the reviewed release and checksums.

The ii Engine repository URL and legal operator/contact are owner placeholders. Do not publish with those unresolved. Menu source: https://github.com/iireborn/menu.
