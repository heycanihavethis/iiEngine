# ii Studio

ii Studio is the local C# workspace built into the Windows ii Engine app. Access remains limited to signed-in members with the Beta Engine User entitlement.

## First workflow

1. Open **ii Studio** and create a project.
2. Studio clones the approved stable `1.0.3` source snapshot into `Documents/ii Engine/Studio/Projects/<project>/source` and creates a separate `builds` folder and `project.json` file. The upstream repository is never edited.
3. Open C# files from the explorer. Monaco provides tabs, line numbers, C# highlighting, find/replace, and build markers. `Ctrl+S` saves all changed tabs.
4. **Build** runs the project's existing solution through `dotnet build`. Its post-build plugin destination is overridden to a project-owned compiler folder, so compiling cannot install into Gorilla Tag. Successful DLLs are validated as an ii menu plugin and copied into the project's `builds` folder.
5. **Install DLL** locates the selected Gorilla Tag installation, verifies the managed plugin GUID, backs up every detected ii menu DLL, installs through the Engine transaction system, and verifies the final checksum. A failed mutation triggers a verified restore; recovery data is retained in Engine Backups if Windows prevents the restore.
6. **BUILD & PLAY** saves, builds, installs, and then calls Engine's existing Steam launcher. It stops before launch when saving, compilation, validation, backup, or installation fails.
7. **LIVE CONSOLE** tails `BepInEx/LogOutput.log` in bounded chunks and provides All, Errors, Warnings, BepInEx, and ii filters.

## Required tools

The installed app bundles Monaco and does not need Node.js or Rust to edit projects. Building projects requires the .NET SDK. Creating the initial source copy requires Git for Windows. Studio checks both tools before enabling project creation. Node.js, pnpm, Rust, Cargo, Tauri, MSVC, and WebView2 remain requirements for contributors compiling ii Engine itself.

## Security boundary

The webview has no shell or filesystem permission. Its commands accept only project IDs, project-relative editable files, build filenames, and a Gorilla Tag directory that passes Engine validation. Git always clones the fixed official repository and stable ref. The build command always uses the project's own solution and redirects its plugin output into the project's builds area. Game mutations remain limited to detected ii menu DLLs under `BepInEx/plugins` and use the existing backup and recovery system.

The current upstream `main` branch was tested on September 15, 2026 and failed at `Managers/VoiceManager.cs:413` because `Sound.clientAudioLevel` does not exist. Stable tag `1.0.3` at commit `8fafa80654722268c56766bdb350e64ba7b223a9` built successfully, so it is the first Studio template.
