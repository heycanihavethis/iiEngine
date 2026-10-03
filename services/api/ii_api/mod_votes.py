"""Upvotes / downvotes for trusted and community mods + weekly picks."""

from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import case, func, select
from sqlalchemy.orm import Session

from .auth import database, require_member
from .models import CommunityMod, ModVote, TrustedMod, User

router = APIRouter(prefix="/v1")


class VoteBody(BaseModel):
    target_type: str = Field(pattern=r"^(trusted|community)$")
    target_id: str = Field(min_length=8, max_length=36)
    value: int = Field(ge=-1, le=1)  # 1 up, -1 down, 0 clear


def _ensure_target(db: Session, target_type: str, target_id: str):
    if target_type == "trusted":
        row = db.get(TrustedMod, target_id)
        if row is None:
            raise HTTPException(404, "Trusted mod not found")
        return row
    row = db.get(CommunityMod, target_id)
    if row is None or row.status != "approved":
        raise HTTPException(404, "Community mod not found")
    return row


def vote_stats(db: Session, target_type: str, target_ids: list[str], user_id: str | None):
    if not target_ids:
        return {}
    rows = db.execute(
        select(
            ModVote.target_id,
            func.coalesce(func.sum(case((ModVote.value == 1, 1), else_=0)), 0).label("ups"),
            func.coalesce(func.sum(case((ModVote.value == -1, 1), else_=0)), 0).label("downs"),
            func.coalesce(func.sum(ModVote.value), 0).label("score"),
        )
        .where(ModVote.target_type == target_type, ModVote.target_id.in_(target_ids))
        .group_by(ModVote.target_id)
    ).all()
    mine: dict[str, int] = {}
    if user_id:
        mine_rows = db.execute(
            select(ModVote.target_id, ModVote.value).where(
                ModVote.user_id == user_id,
                ModVote.target_type == target_type,
                ModVote.target_id.in_(target_ids),
            )
        ).all()
        mine = {tid: int(val) for tid, val in mine_rows}
    out = {}
    for tid, ups, downs, score in rows:
        out[tid] = {
            "upvotes": int(ups),
            "downvotes": int(downs),
            "score": int(score),
            "my_vote": mine.get(tid, 0),
        }
    for tid in target_ids:
        out.setdefault(
            tid, {"upvotes": 0, "downvotes": 0, "score": 0, "my_vote": mine.get(tid, 0)}
        )
    return out


def attach_votes(db: Session, items: list[dict], target_type: str, user_id: str | None):
    ids = [item["id"] for item in items if item.get("id")]
    stats = vote_stats(db, target_type, ids, user_id)
    for item in items:
        item["votes"] = stats.get(
            item["id"], {"upvotes": 0, "downvotes": 0, "score": 0, "my_vote": 0}
        )
    return items


@router.post("/mods/vote")
def cast_vote(
    body: VoteBody,
    request: Request,
    user: User = Depends(require_member),
    db: Session = Depends(database),
):
    _ensure_target(db, body.target_type, body.target_id)
    existing = db.scalar(
        select(ModVote).where(
            ModVote.user_id == user.id,
            ModVote.target_type == body.target_type,
            ModVote.target_id == body.target_id,
        )
    )
    if body.value == 0:
        if existing:
            db.delete(existing)
            db.commit()
        return {"ok": True, "my_vote": 0, **vote_stats(db, body.target_type, [body.target_id], user.id)[body.target_id]}
    if existing:
        existing.value = body.value
        existing.updated_at = datetime.now(UTC)
    else:
        db.add(
            ModVote(
                user_id=user.id,
                target_type=body.target_type,
                target_id=body.target_id,
                value=body.value,
            )
        )
    db.commit()
    return {
        "ok": True,
        **vote_stats(db, body.target_type, [body.target_id], user.id)[body.target_id],
    }


@router.get("/mods/weekly-picks")
def weekly_picks(
    request: Request,
    user: User = Depends(require_member),
    db: Session = Depends(database),
):
    """Top 3 mods by net score over the last 7 days (trusted + community)."""
    since = datetime.now(UTC) - timedelta(days=7)
    rows = db.execute(
        select(
            ModVote.target_type,
            ModVote.target_id,
            func.coalesce(func.sum(ModVote.value), 0).label("score"),
            func.count().label("ballots"),
        )
        .where(ModVote.created_at >= since)
        .group_by(ModVote.target_type, ModVote.target_id)
        .order_by(func.coalesce(func.sum(ModVote.value), 0).desc(), func.count().desc())
        .limit(12)
    ).all()
    picks = []
    for target_type, target_id, score, ballots in rows:
        if target_type == "trusted":
            mod = db.get(TrustedMod, target_id)
            if not mod:
                continue
            picks.append(
                {
                    "target_type": "trusted",
                    "id": mod.id,
                    "name": mod.name,
                    "description": mod.description,
                    "filename": mod.filename,
                    "score": int(score),
                    "ballots": int(ballots),
                    "has_thumbnail": bool(mod.thumbnail),
                    "thumbnail_url": f"/v1/trusted-mods/{mod.id}/thumbnail" if mod.thumbnail else None,
                }
            )
        else:
            mod = db.get(CommunityMod, target_id)
            if not mod or mod.status != "approved":
                continue
            picks.append(
                {
                    "target_type": "community",
                    "id": mod.id,
                    "name": mod.name,
                    "description": mod.description,
                    "filename": mod.filename,
                    "score": int(score),
                    "ballots": int(ballots),
                    "has_thumbnail": bool(mod.thumbnail),
                    "thumbnail_url": f"/v1/community/mods/{mod.id}/thumbnail" if mod.thumbnail else None,
                }
            )
        if len(picks) >= 3:
            break
    # Fallback: top trusted mods by overall votes or newest if quiet week.
    if len(picks) < 3:
        trusted = db.scalars(select(TrustedMod).order_by(TrustedMod.created_at.desc()).limit(6)).all()
        have = {p["id"] for p in picks}
        for mod in trusted:
            if mod.id in have:
                continue
            picks.append(
                {
                    "target_type": "trusted",
                    "id": mod.id,
                    "name": mod.name,
                    "description": mod.description,
                    "filename": mod.filename,
                    "score": 0,
                    "ballots": 0,
                    "has_thumbnail": bool(mod.thumbnail),
                    "thumbnail_url": f"/v1/trusted-mods/{mod.id}/thumbnail" if mod.thumbnail else None,
                }
            )
            if len(picks) >= 3:
                break
    return {"items": picks[:3], "window_days": 7}
