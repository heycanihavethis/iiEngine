import copy

import httpx
import pytest
from conftest import login
from test_identity import authorization

from ii_api.discord import ProviderUnavailable
from ii_api.releases import LATEST_DOWNLOAD_URL, MENUSTATUS_URL, MENUVERSION_URL, Releases

MENUVERSION = {
    "version": "1.1.0",
    "sha256": "e1ca1f93aa06b9306e40230903caf73d343a3c30d24152c4b191baabb1cf7fc3",
    "downloadUrl": "https://github.com/iireborn/menu/releases/download/1.1.0/ii.Reborn.dll",
    "releaseUrl": "https://github.com/iireborn/menu/releases",
}

MENUSTATUS = {"menustatus": True}

DIGEST = "sha256:" + "e1ca1f93aa06b9306e40230903caf73d343a3c30d24152c4b191baabb1cf7fc3"
LATEST = {
    "tag_name": "1.1.0",
    "html_url": "https://github.com/iireborn/menu/releases/tag/1.1.0",
    "published_at": "2026-09-26T06:40:23Z",
    "draft": False,
    "prerelease": False,
    "assets": [
        {
            "name": "ii.Reborn.dll",
            "size": 3237376,
            "digest": DIGEST,
            "browser_download_url": (
                "https://github.com/iireborn/menu/releases/download/1.1.0/ii.Reborn.dll"
            ),
        }
    ],
}


def service(menuversion=MENUVERSION, latest=LATEST, *, head_length=None, menustatus=MENUSTATUS):
    def handler(request: httpx.Request):
        url = str(request.url)
        if url.startswith(MENUSTATUS_URL):
            return httpx.Response(200, json=menustatus)
        if url.startswith(MENUVERSION_URL):
            return httpx.Response(200, json=menuversion)
        if url.startswith("https://api.github.com/repos/iireborn/menu/releases/latest"):
            if latest is None:
                return httpx.Response(403, headers={"X-RateLimit-Reset": "0"})
            return httpx.Response(200, json=latest)
        tagged = (menuversion or {}).get("downloadUrl") if isinstance(menuversion, dict) else None
        if request.method == "HEAD" and (
            url.startswith(LATEST_DOWNLOAD_URL) or (tagged and url.startswith(tagged))
        ):
            headers = {}
            if head_length is not None:
                headers["Content-Length"] = str(head_length)
            return httpx.Response(200, headers=headers)
        return httpx.Response(404)

    return Releases(httpx.MockTransport(handler))


def test_menuversion_drives_metadata_and_pinned_download_url():
    source = service()
    release = source.get()
    assert release["version"] == "1.1.0"
    assert release["sha256"] == MENUVERSION["sha256"]
    assert release["signature"] == "menuversion.json"
    assert release["canonical_filename"] == "ii.Reborn.dll"
    assert release["download_url"] == MENUVERSION["downloadUrl"]
    assert release["byte_size"] == 3237376
    assert release["release_url"].endswith("/menu/releases/tag/1.1.0")
    source.close()


def test_menuversion_works_when_github_api_is_rate_limited():
    source = service(latest=None, head_length=3237376)
    release = source.get()
    assert release["version"] == "1.1.0"
    assert release["download_url"] == MENUVERSION["downloadUrl"]
    assert release["byte_size"] == 3237376
    assert release["release_url"] == "https://github.com/iireborn/menu/releases"
    source.close()


def test_menuversion_falls_back_to_latest_when_download_url_missing():
    payload = copy.deepcopy(MENUVERSION)
    del payload["downloadUrl"]
    source = service(menuversion=payload, latest=None, head_length=3237376)
    release = source.get()
    assert release["download_url"] == LATEST_DOWNLOAD_URL
    assert release["sha256"] == MENUVERSION["sha256"]
    source.close()


def test_menustatus_offline_blocks_release_metadata():
    source = service(menustatus={"menustatus": False})
    with pytest.raises(ProviderUnavailable):
        source.get()
    assert source.status()["online"] is False
    source.close()


@pytest.mark.parametrize(
    "change",
    ["sha", "version", "release_host", "download_host"],
)
def test_menuversion_fails_closed(change):
    payload = copy.deepcopy(MENUVERSION)
    if change == "sha":
        payload["sha256"] = "bad"
    if change == "version":
        payload["version"] = "not-a-version"
    if change == "release_host":
        payload["releaseUrl"] = "https://evil.example/menu/releases"
    if change == "download_host":
        payload["downloadUrl"] = "https://evil.example/ii.Reborn.dll"
    source = service(menuversion=payload, latest=None, head_length=1024)
    with pytest.raises(ProviderUnavailable):
        source.get()
    source.close()


def test_channel_entitlements_and_nonmember_dashboard(identity_client):
    client, fake = identity_client
    fake.member = False
    headers = authorization(login(client))
    dashboard = client.get("/v1/dashboard", headers=headers)
    assert dashboard.status_code == 200
    assert dashboard.json()["announcements"] == []
    assert dashboard.json()["demo"] is False
    fake.member = True
    assert client.get("/v1/releases/beta", headers=headers).status_code == 403
    fake.staff = True
    assert client.get("/v1/releases/beta", headers=headers).status_code == 503
    client.app.state.releases.close()
    client.app.state.releases = service()
    listed = client.get("/v1/releases/stable", headers=headers).json()
    assert listed["version"] == "1.1.0"
    assert listed["download_url"] == MENUVERSION["downloadUrl"]
    catalog = client.get("/v1/menu-releases", headers=headers).json()
    assert catalog["latest_id"] == "github-latest"
    assert catalog["items"][0]["download_url"] == MENUVERSION["downloadUrl"]
