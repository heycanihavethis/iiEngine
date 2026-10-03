# Paste into the iireborn/menu Cursor agent chat

Do **not** invent alternate paths or auth. Match the Engine bridge contract on
`iireborn/iiEngine` (`docs/menu-engine-bridge.md`).

## Task

**Remove Pro loading-screen scaffolding** from the menu. Engine dropped that
feature — no Customize gallery, no `Engine/loading-screen.json`, no
`Engine/LoadingScreen.png`, and no `loading_screen` bridge feature key.

Keep the **Engine Pro bridge verification** path (read `ii-engine-bridge.json`,
live `Authorization: Bridge <ticket>` check, fail closed, one
`ii Engine Pro Verified` toast). Keep **Self Tracker** consumer code if you
already have it (`ii-engine-tracker.json` / `ii-engine-presence.json`).

## Remove / stop doing

1. Any reader, manager, UI, or splash that uses:
   - `iisStupidMenu/Engine/loading-screen.json`
   - `iisStupidMenu/Engine/LoadingScreen.png`
   - `iisStupidMenu/Engine/LoadingScreens/`
2. Any unlock / branch on bridge feature key `"loading_screen"`.
3. Mentions of loading-screen Pro perk in menu copy, tooltips, or comments you
   added for this feature.
4. Do **not** leave dead stubs that still poll those files.

## Keep

1. `EngineProManager` (or equivalent) bridge verify → `HasEnginePro` / `HasFeature`.
2. Known bridge features for now: `engine_pro_mods` only (Pro may still be true
   with an empty or single-feature list — unlock from live `"pro": true`).
3. Fail-closed rules unchanged: never unlock from the file alone; never send
   desktop Bearer tokens from the menu.
4. Self Tracker publish path if already implemented:
   - Read `ii-engine-tracker.json` (`schema_version: 1`, `enabled`)
   - When enabled, periodically write `ii-engine-presence.json`
   - When disabled / missing, stop writing (and do not invent new filenames)

## Acceptance

- [ ] No code path reads or writes loading-screen files under `Engine/`.
- [ ] No reference to feature key `loading_screen`.
- [ ] Bridge Pro verify still works (toast on locked→unlocked).
- [ ] Diff is small and matches existing menu style (minimal comments).

## Out of scope

- Do not change Engine from this chat.
- Do not add Engine Pro menu categories/buttons unless already requested
  elsewhere.
- Do not reintroduce loading screens.
