"""Invite campaign + Pro trial expiry."""

from datetime import UTC, datetime, timedelta

from conftest import login
from sqlalchemy import select
from sqlalchemy.orm import Session
from test_identity import authorization

from ii_api.invites import REQUIRED_INVITEES, expire_pro_trials
from ii_api.models import InviteCampaign, InviteRedemption, ProTrial, RoleGrant, User


def _auth(client):
    return authorization(login(client))


def _ensure_role_grant(engine, discord_id: str):
    with Session(engine) as db:
        user = db.scalar(select(User).where(User.discord_id == discord_id))
        assert user is not None
        grant = db.get(RoleGrant, user.id)
        if grant is None:
            db.add(
                RoleGrant(
                    user_id=user.id,
                    granted_at=datetime.now(UTC),
                    last_verified_at=datetime.now(UTC),
                )
            )
        else:
            grant.removed_at = None
            grant.last_verified_at = datetime.now(UTC)
        db.commit()


def test_invite_create_redeem_and_complete(identity_client):
    client, fake = identity_client
    fake.discord_id = "100000000000000001"
    headers = _auth(client)
    _ensure_role_grant(client.app.state.engine, "100000000000000001")

    created = client.post("/v1/invites/mine", headers=headers)
    assert created.status_code == 201
    code = created.json()["code"]
    assert code and created.json()["authorized_count"] == 0

    # Creator can reload the full code from Engine storage.
    mine = client.get("/v1/invites/mine", headers=headers)
    assert mine.status_code == 200
    assert mine.json()["code"] == code

    assert (
        client.post("/v1/invites/redeem", headers=headers, json={"code": code}).status_code == 403
    )

    for index in range(REQUIRED_INVITEES):
        discord_id = f"20000000000000000{index}"
        fake.discord_id = discord_id
        invitee_headers = _auth(client)
        _ensure_role_grant(client.app.state.engine, discord_id)
        response = client.post("/v1/invites/redeem", headers=invitee_headers, json={"code": code})
        assert response.status_code == 200, response.text
        if index < REQUIRED_INVITEES - 1:
            assert response.json()["campaign_completed"] is False
        else:
            assert response.json()["campaign_completed"] is True

    with Session(client.app.state.engine) as db:
        campaign = db.scalar(select(InviteCampaign))
        assert campaign.completed_at is not None
        assert db.scalar(select(InviteRedemption).limit(1)) is not None
        trials = db.scalars(select(ProTrial)).all()
        assert len(trials) == REQUIRED_INVITEES + 1
        assert any(trial.source == "invite_inviter" for trial in trials)

    fake.discord_id = "100000000000000001"
    assert client.post("/v1/invites/mine", headers=headers).status_code == 409


def test_expire_pro_trials_removes_role(identity_client):
    client, fake = identity_client
    fake.discord_id = "100000000000000001"
    _auth(client)
    with Session(client.app.state.engine) as db:
        user = db.scalar(select(User))
        trial = ProTrial(
            user_id=user.id,
            source="invite_invitee",
            role_id=client.app.state.settings.discord_pro_role_ids.split(",")[0],
            had_pro_before=False,
            starts_at=datetime.now(UTC) - timedelta(days=2),
            expires_at=datetime.now(UTC) - timedelta(hours=1),
        )
        db.add(trial)
        db.commit()

    removed = expire_pro_trials(
        client.app.state.engine, fake, client.app.state.settings, now=datetime.now(UTC)
    )
    assert removed == 1
    assert (
        "role",
        "100000000000000001",
        client.app.state.settings.discord_pro_role_ids.split(",")[0],
    ) in fake.removals
    with Session(client.app.state.engine) as db:
        trial = db.scalar(select(ProTrial))
        assert trial.revoked_at is not None
