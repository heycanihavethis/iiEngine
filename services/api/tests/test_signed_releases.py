import base64
import json
from datetime import UTC, datetime, timedelta

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from ii_api.signed_releases import verify_manifest


def test_signed_manifest_identity_tamper_expiry_and_channel():
    key = Ed25519PrivateKey.generate()
    public = base64.b64encode(key.public_key().public_bytes_raw()).decode()
    now = datetime.now(UTC)
    value = {
        "schema_version": 1,
        "channel": "stable",
        "menu_version": "1.0.3",
        "published_at": (now - timedelta(minutes=1)).isoformat(),
        "expires_at": (now + timedelta(days=1)).isoformat(),
        "minimum_engine_version": "0.1.0",
        "download_url": "https://github.com/iireborn/iis.Stupid.Menu/releases/download/v1.0.3/iis_Stupid_Menu.dll",
        "release_url": "https://github.com/iireborn/iis.Stupid.Menu/releases/tag/v1.0.3",
        "canonical_filename": "ii.s.Stupid.Menu.dll",
        "sha256": "a" * 64,
        "byte_size": 2048,
        "baseline_id": "bepinex-5.4.23.5-win-x64",
        "compatibility_catalog_version": "1",
    }

    def sign(body):
        signature = key.sign(json.dumps(body, sort_keys=True, separators=(",", ":")).encode())
        return json.dumps({**body, "signature": base64.b64encode(signature).decode()})

    valid = sign(value)
    assert verify_manifest(valid, public, "stable")["menu_version"] == "1.0.3"
    for raw, channel in [
        (valid.replace("1.0.3", "9.0.0"), "stable"),
        (valid, "beta"),
        (sign({**value, "expires_at": (now - timedelta(seconds=1)).isoformat()}), "stable"),
        (sign({**value, "download_url": "https://evil.invalid/menu.dll"}), "stable"),
        (sign({**value, "baseline_id": "bepinex-6"}), "stable"),
    ]:
        with pytest.raises(ValueError):
            verify_manifest(raw, public, channel)
