"""Export schemas without database/provider startup or loading a private .env file."""
import json
from pathlib import Path

from ii_api.config import Settings
from ii_api.application import create_app

root = Path(__file__).resolve().parents[1]
schema = create_app(Settings(_env_file=None, app_env="test")).openapi()
(root / "packages/contracts/openapi.json").write_text(
    json.dumps(schema, indent=2, sort_keys=True) + "\n", encoding="utf-8"
)
print("OpenAPI exported without starting external providers.")
