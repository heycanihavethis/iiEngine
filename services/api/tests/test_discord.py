import secrets

import httpx
import pytest

from ii_api.config import Settings
from ii_api.discord import DiscordREST, ProviderUnavailable


def configuration():
    return Settings(
        _env_file=None,
        discord_bot_token=secrets.token_urlsafe(32),
        discord_client_secret=secrets.token_urlsafe(32),
        discord_developer_role_ids="100000000000000002",
        discord_oauth_redirect_uri="https://example.invalid/v1/auth/discord/callback",
    )


def test_oauth_rate_limit_retries_once_when_retry_after_is_short():
    calls = []

    def respond(request):
        calls.append(request.url.path)
        if len(calls) == 1:
            return httpx.Response(429, headers={"Retry-After": "1"})
        return httpx.Response(200, json={"access_token": "fixture-token"})

    provider = DiscordREST(configuration(), httpx.MockTransport(respond))
    response = provider.request("POST", "/oauth2/token", bot=False, data={"code": "x"})
    assert response.status_code == 200
    assert len(calls) == 2
    provider.close()


def test_rate_limit_stops_followup_requests_without_retry_storm():
    calls = []

    def respond(request):
        calls.append(request)
        return httpx.Response(429, headers={"Retry-After": "60"})

    provider = DiscordREST(configuration(), httpx.MockTransport(respond))
    for _ in range(5):
        with pytest.raises(ProviderUnavailable):
            provider.request("GET", "/guilds/fixture/roles")
    assert len(calls) == 1
    provider.close()


def test_bot_rate_limit_does_not_block_oauth_token_exchange():
    calls = []

    def respond(request):
        calls.append((request.method, request.url.path))
        if request.url.path.endswith("/guilds/fixture/members/1"):
            return httpx.Response(429, headers={"Retry-After": "30"})
        if request.url.path.endswith("/oauth2/token"):
            return httpx.Response(200, json={"access_token": secrets.token_urlsafe(24)})
        if request.url.path.endswith("/users/@me"):
            return httpx.Response(200, json={"id": "100000000000000001", "username": "Fixture"})
        if request.url.path.endswith("/oauth2/token/revoke"):
            return httpx.Response(200, json={})
        return httpx.Response(200, json={})

    provider = DiscordREST(configuration(), httpx.MockTransport(respond))
    try:
        try:
            provider.request("GET", "/guilds/fixture/members/1")
            raise AssertionError("expected bot rate limit")
        except ProviderUnavailable:
            pass
        assert provider.identity("fixture-code")["display_name"] == "Fixture"
        assert any(path.endswith("/oauth2/token") for _, path in calls)
    finally:
        provider.close()


def test_identity_scope_token_discard_and_minimal_profile():
    calls = []

    def respond(request):
        calls.append(request)
        if request.url.path.endswith("/oauth2/token"):
            return httpx.Response(200, json={"access_token": secrets.token_urlsafe(32)})
        if request.url.path.endswith("/users/@me"):
            return httpx.Response(200, json={"id": "100000000000000001", "username": "Fixture"})
        if "/users/@me/guilds/" in request.url.path and request.url.path.endswith("/member"):
            return httpx.Response(404)
        return httpx.Response(200, json={})

    provider = DiscordREST(configuration(), httpx.MockTransport(respond))
    assert "guilds.members.read" in provider.authorize_url("fixture-state")
    assert "identify" in provider.authorize_url("fixture-state")
    profile = provider.identity("fixture-code")
    assert profile["display_name"] == "Fixture"
    assert profile["login_membership"]["membership"] is False
    assert calls[-1].url.path.endswith("/oauth2/token/revoke")
    assert "Bot " not in calls[1].headers["Authorization"]
    provider.close()


def test_authorize_url_honors_identify_only_oauth_scopes():
    settings = configuration()
    settings.discord_oauth_scopes = "identify"
    provider = DiscordREST(settings, httpx.MockTransport(lambda request: httpx.Response(200, json={})))
    url = provider.authorize_url("fixture-state")
    assert "scope=identify" in url
    assert "guilds.members.read" not in url
    provider.close()


def test_identity_captures_user_token_guild_membership():
    def respond(request):
        if request.url.path.endswith("/oauth2/token"):
            return httpx.Response(200, json={"access_token": "user-token"})
        if request.url.path.endswith("/users/@me"):
            return httpx.Response(200, json={"id": "100000000000000001", "username": "Fixture"})
        if "/users/@me/guilds/" in request.url.path and request.url.path.endswith("/member"):
            return httpx.Response(200, json={"roles": ["100000000000000002"]})
        if request.url.path.endswith("/roles"):
            return httpx.Response(
                200,
                json=[
                    {
                        "id": "100000000000000002",
                        "name": "Developer",
                        "color": 0,
                        "position": 5,
                    }
                ],
            )
        if request.url.path.endswith("/oauth2/token/revoke"):
            return httpx.Response(200, json={})
        return httpx.Response(404)

    provider = DiscordREST(configuration(), httpx.MockTransport(respond))
    profile = provider.identity("fixture-code")
    assert profile["login_membership"]["membership"] is True
    assert "developer" in profile["login_membership"]["entitlements"]
    provider.close()


def test_roles_entitlements_and_engine_role_routes():
    calls = []

    def respond(request):
        calls.append(request)
        if request.method in ("PUT", "DELETE"):
            return httpx.Response(204)
        if request.url.path.endswith("/roles"):
            return httpx.Response(
                200,
                json=[
                    {
                        "id": "100000000000000004",
                        "name": "Admin display",
                        "color": 0,
                        "managed": False,
                        "position": 8,
                        "unicode_emoji": None,
                        "icon": "a" * 32,
                    },
                    {
                        "id": "100000000000000002",
                        "name": "Dev",
                        "color": 123,
                        "managed": False,
                        "position": 3,
                        "unicode_emoji": "💻",
                        "icon": None,
                    },
                    {
                        "id": "100000000000000003",
                        "name": "Integration",
                        "color": 0,
                        "managed": True,
                    },
                ],
            )
        return httpx.Response(
            200,
            json={
                "roles": [
                    "100000000000000002",
                    "100000000000000003",
                    "100000000000000004",
                ]
            },
        )

    provider = DiscordREST(configuration(), httpx.MockTransport(respond))
    member = provider.membership("100000000000000001")
    assert member["entitlements"] == ["user", "developer"]
    assert member["roles"] == [
        {
            "id": "100000000000000004",
            "name": "Admin display",
            "color": "#cbd5e1",
            "emoji": None,
            "icon_url": "https://cdn.discordapp.com/role-icons/100000000000000004/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png",
            "position": 8,
        },
        {
            "id": "100000000000000002",
            "name": "Dev",
            "color": "#00007b",
            "emoji": "💻",
            "icon_url": None,
            "position": 3,
        },
    ]
    provider.engine_role("100000000000000001")
    provider.engine_role("100000000000000001", remove=True)
    assert calls[-1].method == "DELETE" and calls[-2].method == "PUT"
    assert calls[-1].url.path.endswith("/roles/1548883777462206625")
    provider.close()


def test_beta_engine_user_role_adds_beta_entitlement():
    config = configuration()
    config.discord_beta_role_ids = "1549421049287020568"

    def respond(request):
        if request.url.path.endswith("/roles"):
            return httpx.Response(200, json=[])
        return httpx.Response(200, json={"roles": ["1549421049287020568"]})

    provider = DiscordREST(config, httpx.MockTransport(respond))
    assert provider.membership("100000000000000001")["entitlements"] == ["user", "beta"]
    provider.close()


def test_full_engine_access_role_adds_autoloader_entitlement():
    config = configuration()
    config.discord_full_access_role_ids = "1549986950793007215"

    def respond(request):
        if request.url.path.endswith("/roles"):
            return httpx.Response(200, json=[])
        return httpx.Response(200, json={"roles": ["1549986950793007215"]})

    provider = DiscordREST(config, httpx.MockTransport(respond))
    assert provider.membership("100000000000000001")["entitlements"] == [
        "user",
        "full_access",
    ]
    provider.close()


def test_pro_role_adds_pro_entitlement():
    config = configuration()
    config.discord_pro_role_ids = "1552000000000000001"

    def respond(request):
        if request.url.path.endswith("/roles"):
            return httpx.Response(200, json=[])
        return httpx.Response(200, json={"roles": ["1552000000000000001"]})

    provider = DiscordREST(config, httpx.MockTransport(respond))
    assert provider.membership("100000000000000001")["entitlements"] == ["user", "pro", "beta"]
    provider.close()


@pytest.mark.parametrize("status", [401, 403, 429, 500])
def test_discord_errors_are_safe(status):
    provider = DiscordREST(
        configuration(),
        httpx.MockTransport(
            lambda request: httpx.Response(status, text="sensitive upstream response")
        ),
    )
    with pytest.raises(ProviderUnavailable) as error:
        provider.membership("100000000000000001")
    assert "sensitive" not in str(error.value)
    provider.close()


def test_membership_cache_avoids_repeat_discord_calls():
    calls = []

    def respond(request):
        calls.append(request.url.path)
        if request.url.path.endswith("/members/100000000000000001"):
            return httpx.Response(
                200,
                json={"roles": ["100000000000000002"]},
            )
        if request.url.path.endswith("/roles"):
            return httpx.Response(
                200,
                json=[
                    {
                        "id": "100000000000000002",
                        "name": "Member",
                        "color": 0,
                        "position": 1,
                        "managed": False,
                    },
                    {"id": "1170093288557129748", "name": "@everyone", "color": 0, "position": 0},
                ],
            )
        return httpx.Response(500)

    provider = DiscordREST(configuration(), httpx.MockTransport(respond))
    first = provider.membership("100000000000000001")
    second = provider.membership("100000000000000001")
    assert first["membership"] is True
    assert second["membership"] is True
    # member + roles once, then cache hit
    member_calls = [path for path in calls if path.endswith("/members/100000000000000001")]
    assert len(member_calls) == 1
    provider.close()


def test_membership_stale_cache_survives_discord_outage():
    calls = []
    mode = {"fail": False}

    def respond(request):
        calls.append(request.url.path)
        if mode["fail"]:
            return httpx.Response(503, text="discord unavailable")
        if request.url.path.endswith("/members/100000000000000001"):
            return httpx.Response(200, json={"roles": ["100000000000000002"]})
        if request.url.path.endswith("/roles"):
            return httpx.Response(
                200,
                json=[
                    {
                        "id": "100000000000000002",
                        "name": "Member",
                        "color": 0,
                        "position": 1,
                        "managed": False,
                    }
                ],
            )
        return httpx.Response(500)

    provider = DiscordREST(configuration(), httpx.MockTransport(respond))
    assert provider.membership("100000000000000001")["membership"] is True
    # Expire the fresh TTL but keep the stale window.
    key = "100000000000000001"
    stamped_at, payload = provider._membership_cache[key]
    provider._membership_cache[key] = (stamped_at - 130, payload)
    mode["fail"] = True
    before = len(calls)
    stale = provider.membership("100000000000000001")
    assert stale["membership"] is True
    assert len(calls) > before  # attempted refresh
    provider.close()


def test_list_channel_messages_between_filters_by_window():
    from datetime import UTC, datetime

    calls = []
    start = datetime(2026, 3, 29, 14, 0, tzinfo=UTC)
    end = datetime(2026, 3, 29, 15, 0, tzinfo=UTC)
    after_snowflake = DiscordREST.snowflake_after(start)

    def respond(request):
        calls.append((request.method, request.url.path, dict(request.url.params)))
        assert request.url.path.endswith("/channels/1552761810523000842/messages")
        assert request.url.params.get("after") == after_snowflake
        return httpx.Response(
            200,
            json=[
                {
                    "id": "200",
                    "timestamp": "2026-03-29T14:30:00.000+00:00",
                    "content": "sale A",
                    "author": {"username": "Shop"},
                },
                {
                    "id": "100",
                    "timestamp": "2026-03-29T13:59:00.000+00:00",
                    "content": "too early",
                    "author": {"username": "Shop"},
                },
                {
                    "id": "300",
                    "timestamp": "2026-03-29T15:00:00.000+00:00",
                    "content": "too late",
                    "author": {"username": "Shop"},
                },
            ],
        )

    provider = DiscordREST(configuration(), httpx.MockTransport(respond))
    rows = provider.list_channel_messages_between(
        "1552761810523000842",
        start=start,
        end=end,
    )
    assert [row["content"] for row in rows] == ["sale A"]
    assert calls and calls[0][0] == "GET"
    provider.close()


def test_post_channel_message_accepts_embeds():
    bodies = []

    def respond(request):
        bodies.append(request.read())
        return httpx.Response(200, json={"id": "1"})

    provider = DiscordREST(configuration(), httpx.MockTransport(respond))
    provider.post_channel_message(
        "1554599230083965069",
        "summary",
        embeds=[{"title": "ii Engine · Hourly Pulse", "color": 0xED7602}],
    )
    assert b"Hourly Pulse" in bodies[0]
    provider.close()
