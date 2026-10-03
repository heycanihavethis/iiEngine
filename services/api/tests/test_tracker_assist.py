import ii_api.ai as ai_mod
from conftest import login
from test_identity import authorization


class FakeAI:
    last_prompt = ""
    last_system = ""
    last_max_tokens = 0
    response = "Volt was seen at 14:00Z and 15:00Z in rooms ZZ2A and ELB3."

    async def complete(self, prompt, *, system="", max_tokens=1024, **_kwargs):
        FakeAI.last_prompt = prompt
        FakeAI.last_system = system
        FakeAI.last_max_tokens = max_tokens
        return self.response

    async def stream(self, message, *, system="", max_tokens=1024, **_kwargs):
        FakeAI.last_prompt = message
        FakeAI.last_system = system
        yield self.response

    async def close(self):
        return None


DIGEST = """TRACKER_DIGEST v1 window=3d players=1 generated=2026-10-01T16:00:00.000Z
Fields: nick|id|color|rooms|regions|first|last|sightings|utc_hours_by_day
Volt|8899AABBCCDDEEFF|255 0 0|ZZ2A,ELB3|EU|2026-10-01T14:10:00.000Z|2026-10-01T15:40:00.000Z|2|2026-10-01@14:00Z,15:00Z
"""


def test_tracker_assist_uses_digest_and_small_token_budget(identity_client):
    client, fake = identity_client
    FakeAI.last_prompt = ""
    FakeAI.last_system = ""
    FakeAI.last_max_tokens = 0
    client.app.state.ai_provider = FakeAI()
    headers = authorization(login(client))
    fake.extra_role_ids = ["1549151900073459752"]
    client.post("/v1/me/recheck", headers=headers)
    response = client.post(
        "/v1/ai/tracker-assist",
        headers=headers,
        json={"message": "When was Volt online?", "digest": DIGEST},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert "Volt" in body["answer"]
    assert body["daily_limit"] == 25
    assert isinstance(body["remaining"], int)
    assert "8899AABBCCDDEEFF" in FakeAI.last_prompt
    assert "TRACKER_DIGEST" in FakeAI.last_prompt
    assert "invent" in FakeAI.last_system.casefold() or "only from" in FakeAI.last_system.casefold()
    assert FakeAI.last_max_tokens <= 900


def test_tracker_assist_rejects_invalid_digest_and_enforces_bucket(identity_client, monkeypatch):
    client, fake = identity_client
    client.app.state.ai_provider = FakeAI()
    headers = authorization(login(client))
    fake.extra_role_ids = ["1549151900073459752"]
    client.post("/v1/me/recheck", headers=headers)
    bad = client.post(
        "/v1/ai/tracker-assist",
        headers=headers,
        json={"message": "hello", "digest": "not a digest at all!!!!!!"},
    )
    assert bad.status_code == 422

    # Stay under the /v1/ai IP burst (20/min) while still exhausting the daily bucket.
    monkeypatch.setattr(ai_mod, "TRACKER_SCOUT_DAILY_LIMIT", 3)
    monkeypatch.setattr(ai_mod, "TRACKER_ASSIST_DAILY_LIMIT", 3)
    for _ in range(3):
        ok = client.post(
            "/v1/ai/tracker-assist",
            headers=headers,
            json={"message": "When was Volt online?", "digest": DIGEST},
        )
        assert ok.status_code == 200, ok.text
    limited = client.post(
        "/v1/ai/tracker-assist",
        headers=headers,
        json={"message": "When was Volt online?", "digest": DIGEST},
    )
    assert limited.status_code == 429
