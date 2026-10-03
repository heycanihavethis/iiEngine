from datetime import UTC, datetime, timedelta

from conftest import login


def authorization(tokens):
    return {"Authorization": f"Bearer {tokens['access_token']}"}


def test_tracker_presence_upsert_list_and_clear(identity_client):
    client, _fake = identity_client
    tokens = login(client)
    headers = authorization(tokens)
    updated = datetime.now(UTC).isoformat()

    upsert = client.post(
        "/v1/tracker/presence",
        headers=headers,
        json={
            "username": "PlayerOne",
            "room_code": "abcd",
            "in_room": True,
            "updated_at": updated,
        },
    )
    assert upsert.status_code == 200, upsert.text
    body = upsert.json()
    assert body["username"] == "PlayerOne"
    assert body["room_code"] == "ABCD"
    assert body["in_room"] is True
    assert body["online"] is True
    assert body["status"] == "in_room"
    assert "seconds_ago" in body
    assert "avatar" in body
    assert "user_id" in body

    listed = client.get("/v1/tracker/players", headers=headers)
    assert listed.status_code == 200, listed.text
    payload = listed.json()
    assert payload["schema_version"] == 1
    assert payload["stale_after_seconds"] == 12 * 60
    assert any(player["username"] == "PlayerOne" for player in payload["players"])

    cleared = client.delete("/v1/tracker/presence", headers=headers)
    assert cleared.status_code == 200
    listed_after = client.get("/v1/tracker/players", headers=headers).json()
    assert listed_after["players"] == []


def test_tracker_marks_stale_presence_offline(identity_client):
    client, _fake = identity_client
    tokens = login(client)
    headers = authorization(tokens)
    stale = (datetime.now(UTC) - timedelta(minutes=20)).isoformat()
    client.post(
        "/v1/tracker/presence",
        headers=headers,
        json={
            "username": "Ghost",
            "room_code": "ZZZZ",
            "in_room": True,
            "updated_at": stale,
        },
    )
    players = client.get("/v1/tracker/players", headers=headers).json()["players"]
    assert len(players) == 1
    assert players[0]["online"] is False
    assert players[0]["in_room"] is False
    assert players[0]["room_code"] == ""


def test_tracker_requires_auth(identity_client):
    client, _fake = identity_client
    assert client.get("/v1/tracker/players").status_code == 401
    assert client.post("/v1/tracker/presence", json={}).status_code in {401, 422}


def test_tracker_feed_requires_ii_tracker_role(identity_client):
    client, discord = identity_client
    tokens = login(client)
    headers = authorization(tokens)
    denied = client.get("/v1/tracker/feed", headers=headers)
    assert denied.status_code == 403

    discord.extra_role_ids = ["1549151900073459752"]
    client.post("/v1/me/recheck", headers=headers)
    # Paid unlock without beta: soft coming-soon, never Discord rows.
    unlocked = client.get("/v1/tracker/feed", headers=headers)
    assert unlocked.status_code == 200, unlocked.text
    body = unlocked.json()
    assert body["enabled"] is False
    assert body["live"] is False
    assert body["items"] == []
    assert "coming soon" in (body.get("reason") or "").lower()


def test_tracker_session_requires_beta_role(identity_client):
    client, discord = identity_client
    tokens = login(client)
    headers = authorization(tokens)
    denied = client.post("/v1/tracker/session", headers=headers)
    assert denied.status_code == 403

    discord.extra_role_ids = ["1549151900073459752"]
    client.post("/v1/me/recheck", headers=headers)
    still_denied = client.post("/v1/tracker/session", headers=headers)
    assert still_denied.status_code == 403

    discord.extra_role_ids = ["1554650259152576513"]
    client.post("/v1/me/recheck", headers=headers)
    minted = client.post("/v1/tracker/session", headers=headers)
    assert minted.status_code == 200, minted.text
    body = minted.json()
    assert body["token"]
    assert body["ttl_seconds"] == 3600
    assert body["day"] == datetime.now(UTC).strftime("%Y-%m-%d")


def test_tracker_feed_requires_session_token_for_beta(identity_client):
    client, discord = identity_client
    tokens = login(client)
    headers = authorization(tokens)
    discord.extra_role_ids = ["1554650259152576513"]
    client.post("/v1/me/recheck", headers=headers)
    client.app.state.settings.tracker_feed_enabled = True
    client.app.state.settings.discord_tracker_channel_id = "1550000000000000001"

    missing = client.get("/v1/tracker/feed", headers=headers)
    assert missing.status_code == 401

    session = client.post("/v1/tracker/session", headers=headers).json()
    feed_headers = {**headers, "X-Tracker-Session": session["token"]}
    response = client.get("/v1/tracker/feed", headers=feed_headers)
    assert response.status_code == 200, response.text


def test_tracker_feed_kill_switch_blocks_discord_read(identity_client):
    client, discord = identity_client
    tokens = login(client)
    headers = authorization(tokens)
    discord.extra_role_ids = ["1554650259152576513"]
    client.post("/v1/me/recheck", headers=headers)
    client.app.state.settings.tracker_feed_enabled = False
    client.app.state.settings.discord_tracker_channel_id = "1550000000000000001"
    client.app.state.settings.discord_tracker_guild_id = "1550000000000000002"

    session = client.post("/v1/tracker/session", headers=headers).json()
    feed_headers = {**headers, "X-Tracker-Session": session["token"]}

    calls = []
    original = discord.request

    def request(method, path, **kwargs):
        calls.append((method, path))
        return original(method, path, **kwargs)

    discord.request = request
    response = client.get("/v1/tracker/feed", headers=feed_headers)
    assert response.status_code == 200
    body = response.json()
    assert body["items"] == []
    assert body["live"] is False
    assert not any("/channels/" in path and "/messages" in path for _, path in calls)


def test_tracker_feed_reports_bot_cannot_read_channel(identity_client):
    client, discord = identity_client
    tokens = login(client)
    headers = authorization(tokens)
    discord.extra_role_ids = ["1554650259152576513"]
    client.post("/v1/me/recheck", headers=headers)
    client.app.state.settings.tracker_feed_enabled = True
    client.app.state.settings.discord_tracker_channel_id = "1550000000000000001"
    client.app.state.settings.discord_tracker_players_channel_id = ""
    client.app.state.settings.discord_tracker_guild_id = "1550000000000000002"

    class ForbiddenResponse:
        status_code = 403

        @staticmethod
        def json():
            return {"message": "Missing Access"}

    original = discord.request

    def request(method, path, **kwargs):
        if method == "GET" and path.endswith("/channels/1550000000000000001/messages"):
            return ForbiddenResponse()
        return original(method, path, **kwargs)

    discord.request = request
    session = client.post("/v1/tracker/session", headers=headers).json()
    feed_headers = {**headers, "X-Tracker-Session": session["token"]}
    response = client.get("/v1/tracker/feed", headers=feed_headers)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["unavailable"] is True
    assert body["bot_issue"] is True
    assert "View Channel" in body["reason"]
    assert "Read Message History" in body["reason"]


def test_tracker_feed_reads_configured_channel_when_enabled(identity_client):
    from datetime import UTC, datetime, timedelta

    client, discord = identity_client
    tokens = login(client)
    headers = authorization(tokens)
    discord.extra_role_ids = ["1554650259152576513"]
    client.post("/v1/me/recheck", headers=headers)
    client.app.state.settings.tracker_feed_enabled = True
    client.app.state.settings.discord_tracker_channel_id = "1550000000000000001"
    client.app.state.settings.discord_tracker_guild_id = "1550000000000000002"
    fresh_stamp = (datetime.now(UTC) - timedelta(minutes=1)).isoformat()

    class FeedResponse:
        status_code = 200

        @staticmethod
        def json():
            return [
                {
                    "id": "200",
                    "timestamp": fresh_stamp,
                    "content": "Special Cosmetic Alert",
                    # Poster bot can differ from the Engine role-verify bot.
                    "author": {
                        "id": "1552132434714169394",
                        "username": "Tracker",
                        "avatar": None,
                    },
                    "embeds": [
                        {
                            "title": "Special Cosmetic Detected",
                            "description": "",
                            "fields": [
                                {"name": "Username", "value": "EPICCOOLDUDE", "inline": False},
                                {"name": "ID", "value": "EDA1204079BEAB51", "inline": False},
                                {"name": "Color", "value": "255 0 0", "inline": False},
                                {"name": "Platform", "value": "PC", "inline": False},
                                {"name": "Room", "value": "OYM", "inline": False},
                                {"name": "Region", "value": "USW", "inline": False},
                                {
                                    "name": "Cosmetics",
                                    "value": "AA CREATOR BADGE",
                                    "inline": False,
                                },
                            ],
                        }
                    ],
                }
            ]

    original = discord.request

    def request(method, path, **kwargs):
        if method == "GET" and path.endswith("/channels/1550000000000000001/messages"):
            return FeedResponse()
        return original(method, path, **kwargs)

    discord.request = request
    session = client.post("/v1/tracker/session", headers=headers).json()
    feed_headers = {**headers, "X-Tracker-Session": session["token"]}
    response = client.get("/v1/tracker/feed", headers=feed_headers)
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["enabled"] is True
    assert payload["live"] is True
    assert payload["configured"] is True
    assert payload["unavailable"] is False
    assert len(payload["items"]) == 1
    item = payload["items"][0]
    assert item["username"] == "EPICCOOLDUDE"
    assert item["player_id"] == "EDA1204079BEAB51"
    assert item["color"] == "255 0 0"
    assert item["platform"] == "PC"
    assert item["room"] == "OYM"
    assert item["region"] == "USW"
    assert item["cosmetic"] == "AA CREATOR BADGE"
    assert item["author"] == "EPICCOOLDUDE"
    assert item["embed_title"] == "AA CREATOR BADGE"
    assert item["track_kind"] == "rare"
    assert "EPICCOOLDUDE" in item["text"]
    # Private Discord deep-links must not ship to clients.
    assert item["url"] == ""


def test_tracker_feed_ignores_empty_plaintext_and_splits_room_sync(identity_client):
    from datetime import UTC, datetime, timedelta

    client, discord = identity_client
    tokens = login(client)
    headers = authorization(tokens)
    discord.extra_role_ids = ["1554650259152576513"]
    client.post("/v1/me/recheck", headers=headers)
    client.app.state.settings.tracker_feed_enabled = True
    client.app.state.settings.discord_tracker_channel_id = "1550000000000000001"
    client.app.state.settings.discord_tracker_players_channel_id = "1540889169642000505"
    client.app.state.settings.discord_tracker_guild_id = "1550000000000000002"
    fresh_stamp = (datetime.now(UTC) - timedelta(minutes=1)).isoformat()

    class RareResponse:
        status_code = 200

        @staticmethod
        def json():
            return [
                {
                    "id": "10",
                    "timestamp": fresh_stamp,
                    "content": "",
                    "author": {"id": "1", "username": "noise", "avatar": None},
                    "embeds": [],
                },
                {
                    "id": "11",
                    "timestamp": fresh_stamp,
                    "content": "   ",
                    "author": {"id": "1", "username": "noise", "avatar": None},
                    "embeds": [],
                },
            ]

    class PlayersResponse:
        status_code = 200

        @staticmethod
        def json():
            return [
                {
                    "id": "300",
                    "timestamp": fresh_stamp,
                    "content": "",
                    "author": {
                        "id": "1552132434714169394",
                        "username": "Tracker",
                        "avatar": None,
                    },
                    "embeds": [
                        {
                            "title": "Room Sync Data",
                            "description": "",
                            "fields": [
                                {"name": "Directory", "value": "ELB3", "inline": True},
                                {"name": "Region", "value": "EU", "inline": True},
                                {"name": "Players", "value": "2", "inline": True},
                                {
                                    "name": "Player 1",
                                    "value": (
                                        "Username: MOODGORNING\n"
                                        "ID: 68DE288D5071E5C0\n"
                                        "Color: 255 0 0\n"
                                        "Platform: PC\n"
                                        "Cosmetics: LHAAS., LBAGO."
                                    ),
                                    "inline": False,
                                },
                                {
                                    "name": "Player 2",
                                    "value": (
                                        "Username: WATER\n"
                                        "ID: 55A9B8898FE42FE2\n"
                                        "Color: 170 227 255\n"
                                        "Platform: PC\n"
                                        "Cosmetics: Slingshot, BUILD01"
                                    ),
                                    "inline": False,
                                },
                            ],
                        }
                    ],
                }
            ]

    original = discord.request

    def request(method, path, **kwargs):
        if method == "GET" and path.endswith("/channels/1550000000000000001/messages"):
            return RareResponse()
        if method == "GET" and path.endswith("/channels/1540889169642000505/messages"):
            return PlayersResponse()
        return original(method, path, **kwargs)

    discord.request = request
    session = client.post("/v1/tracker/session", headers=headers).json()
    feed_headers = {**headers, "X-Tracker-Session": session["token"]}
    response = client.get("/v1/tracker/feed", headers=feed_headers)
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["unavailable"] is False
    assert len(payload["items"]) == 2
    by_name = {item["username"]: item for item in payload["items"]}
    assert set(by_name) == {"MOODGORNING", "WATER"}
    mood = by_name["MOODGORNING"]
    assert mood["track_kind"] == "player"
    assert mood["room"] == "ELB3"
    assert mood["region"] == "EU"
    assert mood["player_id"] == "68DE288D5071E5C0"
    assert mood["platform"] == "PC"
    assert mood["color"] == "255 0 0"
    assert "LHAAS" in mood["cosmetic"]
    assert mood["url"] == ""
    # Expanded ids stay unique per player (not the raw Discord message id alone).
    assert len({item["id"] for item in payload["items"]}) == 2
    assert all(item["id"] != "300" for item in payload["items"])


def test_tracker_feed_accepts_colour_and_player_id_labels(identity_client):
    from datetime import UTC, datetime, timedelta

    client, discord = identity_client
    tokens = login(client)
    headers = authorization(tokens)
    discord.extra_role_ids = ["1554650259152576513"]
    client.post("/v1/me/recheck", headers=headers)
    client.app.state.settings.tracker_feed_enabled = True
    client.app.state.settings.discord_tracker_channel_id = "1550000000000000001"
    client.app.state.settings.discord_tracker_players_channel_id = "1540889169642000505"
    fresh_stamp = (datetime.now(UTC) - timedelta(minutes=1)).isoformat()

    class RareResponse:
        status_code = 200

        @staticmethod
        def json():
            return [
                {
                    "id": "71",
                    "timestamp": fresh_stamp,
                    "content": "",
                    "author": {"id": "1", "username": "Tracker", "avatar": None},
                    "embeds": [
                        {
                            "title": "Special Cosmetic",
                            "color": 0xFF00AA,
                            "fields": [
                                {"name": "Username", "value": "RAREUSER", "inline": True},
                                {"name": "Player ID", "value": "ABCDEF0123456789", "inline": True},
                                {"name": "Room", "value": "ELB9", "inline": True},
                                {"name": "Region", "value": "US", "inline": True},
                                {"name": "Cosmetics", "value": "CREATOR", "inline": True},
                            ],
                        }
                    ],
                }
            ]

    class PlayersResponse:
        status_code = 200

        @staticmethod
        def json():
            return [
                {
                    "id": "72",
                    "timestamp": fresh_stamp,
                    "content": "",
                    "author": {"id": "1", "username": "Tracker", "avatar": None},
                    "embeds": [
                        {
                            "title": "Room Sync Data",
                            "fields": [
                                {"name": "Directory", "value": "ELB9", "inline": True},
                                {"name": "Region", "value": "US", "inline": True},
                                {
                                    "name": "Player 1",
                                    "value": (
                                        "Username: COLOURFAN\n"
                                        "Player ID: 1122334455667788\n"
                                        "Colour: 10, 20, 30\n"
                                        "Platform: Quest\n"
                                        "Cosmetics: NONE"
                                    ),
                                    "inline": False,
                                },
                            ],
                        }
                    ],
                }
            ]

    original = discord.request

    def request(method, path, **kwargs):
        if method == "GET" and path.endswith("/channels/1550000000000000001/messages"):
            return RareResponse()
        if method == "GET" and path.endswith("/channels/1540889169642000505/messages"):
            return PlayersResponse()
        return original(method, path, **kwargs)

    discord.request = request
    session = client.post("/v1/tracker/session", headers=headers).json()
    feed_headers = {**headers, "X-Tracker-Session": session["token"]}
    response = client.get("/v1/tracker/feed", headers=feed_headers)
    assert response.status_code == 200, response.text
    by_name = {item["username"]: item for item in response.json()["items"]}
    rare = by_name["RAREUSER"]
    assert rare["track_kind"] == "rare"
    assert rare["player_id"] == "ABCDEF0123456789"
    assert rare["color"] == "255 0 170"
    lobby = by_name["COLOURFAN"]
    assert lobby["track_kind"] == "player"
    assert lobby["player_id"] == "1122334455667788"
    assert lobby["color"] == "10 20 30"
    assert lobby["platform"] == "Quest"


def test_tracker_feed_persists_sightings_and_honors_lookback(identity_client):
    from datetime import UTC, datetime, timedelta

    client, discord = identity_client
    tokens = login(client)
    headers = authorization(tokens)
    discord.extra_role_ids = ["1554650259152576513"]
    client.post("/v1/me/recheck", headers=headers)
    client.app.state.settings.tracker_feed_enabled = True
    client.app.state.settings.discord_tracker_channel_id = "1550000000000000001"
    client.app.state.settings.discord_tracker_players_channel_id = "1540889169642000505"
    fresh_stamp = (datetime.now(UTC) - timedelta(minutes=2)).isoformat()

    class RareResponse:
        status_code = 200

        @staticmethod
        def json():
            return []

    class PlayersResponse:
        status_code = 200

        @staticmethod
        def json():
            return [
                {
                    "id": "9001",
                    "timestamp": fresh_stamp,
                    "content": "",
                    "author": {"id": "1", "username": "Tracker", "avatar": None},
                    "embeds": [
                        {
                            "title": "Room Sync Data",
                            "fields": [
                                {"name": "Directory", "value": "ELB3", "inline": True},
                                {"name": "Region", "value": "EU", "inline": True},
                                {"name": "Players", "value": "1", "inline": True},
                                {
                                    "name": "Player 1",
                                    "value": (
                                        "Username: LOOKBACK\n"
                                        "ID: AABBCCDDEEFF0011\n"
                                        "Color: 1 2 3\n"
                                        "Platform: PC\n"
                                        "Cosmetics: NONE"
                                    ),
                                    "inline": False,
                                },
                            ],
                        }
                    ],
                }
            ]

    original = discord.request

    def request(method, path, **kwargs):
        if method == "GET" and path.endswith("/channels/1550000000000000001/messages"):
            return RareResponse()
        if method == "GET" and path.endswith("/channels/1540889169642000505/messages"):
            return PlayersResponse()
        return original(method, path, **kwargs)

    discord.request = request
    session = client.post("/v1/tracker/session", headers=headers).json()
    feed_headers = {**headers, "X-Tracker-Session": session["token"]}

    first = client.get("/v1/tracker/feed?lookback_seconds=180", headers=feed_headers)
    assert first.status_code == 200, first.text
    assert first.json()["lookback_seconds"] == 180
    assert first.json()["retention_seconds"] == 5 * 24 * 60 * 60
    assert len(first.json()["items"]) == 1

    # Stop Discord reads — history must still come from Postgres for longer windows.
    def dead_request(method, path, **kwargs):
        if method == "GET" and "/channels/" in path and path.endswith("/messages"):
            class Boom:
                status_code = 403

                @staticmethod
                def json():
                    return {"message": "Missing Access"}

            return Boom()
        return original(method, path, **kwargs)

    discord.request = dead_request
    # 3h is the max lookback preset (10800s). Oversized values normalize down.
    archived = client.get("/v1/tracker/feed?lookback_seconds=10800", headers=feed_headers)
    assert archived.status_code == 200, archived.text
    payload = archived.json()
    assert payload["lookback_seconds"] == 10800
    assert payload["unavailable"] is False
    assert len(payload["items"]) == 1
    assert payload["items"][0]["player_id"] == "AABBCCDDEEFF0011"
    assert payload["items"][0]["username"] == "LOOKBACK"
    oversized = client.get("/v1/tracker/feed?lookback_seconds=86400", headers=feed_headers)
    assert oversized.status_code == 422


def test_tracker_session_rejects_wrong_day(identity_client, monkeypatch):
    client, discord = identity_client
    tokens = login(client)
    headers = authorization(tokens)
    discord.extra_role_ids = ["1554650259152576513"]
    client.post("/v1/me/recheck", headers=headers)

    session = client.post("/v1/tracker/session", headers=headers).json()
    import jwt as pyjwt
    from ii_api.tracker import TRACKER_SESSION_AUDIENCE

    secret = client.app.state.settings.access_token_signing_key.get_secret_value()
    claim = pyjwt.decode(
        session["token"],
        secret,
        algorithms=["HS256"],
        audience=TRACKER_SESSION_AUDIENCE,
        issuer="ii-engine",
    )
    claim["day"] = "2099-01-01"
    stale = pyjwt.encode(claim, secret, algorithm="HS256")
    feed_headers = {**headers, "X-Tracker-Session": stale}
    client.app.state.settings.tracker_feed_enabled = True
    client.app.state.settings.discord_tracker_channel_id = "1550000000000000001"
    response = client.get("/v1/tracker/feed", headers=feed_headers)
    assert response.status_code == 401


def test_tracker_feed_cors_allows_session_header(identity_client):
    """Desktop sends X-Tracker-Session; CORS must allow it or the webview shows a fake network error."""
    client, _ = identity_client
    origin = client.app.state.settings.frontend_origin
    response = client.options(
        "/v1/tracker/feed",
        headers={
            "Origin": origin,
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "authorization,x-tracker-session",
        },
    )
    assert response.status_code == 200, response.text
    allowed = response.headers.get("access-control-allow-headers", "").lower()
    assert "x-tracker-session" in allowed
    assert response.headers.get("access-control-allow-origin") == origin


def test_room_sync_parses_markdown_and_backtick_player_blocks():
    from ii_api.tracker import _players_from_room_sync_embed

    room, region, players = _players_from_room_sync_embed(
        {
            "title": "Room Sync Data",
            "fields": [
                {"name": "Directory", "value": "KDFL", "inline": True},
                {"name": "Region", "value": "EU", "inline": True},
                {
                    "name": "Player 1",
                    "value": (
                        "**Username:** CAVERN\n"
                        "**Player ID:** aabbccddeeff0011\n"
                        "**Colour:** 255, 120, 40\n"
                        "**Platform:** PC"
                    ),
                    "inline": False,
                },
                {
                    "name": "Player 2",
                    "value": "Username: `BANSHEE`\nID: `68DE288D5071E5C0`\nColor: `0 180 255`",
                    "inline": False,
                },
                {
                    "name": "Player 3",
                    "value": "SILLYWAFFLE\n1122334455667788\n40 60 180\nQuest",
                    "inline": False,
                },
            ],
        }
    )
    assert room == "KDFL"
    assert region == "EU"
    by_name = {player["username"]: player for player in players}
    assert by_name["CAVERN"]["id"] == "AABBCCDDEEFF0011"
    assert by_name["CAVERN"]["color"] == "255 120 40"
    assert by_name["BANSHEE"]["id"] == "68DE288D5071E5C0"
    assert by_name["BANSHEE"]["color"] == "0 180 255"
    assert by_name["SILLYWAFFLE"]["id"] == "1122334455667788"
    assert by_name["SILLYWAFFLE"]["color"] == "40 60 180"
