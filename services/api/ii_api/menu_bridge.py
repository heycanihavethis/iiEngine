"""Bridge tickets so ii Reborn Menu can read Engine Pro entitlements.

Desktop (aud=ii-desktop) mints a short-lived bridge JWT. The menu never receives
desktop refresh tokens; it only presents the bridge ticket to this router.
"""

from datetime import UTC, datetime, timedelta

import jwt
from fastapi import APIRouter, Depends, Header, HTTPException, Request

from .auth import database, require_member
from .discord import ProviderUnavailable
from .models import User

router = APIRouter(prefix="/v1/menu/bridge")

# Keep in sync with docs/menu-engine-bridge.md and the menu EngineProManager.
BRIDGE_SCHEMA_VERSION = 1
BRIDGE_AUDIENCE = "ii-menu-bridge"
BRIDGE_TTL = timedelta(hours=12)
BRIDGE_FILENAME = "ii-engine-bridge.json"
PRO_FEATURES = ("engine_pro_mods",)


def _member_pro(request: Request) -> bool:
    return "pro" in set(request.state.member.get("entitlements", []))


def _claim_view(*, pro: bool, expires_at: datetime, issued_at: datetime, api_base: str):
    features = list(PRO_FEATURES) if pro else []
    return {
        "schema_version": BRIDGE_SCHEMA_VERSION,
        "api_base": api_base.rstrip("/"),
        "filename": BRIDGE_FILENAME,
        "pro": pro,
        "features": features,
        "issued_at": issued_at,
        "expires_at": expires_at,
    }


def _encode_ticket(request: Request, user: User, *, pro: bool, now: datetime, expires_at: datetime):
    return jwt.encode(
        {
            "sub": user.id,
            "pro": pro,
            "features": list(PRO_FEATURES) if pro else [],
            "aud": BRIDGE_AUDIENCE,
            "iss": "ii-engine",
            "iat": now,
            "exp": expires_at,
        },
        request.app.state.settings.access_token_signing_key.get_secret_value(),
        algorithm="HS256",
    )


def _decode_bridge_ticket(request: Request, ticket: str):
    try:
        return jwt.decode(
            ticket,
            request.app.state.settings.access_token_signing_key.get_secret_value(),
            algorithms=["HS256"],
            audience=BRIDGE_AUDIENCE,
            issuer="ii-engine",
            options={"require": ["sub", "pro", "features", "iat", "exp"]},
        )
    except jwt.PyJWTError as error:
        raise HTTPException(401, "Menu bridge ticket is invalid or expired") from error


@router.post("/ticket")
def issue_bridge_ticket(
    request: Request,
    user: User = Depends(require_member),
    db=Depends(database),
):
    """Desktop-authenticated: mint a bridge ticket + file payload for iisStupidMenu/."""
    del db  # auth dependency opens the session; no extra rows needed
    now = datetime.now(UTC)
    expires_at = now + BRIDGE_TTL
    pro = _member_pro(request)
    ticket = _encode_ticket(request, user, pro=pro, now=now, expires_at=expires_at)
    api_base = request.app.state.settings.backend_public_url.rstrip("/")
    payload = _claim_view(pro=pro, expires_at=expires_at, issued_at=now, api_base=api_base)
    return {**payload, "ticket": ticket}


@router.get("/entitlements")
def bridge_entitlements(
    request: Request,
    authorization: str | None = Header(default=None),
):
    """Menu-authenticated: Authorization: Bridge <ticket> → live Pro status."""
    if not authorization or not authorization.startswith("Bridge "):
        raise HTTPException(401, "Menu bridge ticket required")
    ticket = authorization.removeprefix("Bridge ").strip()
    if not (40 <= len(ticket) <= 4096):
        raise HTTPException(401, "Menu bridge ticket is invalid or expired")
    claim = _decode_bridge_ticket(request, ticket)
    user = None
    if request.app.state.engine:
        from sqlalchemy.orm import Session

        with Session(request.app.state.engine, expire_on_commit=False) as session:
            user = session.get(User, claim["sub"])
    if user is None:
        raise HTTPException(401, "Menu bridge ticket is invalid or expired")
    # Re-check Discord when possible; fall back to the ticket claim + RoleGrant snapshot.
    pro = bool(claim.get("pro"))
    try:
        membership = request.app.state.discord.membership(user.discord_id)
        if not membership.get("membership"):
            raise HTTPException(403, "Join the official Discord server to continue")
        pro = "pro" in set(membership.get("entitlements", []))
    except ProviderUnavailable:
        from sqlalchemy.orm import Session as OrmSession

        from .models import RoleGrant

        with OrmSession(request.app.state.engine, expire_on_commit=False) as session:
            grant = session.get(RoleGrant, user.id)
        if grant is not None and grant.removed_at is None and grant.entitlements:
            pro = "pro" in {str(value) for value in grant.entitlements}
        # Keep ticket Pro claim if Discord is down and no snapshot yet.
    now = datetime.now(UTC)
    expires_at = datetime.fromtimestamp(claim["exp"], tz=UTC)
    api_base = request.app.state.settings.backend_public_url.rstrip("/")
    return _claim_view(pro=pro, expires_at=expires_at, issued_at=now, api_base=api_base)
