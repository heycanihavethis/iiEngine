# Engine ↔ ii Reborn Menu Pro bridge

Automatic handoff: when a signed-in Engine user has a discovered Gorilla Tag
install, the desktop mints a short-lived bridge ticket and writes it to:

```text
{Gorilla Tag}/iisStupidMenu/ii-engine-bridge.json
```

ii Reborn Menu reads that file and calls the Engine API to unlock Pro-only mods.

## File format (`schema_version: 1`)

```json
{
  "schema_version": 1,
  "api_base": "https://ii-engine-api-production.up.railway.app",
  "ticket": "<jwt>",
  "pro": true,
  "features": ["engine_pro_mods"],
  "issued_at": "2026-09-23T13:00:00+00:00",
  "expires_at": "2026-09-23T25:00:00+00:00"
}
```

- `"pro"` / `"features"` in the file are hints only. They must **not** unlock anything.
- Ticket TTL is 12 hours. Engine refreshes on Home load, entitlement change, and Launch.
- Sign-out / disconnect deletes the file.

## API

### `POST /v1/menu/bridge/ticket`

Desktop session only (`Authorization: Bearer` with `aud=ii-desktop`).

Returns the JSON object above (including `ticket` and `filename`).

### `GET /v1/menu/bridge/entitlements`

Menu only:

```http
Authorization: Bridge <ticket>
```

Returns the same fields **without** `ticket`. Re-checks Discord so revoked Pro
does not linger for the full TTL.

Do **not** send desktop Bearer tokens from the menu process.

## Known feature keys

| Feature | Meaning |
|---|---|
| `engine_pro_mods` | Show the Engine Pro category / gated buttons |

Loading-screen file contracts were dropped on the Engine side. Do not reintroduce
`loading_screen` unless both repos agree on a new design.

Self Tracker (opt-in presence) is documented in `docs/self-tracker.md`.

## Menu responsibilities

1. On Awake (and every ~10 minutes), read `iisStupidMenu/ii-engine-bridge.json`.
2. If missing or `expires_at` past → locked.
3. Otherwise `GET {api_base}/v1/menu/bridge/entitlements` with `Authorization: Bridge {ticket}`.
4. Unlock only from a successful live response with `"pro": true`.
5. On network / auth failure → stay locked (optional short in-memory grace after a prior live unlock).
6. For the first verification build: show one on-screen
   `NotificationManager` toast like `ii Engine Pro Verified` on locked→unlocked.
   Do not add Pro menu buttons yet.

## Security model

| Attack | Result |
|---|---|
| User edits the JSON to `"pro": true` | Fail closed unless they also have a valid signed ticket |
| Fake / empty ticket | API returns 401 → locked |
| Block network so the menu "falls back" | Must stay locked if the menu follows fail-closed rules |
| Patch the menu DLL to skip the check | Always possible (GPL client). Not DRM |

The ticket is an HS256 JWT minted by the Engine API with a server-only signing
key. Casual users cannot mint a valid ticket by writing a file. This stops
normal fakes; it does not stop a determined reverse engineer editing the DLL.
