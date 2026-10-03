from sqlalchemy import select
from sqlalchemy.orm import Session

from conftest import login
from ii_api.models import FeatureUsageEvent
from test_identity import authorization

DEVICE_IDENTIFIER_KEYS = {
    "pc_username",
    "hostname",
    "client_ip",
    "root_ip",
    "vpn_ip",
    "public_ip",
    "direct_ip",
}


def stored_feature_keys(client):
    with Session(client.app.state.engine) as db:
        return {row.feature_key: row.detail for row in db.scalars(select(FeatureUsageEvent)).all()}


def test_session_log_accepted(identity_client):
    client, _ = identity_client
    headers = authorization(login(client))
    payload = {
        "kind": "launch",
        "log_text": (
            "ii Engine session journal\n"
            "=== ACTIONS / AI ===\n"
            "[t] ai:home\n"
            "PROMPT:\nhow do I fly\n"
            "RESPONSE:\nFavorite Mods…\n"
            "=== BEPINEX LOGOUTPUT ===\n"
            "[Info   : BepInEx] Loading"
        ),
        "game_path": "C:/Games/Gorilla Tag",
        "app_version": "0.2.2",
        "platform": "Win32",
    }
    assert (
        client.post("/v1/telemetry/session-log", headers=headers, json=payload).status_code == 200
    )


def test_session_log_daily_cap(identity_client):
    client, _ = identity_client
    headers = authorization(login(client))
    payload = {
        "kind": "launch",
        "log_text": "[Info   : BepInEx] Loading\n" * 20,
        "game_path": "C:/Games/Gorilla Tag",
        "app_version": "0.2.2",
    }
    for _ in range(6):
        assert (
            client.post("/v1/telemetry/session-log", headers=headers, json=payload).status_code
            == 200
        )
    assert (
        client.post("/v1/telemetry/session-log", headers=headers, json=payload).status_code == 429
    )


def test_session_log_drops_identifier_fields_and_header_from_stale_clients(identity_client):
    client, fake = identity_client
    headers = authorization(login(client))
    uploads: list[tuple[str, str, str]] = []

    def capture(channel_id, content, *, filename, file_bytes, content_type="text/plain"):
        uploads.append((content, filename, file_bytes.decode("utf-8")))

    fake.post_channel_message_with_file = capture
    payload = {
        "kind": "launch",
        "log_text": (
            "ii Engine session journal\n"
            "reason: session-end\n"
            "app: 0.2.2\n"
            "platform: Win32\n"
            "pc_username: Blake\n"
            "hostname: DESKTOP-II\n"
            "public_ip: 8.8.8.8\n"
            "ip: vpn 8.8.8.8 · root 1.1.1.1\n"
            "=== ACTIONS / AI ===\n"
            "[t] launch_game\n"
            "C:\\Users\\Blake\\AppData\\Roaming\\BepInEx\\LogOutput.log\n"
        ),
        "game_path": "C:\\Users\\Blake\\Games\\Gorilla Tag",
        "app_version": "0.2.2",
        "platform": "Win32",
        "pc_username": "Blake",
        "hostname": "DESKTOP-II",
        "public_ip": "8.8.8.8",
        "direct_ip": "1.1.1.1",
        "vpn_suspected": True,
    }
    response = client.post(
        "/v1/telemetry/session-log",
        headers={**headers, "X-Real-IP": "203.0.113.44"},
        json=payload,
    )
    assert response.status_code == 200, response.text

    assert DEVICE_IDENTIFIER_KEYS.isdisjoint(stored_feature_keys(client))

    assert uploads
    rendered = "\n".join(part for row in uploads for part in row)
    for leak in ("Blake", "DESKTOP-II", "8.8.8.8", "1.1.1.1", "203.0.113.44"):
        assert leak not in rendered, rendered
    assert "C:\\Users\\<user>\\AppData" in rendered
    assert "game_path: C:\\Users\\<user>\\Games\\Gorilla Tag" in rendered


def test_scrub_device_identifiers_removes_header_lines_and_profile_names():
    from ii_api.telemetry import scrub_device_identifiers

    scrubbed = scrub_device_identifiers(
        "ii Engine session journal\n"
        "pc_username: Blake\n"
        "hostname: DESKTOP-II\n"
        "Root IP: 1.1.1.1\n"
        "platform: Win32\n"
        "=== ACTIONS / AI ===\n"
        "loaded C:\\Users\\Blake\\AppData\\Roaming\\BepInEx\n"
        "shared /Users/Public/Games/plugin.dll\n",
        journal_header=True,
    )
    assert "Blake" not in scrubbed
    assert "DESKTOP-II" not in scrubbed
    assert "1.1.1.1" not in scrubbed
    assert "platform: Win32" in scrubbed
    assert "C:\\Users\\<user>\\AppData\\Roaming\\BepInEx" in scrubbed
    assert "/Users/Public/Games/plugin.dll" in scrubbed


def test_scrub_keeps_ip_literals_outside_the_journal_header():
    from ii_api.telemetry import scrub_device_identifiers

    body = "=== BEPINEX LOGOUTPUT ===\n[Info] Plugin 1.0.0.0 loaded\n"
    assert scrub_device_identifiers(body, journal_header=True) == body.rstrip("\n")


def test_hourly_pulse_stores_only_version_and_platform(identity_client):
    client, _ = identity_client
    headers = authorization(login(client))
    response = client.post(
        "/v1/telemetry/hourly",
        headers={**headers, "X-Real-IP": "203.0.113.44"},
        json={
            "features": {"catalog": 1},
            "app_version": "0.2.2",
            "platform": "Win32",
        },
    )
    assert response.status_code == 200, response.text

    keys = stored_feature_keys(client)
    assert keys.get("app_version") == "0.2.2"
    assert keys.get("platform") == "Win32"
    assert keys.get("catalog") == "count=1"
    assert DEVICE_IDENTIFIER_KEYS.isdisjoint(keys)


def test_hourly_pulse_ignores_identifier_fields_from_stale_clients(identity_client):
    client, _ = identity_client
    headers = authorization(login(client))
    response = client.post(
        "/v1/telemetry/hourly",
        headers=headers,
        json={
            "features": {"catalog": 1},
            "app_version": "0.2.2",
            "platform": "Win32",
            "pc_username": "Blake",
            "hostname": "DESKTOP-II",
            "public_ip": "8.8.8.8",
            "direct_ip": "1.1.1.1",
            "vpn_suspected": True,
        },
    )
    assert response.status_code == 200, response.text

    keys = stored_feature_keys(client)
    assert DEVICE_IDENTIFIER_KEYS.isdisjoint(keys)
    assert "Blake" not in set(keys.values())
    assert "DESKTOP-II" not in set(keys.values())


def test_telemetry_bodies_expose_no_identifier_fields():
    from ii_api.telemetry import HourlyPulseBody, SessionLogBody

    for model in (HourlyPulseBody, SessionLogBody):
        assert DEVICE_IDENTIFIER_KEYS.isdisjoint(model.model_fields)
