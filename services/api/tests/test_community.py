import copy
import hashlib
import os
import time

import httpx
from conftest import login
from pydantic import SecretStr
from test_identity import authorization

from ii_api.community import safe_image, sanitize_message
from ii_api.discord import ProviderUnavailable

MESSAGE = {
    "id": "154000000000000002",
    "timestamp": "2026-09-13T12:00:00Z",
    "content": "Hello <script>alert(1)</script> <b>community</b>",
    "author": {"username": "<b>Maintainer</b>"},
    "attachments": [
        {
            "url": "https://cdn.discordapp.com/attachments/test/photo.png",
            "content_type": "image/png",
        },
        {"url": "https://cdn.discordapp.com/attachments/test/run.exe", "content_type": "image/png"},
    ],
}


def test_sanitization_and_attachment_rules():
    result = sanitize_message(MESSAGE, "1537550313546981507", "1170093288557129748")
    assert "<" not in result["text"]
    assert result["author"] == "Maintainer"
    assert len(result["images"]) == 1
    assert result["url"].endswith("/154000000000000002")
    assert "script" not in result
    for unsafe in [
        "javascript:alert(1)",
        "http://cdn.discordapp.com/x.png",
        "https://evil.example/x.png",
        "https://cdn.discordapp.com@evil.example/x.png",
        "https://cdn.discordapp.com:9/x.png",
        "https://cdn.discordapp.com/x.svg",
        "https://cdn.discordapp.com/x.exe",
    ]:
        assert safe_image(unsafe) is None


def test_mentions_and_author_role_are_presented_without_raw_ids():
    message = copy.deepcopy(MESSAGE)
    message["content"] = (
        "Welcome <@1079230828577566790> to <#1537550313546981507> with <@&1549421049287020568>."
    )
    message["mentions"] = [
        {
            "id": "1079230828577566790",
            "username": "Drifted",
            "global_name": "Drifted",
        }
    ]
    message["member"] = {"roles": ["1549421049287020568"]}
    result = sanitize_message(
        message,
        "1537550313546981507",
        "1170093288557129748",
        {
            "1549421049287020568": {
                "name": "Beta Engine User",
                "color": 5763719,
                "position": 12,
                "unicode_emoji": "✅",
            }
        },
        {"1537550313546981507": "main-announcements"},
    )
    assert result["mentions"]["<@1079230828577566790>"] == "@Drifted"
    assert result["mentions"]["<#1537550313546981507>"] == "#main-announcements"
    assert result["mentions"]["<@&1549421049287020568>"] == "@Beta Engine User"
    assert result["author_color"] == "#57f287"
    assert result["author_emoji"] == "✅"


def test_feed_allowlist_pagination_cache_edits_and_outage(identity_client):
    client, fake = identity_client
    headers = authorization(login(client))
    calls = []

    def request(method, path, **kwargs):
        calls.append(path)
        if fake.fail:
            raise ProviderUnavailable("outage")
        older = copy.deepcopy(MESSAGE)
        older["id"] = "154000000000000001"
        return httpx.Response(200, json=[MESSAGE, older])

    fake.request = request
    channel = "1537550313546981507"
    assert client.get("/v1/announcements?channel=999", headers=headers).status_code == 403
    page = client.get(f"/v1/announcements?channel={channel}&limit=1", headers=headers).json()
    assert page["next_cursor"] == MESSAGE["id"]
    assert len(page["items"]) == 1
    client.get(f"/v1/announcements?channel={channel}", headers=headers)
    assert len(calls) == 1
    older = client.get(
        f"/v1/announcements?channel={channel}&before={MESSAGE['id']}", headers=headers
    ).json()
    assert older["items"][0]["id"] == "154000000000000001"

    # Keep membership verification available but fail the feed provider.
    def outage(*args, **kwargs):
        raise ProviderUnavailable("outage")

    fake.request = outage
    client.app.state.announcements.fresh.clear()
    stale = client.get(f"/v1/announcements?channel={channel}", headers=headers).json()
    assert stale["stale"] is True and len(stale["items"]) == 2
    assert client.get("/v1/announcements", headers={}).status_code == 401


def test_announcement_pin_from_engine(identity_client):
    client, fake = identity_client
    fake.staff = True
    headers = authorization(login(client))
    channel = "1537550313546981507"

    def request(method, path, **kwargs):
        if path.endswith(f"/channels/{channel}/messages"):
            return httpx.Response(200, json=[MESSAGE])
        if method == "DELETE" and "/messages/" in path:
            return httpx.Response(204)
        raise AssertionError(f"unexpected {method} {path}")

    fake.request = request
    page = client.get(f"/v1/announcements?channel={channel}", headers=headers).json()
    assert page["items"][0]["pinned"] is False

    pinned = client.post(
        f"/v1/announcements/{channel}/{MESSAGE['id']}/pin",
        headers=headers,
    )
    assert pinned.status_code == 200, pinned.text
    assert pinned.json()["pinned"] is True

    again = client.get(f"/v1/announcements?channel={channel}", headers=headers).json()
    assert again["items"][0]["pinned"] is True
    assert again["pinned_ids"] == [f"{channel}:{MESSAGE['id']}"]

    unpinned = client.delete(
        f"/v1/announcements/{channel}/{MESSAGE['id']}/pin",
        headers=headers,
    )
    assert unpinned.status_code == 200
    final = client.get(f"/v1/announcements?channel={channel}", headers=headers).json()
    assert final["items"][0]["pinned"] is False


def test_engine_announcements_staff_only(identity_client):
    client, fake = identity_client
    headers = authorization(login(client))
    denied = client.post(
        "/v1/community/messages",
        headers=headers,
        json={"category": "engine", "body": "Ship checklist for Engine 0.2.2"},
    )
    assert denied.status_code == 403

    fake.staff = True
    headers = authorization(login(client))
    posted = client.post(
        "/v1/community/messages",
        headers=headers,
        json={"category": "engine", "body": "  Engine 0.2.2 is live.  "},
    )
    assert posted.status_code == 201, posted.text
    assert posted.json()["category"] == "engine"
    assert posted.json()["body"] == "Engine 0.2.2 is live."
    assert posted.json()["anonymous"] is False

    anon = client.post(
        "/v1/community/messages",
        headers=headers,
        json={"category": "engine", "body": "Nope", "anonymous": True},
    )
    assert anon.status_code == 422

    listed = client.get("/v1/community/messages", headers=headers).json()["items"]
    engine = [item for item in listed if item["category"] == "engine"]
    assert len(engine) == 1
    assert engine[0]["body"] == "Engine 0.2.2 is live."


def test_community_chat_and_mod_review_flow(identity_client):
    client, fake = identity_client
    headers = authorization(login(client))
    posted = client.post(
        "/v1/community/messages",
        headers=headers,
        json={"category": "suggestion", "body": "  Add a compact launch card.  "},
    )
    assert posted.status_code == 201
    feed = client.get("/v1/community/messages", headers=headers).json()
    assert feed["items"][0]["body"] == "Add a compact launch card."
    assert feed["items"][0]["author"]["display_name"] == "Synthetic Member"

    artifact = b"MZ" + b"community-fixture"
    submitted = client.post(
        "/v1/community/mods?name=Fixture%20Mod&description=Test-only%20pending%20mod&filename=Fixture.dll",
        headers=headers,
        content=artifact,
    )
    assert submitted.status_code == 201, submitted.text
    item = submitted.json()
    assert item["reviewed"] is False
    assert item["status"] == "pending"
    assert client.get("/v1/community/mods", headers=headers).json()["items"] == []
    assert (
        client.get(f"/v1/community/mods/{item['id']}/download", headers=headers).status_code == 404
    )

    password = "CorrectHorseBatteryStaple1!"
    salt = os.urandom(16)
    hashed = hashlib.scrypt(password.encode(), salt=salt, n=16384, r=8, p=1).hex()
    client.app.state.settings.developer_password_hash = SecretStr(f"scrypt${salt.hex()}${hashed}")
    fake.staff = True
    unlocked = client.post("/v1/developer/unlock", headers=headers, json={"password": password})
    assert unlocked.status_code == 200
    staff = {**headers, "X-Developer-Token": unlocked.json()["token"]}
    pending = client.get("/v1/developer/community-mods", headers=staff).json()
    assert pending["items"][0]["id"] == item["id"]
    reviewed = client.post(
        f"/v1/developer/community-mods/{item['id']}/review",
        headers=staff,
        json={"approve": True, "note": "Looks fine"},
    )
    assert reviewed.status_code == 200, reviewed.text
    assert reviewed.json()["status"] == "approved"
    listed = client.get("/v1/community/mods", headers=headers).json()["items"]
    assert listed[0]["id"] == item["id"]
    downloaded = client.get(f"/v1/community/mods/{item['id']}/download", headers=headers)
    assert downloaded.content == artifact
    assert downloaded.headers["x-content-sha256"] == hashlib.sha256(artifact).hexdigest()
    assert (
        client.delete(f"/v1/developer/community-mods/{item['id']}", headers=staff).status_code
        == 204
    )
    assert client.get("/v1/community/mods", headers=headers).json()["items"] == []


def test_community_chat_mentions_resolve_and_flag_target(identity_client):
    client, _fake = identity_client
    tokens = login(client)
    headers = authorization(tokens)
    seed = client.post(
        "/v1/community/messages",
        headers=headers,
        json={"category": "chat", "body": "hello before mention"},
    )
    assert seed.status_code == 201, seed.text
    user_id = seed.json()["author"]["id"]
    display_name = seed.json()["author"]["display_name"]
    time.sleep(2.05)
    posted = client.post(
        "/v1/community/messages",
        headers=headers,
        json={"category": "chat", "body": f"hey <@{user_id}> check this"},
    )
    assert posted.status_code == 201, posted.text
    payload = posted.json()
    assert payload["mentioned_user_ids"] == [user_id]
    assert payload["mentioned_me"] is True
    assert payload["mentions"][f"<@{user_id}>"] == f"@{display_name}"
    assert f"<@{user_id}>" in payload["body"]

    mentionables = client.get("/v1/community/mentionables", headers=headers)
    assert mentionables.status_code == 200
    ids = {item["id"] for item in mentionables.json()["items"]}
    assert user_id in ids

    time.sleep(2.05)
    anon = client.post(
        "/v1/community/messages",
        headers=headers,
        json={"category": "chat", "body": f"anon <@{user_id}>", "anonymous": True},
    )
    assert anon.status_code == 422


def test_community_mod_ai_info_queues_on_approve(identity_client):
    client, fake = identity_client
    headers = authorization(login(client))

    class FakeAI:
        async def complete(self, prompt, *, system="", max_tokens=1024):
            assert "potentially malicious" in system.casefold() or "informational" in system.casefold()
            assert "History:" in prompt
            return (
                "**Overview**\nFixture community mod.\n"
                "**Apparent Features**\n- Utility\n"
                "**Technical Notes**\n- None\n"
                "**Known History**\n- No prior catalog history was supplied.\n"
                "**Community Caution**\nPotentially malicious (unsigned community DLL).\n"
                "**Footnote**\nAI reviews can be wrong and are not perfect. Treat this as informal information only."
            )

        async def close(self):
            pass

    client.app.state.ai_provider = FakeAI()
    artifact = b"MZ" + b"HarmonyPatch community-ai-fixture"
    submitted = client.post(
        "/v1/community/mods?name=AI%20Brief%20Mod&description=Informational%20review%20fixture&filename=AiBrief.dll",
        headers=headers,
        content=artifact,
    )
    assert submitted.status_code == 201, submitted.text
    mod_id = submitted.json()["id"]

    password = "CorrectHorseBatteryStaple1!"
    salt = os.urandom(16)
    hashed = hashlib.scrypt(password.encode(), salt=salt, n=16384, r=8, p=1).hex()
    client.app.state.settings.developer_password_hash = SecretStr(f"scrypt${salt.hex()}${hashed}")
    fake.staff = True
    unlocked = client.post("/v1/developer/unlock", headers=headers, json={"password": password})
    assert unlocked.status_code == 200
    staff = {**headers, "X-Developer-Token": unlocked.json()["token"]}
    reviewed = client.post(
        f"/v1/developer/community-mods/{mod_id}/review",
        headers=staff,
        json={"approve": True, "note": "Ship it"},
    )
    assert reviewed.status_code == 200, reviewed.text
    assert reviewed.json()["ai_info_status"] in {"queued", "running", "ready"}

    info = client.get(f"/v1/community/mods/{mod_id}/ai-info", headers=headers)
    assert info.status_code == 200, info.text
    body = info.json()
    assert "wrong" in body["disclaimer"].casefold()
    assert "potentially malicious" in body["disclaimer"].casefold()
    assert "inherently malicious" not in body["disclaimer"].casefold()
    # BackgroundTasks run after the response on TestClient.
    assert body["status"] in {"queued", "running", "ready", "failed"}
    if body["status"] == "ready":
        assert body["report"]
        assert "inherently malicious" not in body["report"].casefold()
        assert "wrong" in body["report"].casefold()

    listed = client.get("/v1/community/mods", headers=headers).json()["items"]
    assert listed[0]["id"] == mod_id
    assert listed[0]["ai_info_status"] in {"queued", "running", "ready", "failed"}


def test_creator_application_approval_grants_role(identity_client):
    client, fake = identity_client
    headers = authorization(login(client))
    application = client.post(
        "/v1/community/creator-applications",
        headers=headers,
        json={
            "pitch": "I want to publish community utility mods for Gorilla Tag.",
            "experience": "Shipped several BepInEx plugins over the last year.",
        },
    )
    assert application.status_code == 201
    app_id = application.json()["id"]

    password = "CorrectHorseBatteryStaple1!"
    salt = os.urandom(16)
    hashed = hashlib.scrypt(password.encode(), salt=salt, n=16384, r=8, p=1).hex()
    client.app.state.settings.developer_password_hash = SecretStr(f"scrypt${salt.hex()}${hashed}")
    fake.staff = True
    unlocked = client.post("/v1/developer/unlock", headers=headers, json={"password": password})
    assert unlocked.status_code == 200
    staff = {**headers, "X-Developer-Token": unlocked.json()["token"]}
    pending = client.get("/v1/developer/creator-applications", headers=staff).json()
    assert pending["items"][0]["id"] == app_id
    reviewed = client.post(
        f"/v1/developer/creator-applications/{app_id}/review",
        headers=staff,
        json={"approve": True, "note": "Looks good"},
    )
    assert reviewed.status_code == 200, reviewed.text
    assert reviewed.json()["status"] == "approved"
    assert fake.grants and fake.grants[-1][0] == "role"
