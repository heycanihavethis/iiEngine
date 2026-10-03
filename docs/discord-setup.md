# Discord owner configuration

These instructions document the reviewed Discord configuration and future credential or role maintenance. The live OAuth callback is configured, and the owner enabled Manage Roles for the bot so ii Engine can add or remove the cosmetic Engine User role.

1. Open application **1541246974404198470** in the [Discord Developer Portal](https://discord.com/developers/applications).
2. Add `https://<RAILWAY_DOMAIN>/v1/auth/discord/callback` as an OAuth redirect. It must exactly match `DISCORD_OAUTH_REDIRECT_URI`.
3. Obtain/reset the client secret and bot token only if the authorized owner decides it is needed. Store them directly in Railway Variables.
4. Never paste either secret into chat, source, desktop configuration or a committed file.
5. Confirm the bot role remains above Engine User **1548883777462206625**, with only View Channels, Read Message History and the Manage Roles permission necessary for this cosmetic role. Do not grant Administrator. Guild: **1170093288557129748**.
6. Fill `DISCORD_OWNER_ROLE_IDS`, `DISCORD_ADMIN_ROLE_IDS` and `DISCORD_DEVELOPER_ROLE_IDS` using exact role IDs. Empty lists grant no staff entitlement. Review the public announcement-channel allowlist separately from staff channels.
7. Review the application's privileged-intent notice before **October 11, 2026**, as specified in the reference pack. This date is a supplied owner action item; confirm the actual notice in the portal. The current implementation uses REST membership lookups, not a Gateway member cache.

Use OAuth scopes `identify` and `guilds.members.read` for end-user sign-in (configurable via `DISCORD_OAUTH_SCOPES`; default is both). `identify` covers profile; `guilds.members.read` lets the backend read this guild's member record from the user's token at login so membership survives Discord bot flaps. The backend keeps the client secret and bot token; the desktop must never receive them. The browser callback completes a short-lived request. The initiating desktop proves possession of a random verifier before retrieving an Engine session. See [Discord OAuth](https://docs.discord.com/developers/topics/oauth2).

After owner review and explicit authorization, verify with controlled accounts: member login and cosmetic role grant; nonmember Join Server flow; recheck after joining; ordinary-member rejection from beta/developer/staff; exact staff role access; signout preserves role; disconnect revokes every device and removes role; outage soft-falls back to the last RoleGrant when present. Never perform these tests against production as part of ordinary local CI.
