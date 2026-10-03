# Synthetic fixtures

`demo/dashboard.json` is deliberately synthetic and only loaded by the separate `demo.py` entrypoint. Never substitute it into production endpoints.

Run `python scripts/create-fixtures.py` to create disposable game directory layouts under `work/fixtures`. The `.exe` and `.dll` files are inert text. They must fail PE/.NET verification and must never be used as a trusted release or approved loader baseline. Real managed-metadata/signature tests will use dedicated generated test assemblies and ephemeral signing keys.
