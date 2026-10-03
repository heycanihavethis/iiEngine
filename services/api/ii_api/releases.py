import re
import threading
import time
from datetime import UTC, datetime
from urllib.parse import urlparse

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from .auth import current_user, database, member_view, require_member
from .discord import ProviderUnavailable
from .models import User
from .schemas import DashboardView, ReleaseView
from .signed_releases import active_manifest, release_view

router = APIRouter(prefix="/v1")

# Official menu is never stored by ii Engine — metadata from GitHub; DLL from Releases.
MENU_REPOSITORY = "iireborn/menu"
REPOSITORY_PATHS = (
    f"/{MENU_REPOSITORY}/",
    # Legacy repos remain accepted for older signed manifests only.
    "/iireborn/ii.stupid.menu/",
    "/iireborn/iis.Stupid.Menu/",
)
MENUVERSION_URL = (
    f"https://github.com/{MENU_REPOSITORY}/raw/refs/heads/main/menuversion.json"
)
MENUSTATUS_URL = (
    f"https://github.com/{MENU_REPOSITORY}/raw/refs/heads/main/menustatus.json"
)
GITHUB_LATEST = f"https://api.github.com/repos/{MENU_REPOSITORY}/releases/latest"
LATEST_DOWNLOAD_URL = (
    f"https://github.com/{MENU_REPOSITORY}/releases/latest/download/ii.Reborn.dll"
)
APPROVED_ASSET_NAMES = {"ii.Reborn.dll"}
CANONICAL_FILENAME = "ii.Reborn.dll"
# Keep a short TTL so launch/health feel fresh without burning GitHub's rate limit.
CACHE_SECONDS = 30


def official_url(value, *, download=False):
    if not isinstance(value, str) or len(value) > 2048:
        raise ValueError("Invalid URL")
    parsed = urlparse(value)
    if (
        parsed.scheme != "https"
        or parsed.hostname != "github.com"
        or parsed.username
        or parsed.password
        or parsed.port not in (None, 443)
    ):
        raise ValueError("Release URL is not from the official repository")
    path = parsed.path.rstrip("/") or "/"
    if download:
        allowed = any(
            path.startswith(prefix + "releases/download/")
            or path.startswith(prefix + "releases/latest/download/")
            for prefix in REPOSITORY_PATHS
        )
    else:
        # Accept /owner/repo/releases and /owner/repo/releases/tag/...
        allowed = any(
            path == prefix.rstrip("/") + "/releases" or path.startswith(prefix + "releases/")
            for prefix in REPOSITORY_PATHS
        )
    if not allowed:
        raise ValueError("Release URL is not from the official repository")
    return value


def parse_sha256(value):
    if not isinstance(value, str):
        raise ValueError("Missing SHA-256")
    stripped = value.strip()
    match = re.fullmatch(r"(?:sha256:)?([0-9a-fA-F]{64})", stripped)
    if not match:
        raise ValueError("Invalid SHA-256")
    return match.group(1).lower()


def parse_github_digest(value):
    return parse_sha256(value)


class Releases:
    """Live menu metadata. Prefer menuversion.json; always install from latest/download."""

    def __init__(self, transport=None):
        self.client = httpx.Client(
            timeout=10,
            follow_redirects=True,
            transport=transport,
            headers={"User-Agent": "ii-Engine/0.2.2", "Accept": "application/json"},
        )
        self.cached = None
        self.expires = 0
        self.retry_after = 0
        self.lock = threading.Lock()

    def close(self):
        self.client.close()

    def _from_menustatus(self) -> bool:
        """True when GitHub says the menu is online. Missing/invalid file fails open."""
        try:
            response = self.client.get(MENUSTATUS_URL)
            if response.status_code >= 400:
                return True
            payload = response.json()
            value = payload.get("menustatus", payload.get("status", True))
            if isinstance(value, bool):
                return value
            if isinstance(value, str):
                return value.strip().casefold() not in {"false", "offline", "0", "no"}
            return True
        except (httpx.HTTPError, ValueError, TypeError, AttributeError):
            return True

    def _from_menuversion(self):
        response = self.client.get(MENUVERSION_URL)
        response.raise_for_status()
        payload = response.json()
        version = payload["version"]
        if not isinstance(version, str) or not re.fullmatch(
            r"\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?", version
        ):
            raise ValueError("Invalid version")
        sha256 = parse_sha256(payload["sha256"])
        # Prefer the tagged downloadUrl from menuversion — sha256 and bytes stay atomic.
        # /releases/latest/download/ is only a fallback when downloadUrl is missing.
        tagged = payload.get("downloadUrl")
        if tagged:
            download = official_url(tagged, download=True)
        else:
            download = official_url(LATEST_DOWNLOAD_URL, download=True)
        release = official_url(
            payload.get("releaseUrl") or f"https://github.com/{MENU_REPOSITORY}/releases"
        )
        return {
            "version": version,
            "sha256": sha256,
            "download_url": download,
            "release_url": release,
            "signature": "menuversion.json",
        }

    def status(self) -> dict:
        """Live GitHub menustatus for Home/operations (independent of install metadata)."""
        online = self._from_menustatus()
        if online:
            return {
                "status": "operational",
                "message": "Menu is online per GitHub menustatus.json.",
                "online": True,
            }
        return {
            "status": "offline",
            "message": "Menu is marked offline in GitHub menustatus.json.",
            "online": False,
        }

    def get(self):
        with self.lock:
            if self.cached and self.expires > time.monotonic():
                return dict(self.cached)
            try:
                if not self._from_menustatus():
                    raise ProviderUnavailable("Menu is marked offline in menustatus.json")
                base = self._from_menuversion()
                try:
                    base = self._enrich_from_github_api(base)
                except (httpx.HTTPError, KeyError, ValueError, TypeError, AttributeError):
                    # menuversion alone is enough; size can come from HEAD.
                    pass
                if "byte_size" not in base:
                    size = self._byte_size_via_head(base["download_url"])
                    if size is None:
                        # Rust verifies SHA-256; size is informational for the catalog UI.
                        size = 0
                    base["byte_size"] = size
                if "published_at" not in base:
                    base["published_at"] = datetime.now(UTC).isoformat()
                self.cached = {
                    "version": base["version"],
                    "channel": "stable",
                    "signature": base["signature"],
                    "published_at": base["published_at"],
                    "sha256": base["sha256"],
                    "byte_size": base["byte_size"],
                    "download_url": base["download_url"],
                    "release_url": base["release_url"],
                    "canonical_filename": CANONICAL_FILENAME,
                    "baseline_id": "bepinex-5.4.23.5-win-x64",
                }
                self.expires = time.monotonic() + CACHE_SECONDS
                return dict(self.cached)
            except ProviderUnavailable:
                raise
            except (httpx.HTTPError, KeyError, ValueError, TypeError, AttributeError):
                raise ProviderUnavailable("Release metadata could not be verified") from None

    def _enrich_from_github_api(self, base: dict):
        """Fill size / published_at when the Releases API is available."""
        if self.retry_after > time.time():
            return base
        github = self.client.get(
            GITHUB_LATEST,
            headers={"Accept": "application/vnd.github+json"},
        )
        if github.status_code in (403, 429):
            self.retry_after = max(
                time.time() + 60, float(github.headers.get("X-RateLimit-Reset", "0") or 0)
            )
            return base
        github.raise_for_status()
        latest = github.json()
        if latest.get("draft") or latest.get("prerelease"):
            return base
        assets = [
            asset
            for asset in latest.get("assets", [])
            if isinstance(asset, dict) and asset.get("name") in APPROVED_ASSET_NAMES
        ]
        if len(assets) != 1:
            return base
        asset = assets[0]
        size = asset.get("size")
        if isinstance(size, bool) or not isinstance(size, int) or not 1024 <= size <= 100_000_000:
            return base
        digest = asset.get("digest")
        if digest:
            api_sha = parse_github_digest(digest)
            if api_sha != base["sha256"]:
                # menuversion.json is source of truth for hash when they disagree.
                pass
        published = latest.get("published_at")
        if isinstance(published, str):
            parsed = datetime.fromisoformat(published.replace("Z", "+00:00"))
            if parsed.tzinfo is not None:
                base["published_at"] = parsed.astimezone(UTC).isoformat()
        base["byte_size"] = size
        tag = latest.get("tag_name")
        if isinstance(tag, str):
            html = latest.get("html_url")
            if isinstance(html, str):
                try:
                    base["release_url"] = official_url(html)
                except ValueError:
                    pass
        return base

    def _byte_size_via_head(self, download_url: str) -> int | None:
        try:
            head = self.client.head(download_url)
            if head.status_code >= 400:
                return None
            length = head.headers.get("Content-Length")
            if not length:
                return None
            size = int(length)
            if 1024 <= size <= 100_000_000:
                return size
        except (httpx.HTTPError, ValueError, TypeError):
            return None
        return None


def live_stable_release(request: Request):
    """Prefer live GitHub/menuversion metadata for stable installs."""
    return request.app.state.releases.get()


@router.get("/releases/{channel}", response_model=ReleaseView)
def release(
    channel: str,
    request: Request,
    user: User = Depends(require_member),
    db: Session = Depends(database),
):
    if channel not in ("stable", "beta", "developer"):
        raise HTTPException(404, "Unknown release channel")
    if channel != "stable" and not set(request.state.member["entitlements"]) & {
        "developer",
        "admin",
        "owner",
    }:
        raise HTTPException(403, "Release channel entitlement required")
    if channel == "stable":
        try:
            return live_stable_release(request)
        except ProviderUnavailable:
            try:
                manifest = active_manifest(
                    db, request.app.state.settings.manifest_public_key, channel
                )
                if manifest:
                    return release_view(manifest)
            except ValueError:
                raise HTTPException(503, "Published manifest is expired or invalid") from None
            raise HTTPException(503, "Release metadata is temporarily unavailable") from None
    try:
        manifest = active_manifest(db, request.app.state.settings.manifest_public_key, channel)
        if manifest:
            return release_view(manifest)
    except ValueError:
        raise HTTPException(503, "Published manifest is expired or invalid") from None
    raise HTTPException(503, "Signed channel publisher is not configured")


@router.get("/dashboard", response_model=DashboardView)
def dashboard(
    request: Request, user: User = Depends(current_user), db: Session = Depends(database)
):
    member = member_view(request, user, db)
    result = {
        "demo": False,
        "member": member,
        "release": {
            "version": "Unavailable",
            "channel": "stable",
            "signature": "Unavailable",
            "published_at": None,
        },
        "announcements": [],
        "announcements_stale": False,
    }
    if not member["membership"]:
        return result
    try:
        result["release"] = live_stable_release(request)
    except ProviderUnavailable:
        try:
            manifest = active_manifest(db, request.app.state.settings.manifest_public_key, "stable")
            if manifest:
                result["release"] = release_view(manifest)
        except ValueError:
            pass
    feed = request.app.state.announcements.feed(limit=20)
    result["announcements"], result["announcements_stale"] = feed["items"], feed["stale"]
    return result


@router.get("/manifests/{channel}")
def manifest(
    channel: str,
    request: Request,
    user: User = Depends(require_member),
    db: Session = Depends(database),
):
    if channel not in ("stable", "beta", "developer"):
        raise HTTPException(404, "Unknown channel")
    if channel != "stable" and not set(request.state.member["entitlements"]) & {
        "developer",
        "admin",
        "owner",
    }:
        raise HTTPException(403, "Release channel entitlement required")
    try:
        value = active_manifest(db, request.app.state.settings.manifest_public_key, channel)
    except ValueError:
        raise HTTPException(503, "Published manifest is expired or invalid") from None
    if not value:
        raise HTTPException(404, "No signed manifest published for this channel")
    return value
