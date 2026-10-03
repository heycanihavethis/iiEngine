# Tracker (Engine)

## Rare cosmetics tracker (ii Tracker) — default Tracker tab

Partner Discord channels post rare-cosmetic hits and full-server room sync logs.
Engine splits room-sync embeds into per-player pills and surfaces both feeds in Tracker.

### Access

| Who                                                | What they see                                   |
| -------------------------------------------------- | ----------------------------------------------- |
| No unlock                                          | Coming soon + Plans CTA                         |
| ii Tracker role (`1549151900073459752`)            | Unlocked badge + Coming soon (no live rows yet) |
| Beta tracker role (`1554650259152576513`) or staff | **Live feed** inside Engine                     |

Env:

- `DISCORD_II_TRACKER_ROLE_IDS` — paid / early unlock (coming-soon)
- `DISCORD_II_TRACKER_BETA_ROLE_IDS` — live feed (default `1554650259152576513`)
- `DISCORD_TRACKER_GUILD_ID` — partner guild
- `DISCORD_TRACKER_CHANNEL_ID` — rare cosmetic alert channel
- `DISCORD_TRACKER_PLAYERS_CHANNEL_ID` — full-server room sync channel (default `1540889169642000505`)
- `TRACKER_FEED_ENABLED` — emergency kill switch (even beta cannot read Discord when false)

The bot that **posts** tracker embeds (e.g. app id `1552132434714169394`) can be different from the Engine bot used for OAuth / role checks (`1541246974404198470` / `DISCORD_BOT_TOKEN`). That is fine. Engine only **reads** both channels with `DISCORD_BOT_TOKEN`, so that Engine bot must be invited to the partner guild with View Channel + Read Message History on each channel. Rare embeds (`Username`, `ID`, `Room`, `Region`, `Color`/`Colour`, `Cosmetics`) become `track_kind=rare` pills. Room Sync Data embeds (`Directory`, `Region`, per-player Username/ID/Color/Platform/Cosmetics — British `Colour` and `Player ID` labels are accepted) are split into individual `track_kind=player` pills. Empty plain-text channel noise (no embeds) is ignored.

**If cards show No ID / no color swatch:** the partner bot must put those values in the embed text fields (or description lines like `ID: …` / `Color: 255 0 0`). Discord’s sidebar embed color alone is used only as a rare-embed fallback; Room Sync needs a per-player Color field. Engine’s `DISCORD_BOT_TOKEN` bot must still have View Channel + Read Message History on both tracker channels.

### Anti-scrape (better than a shared daily API key)

A shared rotating key is weak: one leak lets anyone scrape until midnight.
Instead the live feed uses **per-user, short-lived, day-bound session tokens**:

1. Beta client calls `POST /v1/tracker/session` (auth + beta role required).
2. Server mints a JWT (`aud=ii-tracker-feed`, TTL 1 hour, `day=YYYY-MM-DD`, unique `jti`).
3. Client sends it as `X-Tracker-Session` on `GET /v1/tracker/feed`.
4. Tokens stop working after UTC midnight even if TTL remains — client must mint a new one.
5. Stolen tokens only work for that user/day, expire in ≤1h, and hit tight rate limits.

Also:

- Feed responses omit Discord deep-links into the private channel
- `Cache-Control: no-store` on session + feed
- Cap of 25 items per poll
- `/v1/tracker/feed` and `/v1/tracker/session` have separate tight per-IP burst limits
- Channel IDs and the Discord bot token stay server-side only

Railway checklist:

1. Paywall role: `1549151900073459752`
2. Beta role: `1554650259152576513`
3. Partner guild / channels configured; **Engine bot must be in that guild** with **View Channel + Read Message History** on both `DISCORD_TRACKER_CHANNEL_ID` (rare, default `1552132392016420874`) and `DISCORD_TRACKER_PLAYERS_CHANNEL_ID` (room sync, default `1540889169642000505`) in guild `1538948955679752344`
4. `TRACKER_FEED_ENABLED=true` for live beta
5. Redeploy API after changing flags
6. CORS must allow the `X-Tracker-Session` request header (desktop feed calls)

If Engine shows a bot/channel reason (or staff `admin_hint.discord_http_status` 401/403/404): the API is fine — Discord denied the bot. Fix invites/permissions on the partner channels, then Refresh.

## Target Tracker — beta personal watchlist

Separate nav item under Tracker. **Beta tracker role / staff only** for the live board.

- Engine keeps a rolling **24h local sighting history** from the same dual-channel player feed.
- Search by **player ID**, **room code**, or **name**; results use the same Name / Room / ID cards as Player Tracker.
- Click a result (or Watch) to add them to a **personal watchlist** stored only in localStorage on that install.
- You can also **add a player ID that has never appeared** in the feed yet; they stay on the list offline and surface under Live when the tracker eventually spots that ID.
- The Online / Live section lists watched players **only while a fresh lobby sighting** is within ~12 minutes — offline targets remain on the watchlist.
- Not shared with other users or the API.

## Self Tracker / Engine players — same tab, secondary

Shared root (same as the Pro bridge):

```text
{Gorilla Tag}/iisStupidMenu/
```

| Path                      | Direction     | Role                                        |
| ------------------------- | ------------- | ------------------------------------------- |
| `ii-engine-tracker.json`  | Engine → Menu | `{ schema_version: 1, enabled }`            |
| `ii-engine-presence.json` | Menu → Engine | username / room_code / in_room / updated_at |

**Current ship state:** Coming soon. The Tracker tab shows the Self Tracker card as
Coming soon and does not poll presence APIs or show a live Engine player list.

When re-enabled later:

- Viewing the Engine player list was planned for Free + Pro.
- Sharing (writing the tracker flag / appearing on the list) is a Pro perk.
- Never put Engine Bearer tokens in `iisStupidMenu/`.
