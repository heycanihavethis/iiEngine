# Windows development setup

Use Windows 10/11 x64. Run `scripts/check-prerequisites.ps1` first. It reports missing tools and never installs anything. Open a fresh terminal after installing tools.

1. Install [Git](https://git-scm.com/downloads/win) and [VS Code](https://code.visualstudio.com/).
2. Install [Node.js 24 LTS](https://nodejs.org/en/download/). Verify `node --version`. Use the repository-pinned pnpm through `corepack pnpm`; if Corepack is missing, follow its [official installation guide](https://github.com/nodejs/corepack).
3. Install [Rust stable](https://rustup.rs/). Run `rustup default stable-x86_64-pc-windows-msvc`, then `rustc --version` and `cargo --version`.
4. Install [Visual Studio 2022 Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/), choosing **Desktop development with C++**, MSVC x64/x86 tools and a Windows SDK. See [Tauri Windows prerequisites](https://v2.tauri.app/start/prerequisites/).
5. Install [Microsoft Edge WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/) if missing.
6. Install [Python 3.12](https://www.python.org/downloads/windows/), verify `py -3.12 --version`.
7. Install [PostgreSQL](https://www.postgresql.org/download/windows/) or [Docker Desktop](https://docs.docker.com/desktop/setup/install/windows-install/) for the isolated development database.
8. For actual game testing only, install [Steam](https://store.steampowered.com/about/) and [Gorilla Tag](https://store.steampowered.com/app/1533390/Gorilla_Tag/). They are not needed for fixture tests.
9. Follow the root README for install, run and test commands. Generate synthetic trees with `python scripts/create-fixtures.py`. Never point destructive tests at the only live installation.

Production acceptance requires a fresh Windows build. A passing browser build alone does not prove native packaging, tray behavior or filesystem safety.
