"""Invite campaign: 4 authorized invitees → invitee 1d Pro + inviter 5d Pro (one-time)."""

from __future__ import annotations

import hashlib
import hmac
import secrets
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .auth import database, require_member
from .discord import ProviderUnavailable
from .models import InviteCampaign, InviteRedemption, ProTrial, RoleGrant, User

router = APIRouter(prefix="/v1/invites")

REQUIRED_INVITEES = 4
INVITEE_TRIAL_DAYS = 1
INVITER_TRIAL_DAYS = 5


def _hash_code(code: str) -> str:
    return hashlib.sha256(code.strip().upper().encode("utf-8")).hexdigest()


def _pro_role_id(settings) -> str:
    roles = [item.strip() for item in settings.discord_pro_role_ids.split(",") if item.strip()]
    if not roles or not roles[0].isdigit():
        raise HTTPException(503, "Pro role is not configured")
    return roles[0]


def _campaign_view(db: Session, campaign: InviteCampaign, *, reveal_code: str | None = None):
    count = db.scalar(
        select(func.count())
        .select_from(InviteRedemption)
        .where(InviteRedemption.campaign_id == campaign.id)
    )
    code = reveal_code or campaign.code_plain
    return {
        "code": code,
        "code_hint": f"{campaign.code_prefix}…" if campaign.code_prefix else None,
        "authorized_count": int(count or 0),
        "required": REQUIRED_INVITEES,
        "completed": campaign.completed_at is not None,
        "completed_at": campaign.completed_at,
        "invitee_trial_days": INVITEE_TRIAL_DAYS,
        "inviter_trial_days": INVITER_TRIAL_DAYS,
    }


def _grant_trial(
    request: Request,
    db: Session,
    *,
    user: User,
    days: int,
    source: str,
    role_id: str,
):
    membership = request.app.state.discord.membership(user.discord_id)
    had_pro = role_id in set(membership.get("role_ids", []))
    now = datetime.now(UTC)
    trial = ProTrial(
        user_id=user.id,
        source=source,
        role_id=role_id,
        had_pro_before=had_pro,
        starts_at=now,
        expires_at=now + timedelta(days=days),
    )
    db.add(trial)
    if not had_pro:
        request.app.state.discord.grant_member_role(user.discord_id, role_id)
    return trial


def _complete_campaign_if_ready(request: Request, db: Session, campaign: InviteCampaign):
    if campaign.completed_at is not None:
        return False
    count = db.scalar(
        select(func.count())
        .select_from(InviteRedemption)
        .where(InviteRedemption.campaign_id == campaign.id)
    )
    if int(count or 0) < REQUIRED_INVITEES:
        return False
    role_id = _pro_role_id(request.app.state.settings)
    inviter = db.get(User, campaign.inviter_user_id)
    if inviter is None:
        raise HTTPException(500, "Invite campaign is corrupt")
    redemptions = db.scalars(
        select(InviteRedemption)
        .where(InviteRedemption.campaign_id == campaign.id)
        .order_by(InviteRedemption.authorized_at.asc())
        .limit(REQUIRED_INVITEES)
    ).all()
    try:
        for redemption in redemptions:
            invitee = db.get(User, redemption.invitee_user_id)
            if invitee is None:
                continue
            _grant_trial(
                request,
                db,
                user=invitee,
                days=INVITEE_TRIAL_DAYS,
                source="invite_invitee",
                role_id=role_id,
            )
        _grant_trial(
            request,
            db,
            user=inviter,
            days=INVITER_TRIAL_DAYS,
            source="invite_inviter",
            role_id=role_id,
        )
    except ProviderUnavailable as error:
        raise HTTPException(503, "Discord could not grant Pro trial roles") from error
    campaign.completed_at = datetime.now(UTC)
    return True


@router.get("/mine")
def my_invite(request: Request, user: User = Depends(require_member), db: Session = Depends(database)):
    campaign = db.scalar(
        select(InviteCampaign).where(InviteCampaign.inviter_user_id == user.id)
    )
    if campaign is None:
        return {
            "code": None,
            "code_hint": None,
            "authorized_count": 0,
            "required": REQUIRED_INVITEES,
            "completed": False,
            "completed_at": None,
            "invitee_trial_days": INVITEE_TRIAL_DAYS,
            "inviter_trial_days": INVITER_TRIAL_DAYS,
        }
    return _campaign_view(db, campaign)


@router.post("/mine", status_code=201)
def create_invite(
    request: Request, user: User = Depends(require_member), db: Session = Depends(database)
):
    """Create a personal one-time invite code. Engine stores it for the creator."""
    existing = db.scalar(select(InviteCampaign).where(InviteCampaign.inviter_user_id == user.id))
    if existing is not None:
        raise HTTPException(409, "You already have an invite code for this one-time deal")
    # Require Engine User role grant so bots/API-only accounts cannot farm invites.
    grant = db.get(RoleGrant, user.id)
    if grant is None or grant.removed_at is not None:
        raise HTTPException(403, "Authorize ii Engine on Discord before creating invites")
    raw = "II" + secrets.token_hex(4).upper()
    campaign = InviteCampaign(
        inviter_user_id=user.id,
        code_hash=_hash_code(raw),
        code_prefix=raw[:4],
        code_plain=raw,
    )
    db.add(campaign)
    db.commit()
    db.refresh(campaign)
    return _campaign_view(db, campaign, reveal_code=raw)


class RedeemBody(BaseModel):
    code: str = Field(min_length=6, max_length=32)


@router.post("/redeem")
def redeem_invite(
    body: RedeemBody,
    request: Request,
    user: User = Depends(require_member),
    db: Session = Depends(database),
):
    code = body.code.strip().upper()
    if not code.isalnum():
        raise HTTPException(422, "Invalid invite code")
    grant = db.get(RoleGrant, user.id)
    if grant is None or grant.removed_at is not None:
        raise HTTPException(
            403,
            "Download ii Engine and finish Discord authorization before redeeming an invite",
        )
    existing = db.scalar(
        select(InviteRedemption).where(InviteRedemption.invitee_user_id == user.id)
    )
    if existing is not None:
        raise HTTPException(409, "This account already redeemed an invite")
    campaign = db.scalar(
        select(InviteCampaign).where(InviteCampaign.code_hash == _hash_code(code))
    )
    if campaign is None:
        # Constant-ish failure path; do not reveal whether prefix matched.
        raise HTTPException(404, "Invite code not found")
    if campaign.inviter_user_id == user.id:
        raise HTTPException(403, "You cannot redeem your own invite")
    if campaign.completed_at is not None:
        raise HTTPException(409, "This invite deal is already finished")
    if not hmac.compare_digest(campaign.code_hash, _hash_code(code)):
        raise HTTPException(404, "Invite code not found")
    count = db.scalar(
        select(func.count())
        .select_from(InviteRedemption)
        .where(InviteRedemption.campaign_id == campaign.id)
    )
    if int(count or 0) >= REQUIRED_INVITEES:
        raise HTTPException(409, "This invite already has enough members")
    db.add(
        InviteRedemption(
            campaign_id=campaign.id,
            invitee_user_id=user.id,
            authorized_at=datetime.now(UTC),
        )
    )
    db.flush()
    completed = _complete_campaign_if_ready(request, db, campaign)
    db.commit()
    return {
        "ok": True,
        "campaign_completed": completed,
        "message": (
            "Invite locked in. When four friends authorize, everyone in the deal gets Pro trial time."
            if not completed
            else "Invite deal complete — Pro trial roles were granted."
        ),
    }


def expire_pro_trials(engine, discord, settings, *, now=None):
    """Remove expired invite trial Pro roles when the member did not already have Pro."""
    now = now or datetime.now(UTC)
    role_ids = [item.strip() for item in settings.discord_pro_role_ids.split(",") if item.strip()]
    if not role_ids:
        return 0
    role_id = role_ids[0]
    removed = 0
    with Session(engine) as db:
        rows = db.scalars(
            select(ProTrial).where(
                ProTrial.revoked_at.is_(None),
                ProTrial.expires_at <= now,
            )
        ).all()
        for trial in rows:
            trial.revoked_at = now
            if trial.had_pro_before:
                continue
            # Keep Pro if another non-expired trial still covers this user.
            still = db.scalar(
                select(func.count())
                .select_from(ProTrial)
                .where(
                    ProTrial.user_id == trial.user_id,
                    ProTrial.id != trial.id,
                    ProTrial.revoked_at.is_(None),
                    ProTrial.expires_at > now,
                )
            )
            if int(still or 0) > 0:
                continue
            user = db.get(User, trial.user_id)
            if user is None:
                continue
            try:
                discord.revoke_member_role(user.discord_id, role_id)
                removed += 1
            except ProviderUnavailable:
                # Leave revoked_at unset so the next maintenance pass retries.
                trial.revoked_at = None
        db.commit()
    return removed
