# ii Engine owner input worksheet

Fill the fields marked `FILL IN` that are safe to store in project documentation. Do **not** type secret values into this file, chat, an issue, or a commit. Secret sections contain status checkboxes only; enter the value directly in the named provider.

When this worksheet is complete, tell Codex to read `OWNER-INPUTS.md` and continue the acceptance build. Keep unresolved fields as `FILL IN` rather than guessing.

The shortest path forward is to complete sections 1, 3, 4, 5, 6, 7, 9 and 11 first. Sections 8, 10 and 12 contain secret/provider work you perform directly. Section 13 requires owner/legal decisions. Section 14 stays unchecked until local acceptance passes.

## 1. Ownership and public project identity

- Public product name: `ii Engine` (confirm or replace: confirmed)
- Legal operator name or registered entity: `Drifted`
- Public support email or support URL: `https://discord.com/channels/1170093288557129748/1378349743880671282`
- Privacy-request email or URL: `drifted1000@outlook.com`
- Legal contact email or URL: `drifted1000@outlook.com`
- Public ii Engine source repository URL: (none yet, but will export all files to github at: github.com/iireborn/iiEngine )
- Menu source repository URL: `https://github.com/iireborn/menu` (confirm: `YES
- Copyright holder/year text for ii Engine: `Copyright © 2026 Drifted`
- Release publisher display name: `Drifted`

Directions: use a monitored contact owned by the project, not a developer's private address. The repository must include GPL corresponding source for every distributed build.

## 2. Release scope and support decisions

- First public Engine version: `0.1.0`
- Supported Windows versions: `Windows 10 22H2 and Windows 11, 64-bit`
- First release channel: `stable`
- Automatic Engine updates in first release: `No` (recommended `NO`; current app uses manual updates)
- Public release audience: `Everyone; online member features require official Discord membership`
- Minimum user age / age policy: `13 (age for discord server requirments)`
- Governing-law/jurisdiction language: United states
- Support response expectation, if promised: NONE PROMISED`
- Owner accepts that mod use remains subject to current Gorilla Tag/platform/server rules: `YES

## 3. Complete BepInEx 5.4.23.4 baseline

- Complete approved ZIP local path: `FILL IN`
- Original download/release URL: `FILL IN`
- Person/maintainer who approved this exact archive: `FILL IN`
- Approval date: `FILL IN` (`YYYY-MM-DD`)
- Intended architecture: `x64` (confirm: `YES / REPLACE`)
- Expected version: `5.4.23.4` (confirm: `YES`)
- Root `winhttp.dll` present: `YES / NO`
- Root `doorstop_config.ini` present: `YES / NO`
- `BepInEx/core/BepInEx.dll` present: `YES / NO`
- Maintainer authorizes ii Engine to redistribute this baseline: `YES / NO / PENDING`
- License/notice location or text: `FILL IN`

Directions: put the approved ZIP outside the Git repository, such as the Desktop, and provide only its local path. The current uploaded BepInEx ZIP is incomplete because both root bootstrap files are absent. Do not substitute BepInEx 6. Codex will hash every approved file, build the baseline inventory, inspect it without executing DLLs, and run installation tests only against fixtures until real-game testing is separately approved.

## 4. Menu artifact and compatibility approval

- Approved menu version: `FILL IN` (current uploaded DLL appears to be `1.0.3`)
- Approved DLL local path: `FILL IN`
- Expected SHA-256: `FILL IN` (current uploaded DLL: `4b7148a5012aee3ed99f9c8456f11f51be053910cb274508d6d54ddc683b559e`; maintainer must confirm)
- Canonical installed filename: `ii.s.Stupid.Menu.dll` (confirm: `YES / REPLACE`)
- Expected BepInPlugin GUID: `org.iidk.gorillatag.iimenu` (confirm: `YES / REPLACE`)
- Official release page URL: `FILL IN`
- Official direct DLL download URL: `FILL IN`
- Full 40-character source commit SHA used to build the DLL: `FILL IN`
- Source tree at that commit builds the exact supplied DLL: `YES / NO / NOT YET VERIFIED`
- Maintainer approving this build: `FILL IN`
- Approval date: `FILL IN` (`YYYY-MM-DD`)
- Gorilla Tag game version tested: `FILL IN`
- Compatibility result: `FILL IN` (`compatible`, `incompatible`, or exact limitations)
- Known conflicting mod GUIDs/files: `FILL IN` or `NONE VERIFIED`
- Walksim-Fixed handling approved: `FILL IN`

Directions: release URLs must remain under `https://github.com/iireborn/menu/`. Source edits happen through Git review and CI. The Developer panel may publish a source reference and signed release manifest; it does not compile or execute arbitrary source.

## 5. GitHub repository and protected release environment

- GitHub organization/account: `FILL IN`
- ii Engine repository name: `FILL IN`
- Default branch: `FILL IN` (recommended `main`)
- Production GitHub Environment name: `FILL IN` (recommended `production`)
- Required production reviewers: `FILL IN GITHUB USERNAMES`
- Branch protection enabled on default branch: `[ ]`
- Pull request review required: `[ ]`
- CI required before merge: `[ ]`
- Production environment requires owner review: `[ ]`
- Repository visibility: `FILL IN` (`public` is simplest for GPL source distribution; obtain advice if private during development)

Directions: create the repository, then open **Settings → Environments → New environment**, use the name above, add required reviewers, and restrict deployment branches. Add secrets under that environment rather than ordinary repository variables when they are used for publishing. GitHub documents repository and environment secrets under **Settings → Secrets and variables → Actions**.

Do not create secrets until the signing workflow is reviewed. Required future GitHub secret status:

- `RELEASE_MANIFEST_PRIVATE_KEY`: `[ ] NOT CREATED  [ ] ADDED TO PROTECTED ENVIRONMENT`
- Windows code-signing credential(s): `[ ] NOT AVAILABLE  [ ] ADDED TO SIGNING SERVICE/PROTECTED ENVIRONMENT`
- Timestamp/signing-service credentials, if applicable: `[ ] NOT AVAILABLE  [ ] CONFIGURED`

Never paste their values here. The release workflow should receive them only after the protected environment's reviewer approves the job.

## 6. Railway project and PostgreSQL

- Railway account/team owner: `FILL IN`
- Railway project name: `FILL IN` (recommended `ii-engine`)
- Railway environment name: `FILL IN` (recommended `production`)
- API service name: `FILL IN` (recommended `api`)
- PostgreSQL service name: `FILL IN` (recommended `Postgres`)
- Railway public API domain: `FILL IN AFTER GENERATING DOMAIN`
- Final API origin including scheme: `FILL IN` (must be exactly `https://<domain>` with no path or trailing slash)
- Deployment region: `FILL IN`
- Healthcheck path: `/health/ready` (confirm: `YES`)
- Root directory/build context: repository root (confirm: `YES`)
- Dockerfile path: `services/api/Dockerfile` (confirm: `YES`)
- Pre-deploy migration command: `alembic upgrade head` (confirm: `YES`)
- Production backup retention configured for PostgreSQL: `YES / NO / PENDING`
- Shared edge rate-limit provider/plan: `FILL IN` or `PENDING`
- Continuous uptime monitor and alert recipient: `FILL IN` or `PENDING`

Directions:

1. In Railway, create a project and add a service from the ii Engine GitHub repository.
2. Add PostgreSQL using **+ New → Database → PostgreSQL**. Leave the database private.
3. In the API service, set the Dockerfile path above. The application listens on Railway's injected `PORT`.
4. Under **Settings → Networking → Public Networking**, choose **Generate Domain**. Copy the HTTPS origin into the two domain fields above.
5. Under **Settings → Healthcheck**, enter `/health/ready`.
6. Under the API service's **Variables** tab, add the variables listed below. Railway stages variable changes; review and deploy them when the project is ready.
7. Use Railway reference variables for the private database connection. If the database service is named `Postgres`, set the exact value to `postgresql+psycopg://${{Postgres.PGUSER}}:${{Postgres.PGPASSWORD}}@${{Postgres.PGHOST}}:${{Postgres.PGPORT}}/${{Postgres.PGDATABASE}}`.

## 7. Railway non-secret variables

Fill these directly in Railway Variables when the service exists. Public IDs may also be copied into this worksheet.

```dotenv
APP_ENV=production
BACKEND_PUBLIC_URL=FILL IN: exact https:// API origin
FRONTEND_ORIGIN=http://tauri.localhost
DATABASE_URL=postgresql+psycopg://${{Postgres.PGUSER}}:${{Postgres.PGPASSWORD}}@${{Postgres.PGHOST}}:${{Postgres.PGPORT}}/${{Postgres.PGDATABASE}}
DISCORD_CLIENT_ID=1541246974404198470
DISCORD_GUILD_ID=1170093288557129748
DISCORD_ENGINE_USER_ROLE_ID=1548883777462206625
DISCORD_OWNER_ROLE_IDS=FILL IN: comma-separated snowflake IDs
DISCORD_ADMIN_ROLE_IDS=FILL IN: comma-separated snowflake IDs
DISCORD_DEVELOPER_ROLE_IDS=FILL IN: comma-separated snowflake IDs
DISCORD_ANNOUNCEMENT_CHANNEL_IDS=1537550313546981507,1548782443715240017
DISCORD_UPDATE_CHANNEL_ID=1547774251963256893
DISCORD_APP_UPDATE_CHANNEL_ID=1548890452328194188
DISCORD_OAUTH_REDIRECT_URI=FILL IN: BACKEND_PUBLIC_URL/v1/auth/discord/callback
DISCORD_OAUTH_SCOPES=identify guilds.members.read
DISCORD_PRO_ROLE_IDS=1551472794238320680
ROBLOX_CATALOG_ASSET_ID=93620103303755
ROBLOX_CATALOG_URL=https://www.roblox.com/catalog/93620103303755/ii-Engine-Pro-Lifetime
ROBLOX_BUNDLE_CATALOG_ASSET_ID=112921567316975
ROBLOX_BUNDLE_CATALOG_URL=https://www.roblox.com/catalog/112921567316975/ii-Engine-Pro-ii-Tracker
ROBLOX_WEEKEND_BUNDLE_CATALOG_ASSET_ID=140291726071649
ROBLOX_WEEKEND_BUNDLE_CATALOG_URL=https://www.roblox.com/catalog/140291726071649/ii-Engine-Pro-ii-Tracker-Weekend
DISCORD_II_TRACKER_ROLE_IDS=1549151900073459752
AI_MODEL=Qwen/Qwen2.5-7B-Instruct
AI_BASE_URL=https://api.siliconflow.com/v1
MANIFEST_PUBLIC_KEY=FILL IN AFTER SIGNING SETUP: base64 Ed25519 public key
LOG_LEVEL=INFO
DEVELOPER_PUBLISH_ENABLED=false
```

Confirm supplied identifiers:

- Discord application `1541246974404198470`: `YES / REPLACE`
- Guild `1170093288557129748`: `YES / REPLACE`
- Engine User role `1548883777462206625`: `YES / REPLACE`
- Announcement channels: `YES / REPLACE WITH IDS`
- Menu update channel: `YES / REPLACE`
- App update channel: `YES / REPLACE`

## 8. Railway secrets — status only

Open the API service's **Variables** tab, create each variable, then choose its three-dot menu and **Seal** after checking it. Sealed variables cannot be shown again. Never copy the value into this worksheet.

- `DISCORD_CLIENT_SECRET`: `[ ] ROTATED  [ ] ADDED  [ ] SEALED  [ ] NOT READY`
- `DISCORD_BOT_TOKEN`: `[ ] ROTATED  [ ] ADDED  [ ] SEALED  [ ] NOT READY`
- `ROBLOX_OPEN_CLOUD_API_KEY`: `[x] CREATED  [x] ADDED  [ ] SEALED  [ ] NOT READY`
  (Required for Plans → Claim Pro. Public Roblox inventory returns 403 for private inventories; without Open Cloud, `/v1/billing/roblox/claim` returns 503.)
  **Must** be a Creator Dashboard → Open Cloud → API Keys key with permission
  `user.inventory-item:read` enabled (and Accept Permissions). A revoked/wrong key
  returns Roblox `401 Invalid API Key` and Claim shows a verification error.
  Rotate by pasting the new value into Railway `ROBLOX_OPEN_CLOUD_API_KEY` on
  `ii-engine-api` (do not commit the value).
- `SILICONFLOW_API_KEY`: `[ ] CREATED  [ ] ADDED  [ ] SEALED  [ ] NOT READY`
- `NVIDIA_API_KEY_2` (legacy fallback only): `[ ] OPTIONAL  [ ] ADDED  [ ] SEALED  [ ] SKIP`
- `ACCESS_TOKEN_SIGNING_KEY`: `[ ] GENERATED  [ ] ADDED  [ ] SEALED`
- `REFRESH_TOKEN_PEPPER`: `[ ] GENERATED SEPARATELY  [ ] ADDED  [ ] SEALED`
- `DEVELOPER_PASSWORD_HASH`: `[ ] COPIED FROM IGNORED LOCAL CONFIG  [ ] ADDED  [ ] SEALED`

Generate independent session values locally without displaying them in chat:

```powershell
$signing = [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(48))
$pepper = [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(48))
```

Paste `$signing` directly into Railway's `ACCESS_TOKEN_SIGNING_KEY` field and `$pepper` directly into `REFRESH_TOKEN_PEPPER`, then clear the terminal variables. They must differ. Do not use the local demo key in production.

The developer password hash is in the latest ignored `work/developer-access/developer-config-*.json`. Copy only `developer_password_hash` to Railway. Put the plaintext password from the sibling handoff text file in the team's password manager. Generate a replacement with `python scripts/manage-developer-password.py` whenever anyone leaves the developer group.

## 9. Discord Developer Portal

- Production OAuth redirect: `FILL IN` (must equal `https://<Railway domain>/v1/auth/discord/callback` byte for byte)
- Owner role ID(s): `FILL IN`
- Admin role ID(s): `FILL IN`
- Developer role ID(s): `FILL IN`
- Bot role name: `FILL IN`
- Bot role is above Engine User in role order: `YES / NO`
- Bot has View Channels in announcement channels: `YES / NO`
- Bot has Read Message History in announcement channels: `YES / NO`
- Bot has Manage Roles for Engine User: `YES / NO`
- Bot has Administrator: `MUST BE NO`
- End-user OAuth scopes: `identify guilds.members.read` (confirm: `YES`; override with `DISCORD_OAUTH_SCOPES=identify` only if rolling back)
- Privileged-intent notice reviewed in portal: `YES / NO / NOT SHOWN`
- Controlled member test account available: `YES / NO`
- Controlled nonmember test account available: `YES / NO`
- Controlled developer/admin test account available: `YES / NO`

Directions:

1. Open Discord Developer Portal → Applications → application `1541246974404198470`.
2. Under **OAuth2**, add the exact production redirect above. The backend uses the authorization-code flow and validates state; do not enable implicit grant for this design.
3. Under **Bot**, reset the bot token because the supplied bot archive contains an `.env` file. Put the replacement directly in Railway.
4. Reset the OAuth client secret if it could have appeared in the same archive. Put the replacement directly in Railway.
5. In Discord, enable Developer Mode under **User Settings → Advanced**. Right-click each role and choose **Copy Role ID**. Fill the public role-ID fields above and Railway variables.
6. Place the bot's role above Engine User. Grant only View Channels, Read Message History, and Manage Roles needed for the cosmetic role. Channel overrides must permit reading the configured public announcement channels.
7. Do not change production roles or run production role tests until the local acceptance build passes and the owner separately approves that test window.

## 10. SiliconFlow AI provider

- SiliconFlow account owner: `FILL IN`
- API key created for ii Engine backend: `YES / NO`
- `SILICONFLOW_API_KEY` entered directly into Railway and sealed: `YES / NO`
- `AI_BASE_URL=https://api.siliconflow.com/v1` set on Railway: `YES / NO`
- Model access confirmed for `Qwen/Qwen2.5-7B-Instruct`: `YES / NO`
- Provider terms/privacy reviewed by owner: `YES / NO / PENDING`
- Provider retention behavior reflected in privacy review: `YES / NO / PENDING`

Directions: create the key in the owner-controlled SiliconFlow account (`https://cloud.siliconflow.com`). Enter it only in Railway (never in chat or the desktop). Use base URL `https://api.siliconflow.com/v1` (not `.cn` for international keys). After deployment, run a controlled prompt, cancellation, quota and provider-outage test without logging prompt content. Legacy `NVIDIA_API_KEY_2` is optional fallback only.

## 11. Ed25519 menu-manifest signing

- Useless/authorized release maintainer agrees releases can publish signed manifests: `YES / NO / PENDING`
- Signing owner: `FILL IN`
- Signing implementation: `FILL IN` (`GitHub protected environment`, `managed signing service`, or another reviewed option)
- Base64 Ed25519 public key: `FILL IN` (public; exactly 32 decoded bytes)
- Private-key secret name: `RELEASE_MANIFEST_PRIVATE_KEY` (confirm: `YES / REPLACE`)
- Key-rotation contact/process: `FILL IN`
- Emergency manifest withdrawal owner: `FILL IN`
- Stable manifest validity period: `FILL IN` (days)
- Beta manifest validity period: `FILL IN` (days)
- Developer manifest validity period: `FILL IN` (days)
- First signed-manifest fixture independently verified: `YES / NO`

Directions: generate the key offline or in the approved signing service. Put the private key only in the protected GitHub environment/signing service. Put the public key in Railway as `MANIFEST_PUBLIC_KEY` and pin the same public key in the desktop build. A manifest must include schema version, channel, version, dates, minimum Engine version, official URLs, canonical filename, SHA-256, byte size, exact baseline ID, compatibility-catalog version and signature. Publishing a Developer-panel release post without a valid manifest may announce information but cannot authorize installation.

## 12. Windows code signing

- Certificate available: `YES / NO / PENDING`
- Certificate subject/publisher name: `FILL IN IF PUBLIC`
- Signing provider/service: `FILL IN`
- EV/standard certificate or Microsoft Trusted Signing: `FILL IN`
- RFC 3161 timestamp URL: `FILL IN`
- Certificate expiry date: `FILL IN` (`YYYY-MM-DD`)
- Signing credentials stored only in signing provider/protected CI: `YES / NO`

Directions: do not export a private certificate into the repository or send it in chat. Supply the signing-service integration details after selecting a provider. Development installers can be clearly marked unsigned; broad public distribution should wait for the owner's signing decision.

## 13. Privacy, retention and data operations

- Privacy policy effective date: `2026-10-03`
- Terms effective date: `2026-09-15`
- Account record retention after disconnect/deletion request: `FILL IN`
- Expired refresh-session retention: `30` days
- Authentication audit-event retention: `180` days
- Developer publication audit-event retention: `180` days
- Announcement cache retention: `30` days
- Database backup retention: `30` days
- Verified deletion-request response time: `30 days`
- Person/role responsible for deletion requests: `Drifted`
- Person/role responsible for security incidents: `Drifted`
- Backend logs confirmed to omit query strings, authorization headers and bodies: `YES / NO`
- Hosting access logs configured to omit OAuth query strings: `YES / NO / PENDING`
- Diagnostic uploads: `NONE AUTOMATIC` (confirm: `YES`)
- AI prompt/answer persistence by ii Engine backend: `NONE` (confirm: `YES`)
- Menu beacon consent behavior fixed by menu maintainer: `YES / NO / PENDING`
- Until fixed, disclosure of the separate menu beacon approved: `YES / NO`

Directions: have the privacy policy and terms reviewed by the operator's qualified adviser. Retention values require a scheduled cleanup implementation and a matching database-backup policy before production. The menu currently sends its live beacon even when its room telemetry-disable file exists; resolve that behavior or keep the disclosure accurate before calling telemetry opt-in.

## 14. Final owner-authorized test windows

Leave these unchecked until Codex reports that local installation and packaging acceptance pass.

- `[ ]` Authorize controlled Discord tests against the production guild, naming the test accounts and time window.
- `[ ]` Authorize temporary Engine User role assignment/removal during those controlled tests.
- `[ ]` Authorize first Railway production deployment.
- `[ ]` Authorize `DEVELOPER_PUBLISH_ENABLED=true` after the production panel is reviewed.
- `[ ]` Authorize creation of the first public GitHub release.
- `[ ]` Authorize posting the prepared app-update announcement to channel `1548890452328194188`.

Each authorization is separate. A local build or completed worksheet does not authorize deployment, Discord changes, or publishing.

## 15. What Codex completes after receiving this worksheet

1. Validate the baseline and menu inputs, create reviewed hash inventories, and keep uploaded binaries out of source control.
2. Finish native signed download, two-step install/repair/restore, interruption recovery, backup retention and Steam launch integration.
3. Finish native preference persistence, tray behavior, diagnostics, accessibility and supported DPI checks.
4. Configure the exact public backend origin and desktop content-security policy after the Railway domain exists.
5. Complete retention/deletion code from the owner's approved periods.
6. Add reviewed signing/publishing workflows without exposing private keys.
7. Run frontend, Python/PostgreSQL, Rust, security, migration, packaging and clean-Windows acceptance checks.
8. Produce reviewable MSI/NSIS artifacts, checksums, SBOM, notices, source bundle, release notes and Discord announcement draft.
9. Stop for owner review before any production deployment, role changes, release publication or Discord announcement.

## Official setup references

- Railway variables and sealed values: https://docs.railway.com/variables
- Railway PostgreSQL: https://docs.railway.com/databases/postgresql
- Railway public domains: https://docs.railway.com/networking/public-networking
- Railway deployment healthchecks: https://docs.railway.com/deployments/healthchecks
- Discord OAuth2 and permissions: https://docs.discord.com/developers/platform/oauth2-and-permissions
- Discord server roles and channel permissions: https://docs.discord.com/developers/platform/server-and-channel-management
- GitHub Actions secrets: https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets
- GitHub protected deployment environments: https://docs.github.com/en/actions/concepts/workflows-and-actions/deployment-environments
