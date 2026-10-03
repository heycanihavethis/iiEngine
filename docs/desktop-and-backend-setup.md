# Desktop, developer panel and backend setup

## What runs where

The Windows app is a Tauri executable containing the React interface and Rust system commands. FastAPI is a separate service. In local development it runs on this computer; after an approved deployment it runs on Railway alongside a private PostgreSQL database. Users install the desktop executable and do not install Python or PostgreSQL. Development currently uses local mocks; live Discord and NVIDIA functionality needs backend credentials.

## Run the desktop on this computer now

The C++ workload is detected and the Windows native tests now pass. Existing dependencies are installed. Open PowerShell in the repository root. Use three terminals:

Terminal 1 — local backend, with persisted sandbox content and the developer password:

```powershell
& work/venv312/Scripts/python.exe -m uvicorn demo:app --app-dir services/api --host 127.0.0.1 --port 8000 --no-access-log
```

Terminal 2 — development interface:

```powershell
corepack pnpm dev
```

Terminal 3 — native Windows shell:

```powershell
$env:RUSTUP_HOME = Join-Path (Get-Location) 'work/tools/rustup'
$env:CARGO_HOME = Join-Path (Get-Location) 'work/tools/cargo'
& work/tools/cargo/bin/cargo.exe run --manifest-path apps/desktop/src-tauri/Cargo.toml
```

Do not start duplicate servers if these ports are already in use. Select **Enter local demo**, then **Developer**. The sandbox uses a synthetic developer identity; the shared password is still required. Only this local demo omits Discord login. It is excluded from the production container. Never expose `demo:app` publicly.

The generated password and private configuration are in ignored `work/developer-access/`. Store the password in the team's password manager. The demo loads the latest `developer-config-*.json` on restart. Sandbox edits persist in `sandbox.db`. They never alter Discord or GitHub.

## Routine changes without a new desktop build

1. Open Developer and unlock using the group password. Online, the backend also checks the user's live Discord developer/admin/owner entitlement.
2. Choose Announcement, Menu release post, Menu source reference or Service notice.
3. Enter the title, text, audience and optional public HTTPS link. Release posts require version and DLL SHA-256. Source references require an official GitHub URL and full 40-character commit SHA.
4. Save the draft. Existing published content remains unchanged.
5. Review the saved revision, then publish. Home refreshes developer content every 30 seconds. A stale edit is rejected when another developer changed that item.
6. Withdraw a published item to remove it from members' feeds while retaining its draft.

A release post can include the maintainer's signed JSON manifest. With the configured public key, the backend verifies signature, dates, channel, file identity and official URLs before accepting it. It then serves that release through `/v1/releases/<channel>` and `/v1/manifests/<channel>`. Editing source references does not compile source. Executable source changes still require the GitHub build/signing process. Never paste a signing private key into the panel. Changes to the desktop's own code still need a new installer.

The unlocked token lives in memory, expires after 15 minutes, and is bound to the signed-in device session. Five failed password attempts lock that identity for 15 minutes. Every management request checks staff access. Password rotation invalidates old unlocks when backend configuration reloads. Production publication defaults to disabled until owner review.

## Configure the real backend after local review

The owner authorized and completed the Railway deployment at `https://ii-engine-api-production.up.railway.app`. PostgreSQL, current migrations, Dockerfile deployment, the pre-deploy migration command and HTTPS health checks are configured. Discord OAuth/bot credentials, staff-role mappings, NVIDIA, developer-password hash and independent session keys are stored as masked Railway variables. The service runs with `APP_ENV=production`; publication remains disabled pending review. The steps below document the deployed configuration and its later rotation/recovery procedure.

1. Create/select an owner-controlled GitHub repository for ii Engine and a Railway project. Connect the repository to a Railway service. Use repository-root build context and `services/api/Dockerfile`; do not use the demo entrypoint.
2. Add Railway PostgreSQL. Reference its private connection URL in the API service's `DATABASE_URL`, using the `postgresql+psycopg://` driver prefix.
3. Generate a Railway HTTPS domain. Set `BACKEND_PUBLIC_URL` to that origin and `DISCORD_OAUTH_REDIRECT_URI` to `<origin>/v1/auth/discord/callback`.
4. In Discord Developer Portal application `1541246974404198470`, register that exact callback. Set `DISCORD_CLIENT_SECRET` and `DISCORD_BOT_TOKEN` directly in Railway Variables. Do not copy them to chat, Git, Vite variables or desktop files.
5. Confirm guild `1170093288557129748`, Engine User role `1548883777462206625`, Beta Engine User role `1549421049287020568`, announcement channel IDs, and exact staff role IDs. Set `DISCORD_OWNER_ROLE_IDS`, `DISCORD_ADMIN_ROLE_IDS`, `DISCORD_DEVELOPER_ROLE_IDS`, and `DISCORD_BETA_ROLE_IDS`. With separate approval, ensure the bot can read those channels and manage the cosmetic role, with its bot role above Engine User. Do not grant Administrator.
6. Generate independent random values of at least 32 characters for `ACCESS_TOKEN_SIGNING_KEY` and `REFRESH_TOKEN_PEPPER` directly into your secret manager/Railway. Configure `SILICONFLOW_API_KEY` for AI (model `Qwen/Qwen2.5-7B-Instruct`, base URL `https://api.siliconflow.com/v1`). Legacy `NVIDIA_API_KEY_2` remains a fallback only.
7. Set `DEVELOPER_PASSWORD_HASH` to the scrypt hash from the generated private configuration JSON. Share only the password via the team password manager. Generate a new pair with `python scripts/manage-developer-password.py` when rotating; update Railway and restart. The demo session signing key in the JSON is for local use only: generate fresh production session keys.
8. Set `APP_ENV=production`, `FRONTEND_ORIGIN=http://tauri.localhost` for the Windows packaged webview; verify the actual origin in the native release test. Set `MANIFEST_PUBLIC_KEY` to the maintainer's base64 Ed25519 public key. Private signing keys stay in the maintainer's CI secret store.
9. Run `alembic upgrade head` as the pre-deploy command (working directory `/app` in the container). Current schema revision is `0005`. Use `/health/ready` as readiness probe.
10. Keep `DEVELOPER_PUBLISH_ENABLED=false` until the owner reviews the connected environment. Enable only after approval. Configure backup, log redaction/retention and shared edge rate limits before public use.
11. Test approved accounts for member/nonmember/staff access, signout, disconnect, content publication, AI quota and provider outages. Production role assignment/removal tests require owner approval.

## Build installers after the backend is reviewed

Production packages have the public Railway origin pinned in the Vite production environment and native release fallback. CI also sets `VITE_BACKEND_PUBLIC_URL` and `ENGINE_BACKEND_URL` explicitly to `https://ii-engine-api-production.up.railway.app`. The Tauri `connect-src` policy allows that exact origin and local development. Pin the maintainer's verification public key in the native release configuration. Never put provider secrets or signing private keys in the desktop build.

```powershell
corepack pnpm build
corepack pnpm --filter @ii/desktop tauri build
```

The Tauri release build writes installers under `apps/desktop/src-tauri/target/release/bundle/` (`msi/` and `nsis/`). The release build must be tested on a clean Windows account, with WebView2, API connectivity, tray behavior and DPI scaling. Generate checksums, SBOM and GPL corresponding source. Code-sign if the owner supplies a certificate. Publishing the installers and posting a Discord announcement require separate owner approval.

## Remaining base-app work and owner inputs

Native compilation is no longer blocked. The verified install pipeline and Steam launch are implemented. Journal recovery and reviewed restore still need their narrow Tauri/UI entrypoints, and a clean Windows account installer test remains a release gate. Discord login, server roles, and the NVIDIA provider are configured on the live backend.

The latest owner upload still contains only the BepInEx core folder: `winhttp.dll` and `doorstop_config.ini` are absent. Supply the complete maintainer-approved 5.4.23.4 Windows x64 distribution, including its root files and approved inventory. The menu DLL and 226 C# source files are present. Bot source is reference material only; its embedded environment file was not read. Settings contain an InstallId-named item and must be sanitized before any distributable defaults are made.

Owner-only inputs: approved complete baseline; staff role IDs; backend domain and provider configuration; maintainer signing public key and protected signing workflow; legal operator/contact; optional Windows signing certificate. No production secret should be sent through chat.
