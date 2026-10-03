# Paste this entire message into a Cursor cloud agent chat that has the
# `iireborn/menu` repository open. Do not invent a different protocol.

## Task

Implement the **ii Engine Pro bridge** verification path only. For now, do **not**
add any Engine Pro menu category or buttons. When Pro verifies live, show a short
on-screen GUI notification so it is obvious the bridge works.

The Engine side is already implemented in `iireborn/iiEngine`
(see `docs/menu-engine-bridge.md` on that repo).

Do **not** change the Engine repo from this chat. Only change this menu repo.

## Code style (mandatory)

Match existing ii Reborn Menu code so the diff does **not** look AI-generated:

- Do **not** add comments unless they are genuinely required for a non-obvious
  invariant (prefer zero new comments).
- Do **not** add docblocks, region banners, "NOTE:", "IMPORTANT:", emoji, or
  tutorial-style explanations.
- Do **not** rename unrelated symbols, reformat unrelated files, or "clean up"
  surrounding code.
- Mirror naming, bracing, null handling, logging, and notification patterns
  already used in `ServerData`, `ExternalModsManager`, `PluginManager`, and
  `NotificationManager`.
- Keep GPL file headers only because neighboring files already have them — copy
  that header style exactly, nothing fancier.
- Prefer small, boring diffs. No speculative abstractions.

## How it works (already automatic on Engine)

1. User signs into ii Engine with Discord.
2. If they have the Engine Pro Discord role, entitlement `"pro"` is set.
3. Engine writes this file into the Gorilla Tag install:

```text
{Gorilla Tag root}/iisStupidMenu/ii-engine-bridge.json
```

That is the same folder as `PluginInfo.BaseDirectory` (`iisStupidMenu`).

4. Your job: read that file, verify live Pro status with the Engine API, and
   when verified show a short on-screen message.

## Exact file format (schema_version 1)

```json
{
  "schema_version": 1,
  "api_base": "https://ii-engine-api-production.up.railway.app",
  "ticket": "<jwt string>",
  "pro": true,
  "features": ["engine_pro_mods"],
  "issued_at": "2026-09-23T13:00:00+00:00",
  "expires_at": "2026-09-23T25:00:00+00:00"
}
```

- Path: `$"{PluginInfo.BaseDirectory}/ii-engine-bridge.json"` (same style as
  `ServerData` / preferences).

## Exact API contract

### Live check (required to unlock)

```http
GET {api_base}/v1/menu/bridge/entitlements
Authorization: Bridge {ticket}
```

Success JSON (no `ticket` field):

```json
{
  "schema_version": 1,
  "api_base": "https://ii-engine-api-production.up.railway.app",
  "filename": "ii-engine-bridge.json",
  "pro": true,
  "features": ["engine_pro_mods"],
  "issued_at": "...",
  "expires_at": "..."
}
```

### Rules (fail closed)

- NEVER send Engine desktop Bearer tokens from the menu.
- Header must be exactly `Authorization: Bridge <ticket>` (not Bearer).
- If the file is missing → Pro locked.
- If `schema_version != 1` → Pro locked.
- If `expires_at` is in the past → Pro locked (do not call API).
- **Never unlock from the file alone.** The file's `"pro": true` is not trust.
  Only a successful live response with `"pro": true` may set `HasEnginePro`.
- On network failure, HTTP error, or invalid ticket → keep Pro **locked**
  (or clear it if it was previously unlocked). Do **not** soft-fallback to the
  cached file `pro` flag — that would let anyone forge the JSON.
- Optionally keep a short in-memory grace (e.g. last successful live unlock
  remains valid for up to 15 minutes) so a brief blip mid-session does not
  flap status. Grace must start only after a successful live unlock.
- Poll once on Awake (after a short delay like ServerData, ~5–10s) and again
  every 10 minutes while the game is open.
- Use `UnityWebRequest` like `ServerData` / `ExternalModsManager`.
- Pin `api_base` host to `ii-engine-api-production.up.railway.app` (or
  `127.0.0.1` / `localhost` only if you already have a local-dev pattern).
  Reject other hosts from the file.

## What to implement in this repo

1. **New file** `Managers/EngineProManager.cs` (static or MonoBehaviour — match
   existing manager style; `ServerData` / `ExternalModsManager` are the models).

   Public API:

   ```csharp
   public static bool HasEnginePro { get; private set; }
   public static bool HasFeature(string feature);
   public static IReadOnlyList<string> Features { get; }
   ```

2. **Register it** from `Plugin.cs` the same way other managers are added.

3. **Verification UI only (no Buttons.cs / category work for now)**
   - Do **not** add an Engine Pro category, buttons, placeholders, or tooltips
     in `Buttons.cs` / `Menu/Buttons.cs`.
   - When a live check first succeeds with `pro: true`, show one short
     on-screen notification via `NotificationManager.SendNotification`, matching
     existing rich-text style, for example:

     ```text
     <color=grey>[</color><color=green>ENGINE</color><color=grey>]</color> ii Engine Pro Verified
     ```

   - Show that verified notification **once per successful unlock transition**
     (locked → unlocked), not on every 10-minute refresh while already unlocked.
   - Do **not** spam notifications on failures. Optional: a single quiet log via
     `LogManager` on auth/network failure is fine; no error toast required.

4. Do not hardcode Discord role IDs. Trust the bridge only.
5. Do not invent alternate file names, endpoints, or auth schemes.
6. Keep GPL headers consistent with neighboring files.

## Acceptance checklist

- [ ] With no bridge file → locked, no verified message.
- [ ] With forged file `"pro": true` + fake ticket → stays locked (API rejects).
- [ ] With forged file + blocked network → stays locked (no soft-fallback unlock).
- [ ] With a valid Pro bridge file + API reachable → `HasEnginePro == true` and
      one on-screen **"ii Engine Pro Verified"** notification appears.
- [ ] With a free (`pro:false`) bridge file → locked, no verified message.
- [ ] Expired `expires_at` → locked.
- [ ] Menu never uses Bearer for this flow.
- [ ] No new Engine Pro buttons/categories were added.
- [ ] Diff looks like normal menu code (minimal comments, no AI polish).

## Out of scope

- Do not implement payments, Discord OAuth, or talking to `gtag.useless.best`
  for this feature.
- Do not modify ii Engine from this chat.
- Do not store Engine refresh tokens in `iisStupidMenu/`.
- Do not add Pro-gated mods or Buttons.cs entries yet — verification toast only.
- Do not claim this is DRM. Client gates stop casual abuse only; a patched DLL
  can always skip checks. That is acceptable for this product.

## Reference (Engine repo, read-only)

- Contract doc: `docs/menu-engine-bridge.md`
- API: `services/api/ii_api/menu_bridge.py`
- Desktop writer: `apps/desktop/src-tauri/src/menu_bridge.rs`
- Desktop sync: `apps/desktop/src/menuBridge.ts`

Implement, compile if possible, and summarize exactly which files you changed.
