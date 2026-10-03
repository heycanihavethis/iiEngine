from datetime import UTC, datetime

from conftest import login


def authorization(tokens):
    return {"Authorization": f"Bearer {tokens['access_token']}"}


def test_bridge_ticket_and_entitlements_for_pro_member(identity_client):
    client, fake = identity_client
    fake.extra_entitlements = ["pro"]
    tokens = login(client)
    headers = authorization(tokens)

    issued = client.post("/v1/menu/bridge/ticket", headers=headers)
    assert issued.status_code == 200, issued.text
    body = issued.json()
    assert body["schema_version"] == 1
    assert body["pro"] is True
    assert body["features"] == ["engine_pro_mods"]
    assert body["filename"] == "ii-engine-bridge.json"
    assert body["ticket"]
    assert body["api_base"]
    assert datetime.fromisoformat(body["expires_at"]) > datetime.now(UTC)

    live = client.get(
        "/v1/menu/bridge/entitlements",
        headers={"Authorization": f"Bridge {body['ticket']}"},
    )
    assert live.status_code == 200, live.text
    view = live.json()
    assert view["pro"] is True
    assert view["features"] == ["engine_pro_mods"]
    assert "ticket" not in view


def test_bridge_ticket_reports_free_member(identity_client):
    client, _fake = identity_client
    tokens = login(client)
    body = client.post("/v1/menu/bridge/ticket", headers=authorization(tokens)).json()
    assert body["pro"] is False
    assert body["features"] == []

    live = client.get(
        "/v1/menu/bridge/entitlements",
        headers={"Authorization": f"Bridge {body['ticket']}"},
    )
    assert live.status_code == 200
    assert live.json()["pro"] is False


def test_bridge_entitlements_reject_desktop_bearer(identity_client):
    client, _fake = identity_client
    tokens = login(client)
    response = client.get(
        "/v1/menu/bridge/entitlements",
        headers={"Authorization": f"Bearer {tokens['access_token']}"},
    )
    assert response.status_code == 401


def test_bridge_entitlements_reflect_revoked_pro(identity_client):
    client, fake = identity_client
    fake.extra_entitlements = ["pro"]
    tokens = login(client)
    ticket = client.post("/v1/menu/bridge/ticket", headers=authorization(tokens)).json()["ticket"]
    fake.extra_entitlements = []
    live = client.get(
        "/v1/menu/bridge/entitlements",
        headers={"Authorization": f"Bridge {ticket}"},
    )
    assert live.status_code == 200
    assert live.json()["pro"] is False
    assert live.json()["features"] == []
