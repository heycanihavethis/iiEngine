"""Customize appearance preset share codes (Pro import)."""

from __future__ import annotations

import secrets
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from .access import member_has_uncapped_limits
from .auth import database, require_member
from .models import AppearancePresetShare, User

router = APIRouter(prefix="/v1/presets")

CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
SHARE_TTL_DAYS = 90
MAX_PAYLOAD_CHARS = 120_000
MAX_OWNED_PRESETS = 20
MAX_OWNED_PRESETS_UNCAPPED = 500


def _has_pro(request: Request) -> bool:
    return "pro" in set(request.state.member.get("entitlements", []))


def _require_pro(request: Request) -> None:
    if not _has_pro(request):
        raise HTTPException(403, "Engine Pro is required to share or import Customize presets")


def _new_code(db: Session) -> str:
    for _ in range(12):
        raw = "CUS-" + "".join(secrets.choice(CODE_ALPHABET) for _ in range(8))
        if db.scalar(select(AppearancePresetShare.id).where(AppearancePresetShare.code == raw)):
            continue
        return raw
    raise HTTPException(503, "Could not allocate a share code")


class PresetShareBody(BaseModel):
    preset: dict = Field(...)


@router.post("", status_code=201)
@router.post("/", status_code=201, include_in_schema=False)
def create_preset_share(
    body: PresetShareBody,
    request: Request,
    user: User = Depends(require_member),
    db: Session = Depends(database),
):
    _require_pro(request)
    appearance = body.preset.get("appearance") if isinstance(body.preset, dict) else None
    if not isinstance(appearance, dict):
        raise HTTPException(422, "Preset must include an appearance object")
    # Drop huge custom-icon blobs from shared codes; importers keep their own icon.
    slim = {
        "version": body.preset.get("version", 1),
        "exportedAt": body.preset.get("exportedAt") or datetime.now(UTC).isoformat(),
        "appearance": {
            **appearance,
            "customIconDataUrl": "",
            "customIconRgbaB64": "",
        },
    }
    encoded = str(slim)
    if len(encoded) > MAX_PAYLOAD_CHARS:
        raise HTTPException(422, "Preset is too large to share as a code")
    # Cap per-user shares (elevated for owner/admin/uncapped).
    owned_cap = (
        MAX_OWNED_PRESETS_UNCAPPED
        if member_has_uncapped_limits(
            getattr(request.state, "member", None),
            uncapped_role_ids=getattr(
                request.app.state.settings, "discord_uncapped_role_ids", ""
            ),
        )
        else MAX_OWNED_PRESETS
    )
    owned = list(
        db.scalars(
            select(AppearancePresetShare)
            .where(AppearancePresetShare.user_id == user.id)
            .order_by(AppearancePresetShare.created_at.desc())
        )
    )
    for stale in owned[owned_cap:]:
        db.delete(stale)
    code = _new_code(db)
    row = AppearancePresetShare(
        code=code,
        user_id=user.id,
        payload=slim,
        expires_at=datetime.now(UTC) + timedelta(days=SHARE_TTL_DAYS),
    )
    db.add(row)
    db.commit()
    return {
        "code": code,
        "expires_at": row.expires_at.isoformat(),
        "note": "Custom icons are not included in share codes.",
    }


@router.get("/{code}")
def fetch_preset_share(
    code: str,
    request: Request,
    user: User = Depends(require_member),
    db: Session = Depends(database),
):
    _require_pro(request)
    normalized = code.strip().upper()
    if not normalized.startswith("CUS-") or len(normalized) > 16:
        raise HTTPException(422, "Invalid preset share code")
    db.execute(
        delete(AppearancePresetShare).where(AppearancePresetShare.expires_at <= datetime.now(UTC))
    )
    row = db.scalar(select(AppearancePresetShare).where(AppearancePresetShare.code == normalized))
    if row is None:
        raise HTTPException(404, "Preset code not found or expired")
    return {"code": row.code, "preset": row.payload, "expires_at": row.expires_at.isoformat()}
