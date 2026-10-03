# ii Engine — Known Issues & FAQ

Copy/paste friendly for Discord. Most fixes are: **close Gorilla Tag**, **use the Windows desktop app**, **re-sign in with Discord**, or **pause antivirus briefly**.

---

## Quick start

1. Use the **Windows ii Engine app** (browser demo cannot install, launch, or repair).
2. **Sign in with Discord** and stay in the official server (`discord.gg/iidk`).
3. Point Engine at your real Steam **Gorilla Tag** folder (`…/steamapps/common/Gorilla Tag`).
4. Fully **quit Gorilla Tag** before Update / Repair / Mod Library / Studio install / SoundLab.
5. If installs fail verification, briefly pause **Windows Real-time protection**, retry, then turn it back on.

---

## Auth / Discord

| What you see | What to do |
|---|---|
| Discord session expired / Sign in to continue | Sign in again from Home |
| Couldn't verify Discord / roles | Re-authorize Discord; join `discord.gg/iidk` |
| Join the official Discord server to continue | Join the server, then sign in again |
| Sign-in expired / Discord sign-in failed | Close the browser tab and start Discord sign-in again |
| Too many sign-in attempts | Wait a few minutes, then retry |
| Windows Credential Manager is unavailable | Use the desktop app as a normal Windows user; fix Credential Manager if broken |
| App access is restricted / launching locked | Your Discord roles don’t include Engine access — ask staff |

---

## Launch / game path

| What you see | What to do |
|---|---|
| Gorilla Tag was not found in any Steam library | Install GT via Steam, wait for libraries, restart Engine |
| Select a valid Gorilla Tag installation | Choose the folder that contains `Gorilla Tag.exe` |
| Close Gorilla Tag before… / already running | Fully quit the game, then retry |
| ii Menu is not installed yet | Click **Update ii Menu** (or Install) on Home first |
| Official menu metadata is unavailable | GitHub menu feed hiccup — retry later; if a menu DLL is already installed you can often still launch |
| Menu is marked offline | Staff set the feed offline — wait |
| Launch / Menu updates require the Windows desktop app | Use the packaged Windows app |

---

## Mod Library / AutoLoader / BepInEx

| What you see | What to do |
|---|---|
| Could not install / remove / import / change a mod | Close GT, confirm game path, retry |
| Trusted mod checksum did not match | Retry later or re-download |
| Choose a valid Windows mod DLL smaller than 25 MB | Use a real `.dll` under 25 MB |
| That installed mod was not found / already enabled | Refresh Mod Library and retry |
| Install community mods from the Windows desktop app | Desktop app required |
| Applying loadouts requires the Windows desktop app | Pro loadouts only work in the desktop app |

---

## The Kraken

| What you see | What to do |
|---|---|
| Could not create a safety backup before The Kraken | Free disk space, close GT, briefly exclude plugins from AV |
| Kraken wait/launch was cancelled | Safe to retry |
| The Kraken session ended. Extra mods were removed | Expected cleanup after GT closes |

---

## Catalog / AI

| What you see | What to do |
|---|---|
| Engine could not find `/v1/ai/menu-catalog` | Live API was on an older build — update Engine; Catalog also ships a bundled offline catalog as fallback |
| Could not load the menu catalog | Check network; retry |
| Engine Pro is required to use Catalog Ask AI | Pro perk — upgrade on Plans |
| Daily allowance is in use or exhausted | Daily AI quota — try again after reset |
| Private AI / Assistant temporarily unavailable | Backend AI down — retry later (often not charged) |
| Could not explain this mod | Need Pro + retry |

---

## Health & Repair

| What you see | What to do |
|---|---|
| Health checks require the Windows desktop app | Use the Windows app |
| No published menu release is available | Wait for staff / GitHub menu pin |
| Latest verified menu did not pass installation verification | Usually antivirus lock — pause Real-time protection, Repair again |
| Type `RESET GORILLA TAG` to confirm | Type that exact phrase for clean reinstall |
| Steam did not finish within 30 minutes | Let Steam finish, then Repair again |
| Scan feels instant | After Scan for Issues, Engine shows a **Scan complete** summary with issue count (and System Check rows) |

---

## Antivirus

| What you see | What to do |
|---|---|
| Antivirus is locking … for verification | Windows Security → Virus & threat protection → Manage settings → turn **Real-time protection** off briefly → Install/Repair → turn it back on |
| Cannot read file for verification | Same as above; also close GT |
| Opened Virus & threat protection… | Follow Manage settings in the window Engine opened |

---

## Studio

| What you see | What to do |
|---|---|
| Importing from GitHub/ZIP / separate window needs Pro | Upgrade to Engine Pro |
| .NET SDK is required to build | Install .NET 8 SDK, then Refresh |
| Git is required | Install Git, then Refresh |
| Close Gorilla Tag before installing a Studio build | Quit GT first |
| Compiled DLL does not contain exactly one ii menu plugin | Project must build one ii menu plugin |
| Engine AI unavailable. Used local… | Optional AI fallback — local tips still work |
| Save this file before closing its tab | Save first |

---

## Community / chat

| What you see | What to do |
|---|---|
| Chat is temporarily unavailable | Retry; check connection |
| Engine Pro required to post / use `/ai` / #pro-lounge | Need Pro |
| Only Engine developers and admins can post here | Staff-only channel |
| Message blocked by automod | Soften language and resend |
| Wait a moment before sending another message | Rate limit — wait a few seconds |
| Could not send / delete / pin | Retry; pins need mod/admin |
| Announcements live in Community | There is no separate Announcements tab — use Community → announcements channels |

---

## Network / API / updates

| What you see | What to do |
|---|---|
| ii Engine can't reach the network / Can't connect | Check internet/firewall; Try again; re-authorize Discord |
| Engine could not find `/v1/…` | App newer than live API for that path — update app or wait for backend redeploy |
| Published manifest expired / channel entitlement required | Re-auth Discord; wait for staff publish |
| This release requires a newer ii Engine | Update the desktop app |
| Downloaded menu failed SHA-256 verification | Retry; pin may be mid-publish |

---

## Pro / Plans / invites / Customize

| What you see | What to do |
|---|---|
| Could not link Roblox / claim Pro | Use exact Roblox username from your profile URL; buy the catalog item first |
| That Roblox account does not own the Pro catalog item | Purchase first, then Claim |
| Already linked / already claimed | One claim per Roblox account — contact staff if stuck |
| Engine Pro required to share/import Customize presets | Pro perk |
| Invite invalid / own invite / already redeemed / finished | Check code; finish Discord auth in Engine first |

---

## Misc

| What you see | What to do |
|---|---|
| Customize icon errors | PNG/JPG/WebP under 4 MB |
| SoundLab upload failed / too large | Desktop + GT path; MP3/MP4 under 40 MB; close GT first |
| Page failed to load. Refresh the page | Soft-reload the app window |
| Cone role / The cone fell over… | Easter egg — Discord role grant may fail if Discord API is down; retry later |

---

## Still stuck?

1. Note the **exact error text**.
2. Say whether GT was closed, and whether you paused antivirus.
3. Ask in Discord with that info (and your Engine version if you know it).
