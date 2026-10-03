from conftest import login
from test_identity import authorization


def test_preset_share_requires_pro(identity_client):
    client, _discord = identity_client
    headers = authorization(login(client))
    response = client.post(
        "/v1/presets",
        headers=headers,
        json={
            "preset": {
                "version": 2,
                "exportedAt": "2026-01-01T00:00:00Z",
                "appearance": {"themeId": "ember", "appName": "Test"},
            }
        },
    )
    assert response.status_code == 403


def test_preset_share_create_and_import(identity_client):
    client, discord = identity_client
    discord.extra_entitlements = ["pro"]
    headers = authorization(login(client))
    created = client.post(
        "/v1/presets",
        headers=headers,
        json={
            "preset": {
                "version": 2,
                "exportedAt": "2026-01-01T00:00:00Z",
                "appearance": {
                    "themeId": "ember",
                    "appName": "Shared",
                    "customIconDataUrl": "data:image/png;base64,AAAA",
                },
            }
        },
    )
    assert created.status_code == 201, created.text
    code = created.json()["code"]
    assert code.startswith("CUS-")
    fetched = client.get(f"/v1/presets/{code}", headers=headers)
    assert fetched.status_code == 200
    payload = fetched.json()["preset"]
    assert payload["appearance"]["appName"] == "Shared"
    assert payload["appearance"]["customIconDataUrl"] == ""
