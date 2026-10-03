"""Validate maintainer-signed release manifests without fetching or executing artifacts."""

import base64
import json
import re
from datetime import UTC, datetime
from urllib.parse import urlsplit

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from sqlalchemy import select

from .models import ManagedContent

FIELDS = {
    "schema_version",
    "channel",
    "menu_version",
    "published_at",
    "expires_at",
    "minimum_engine_version",
    "download_url",
    "release_url",
    "canonical_filename",
    "sha256",
    "byte_size",
    "baseline_id",
    "compatibility_catalog_version",
    "signature",
}


def verify_manifest(raw, public_key, channel):
    try:
        value = json.loads(raw)
        if not isinstance(value, dict) or set(value) != FIELDS:
            raise ValueError()
        signature = base64.b64decode(value["signature"], validate=True)
        unsigned = {key: item for key, item in value.items() if key != "signature"}
        canonical = json.dumps(
            unsigned, sort_keys=True, separators=(",", ":"), ensure_ascii=False
        ).encode()
        Ed25519PublicKey.from_public_bytes(base64.b64decode(public_key, validate=True)).verify(
            signature, canonical
        )
        now = datetime.now(UTC)
        published, expires = (
            datetime.fromisoformat(value["published_at"]),
            datetime.fromisoformat(value["expires_at"]),
        )
        if not published.tzinfo or not expires.tzinfo or not published <= now < expires:
            raise ValueError()
        if value["schema_version"] != 1 or value["channel"] != channel:
            raise ValueError()
        if value["canonical_filename"] not in (
            "ii.Reborn.dll",
            "ii.s.Stupid.Menu.dll",  # legacy signed manifests
        ) or value["baseline_id"] not in (
            "bepinex-5.4.23.5-win-x64",
            "bepinex-5.4.23.4-win-x64",  # legacy signed manifests
        ):
            raise ValueError()
        if type(value["byte_size"]) is not int or not 1024 <= value["byte_size"] <= 100_000_000:
            raise ValueError()
        if not re.fullmatch(r"[a-f0-9]{64}", value["sha256"]):
            raise ValueError()
        for key in ("menu_version", "minimum_engine_version"):
            if not re.fullmatch(r"\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?", value[key]):
                raise ValueError()
        for key, prefixes in (
            (
                "download_url",
                (
                    "/iireborn/menu/releases/latest/download/",
                    "/iireborn/menu/releases/download/",
                    "/iireborn/ii.stupid.menu/releases/download/",
                    "/iireborn/iis.Stupid.Menu/releases/download/",
                ),
            ),
            (
                "release_url",
                (
                    "/iireborn/menu/releases/",
                    "/iireborn/ii.stupid.menu/releases/",
                    "/iireborn/iis.Stupid.Menu/releases/",
                ),
            ),
        ):
            url = urlsplit(value[key])
            if (
                url.scheme != "https"
                or url.hostname != "github.com"
                or url.username
                or url.password
                or url.port
                or url.fragment
                or not any(url.path.startswith(prefix) for prefix in prefixes)
            ):
                raise ValueError()
        return value
    except (ValueError, TypeError, KeyError, InvalidSignature):
        raise ValueError(
            "Manifest signature, identity, URL or validity period is invalid"
        ) from None


def active_manifest(db, public_key, channel):
    rows = db.scalars(
        select(ManagedContent)
        .where(ManagedContent.kind == "release", ManagedContent.published_at.is_not(None))
        .order_by(ManagedContent.published_at.desc())
    )
    for row in rows:
        payload = row.published_payload or {}
        if payload.get("channel") == channel and payload.get("manifest"):
            return verify_manifest(payload["manifest"], public_key, channel)
    return None


def release_view(manifest):
    return {
        **manifest,
        "version": manifest["menu_version"],
        "signature": "Signed manifest available",
    }
