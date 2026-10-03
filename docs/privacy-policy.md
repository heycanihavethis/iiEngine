# ii Engine Privacy Policy

Operator: **Drifted**. Privacy contact: **drifted1000@outlook.com**. Effective date: **October 3, 2026**.

This policy describes the ii Engine Windows application and its configured online service.

## Discord account

Sign-in requests the `identify` and `guilds.members.read` OAuth scopes. ii Engine receives your Discord ID, display name and available avatar, and may read your membership and roles in the official ii Engine Discord server to determine access. Role names entered on the desktop do not grant privileges. We do not request your email, password, direct messages or automatic server joining. Discord OAuth tokens are discarded after profile retrieval. See [Discord's OAuth documentation](https://docs.discord.com/developers/topics/oauth2).

For a member, the service assigns the cosmetic Engine User role. Signing out ends the device session and keeps this role. Disconnect revokes all Engine sessions and attempts to remove the role. If Discord is unavailable, sessions remain revoked and support can help remove the role. Disconnect does not automatically erase the account database record.

## Sessions, records and retention

An Engine access token lasts 15 minutes. Refresh credentials rotate and expire after 30 days; Windows Credential Manager stores the desktop refresh credential. The database stores a keyed hash, not the original refresh token. OAuth request proofs expire after five minutes. The service discards Discord OAuth tokens after profile retrieval and attempts upstream revocation.

The database also stores your account record, role-grant timestamps, daily AI request counts and coarse authentication audit events. Expired or revoked session records are retained for up to 30 days, audit events for up to 180 days, announcement cache entries for up to 30 days, and daily AI usage counters for up to 30 days. A scheduled cleanup runs daily. PostgreSQL backups are retained for up to 30 days.

You can delete your Engine account from Settings after signing in, or request deletion at **drifted1000@outlook.com**. Drifted responds to verified requests within 30 days. Account deletion revokes Engine sessions and removes the active account and its dependent records. Deleted records may remain in encrypted database backups until the 30-day backup period expires. Deleting Engine data does not delete your Discord account or independently held provider records.

## Private iiGPT

Questions go through the backend to the configured AI provider (SiliconFlow by default; legacy NVIDIA keys still work if SiliconFlow is unset). They are not posted to a public Discord channel. Engine does not keep prompt or answer text in its database. When Engine telemetry is enabled (on by default; toggleable in Settings), successful AI exchanges and optional launch console logs may be forwarded to a private staff Discord channel as attached text files so maintainers can diagnose bugs. Those forwarded files carry no hostname, operating-system account name or IP address. The desktop may also keep the current conversation in memory; New Chat, Delete Local History, or closing the view clears it. Export creates a local copy at your request. Daily successful-request counts enforce allowance quotas; abandoned request reservations expire after two minutes.

The provider processes the prompt and generated answer under its applicable terms and policies. Do not assume Engine's non-retention policy controls the provider's retention. The operator must review the specific service agreement and the provider's privacy policy before enabling the service. Avoid entering sensitive personal information.

## Community data and local files

The backend caches sanitized messages, authors, timestamps and safe image links from configured public announcement channels. No private channel or arbitrary message lookup is exposed.

The desktop reads the selected Gorilla Tag installation to inspect loader and plugin metadata. Repair will require an exact scope review and a verified local backup. Backups can contain menu preferences, InstallId and other files from the approved repair scope; they stay on your device. Keep them private.

Diagnostic export must show the exact selected report first. It is local only; there is no automatic upload. Engine's routine server logs contain a random request ID and response status, not prompts, tokens, request bodies or user paths. Hosting access logs must also be configured to exclude OAuth query strings.

## Telemetry and the separate menu beacon

Engine telemetry defaults on and can be turned off in Settings. When enabled, Engine may send the Engine version, a coarse platform string, feature-usage counts, AI prompt/response transcripts, and launch/session console logs to a private staff Discord channel (as short summaries plus attached text files). Those records are linked to the Discord account you signed in with. It does not sell personal information or include hidden third-party analytics SDKs.

Engine telemetry does not collect your computer name (hostname), your Windows or other operating-system account name, your MAC address, or any IP address — public, local, or VPN. The desktop runs no public-IP, STUN or VPN-detection probe, and the service neither derives nor stores a client IP address for telemetry. Windows and Unix user-profile paths that appear in submitted log text or in the reported game path are rewritten to remove the account name before anything is stored or posted. If an older desktop build still sends such a field, the service drops it on arrival. Historical telemetry rows that contained these identifiers were deleted by database migration `0028_purge_device_identifier_telemetry`, and the daily cleanup removes any that reappear.

Separately from telemetry, the service holds the connection IP address in memory only for per-caller request rate limiting. It is not written to telemetry records, audit events or application logs. Hosting and network providers still observe connection addresses in order to route traffic, under their own terms.

The existing menu is a separate system. Reference inspection found a live beacon roughly every 25 seconds using a locally generated 12-character InstallId. That beacon currently ignores the room-telemetry disable flag. The `iiMenu_DisableTelemetry.txt` setting must not be described as disabling that beacon. Full menu-settings reset clears the active InstallId, while a repair backup retains its previous contents. Maintainers must resolve or continue clearly disclosing this consent limitation.

## Service providers and changes

Configured operation involves Discord for identity and community data, Railway and PostgreSQL for hosting and records, NVIDIA for AI requests, and GitHub for source and releases. Those providers process data under their own terms and policies. Material changes to ii Engine data handling require an updated effective date and clear notice in the app.
