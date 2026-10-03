"""Fetch GitHub latest menu metadata, verify digest, and sign a stable manifest."""

import base64
import hashlib
import json
import os
import re
import sys
import time
import urllib.request
from datetime import UTC, datetime, timedelta
from pathlib import Path
from urllib.parse import urlparse

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

GITHUB_API = "https://api.github.com/repos/iireborn/menu/releases/latest"
LATEST_DOWNLOAD = "https://github.com/iireborn/menu/releases/latest/download/ii.Reborn.dll"
REPOSITORY_PREFIXES = (
    "/iireborn/menu/",
    "/iireborn/ii.stupid.menu/",
    "/iireborn/iis.Stupid.Menu/",
)
APPROVED_ASSET_NAMES = {"ii.Reborn.dll"}
CANONICAL_FILENAME = "ii.Reborn.dll"


def request_json(url: str):
    last_error = None
    for attempt in range(5):
        request = urllib.request.Request(
            url,
            headers={
                "User-Agent": "ii-Engine-Manifest/1",
                "Accept": "application/vnd.github+json",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                if (
                    response.status != 200
                    or int(response.headers.get("Content-Length", "0") or 0) > 2_000_000
                ):
                    raise ValueError("Release service returned an invalid response")
                return json.load(response)
        except (OSError, ValueError) as error:
            last_error = error
            if attempt < 4:
                time.sleep(2**attempt)
    raise ValueError("Release service remained unavailable after five attempts") from last_error


def official_url(value: str, *, download: bool) -> str:
    parsed = urlparse(value)
    if (
        parsed.scheme != "https"
        or parsed.hostname != "github.com"
        or parsed.port not in (None, 443)
        or parsed.username
        or parsed.password
        or parsed.fragment
    ):
        raise ValueError("Release URL is outside the official repository")
    path = parsed.path
    if download:
        ok = any(
            path.startswith(prefix + "releases/download/")
            or path.startswith(prefix + "releases/latest/download/")
            for prefix in REPOSITORY_PREFIXES
        )
    else:
        ok = any(path.startswith(prefix + "releases/") for prefix in REPOSITORY_PREFIXES)
    if not ok:
        raise ValueError("Release URL is outside the official repository")
    return value


def parse_digest(value: str) -> str:
    match = re.fullmatch(r"sha256:([0-9a-fA-F]{64})", (value or "").strip())
    if not match:
        raise ValueError("GitHub asset digest is missing or invalid")
    return match.group(1).lower()


def main() -> None:
    output = Path(sys.argv[1] if len(sys.argv) > 1 else "signed-stable-manifest.json")
    github = request_json(GITHUB_API)
    version = github["tag_name"].removeprefix("v")
    assets = [
        asset for asset in github["assets"] if asset.get("name") in APPROVED_ASSET_NAMES
    ]
    if (
        not re.fullmatch(r"\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?", version)
        or len(assets) != 1
        or github.get("draft")
        or github.get("prerelease")
    ):
        raise ValueError("Official menu release is ambiguous or unpublished")
    digest = parse_digest(assets[0].get("digest", ""))
    download_url = official_url(LATEST_DOWNLOAD, download=True)
    release_url = official_url(github["html_url"], download=False)
    request = urllib.request.Request(
        download_url, headers={"User-Agent": "ii-Engine-Manifest/1"}
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        artifact = response.read(100_000_001)
    if not 1024 <= len(artifact) <= 100_000_000 or len(artifact) != assets[0]["size"]:
        raise ValueError("Menu artifact has an invalid size")
    if hashlib.sha256(artifact).hexdigest() != digest:
        raise ValueError("Menu artifact does not match the published SHA-256")
    published = datetime.fromisoformat(github["published_at"].replace("Z", "+00:00"))
    manifest = {
        "schema_version": 1,
        "channel": "stable",
        "menu_version": version,
        "published_at": published.astimezone(UTC).isoformat().replace("+00:00", "Z"),
        "expires_at": (datetime.now(UTC) + timedelta(days=30))
        .isoformat()
        .replace("+00:00", "Z"),
        "minimum_engine_version": "0.1.0",
        "download_url": download_url,
        "release_url": release_url,
        "canonical_filename": CANONICAL_FILENAME,
        "sha256": digest,
        "byte_size": len(artifact),
        "baseline_id": "bepinex-5.4.23.5-win-x64",
        "compatibility_catalog_version": "1",
    }
    private = base64.b64decode(
        os.environ["II_ENGINE_MANIFEST_PRIVATE_KEY"], validate=True
    )
    if len(private) != 32:
        raise ValueError("Signing secret has an invalid size")
    signing_bytes = json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode()
    manifest["signature"] = base64.b64encode(
        Ed25519PrivateKey.from_private_bytes(private).sign(signing_bytes)
    ).decode()
    output.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"Signed stable menu {version}: {digest[:12]}… ({len(artifact)} bytes)")


if __name__ == "__main__":
    main()
