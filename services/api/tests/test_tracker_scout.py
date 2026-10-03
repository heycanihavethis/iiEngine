from datetime import UTC, datetime, timedelta

from conftest import login
from ii_api.ai import (
    _answer_looks_ungrounded,
    _empty_scout_answer,
    _infer_scout_search_plan,
    _parse_scout_plan,
    _sanitize_scout_user_text,
)
from ii_api.models import TrackerSighting
from ii_api.tracker import (
    format_sightings_for_scout,
    resolve_scout_time_window,
    rollup_scout_players,
    search_sightings,
)
from sqlalchemy.orm import Session
from test_identity import authorization


class FakeAI:
    responses: list[str] = []
    last_system = ""
    last_prompt = ""
    last_max_tokens = 0

    async def complete(self, prompt, *, system="", max_tokens=1024, **_kwargs):
        FakeAI.last_prompt = prompt
        FakeAI.last_system = system
        FakeAI.last_max_tokens = max_tokens
        if FakeAI.responses:
            return FakeAI.responses.pop(0)
        return "ok"

    async def stream(self, message, *, system="", max_tokens=1024, **kwargs):
        yield await self.complete(message, system=system, max_tokens=max_tokens, **kwargs)

    async def close(self):
        return None


def test_empty_scout_answer_and_ungrounded_detector():
    assert "Nobody matched room HI" in _empty_scout_answer(
        [{"field": "room", "q": "HI", "hits": 0}]
    )
    hallucinated = (
        "No one matched. Check out the Mystic Trials room instead with "
        "the Enchanted Quill cosmetic."
    )
    assert _answer_looks_ungrounded(hallucinated, hits=[], players=[])
    grounded = "Volt was last in ROOM9 around 14:00 UTC."
    assert not _answer_looks_ungrounded(
        grounded,
        hits=[{"username": "Volt", "room": "ROOM9", "color": "1 2 3"}],
        players=[{"username": "Volt", "room": "ROOM9"}],
    )


def test_parse_scout_plan_chat_and_search():
    chat = _parse_scout_plan('{"mode":"chat","reply":"Hey there!"}')
    assert chat["mode"] == "chat"
    assert "Hey" in chat["reply"]
    search = _parse_scout_plan(
        '```json\n{"mode":"search","queries":[{"field":"username","q":"Volt"}]}\n```'
    )
    assert search["mode"] == "search"
    assert search["queries"][0]["q"] == "Volt"
    timed = _parse_scout_plan(
        '{"mode":"search","queries":[{"field":"room","q":"HI","day":"today","hour_utc":14}]}'
    )
    assert timed["queries"][0]["field"] == "room"
    assert timed["queries"][0]["q"] == "HI"
    assert timed["queries"][0]["day"] == "today"
    assert timed["queries"][0]["hour_utc"] == 14


def test_parse_scout_plan_rejects_concatenated_raw_json_leak():
    messy = (
        '{"mode":"search","queries":[{"field":"username|player_id|room|any",'
        '"q":"finger paitners","day":"today","hour_utc":23}]}```json\n'
        '{"mode":"chat","reply":"Checking for Finger Paitners online now."}\n```'
    )
    plan = _parse_scout_plan(messy)
    assert plan["mode"] == "search"
    assert plan["queries"][0]["q"] == "finger paitners"
    assert plan["queries"][0]["field"] == "username"
    assert "{" not in plan.get("reply", "")


def test_sanitize_scout_user_text_strips_plan_json():
    assert _sanitize_scout_user_text('{"mode":"search","queries":[{"q":"x"}]}') == ""
    assert "Checking" in _sanitize_scout_user_text(
        '{"mode":"chat","reply":"Checking lobbies now."}'
    )
    cleaned = _sanitize_scout_user_text(
        'Found them. {"mode":"search","queries":[{"field":"room","q":"HI"}]} More later.'
    )
    assert "Found them" in cleaned
    assert "mode" not in cleaned
    assert "queries" not in cleaned


def test_resolve_scout_time_window_hour_bucket():
    now = datetime(2026, 10, 1, 18, 0, tzinfo=UTC)
    since, until = resolve_scout_time_window(day="today", hour_utc=14, now=now)
    assert since == datetime(2026, 10, 1, 13, 30, tzinfo=UTC)
    assert until == datetime(2026, 10, 1, 15, 30, tzinfo=UTC)


def test_resolve_scout_time_window_lookback_minutes():
    now = datetime(2026, 10, 1, 18, 0, tzinfo=UTC)
    since, until = resolve_scout_time_window(lookback_minutes=60, now=now)
    assert until == now
    assert since == now - timedelta(minutes=60)


def test_infer_scout_search_plan_recent_players():
    plan = _infer_scout_search_plan("who was playing an hour ago")
    assert plan is not None
    assert plan["mode"] == "search"
    assert plan["queries"][0]["lookback_minutes"] >= 60
    assert plan["queries"][0]["q"] == ""
    assert _infer_scout_search_plan("hi") is None


def test_search_sightings_time_only_browse(identity_client):
    client, _ = identity_client
    engine = client.app.state.engine
    now = datetime.now(UTC)
    with Session(engine) as db:
        db.add(
            TrackerSighting(
                id="scout-recent-1",
                player_id="AABBCCDDEEFF0099",
                username="RecentOne",
                room="ZZ9A",
                region="EU",
                color="10 20 30",
                track_kind="player",
                author="Tracker",
                text="",
                embed_title="RecentOne",
                seen_at=now - timedelta(minutes=25),
            )
        )
        db.add(
            TrackerSighting(
                id="scout-old-1",
                player_id="1122334455667799",
                username="OldOne",
                room="AA1A",
                region="US",
                color="0 0 0",
                track_kind="player",
                author="Tracker",
                text="",
                embed_title="OldOne",
                seen_at=now - timedelta(hours=5),
            )
        )
        db.commit()
        since, until = resolve_scout_time_window(lookback_minutes=90, now=now)
        hits = search_sightings(db, query="", field="any", since=since, until=until, limit=40)
        names = {row["username"] for row in hits}
        assert "RecentOne" in names
        assert "OldOne" not in names


def test_search_sightings_filters_by_username(identity_client):
    client, _ = identity_client
    engine = client.app.state.engine
    now = datetime.now(UTC)
    with Session(engine) as db:
        db.add(
            TrackerSighting(
                id="scout-hit-1",
                player_id="AABBCCDDEEFF0011",
                username="VoltScout",
                room="ELB3",
                region="EU",
                color="255 0 0",
                track_kind="player",
                author="Tracker",
                text="",
                embed_title="VoltScout",
                seen_at=now - timedelta(hours=2),
            )
        )
        db.add(
            TrackerSighting(
                id="scout-miss-1",
                player_id="1122334455667788",
                username="OtherNick",
                room="ZZ2A",
                region="US",
                color="0 0 0",
                track_kind="player",
                author="Tracker",
                text="",
                embed_title="OtherNick",
                seen_at=now - timedelta(hours=1),
            )
        )
        db.commit()
        hits = search_sightings(db, query="Volt", field="username", limit=20)
        assert len(hits) == 1
        assert hits[0]["username"] == "VoltScout"
        block = format_sightings_for_scout(hits)
        assert "VoltScout" in block
        assert "ELB3" in block


def _tracker_headers(client, discord):
    headers = authorization(login(client))
    discord.extra_role_ids = ["1549151900073459752"]
    client.post("/v1/me/recheck", headers=headers)
    return headers


def test_tracker_scout_requires_ii_tracker_role(identity_client):
    client, discord = identity_client
    FakeAI.responses = ['{"mode":"chat","reply":"should not run"}']
    client.app.state.ai_provider = FakeAI()
    headers = authorization(login(client))
    # Pro alone (no ii Tracker role) must not reach Scout.
    discord.extra_role_ids = ["1551472794238320680"]
    client.post("/v1/me/recheck", headers=headers)
    response = client.post(
        "/v1/ai/tracker-scout",
        headers=headers,
        json={"message": "hi"},
    )
    assert response.status_code == 403, response.text


def test_tracker_scout_chat_skips_search(identity_client):
    client, discord = identity_client
    FakeAI.responses = ['{"mode":"chat","reply":"Hey! What lobby are we checking?"}']
    client.app.state.ai_provider = FakeAI()
    headers = _tracker_headers(client, discord)
    response = client.post(
        "/v1/ai/tracker-scout",
        headers=headers,
        json={"message": "hi"},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["mode"] == "chat"
    assert "Hey" in body["answer"]
    assert body["searches"] == []
    assert body["daily_limit"] == 25


def test_tracker_scout_empty_hits_never_asks_answer_model(identity_client):
    """Empty search must not invent alternate lobbies/cosmetics."""
    client, discord = identity_client
    FakeAI.responses = [
        '{"mode":"search","queries":[{"field":"room","q":"ArcaneExperiments"}]}',
        # If the answerer were called, this hallucinated text would leak.
        (
            "No one matched. Check out the Mystic Trials room instead — "
            "Enchanted Quill cosmetic and Mystic Blue."
        ),
    ]
    client.app.state.ai_provider = FakeAI()
    headers = _tracker_headers(client, discord)
    response = client.post(
        "/v1/ai/tracker-scout",
        headers=headers,
        json={"message": "anyone in ArcaneExperiments"},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["mode"] == "search"
    assert body.get("hit_count", 0) == 0
    assert "Mystic" not in body["answer"]
    assert "Enchanted" not in body["answer"]
    assert "Nobody matched" in body["answer"]
    # Planner consumed; hallucinated answerer response must remain unused.
    assert FakeAI.responses == [
        (
            "No one matched. Check out the Mystic Trials room instead — "
            "Enchanted Quill cosmetic and Mystic Blue."
        )
    ]


def test_tracker_scout_uncapped_role_gets_elevated_daily_limit(identity_client):
    client, discord = identity_client
    FakeAI.responses = ['{"mode":"chat","reply":"Elevated scout ready."}']
    client.app.state.ai_provider = FakeAI()
    client.app.state.settings.ai_uncapped_daily_request_limit = 500
    headers = authorization(login(client))
    discord.extra_role_ids = ["1549151900073459752", "1555606816291954819"]
    client.post("/v1/me/recheck", headers=headers)
    response = client.post(
        "/v1/ai/tracker-scout",
        headers=headers,
        json={"message": "hi"},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["daily_limit"] == 500
    assert body["remaining"] == 499


def test_tracker_scout_recent_browse_overrides_lazy_chat(identity_client):
    client, discord = identity_client
    engine = client.app.state.engine
    now = datetime.now(UTC)
    with Session(engine) as db:
        db.add(
            TrackerSighting(
                id="scout-hour-ago-1",
                player_id="FEEDFACECAFEBABE",
                username="HourAgoNick",
                room="RUN1",
                region="EU",
                color="200 100 50",
                track_kind="player",
                author="Tracker",
                text="",
                embed_title="HourAgoNick",
                seen_at=now - timedelta(minutes=50),
            )
        )
        db.commit()

    FakeAI.responses = [
        # Lazy planner wrongly chats; server should infer a recent search.
        '{"mode":"chat","reply":"I only have data from the last 5 days."}',
        # Unhelpful answerer should be replaced with a deterministic summary.
        "I only have data from the last 5 days.",
    ]
    client.app.state.ai_provider = FakeAI()
    headers = _tracker_headers(client, discord)
    response = client.post(
        "/v1/ai/tracker-scout",
        headers=headers,
        json={"message": "who was playing an hour ago"},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["mode"] == "search"
    assert body["hit_count"] >= 1
    assert any(player["username"] == "HourAgoNick" for player in body["players"])
    assert "5 days" not in body["answer"].lower()
    assert "HourAgoNick" in body["answer"]


def test_tracker_scout_never_returns_raw_planner_json(identity_client):
    client, discord = identity_client
    engine = client.app.state.engine
    now = datetime.now(UTC)
    with Session(engine) as db:
        db.add(
            TrackerSighting(
                id="scout-finger-1",
                player_id="AABBCCDDEEFF0011",
                username="Finger Paitners",
                room="ROOM9",
                region="EU",
                color="10 20 30",
                track_kind="player",
                author="Tracker",
                text="",
                embed_title="Finger Paitners",
                seen_at=now - timedelta(minutes=55),
            )
        )
        db.commit()
    FakeAI.responses = [
        (
            '{"mode":"search","queries":[{"field":"username|player_id|room|any",'
            '"q":"finger paitners"}]}```json\n'
            '{"mode":"chat","reply":"Checking for Finger Paitners online now."}\n```'
        ),
        "Finger Paitners was last seen in ROOM9 about an hour ago (UTC).",
    ]
    client.app.state.ai_provider = FakeAI()
    headers = _tracker_headers(client, discord)
    response = client.post(
        "/v1/ai/tracker-scout",
        headers=headers,
        json={"message": "where is finger paitners"},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["mode"] == "search"
    assert '{"mode"' not in body["answer"]
    assert "queries" not in body["answer"]
    assert "```" not in body["answer"]
    assert "Finger Paitners" in body["answer"]
    assert body.get("hit_count", 0) >= 1


def test_tracker_scout_search_then_answer(identity_client):
    client, discord = identity_client
    engine = client.app.state.engine
    now = datetime.now(UTC)
    with Session(engine) as db:
        db.add(
            TrackerSighting(
                id="scout-search-1",
                player_id="EDA1204079BEAB51",
                username="FlowerScout",
                room="ROOM1",
                region="EU",
                color="170 227 255",
                track_kind="player",
                author="Tracker",
                text="",
                embed_title="FlowerScout",
                seen_at=now - timedelta(minutes=30),
            )
        )
        db.commit()

    FakeAI.responses = [
        '{"mode":"search","queries":[{"field":"username","q":"Flower"}]}',
        "FlowerScout was in ROOM1 about 30 minutes ago (UTC).",
    ]
    client.app.state.ai_provider = FakeAI()
    headers = _tracker_headers(client, discord)
    response = client.post(
        "/v1/ai/tracker-scout",
        headers=headers,
        json={"message": "Where was Flower?"},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["mode"] == "search"
    assert body["hit_count"] == 1
    assert body["searches"][0]["q"] == "Flower"
    assert "FlowerScout" in body["answer"]
    assert "SEARCH_RESULTS" in FakeAI.last_prompt
    assert body["players"][0]["username"] == "FlowerScout"
    assert body["players"][0]["room"] == "ROOM1"


def test_tracker_scout_room_time_returns_player_pills(identity_client):
    client, discord = identity_client
    engine = client.app.state.engine
    now = datetime.now(UTC).replace(minute=0, second=0, microsecond=0)
    hour = 14 if now.hour != 14 else 15
    stamp = now.replace(hour=hour)
    with Session(engine) as db:
        db.add(
            TrackerSighting(
                id="scout-room-hi-1",
                player_id="AABBCCDDEEFF0011",
                username="CAVERN",
                room="HI",
                region="EU",
                color="255 120 40",
                track_kind="player",
                author="Tracker",
                text="",
                embed_title="CAVERN",
                seen_at=stamp + timedelta(minutes=5),
            )
        )
        db.add(
            TrackerSighting(
                id="scout-room-hi-2",
                player_id="1122334455667788",
                username="BANSHEE",
                room="HI",
                region="EU",
                color="40 60 180",
                track_kind="player",
                author="Tracker",
                text="",
                embed_title="BANSHEE",
                seen_at=stamp + timedelta(minutes=12),
            )
        )
        db.add(
            TrackerSighting(
                id="scout-room-other",
                player_id="DEADBEEF00C0FFEE",
                username="OUTSIDER",
                room="ZZ2A",
                region="US",
                color="0 0 0",
                track_kind="player",
                author="Tracker",
                text="",
                embed_title="OUTSIDER",
                seen_at=stamp + timedelta(minutes=8),
            )
        )
        db.commit()
        since, until = resolve_scout_time_window(day="today", hour_utc=hour, now=now)
        hits = search_sightings(db, query="HI", field="room", since=since, until=until, limit=40)
        assert {row["username"] for row in hits} == {"CAVERN", "BANSHEE"}
        pills = rollup_scout_players(hits)
        assert len(pills) == 2

    FakeAI.responses = [
        (
            '{"mode":"search","queries":[{"field":"room","q":"HI","day":"today","hour_utc":'
            + str(hour)
            + "}]}"
        ),
        "CAVERN and BANSHEE were in room HI around that hour (UTC).",
    ]
    client.app.state.ai_provider = FakeAI()
    headers = _tracker_headers(client, discord)
    response = client.post(
        "/v1/ai/tracker-scout",
        headers=headers,
        json={"message": f'Who was in room "HI" at {hour}:00 UTC today?'},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["mode"] == "search"
    assert body["hit_count"] == 2
    names = {player["username"] for player in body["players"]}
    assert names == {"CAVERN", "BANSHEE"}
