from concurrent.futures import ThreadPoolExecutor

from ii_api.limits import RequestLimits


def test_atomic_auth_limit_and_expiry_without_retaining_addresses():
    now = [10.0]
    limits = RequestLimits(clock=lambda: now[0])
    with ThreadPoolExecutor(max_workers=16) as pool:
        answers = list(
            pool.map(lambda _: limits.check("synthetic-client", "/v1/auth/requests"), range(50))
        )
    assert answers.count(0) == 10
    assert "synthetic-client" not in repr(limits.buckets)
    assert limits.check("another-client", "/v1/auth/requests") == 0
    now[0] += 601
    assert limits.check("synthetic-client", "/v1/auth/requests") == 0


def test_ai_and_telemetry_burst_limits():
    now = [10.0]
    limits = RequestLimits(clock=lambda: now[0])
    assert sum(1 for _ in range(20) if limits.check("ai-client", "/v1/ai/chat") == 0) == 20
    assert limits.check("ai-client", "/v1/ai/chat") > 0
    assert sum(1 for _ in range(12) if limits.check("tel-client", "/v1/telemetry") == 0) == 12
    assert limits.check("tel-client", "/v1/telemetry/session-log") > 0


def test_limit_response_has_retry_after_and_no_request_content(identity_client):
    client, _ = identity_client
    for _ in range(10):
        client.post("/v1/auth/requests", json={"challenge": "x" * 43})
    response = client.post("/v1/auth/requests", json={"challenge": "private"})
    assert response.status_code == 429
    assert int(response.headers["Retry-After"]) > 0
    assert response.headers["Cache-Control"] == "no-store"
    assert "private" not in response.text
    cors = client.post(
        "/v1/auth/requests",
        json={"challenge": "x" * 43},
        headers={"Origin": client.app.state.settings.frontend_origin},
    )
    assert cors.status_code == 429
    assert cors.headers["Access-Control-Allow-Origin"] == client.app.state.settings.frontend_origin
    assert client.get("/health/live").status_code == 200


def test_production_limits_use_railway_real_ip(identity_client):
    client, _ = identity_client
    client.app.state.settings.app_env = "production"
    first = {"X-Real-IP": "203.0.113.10"}
    second = {"X-Real-IP": "203.0.113.11"}
    for _ in range(10):
        assert (
            client.post(
                "/v1/auth/requests", json={"challenge": "x" * 43}, headers=first
            ).status_code
            == 201
        )
    assert (
        client.post("/v1/auth/requests", json={"challenge": "x" * 43}, headers=first).status_code
        == 429
    )
    assert (
        client.post("/v1/auth/requests", json={"challenge": "x" * 43}, headers=second).status_code
        == 201
    )
