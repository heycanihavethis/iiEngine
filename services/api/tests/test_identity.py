from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta

from conftest import begin_login, login
from sqlalchemy.orm import Session

from ii_api.models import AuthRequest


def authorization(tokens):
    return {"Authorization": f"Bearer {tokens['access_token']}"}


def test_state_verifier_and_single_use(identity_client):
    client, fake = identity_client
    request_id, verifier, state = begin_login(client)
    assert (
        client.get(
            "/v1/auth/discord/callback", params={"state": "wrong", "code": "fixture"}
        ).status_code
        == 400
    )
    assert (
        client.post(f"/v1/auth/requests/{request_id}/poll", json={"verifier": "x" * 43}).status_code
        == 400
    )
    assert (
        client.post(f"/v1/auth/requests/{request_id}/poll", json={"verifier": verifier}).json()[
            "status"
        ]
        == "pending"
    )
    assert (
        client.get(
            "/v1/auth/discord/callback", params={"state": state, "code": "fixture"}
        ).status_code
        == 200
    )
    assert (
        client.get(
            "/v1/auth/discord/callback", params={"state": state, "code": "fixture"}
        ).status_code
        == 400
    )
    assert (
        client.post(f"/v1/auth/requests/{request_id}/poll", json={"verifier": verifier}).json()[
            "status"
        ]
        == "complete"
    )
    assert (
        client.post(f"/v1/auth/requests/{request_id}/poll", json={"verifier": verifier}).status_code
        == 400
    )
    assert len(fake.grants) == 1


def test_success_page_is_branded_secure_and_closes_itself(identity_client):
    client, _ = identity_client
    _, _, state = begin_login(client)
    response = client.get("/v1/auth/discord/callback", params={"state": state, "code": "fixture"})
    assert response.status_code == 200
    assert "Signed in to ii Engine" in response.text
    assert "iiengine://auth-complete" in response.text
    assert "Close this window" in response.text
    assert "Open ii Engine" in response.text
    assert response.headers["content-security-policy"].startswith("default-src 'none'")
    assert response.headers["referrer-policy"] == "no-referrer"
    assert response.headers["x-frame-options"] == "DENY"


def test_expired_state(identity_client):
    client, _ = identity_client
    request_id, verifier, state = begin_login(client)
    with Session(client.app.state.engine) as db:
        db.get(AuthRequest, request_id).expires_at = datetime.now(UTC) - timedelta(seconds=1)
        db.commit()
    assert (
        client.get(
            "/v1/auth/discord/callback", params={"state": state, "code": "fixture"}
        ).status_code
        == 400
    )
    assert (
        client.post(f"/v1/auth/requests/{request_id}/poll", json={"verifier": verifier}).status_code
        == 400
    )


def test_refresh_reuses_token_and_survives_retry(identity_client):
    client, _ = identity_client
    original = login(client)
    result = client.post("/v1/auth/refresh", json={"refresh_token": original["refresh_token"]})
    assert result.status_code == 200
    refreshed = result.json()
    assert refreshed["refresh_token"] == original["refresh_token"]
    assert "access_token" in refreshed
    assert client.get("/v1/me", headers=authorization(refreshed)).status_code == 200
    # Retrying the same refresh must not wipe the session (desktop vault races).
    again = client.post("/v1/auth/refresh", json={"refresh_token": original["refresh_token"]})
    assert again.status_code == 200
    assert again.json()["refresh_token"] == original["refresh_token"]
    assert client.get("/v1/me", headers=authorization(again.json())).status_code == 200
    assert client.get("/v1/me", headers=authorization(refreshed)).status_code == 200


def test_dashboard_survives_discord_membership_outage(identity_client):
    client, fake = identity_client
    tokens = login(client)
    fake.fail_membership = True
    response = client.get("/v1/dashboard", headers=authorization(tokens))
    assert response.status_code == 200
    assert response.json()["member"]["membership"] is True
    assert response.json()["member"]["entitlements"] == ["user"]


def test_membership_outage_never_returns_503_and_keeps_role_grant_snapshot(identity_client):
    """Live Discord + RoleGrant snapshot: Engine must stay open without the 503 banner."""
    client, fake = identity_client
    fake.staff = True
    fake.extra_entitlements = ["pro"]
    fake.extra_role_ids = ["1549421049287020568"]
    tokens = login(client)
    headers = authorization(tokens)
    # Successful verify writes the RoleGrant entitlement snapshot.
    live = client.get("/v1/me", headers=headers)
    assert live.status_code == 200
    assert "admin" in live.json()["entitlements"]
    assert "pro" in live.json()["entitlements"]
    # Discord bot outage: fall back to the snapshot, never 503.
    fake.fail_membership = True
    soft = client.get("/v1/me", headers=headers)
    assert soft.status_code == 200
    assert soft.json()["membership"] is True
    assert "admin" in soft.json()["entitlements"]
    assert "pro" in soft.json()["entitlements"]
    assert client.get("/v1/dashboard", headers=headers).status_code == 200
    channels = client.get("/v1/channels", headers=headers)
    assert channels.status_code == 200


def test_flaky_not_in_guild_keeps_recent_role_grant(identity_client):
    """A Discord 404 after a successful verify must not wipe Pro access."""
    client, fake = identity_client
    fake.staff = True
    fake.extra_entitlements = ["pro"]
    tokens = login(client)
    headers = authorization(tokens)
    assert "pro" in client.get("/v1/me", headers=headers).json()["entitlements"]
    fake.member = False
    soft = client.get("/v1/me", headers=headers)
    assert soft.status_code == 200
    assert soft.json()["membership"] is True
    assert "pro" in soft.json()["entitlements"]
    assert client.get("/v1/dashboard", headers=headers).status_code == 200


def test_oauth_scope_upgrade_revokes_refresh_sessions_once(identity_client):
    from ii_api.auth import OAUTH_SCOPE_REAUTH_EVENT, revoke_sessions_for_oauth_scope_upgrade
    from ii_api.models import AuditEvent, RoleGrant, User
    from sqlalchemy import func, select
    from sqlalchemy.orm import Session

    client, _ = identity_client
    tokens = login(client)
    headers = authorization(tokens)
    assert client.get("/v1/me", headers=headers).status_code == 200
    engine = client.app.state.engine
    first = revoke_sessions_for_oauth_scope_upgrade(engine)
    assert first >= 1
    assert client.get("/v1/me", headers=headers).status_code == 401
    # Marker makes a second pass a no-op; users/RoleGrants stay for the next Discord login.
    assert revoke_sessions_for_oauth_scope_upgrade(engine) == 0
    with Session(engine) as db:
        assert db.scalar(
            select(func.count()).select_from(AuditEvent).where(
                AuditEvent.event_type == OAUTH_SCOPE_REAUTH_EVENT
            )
        )
        assert db.scalar(select(func.count()).select_from(User)) >= 1
        assert db.scalar(select(func.count()).select_from(RoleGrant)) >= 0


def test_signout_preserves_role_and_disconnect_revokes_all(identity_client):
    client, fake = identity_client
    first = login(client)
    assert client.post("/v1/auth/signout", headers=authorization(first)).status_code == 204
    assert fake.removals == []
    assert client.get("/v1/me", headers=authorization(first)).status_code == 401
    second, third = login(client), login(client)
    response = client.post("/v1/auth/disconnect", headers=authorization(second))
    assert response.json() == {
        "sessions_revoked": True,
        "role_removed": True,
        "message": "Disconnected",
    }
    assert client.get("/v1/me", headers=authorization(third)).status_code == 401
    assert len(fake.removals) == 1


def test_nonmember_and_backend_rbac(identity_client):
    client, fake = identity_client
    fake.member = False
    tokens = login(client)
    headers = authorization(tokens)
    assert fake.grants == []
    assert client.get("/v1/me", headers=headers).json()["membership"] is False
    assert client.get("/v1/channels", headers=headers).status_code == 403
    fake.member = True
    assert client.get("/v1/channels", headers=headers).json()["channels"] == ["stable"]
    assert client.get("/v1/staff", headers={**headers, "X-Role": "owner"}).status_code == 403
    fake.staff = True
    assert client.get("/v1/staff", headers=headers).json()["read_only"] is True
    assert client.get("/v1/channels", headers=headers).json()["channels"] == [
        "stable",
        "beta",
        "developer",
    ]


def test_discord_outage_keeps_session_and_disconnect_still_revokes(identity_client):
    client, fake = identity_client
    tokens = login(client)
    fake.fail = True
    # Bot outages must not force another Discord authorize for an active session.
    assert client.get("/v1/dashboard", headers=authorization(tokens)).status_code == 200
    assert client.get("/v1/channels", headers=authorization(tokens)).status_code == 200
    response = client.post("/v1/auth/disconnect", headers=authorization(tokens))
    assert response.json()["role_removed"] is False
    assert client.get("/v1/me", headers=authorization(tokens)).status_code == 401


def test_callback_outage_consumes_state(identity_client):
    client, fake = identity_client
    request_id, verifier, state = begin_login(client)
    fake.fail = True
    response = client.get("/v1/auth/discord/callback", params={"state": state, "code": "fixture"})
    assert response.status_code == 503
    assert "text/html" in response.headers["content-type"]
    assert b"temporarily unavailable" in response.content.lower()
    assert (
        client.get(
            "/v1/auth/discord/callback", params={"state": state, "code": "fixture"}
        ).status_code
        == 400
    )
    assert (
        client.post(f"/v1/auth/requests/{request_id}/poll", json={"verifier": verifier}).json()[
            "status"
        ]
        == "failed"
    )


def test_callback_membership_outage_still_completes_login(identity_client):
    """Bot membership blips must not fail a finished Discord OAuth identity exchange."""
    client, fake = identity_client
    request_id, verifier, state = begin_login(client)
    fake.fail_membership = True
    response = client.get("/v1/auth/discord/callback", params={"state": state, "code": "fixture"})
    assert response.status_code == 200
    assert b"Signed in to ii Engine" in response.content
    poll = client.post(f"/v1/auth/requests/{request_id}/poll", json={"verifier": verifier})
    assert poll.status_code == 200
    assert poll.json()["status"] == "complete"
    assert poll.json()["access_token"]
    assert fake.grants == []


def test_concurrent_completion_is_single_use_on_postgres(identity_client):
    client, _ = identity_client
    if client.app.state.engine.dialect.name != "postgresql":
        import pytest

        pytest.skip("Row locking must be verified against PostgreSQL")
    request_id, verifier, state = begin_login(client)
    client.get("/v1/auth/discord/callback", params={"state": state, "code": "fixture"})

    def poll(_):
        return client.post(
            f"/v1/auth/requests/{request_id}/poll", json={"verifier": verifier}
        ).status_code

    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(poll, range(8)))
    assert results.count(200) == 1
    assert results.count(400) == 7


def test_join_then_recheck_grants_cosmetic_role(identity_client):
    client, fake = identity_client
    fake.member = False
    headers = authorization(login(client))
    assert client.post("/v1/me/recheck", headers=headers).json()["membership"] is False
    assert fake.grants == []
    fake.member = True
    assert client.post("/v1/me/recheck", headers=headers).json()["membership"] is True
    assert len(fake.grants) == 1


def test_cone_easter_egg_awards_fixed_discord_role(identity_client):
    client, fake = identity_client
    headers = authorization(login(client))
    response = client.post("/v1/me/cone-kill", headers=headers)
    assert response.status_code == 200
    assert response.json()["role_id"] == "1550271602720247959"
    assert fake.grants[-1] == ("cone", "100000000000000001")


def test_concurrent_first_logins_share_one_user(identity_client):
    client, _ = identity_client
    if client.app.state.engine.dialect.name != "postgresql":
        import pytest

        pytest.skip("PostgreSQL uniqueness and row locking required")
    starts = [begin_login(client) for _ in range(6)]

    def complete(start):
        return client.get(
            "/v1/auth/discord/callback", params={"state": start[2], "code": "fixture"}
        ).status_code

    with ThreadPoolExecutor(max_workers=6) as pool:
        assert list(pool.map(complete, starts)) == [200] * 6
    from sqlalchemy import func, select

    from ii_api.models import User

    with Session(client.app.state.engine) as db:
        assert db.scalar(select(func.count()).select_from(User)) == 1


def test_rotation_and_disconnect_leave_no_live_sessions(identity_client):
    client, _ = identity_client
    if client.app.state.engine.dialect.name != "postgresql":
        import pytest

        pytest.skip("PostgreSQL row locking required")
    rotating, disconnecting = login(client), login(client)
    with ThreadPoolExecutor(max_workers=2) as pool:
        rotation = pool.submit(
            client.post, "/v1/auth/refresh", json={"refresh_token": rotating["refresh_token"]}
        )
        removal = pool.submit(
            client.post, "/v1/auth/disconnect", headers=authorization(disconnecting)
        )
        assert removal.result().status_code == 200
        assert rotation.result().status_code in (200, 401)
    from sqlalchemy import func, select

    from ii_api.models import RefreshSession

    with Session(client.app.state.engine) as db:
        assert (
            db.scalar(
                select(func.count())
                .select_from(RefreshSession)
                .where(RefreshSession.revoked_at.is_(None))
            )
            == 0
        )


def test_authenticated_account_deletion_revokes_access_and_removes_role(identity_client):
    client, fake = identity_client
    headers = authorization(login(client))
    response = client.delete("/v1/me", headers=headers)
    assert response.status_code == 200
    assert response.json()["account_deleted"] is True
    assert response.json()["role_removed"] is True
    assert len(fake.removals) == 1
    assert client.get("/v1/me", headers=headers).status_code == 401
