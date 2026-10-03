"""Community chat roles, delete, automod, trusted creator publish, thumbnails."""

import base64
import hashlib
import os

from conftest import login
from pydantic import SecretStr
from test_identity import authorization


def test_chat_role_tag_anonymous_delete_and_automod(identity_client):
    client, fake = identity_client
    fake.extra_role_ids = ["1549421049287020568"]
    headers = authorization(login(client))

    blocked = client.post(
        "/v1/community/messages",
        headers=headers,
        json={"category": "chat", "body": "you are a f4ggot"},
    )
    assert blocked.status_code == 422

    created = client.post(
        "/v1/community/messages",
        headers=headers,
        json={"category": "chat", "body": "hello lobby"},
    )
    assert created.status_code == 201, created.text
    payload = created.json()
    assert payload["author"]["role_name"] == "Beta Engine User"
    assert payload["author"]["role_color"] == "#22c55e"
    assert payload["can_delete"] is True

    import time

    time.sleep(2.1)
    anon = client.post(
        "/v1/community/messages",
        headers=headers,
        json={"category": "chat", "body": "ghost mode", "anonymous": True},
    )
    assert anon.status_code == 201
    assert anon.json()["author"]["display_name"] == "Anonymous"
    assert anon.json()["author"]["role_name"] is None

    listed = client.get("/v1/community/messages", headers=headers).json()["items"]
    assert any(item["id"] == created.json()["id"] for item in listed)
    assert client.delete(
        f"/v1/community/messages/{created.json()['id']}", headers=headers
    ).status_code == 204


def test_trusted_creator_can_publish_with_thumbnail_suffix(identity_client):
    """Real thumbnails ride after the DLL (header base64 hits proxy header limits)."""
    client, fake = identity_client
    fake.extra_role_ids = [client.app.state.settings.discord_trusted_creator_role_id]
    headers = authorization(login(client))
    artifact = b"MZ" + b"\x00" * 128
    png = base64.b64decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
    )
    body = artifact + png
    uploaded = client.post(
        "/v1/trusted-mods/publish?name=Creator%20Pack&description=Trusted%20creator%20upload&filename=Creator.Pack.dll",
        headers={**headers, "X-Thumbnail-Size": str(len(png))},
        content=body,
    )
    assert uploaded.status_code == 201, uploaded.text
    item = uploaded.json()
    assert item["has_thumbnail"] is True
    thumb = client.get(item["thumbnail_url"], headers=headers)
    assert thumb.status_code == 200
    assert thumb.content[:8] == b"\x89PNG\r\n\x1a\n"


def test_trusted_creator_can_publish_with_thumbnail(identity_client):
    client, fake = identity_client
    fake.extra_role_ids = [client.app.state.settings.discord_trusted_creator_role_id]
    headers = authorization(login(client))
    artifact = b"MZ" + b"\x00" * 128
    # Minimal 1x1 PNG
    png = base64.b64decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
    )
    uploaded = client.post(
        "/v1/trusted-mods/publish?name=Creator%20Pack&description=Trusted%20creator%20upload&filename=Creator.Pack.dll",
        headers={**headers, "X-Thumbnail-Base64": base64.b64encode(png).decode()},
        content=artifact,
    )
    assert uploaded.status_code == 201, uploaded.text
    item = uploaded.json()
    assert item["has_thumbnail"] is True
    thumb = client.get(item["thumbnail_url"], headers=headers)
    assert thumb.status_code == 200
    assert thumb.content[:8] == b"\x89PNG\r\n\x1a\n"
    catalog = client.get("/v1/trusted-mods", headers=headers).json()["items"]
    assert catalog[0]["id"] == item["id"]


def test_feature_permissions_persist_role_selection(identity_client):
    client, fake = identity_client
    headers = authorization(login(client))
    password = "CorrectHorseBatteryStaple1!"
    salt = os.urandom(16)
    hashed = hashlib.scrypt(password.encode(), salt=salt, n=16384, r=8, p=1).hex()
    client.app.state.settings.developer_password_hash = SecretStr(f"scrypt${salt.hex()}${hashed}")
    fake.staff = True
    unlocked = client.post("/v1/developer/unlock", headers=headers, json={"password": password})
    assert unlocked.status_code == 200
    staff = {**headers, "X-Developer-Token": unlocked.json()["token"]}
    saved = client.post(
        "/v1/developer/operations/features",
        headers=staff,
        json={
            "community_chat": {
                "enabled": True,
                "everyone": False,
                "role_ids": ["1549421049287020568"],
                "entitlements": [],
            },
            "launch_game": {
                "enabled": True,
                "everyone": False,
                "role_ids": ["1549986950793007215"],
                "entitlements": ["owner"],
            },
        },
    )
    assert saved.status_code == 200, saved.text
    assert saved.json()["feature_access"]["community_chat"]["role_ids"] == [
        "1549421049287020568"
    ]
    public = client.get("/v1/platform/operations", headers=headers).json()
    assert public["feature_access"]["community_chat"]["everyone"] is False
    assert public["feature_access"]["community_chat"]["role_ids"] == ["1549421049287020568"]


def test_pro_forum_requires_pro_entitlement(identity_client):
    client, fake = identity_client
    headers = authorization(login(client))
    blocked = client.post(
        "/v1/community/messages",
        headers=headers,
        json={"category": "pro", "body": "hello pro lounge"},
    )
    assert blocked.status_code == 403

    fake.extra_entitlements = ["pro"]
    # Re-login so membership entitlements refresh on the session member payload.
    headers = authorization(login(client))
    import time

    time.sleep(2.1)
    ok = client.post(
        "/v1/community/messages",
        headers=headers,
        json={"category": "pro", "body": "hello pro lounge"},
    )
    assert ok.status_code == 201, ok.text
    assert ok.json()["category"] == "pro"


def test_community_creator_cannot_publish_trusted(identity_client):
    client, fake = identity_client
    fake.extra_role_ids = [client.app.state.settings.discord_community_creator_role_id]
    headers = authorization(login(client))
    artifact = b"MZ" + b"\x00" * 128
    denied = client.post(
        "/v1/trusted-mods/publish?name=Nope&description=Should%20fail&filename=Nope.dll",
        headers=headers,
        content=artifact,
    )
    assert denied.status_code == 403
