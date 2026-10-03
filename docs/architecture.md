# Architecture and trust boundaries

The React webview displays server data and local status. Rust owns Steam discovery, process detection, filesystem changes, downloaded artifact verification, Windows Credential Manager, and launch. The shell exposes an explicit command allowlist, not a generic filesystem or shell API. The initial shell exposes only environment status.

The FastAPI service owns Discord OAuth identity, sessions, membership/role enforcement, announcements and private AI. The existing bot keeps its current process and gateway connection; this API will use Discord REST only. PostgreSQL stores minimal identity, hashed auth/refresh proofs, role grant records, quota counters, sanitized announcement cache and coarse audit events.

The isolated `demo.py` entrypoint reads only synthetic fixture data. Production fails closed on missing configuration; neither a network error nor missing secrets selects demo mode. Production exposes authenticated identity, community, AI, release, developer-content, and health routes.

No release manifest is trusted without verification. The owner-approved BepInEx 5.4.23.4 package supplies the complete pinned loader baseline. Install operations acquire a per-game lock, reject links, junctions, and traversal, create and verify a backup, then stage and atomically swap only approved paths. Restore and journal recovery still need their final desktop entrypoints.

Menu DLL updates are **confirm-before-apply**: Launch soft-continues on an installed menu; writing a newer verified menu requires an explicit **Update ii Menu** / **Install ii Menu** click. Prefetch only warms the package cache. See `docs/release-baseline.md`.
