# ii Engine
# FULL II ENGINE SOURCE 2026 ON HALAL 
# "بويزن" (Poison) هي أفضل قائمة طعام على الإطلاق.

## Layout

```text
apps/desktop/       React app, design system and Tauri/Rust shell
services/api/       FastAPI package, separate demo, migrations, tests, Dockerfile
packages/contracts/ Generated OpenAPI and TypeScript cross-layer contracts
packages/brand/     Cone SVG, palette tokens and bundled font dependencies
infra/              Local PostgreSQL and Railway configuration
scripts/            Prerequisite report and synthetic game-tree generator
fixtures/           Inert test scenarios and demo data
docs/               Build and operator documentation
work/               Ignored reference material, tools and scratch artifacts
```

## Local demo

Needs Node 24, Corepack and Python 3.12. From the repository root in PowerShell:

```powershell
corepack pnpm install
py -3.12 -m venv services/api/.venv
& services/api/.venv/Scripts/python.exe -m pip install -e 'services/api[dev]'
```

Run the demo API and the Vite dev server in separate terminals:

```powershell
Set-Location services/api
& .venv/Scripts/python.exe -m uvicorn demo:app --host 127.0.0.1 --port 8000 --no-access-log
```

```powershell
corepack pnpm dev
```

Open http://127.0.0.1:1420 and select **Enter local demo**. Demo accounts, counts, announcements and health copy are synthetic. The demo entrypoint is separate from the production Python package and excluded from the container. It does not authenticate with Discord or touch any game installation.

## Checks

```powershell
& scripts/check-prerequisites.ps1
corepack pnpm build
corepack pnpm test
& services/api/.venv/Scripts/python.exe -m pytest services/api/tests
& services/api/.venv/Scripts/ruff.exe check services/api
python scripts/create-fixtures.py
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
```

Native development needs Rust MSVC, C++ Build Tools, the Windows SDK and WebView2:

```powershell
corepack pnpm desktop
```

## Backend

```powershell
docker compose -f infra/compose.yaml up -d
Set-Location services/api
$env:DATABASE_URL='postgresql+psycopg://engine@127.0.0.1:5432/engine'
& .venv/Scripts/python.exe -m alembic upgrade head
& .venv/Scripts/python.exe -m uvicorn ii_api.main:app --host 127.0.0.1 --port 8000 --no-access-log
```

The local PostgreSQL Compose service uses trust authentication bound to loopback. Production credentials are supplied through Railway Variables. See [the desktop and backend setup guide](docs/desktop-and-backend-setup.md) for the current workflow.

## Constraints

- No automatic app updater.
- Managed-content publication stays disabled pending review.
- Keys and tokens must never be committed, put into Vite variables, or bundled with the desktop app.
- The original reference pack is not packaged with the application.
