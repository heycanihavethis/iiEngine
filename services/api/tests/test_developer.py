import hashlib
import io
import secrets
import zipfile

from conftest import login
from pydantic import SecretStr


class FakeReleases:
    def get(self):
        return {
            "version": "2.4.1",
            "sha256": "b" * 64,
            "release_url": "https://github.com/iireborn/iis.Stupid.Menu/releases/tag/v2.4.1",
        }

    def close(self):
        pass


def configure(client):
    password = secrets.token_urlsafe(32)
    salt = secrets.token_bytes(16)
    hashed = hashlib.scrypt(password.encode(), salt=salt, n=16384, r=8, p=1).hex()
    client.app.state.settings.developer_password_hash = SecretStr(f"scrypt${salt.hex()}${hashed}")
    return password


def test_staff_password_snapshot_conflict_and_withdraw(identity_client):
    client, discord = identity_client
    password = configure(client)
    token = login(client)
    auth = {"Authorization": "Bearer " + token["access_token"]}
    assert (
        client.post("/v1/developer/unlock", headers=auth, json={"password": password}).status_code
        == 403
    )
    discord.staff = True
    unlocked = client.post("/v1/developer/unlock", headers=auth, json={"password": password})
    assert unlocked.status_code == 200
    headers = {**auth, "X-Developer-Token": unlocked.json()["token"]}
    body = {"kind": "announcement", "title": "Original", "text": "Hello"}
    row = client.post("/v1/developer/content", headers=headers, json=body).json()
    path = "/v1/developer/content/" + row["id"]
    assert client.get("/v1/content", headers=auth).json()["items"] == []
    assert (
        client.post(
            path + "/visibility", headers=headers, json={"expected_revision": 1, "publish": True}
        ).status_code
        == 403
    )
    client.app.state.settings.developer_publish_enabled = True
    assert (
        client.post(
            path + "/visibility", headers=headers, json={"expected_revision": 1, "publish": True}
        ).status_code
        == 200
    )
    assert (
        client.post(
            path, headers=headers, json={**body, "title": "Draft change", "expected_revision": 2}
        ).status_code
        == 200
    )
    assert client.get("/v1/content", headers=auth).json()["items"][0]["title"] == "Original"
    assert (
        client.post(path, headers=headers, json={**body, "expected_revision": 2}).status_code == 409
    )
    assert (
        client.post(
            path + "/visibility", headers=headers, json={"expected_revision": 3, "publish": False}
        ).status_code
        == 200
    )
    assert client.get("/v1/content", headers=auth).json()["items"] == []
    discord.staff = False
    assert client.get("/v1/developer/content", headers=headers).status_code == 403


def test_lockout_rotation_and_session_binding(identity_client):
    client, discord = identity_client
    discord.staff = True
    password = configure(client)
    auth = {"Authorization": "Bearer " + login(client)["access_token"]}
    unlocked = client.post("/v1/developer/unlock", headers=auth, json={"password": password}).json()
    headers = {**auth, "X-Developer-Token": unlocked["token"]}
    # Unlock is bound to the staff user + password digest, not the access-token sid,
    # so a refreshed Discord session can still use an existing unlock.
    other = {**headers, "Authorization": "Bearer " + login(client)["access_token"]}
    assert client.get("/v1/developer/content", headers=other).status_code == 200
    configure(client)
    assert client.get("/v1/developer/content", headers=headers).status_code == 403
    for _ in range(5):
        assert (
            client.post(
                "/v1/developer/unlock", headers=auth, json={"password": password}
            ).status_code
            == 403
        )
    assert (
        client.post("/v1/developer/unlock", headers=auth, json={"password": password}).status_code
        == 429
    )


def test_no_password_without_identity_or_unlocked_token(identity_client):
    client, discord = identity_client
    password = configure(client)
    assert client.post("/v1/developer/unlock", json={"password": password}).status_code == 401
    discord.staff = True
    auth = {"Authorization": "Bearer " + login(client)["access_token"]}
    assert client.get("/v1/developer/content", headers=auth).status_code == 403


def test_sync_official_stable_release_creates_one_reviewable_draft(identity_client):
    client, discord = identity_client
    discord.staff = True
    client.app.state.releases.close()
    client.app.state.releases = FakeReleases()
    password = configure(client)
    auth = {"Authorization": "Bearer " + login(client)["access_token"]}
    unlocked = client.post("/v1/developer/unlock", headers=auth, json={"password": password})
    headers = {**auth, "X-Developer-Token": unlocked.json()["token"]}

    first = client.post("/v1/developer/sync-stable", headers=headers)
    second = client.post("/v1/developer/sync-stable", headers=headers)

    assert first.status_code == 201
    assert second.status_code == 201
    assert first.json()["id"] == second.json()["id"]
    assert first.json()["version"] == "2.4.1"
    assert first.json()["sha256"] == "b" * 64
    assert first.json()["published_at"] is None


def test_developer_role_cannot_open_admin_portal(identity_client):
    client, discord = identity_client
    discord.staff = True
    discord.staff_role = "developer"
    password = configure(client)
    auth = {"Authorization": "Bearer " + login(client)["access_token"]}
    response = client.post("/v1/developer/unlock", headers=auth, json={"password": password})
    assert response.status_code == 403
    assert response.json()["detail"] == "Admin or owner role required"


def test_admin_operations_and_release_staging(identity_client):
    client, discord = identity_client
    discord.staff = True
    password = configure(client)
    auth = {"Authorization": "Bearer " + login(client)["access_token"]}
    unlocked = client.post("/v1/developer/unlock", headers=auth, json={"password": password})
    headers = {**auth, "X-Developer-Token": unlocked.json()["token"]}

    countdown = client.post(
        "/v1/developer/operations/countdown",
        headers=headers,
        json={"enabled": True, "title": "Menu 2.5", "target_at": "2027-01-02T12:00:00Z"},
    )
    assert countdown.status_code == 200
    status = client.post(
        "/v1/developer/operations/menu",
        headers=headers,
        json={"status": "maintenance", "message": "Installing an update."},
    )
    assert status.status_code == 200
    pricing = client.post(
        "/v1/developer/operations/pricing",
        headers=headers,
        json={
            "lifetime_usd": 9,
            "lifetime_on_sale": True,
            "lifetime_sale_name": "Launch week",
            "lifetime_was_usd": 14,
            "bundle_usd": 18,
            "bundle_on_sale": True,
            "bundle_sale_name": "Tracker pack promo",
            "bundle_was_usd": 25,
            "robux_price": 1800,
            "robux_on_sale": True,
            "robux_sale_name": "Roblox promo",
            "robux_was_price": 2500,
        },
    )
    assert pricing.status_code == 200, pricing.text
    assert pricing.json()["lifetime_usd"] == 9
    assert pricing.json()["bundle_usd"] == 18
    assert pricing.json()["bundle_on_sale"] is True
    assert pricing.json()["bundle_sale_name"] == "Tracker pack promo"
    assert pricing.json()["robux_price"] == 1800
    features = client.post(
        "/v1/developer/operations/features",
        headers=headers,
        json={
            "studio": {
                "enabled": True,
                "everyone": False,
                "role_ids": ["1549421049287020568"],
                "entitlements": ["admin"],
            },
            "mod_library": {"enabled": True, "everyone": True, "role_ids": [], "entitlements": []},
            "launch_game": {
                "enabled": True,
                "everyone": False,
                "role_ids": ["1549986950793007215"],
                "entitlements": ["owner"],
            },
            "health_repair": {
                "enabled": True,
                "everyone": True,
                "role_ids": [],
                "entitlements": [],
            },
            "announcements": {
                "enabled": True,
                "everyone": True,
                "role_ids": [],
                "entitlements": [],
            },
            "backups": {
                "enabled": True,
                "everyone": True,
                "role_ids": [],
                "entitlements": [],
            },
        },
    )
    assert features.status_code == 200
    public = client.get("/v1/platform/operations", headers=auth).json()
    assert public["countdown"]["title"] == "Menu 2.5"
    assert public["menu"]["status"] == "maintenance"
    assert public["pricing"]["lifetime_usd"] == 9
    assert public["pricing"]["lifetime_on_sale"] is True
    assert public["pricing"]["lifetime_sale_name"] == "Launch week"
    assert public["pricing"]["bundle_usd"] == 18
    assert public["pricing"]["bundle_on_sale"] is True
    assert public["pricing"]["bundle_sale_name"] == "Tracker pack promo"
    assert public["pricing"]["robux_price"] == 1800
    assert public["feature_access"]["launch_game"]["role_ids"] == ["1549986950793007215"]

    bad_sale = client.post(
        "/v1/developer/operations/pricing",
        headers=headers,
        json={
            "lifetime_usd": 14,
            "lifetime_on_sale": True,
            "lifetime_sale_name": "Bad",
            "lifetime_was_usd": 10,
            "bundle_usd": 25,
            "bundle_on_sale": False,
            "bundle_sale_name": "",
            "bundle_was_usd": None,
            "robux_price": 2500,
            "robux_on_sale": False,
            "robux_sale_name": "",
            "robux_was_price": None,
        },
    )
    assert bad_sale.status_code == 422

    bad_bundle = client.post(
        "/v1/developer/operations/pricing",
        headers=headers,
        json={
            "lifetime_usd": 14,
            "lifetime_on_sale": False,
            "lifetime_sale_name": "",
            "lifetime_was_usd": None,
            "bundle_usd": 25,
            "bundle_on_sale": True,
            "bundle_sale_name": "Bad bundle",
            "bundle_was_usd": 20,
            "robux_price": 2500,
            "robux_on_sale": False,
            "robux_sale_name": "",
            "robux_was_price": None,
        },
    )
    assert bad_bundle.status_code == 422

    invalid = client.post(
        "/v1/developer/releases?version=1.2.3&filename=menu.dll",
        headers={**headers, "Content-Type": "application/octet-stream"},
        content=b"not-a-dll",
    )
    assert invalid.status_code == 410
    artifact = b"MZ" + b"\x00" * 128
    staged = client.post(
        "/v1/developer/releases?version=1.2.3&filename=menu.dll",
        headers={**headers, "Content-Type": "application/octet-stream"},
        content=artifact,
    )
    assert staged.status_code == 410
    operations = client.get("/v1/developer/operations", headers=headers)
    assert operations.status_code == 200
    assert operations.json()["available_roles"][0]["name"] == "Beta Engine User"

    client.app.state.settings.developer_publish_enabled = True
    client.app.state.releases = type(
        "R",
        (),
        {
            "close": staticmethod(lambda: None),
            "get": staticmethod(
                lambda: {
                    "version": "1.0.5",
                    "channel": "stable",
                    "signature": "GitHub release digest",
                    "published_at": "2026-09-26T06:40:23+00:00",
                    "sha256": "b" * 64,
                    "byte_size": 3256832,
                    "download_url": (
                        "https://github.com/iireborn/menu/releases/latest/download/ii.Reborn.dll"
                    ),
                    "release_url": "https://github.com/iireborn/menu/releases/tag/1.0.5",
                    "canonical_filename": "ii.Reborn.dll",
                    "baseline_id": "bepinex-5.4.23.5-win-x64",
                }
            ),
        },
    )()
    catalog = client.get("/v1/menu-releases", headers=auth)
    assert catalog.status_code == 200
    assert catalog.json()["latest_id"] == "github-latest"
    assert catalog.json()["items"][0]["version"] == "1.0.5"
    assert catalog.json()["items"][0]["download_url"].endswith("ii.Reborn.dll")
    ticket = client.post("/v1/menu-releases/github-latest/ticket", headers=auth)
    assert ticket.status_code == 410
    assert client.get("/v1/menu-releases").status_code == 401



def test_trusted_mod_catalog_is_available_to_every_signed_in_member(identity_client):
    client, discord = identity_client
    discord.staff = True
    password = configure(client)
    auth = {"Authorization": "Bearer " + login(client)["access_token"]}
    unlocked = client.post("/v1/developer/unlock", headers=auth, json={"password": password})
    headers = {**auth, "X-Developer-Token": unlocked.json()["token"]}
    artifact = b"MZ" + b"trusted-mod" * 20
    created = client.post(
        "/v1/developer/trusted-mods?name=Trusted%20Utility&description=Approved%20test%20mod&filename=Trusted.Utility.dll",
        headers={**headers, "Content-Type": "application/octet-stream"},
        content=artifact,
    )
    assert created.status_code == 201
    identifier = created.json()["id"]
    assert client.get("/v1/trusted-mods", headers=auth).json()["items"][0]["id"] == identifier
    ticket = client.post(f"/v1/trusted-mods/{identifier}/ticket", headers=auth)
    download = client.get(ticket.json()["download_url"])
    assert download.content == artifact
    assert download.headers["x-mod-sha256"] == hashlib.sha256(artifact).hexdigest()
    discord.extra_entitlements = []
    assert client.get("/v1/trusted-mods", headers=auth).status_code == 200
    assert (
        client.delete(f"/v1/developer/trusted-mods/{identifier}", headers=headers).status_code
        == 204
    )
    assert client.get("/v1/trusted-mods", headers=auth).json()["items"] == []


def test_studio_template_catalog_verifies_safe_zip_and_download(identity_client):
    client, discord = identity_client
    discord.staff = True
    discord.extra_role_ids = ["1549421049287020568"]
    password = configure(client)
    auth = {"Authorization": "Bearer " + login(client)["access_token"]}
    unlocked = client.post("/v1/developer/unlock", headers=auth, json={"password": password})
    headers = {**auth, "X-Developer-Token": unlocked.json()["token"]}
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, "w") as bundle:
        bundle.writestr("Starter.csproj", "<Project />")
        bundle.writestr("Plugin.cs", "public class Plugin {}")
    created = client.post(
        "/v1/developer/studio-templates?name=Starter&description=Approved%20starter&filename=starter.zip",
        headers={**headers, "Content-Type": "application/zip"},
        content=archive.getvalue(),
    )
    assert created.status_code == 201
    identifier = created.json()["id"]
    discord.extra_entitlements = []
    catalog = client.get("/v1/studio-templates", headers=auth)
    assert catalog.status_code == 200
    assert catalog.json()["items"][0]["id"] == identifier
    ticket = client.post(f"/v1/studio-templates/{identifier}/ticket", headers=auth)
    download = client.get(ticket.json()["download_url"])
    assert download.status_code == 200
    assert download.content == archive.getvalue()
    assert download.headers["x-template-sha256"] == hashlib.sha256(archive.getvalue()).hexdigest()
    assert (
        client.delete(f"/v1/developer/studio-templates/{identifier}", headers=headers).status_code
        == 204
    )
