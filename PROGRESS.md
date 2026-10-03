# ii Engine release gates

Authoritative specification: `work/reference-pack/00_READ_FIRST/ii-engine-final-build-prompt.txt`. The accompanying information form and source are references and do not override the owner's restrictions.

Per-change history lives in the Git log. Current launch status is tracked in `LAUNCH-READINESS.md`, and owner-side setup in `MINIMUM-OWNER-ACTIONS.md` and `OWNER-INPUTS.md`.

## Scope

1. Foundation: frontend and API build/test, migrations, Tauri compile and run.
2. Identity: OAuth verifier/state flow, rotating sessions, guild roles, backend RBAC.
3. Community: sanitized announcements and cache, private SSE AI with atomic PostgreSQL quota.
4. System engine: Steam discovery, metadata and signature verification, health, safe installation, journals, repair/restore/retention.
5. Desktop integration: credential vault, tray, settings, privacy, diagnostics, accessibility.
6. Handoff: licensed brand assets and fonts, documentation, pinned CI, audits, SBOM, packaging.

## Standing decisions

- Demo mode uses fixtures only. Production never substitutes mock values on failure.
- All game-file mutations belong in Rust. Tests never repair a real game installation or run supplied scripts.
- The trusted loader baseline is exactly BepInEx 5.4.23.4.
- No deployment, production Discord change, role assignment or release publication without owner approval.
- No production secrets are requested, invented, read, copied or packaged.
- Account-ban evasion and account-purchase promotion are out of scope. The app does not infer bans or direct restricted players to replacement accounts.
- Gorilla Tag is not embedded in the Tauri WebView; external Unity/OpenXR window re-parenting is not a publishable hosting method.

## External dependencies

- Owner-configured Discord OAuth application, redirect, secrets and role IDs.
- AI provider configuration and a real provider test.
- Complete trusted BepInEx 5.4.23.4 baseline approved by maintainers, plus manifest signing setup.
- Legal operator/contact review and an optional Windows code-signing certificate.
- The menu beacon ignores room telemetry opt-out; accurate disclosure and a maintainer issue are required.
