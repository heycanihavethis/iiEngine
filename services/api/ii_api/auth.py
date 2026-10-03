import hmac
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import jwt
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import HTMLResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field
from sqlalchemy import delete, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .discord import ProviderUnavailable
from .models import AuditEvent, AuthRequest, RefreshSession, RoleGrant, User
from .schemas import MemberView
from .security import digest, refresh_hash, token, utc, verifier_challenge

router = APIRouter(prefix="/v1")
bearer = HTTPBearer(auto_error=False)
REFRESH_LIFETIME = timedelta(days=90)
ACCESS_LIFETIME = timedelta(minutes=15)
# One-shot marker: revoke every desktop refresh session so users re-consent to
# identify + guilds.members.read. RoleGrant / accounts are intentionally kept.
OAUTH_SCOPE_REAUTH_EVENT = "oauth_scopes_guilds_members_read_v1"

AUTH_COMPLETE_HTML = """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Signed in to ii Engine</title>
  <style>
    :root { color-scheme: dark; font-family: "Segoe UI", ui-sans-serif, system-ui, sans-serif; }
    * { box-sizing: border-box; }
    body {
      margin: 0; min-height: 100vh; display: grid; place-items: center; color: #f8f3ea;
      background:
        radial-gradient(circle at 50% 0%, #8a4214 0%, transparent 42%),
        radial-gradient(circle at 80% 80%, #2a1810 0%, #100d0b 55%);
      overflow: hidden;
    }
    body::before, body::after {
      content: ""; position: fixed; border-radius: 50%; pointer-events: none; filter: blur(40px);
      animation: drift 8s ease-in-out infinite alternate;
    }
    body::before { width: 280px; height: 280px; top: -40px; left: 10%; background: #ff780055; }
    body::after { width: 220px; height: 220px; bottom: 5%; right: 8%; background: #38bdf833;
      animation-delay: -3s; }
    @keyframes drift { from { transform: translateY(0); } to { transform: translateY(18px); } }
    @keyframes pop {
      0% { opacity: 0; transform: translateY(16px) scale(.96); }
      100% { opacity: 1; transform: translateY(0) scale(1); }
    }
    @keyframes check-pop {
      0% { transform: scale(.4); opacity: 0; }
      60% { transform: scale(1.12); opacity: 1; }
      100% { transform: scale(1); }
    }
    @keyframes ring {
      0% { box-shadow: 0 0 0 0 #ff970066; }
      100% { box-shadow: 0 0 0 18px transparent; }
    }
    main {
      position: relative; z-index: 1; width: min(440px, calc(100% - 32px));
      padding: 40px 36px 32px; text-align: center;
      border: 1px solid #b86420aa; border-radius: 22px;
      background: linear-gradient(165deg, rgba(36, 22, 14, .96), rgba(16, 12, 10, .96));
      box-shadow: 0 28px 90px #000a; animation: pop .55s cubic-bezier(.22,1,.36,1) both;
    }
    .mark {
      display: grid; place-items: center; width: 68px; height: 68px; margin: 0 auto 18px;
      border-radius: 20px; color: #17100b;
      background: linear-gradient(145deg, #ffc266, #ff7800);
      font-size: 36px; font-weight: 900;
      animation: check-pop .55s cubic-bezier(.22,1,.36,1) .08s both, ring 1.1s ease-out .35s 2;
    }
    .eyebrow {
      margin: 0 0 8px; color: #ffb56a; font-size: 11px; font-weight: 800;
      letter-spacing: .16em; text-transform: uppercase;
    }
    h1 { margin: 0 0 10px; font-size: 28px; letter-spacing: -.02em; }
    p { margin: 0 0 22px; color: #d2c3b2; line-height: 1.55; font-size: 15px; }
    .actions { display: grid; gap: 10px; }
    button {
      width: 100%; border: 0; border-radius: 12px; padding: 13px 18px; cursor: pointer;
      font: inherit; font-weight: 700; transition: transform .15s ease, background .15s ease;
    }
    button:active { transform: scale(.98); }
    .primary { color: #fff; background: linear-gradient(180deg, #ff8618, #e25f00); }
    .primary:hover { background: linear-gradient(180deg, #ff9a3a, #f06c0a); }
    .ghost {
      color: #f0d5b1; background: transparent; border: 1px solid #ffffff22;
    }
    .ghost:hover { border-color: #ff970055; background: #ff970014; }
    .hint { margin: 14px 0 0; color: #9a8672; font-size: 12px; }
  </style>
</head>
<body>
  <main>
    <div class="mark" aria-hidden="true">✓</div>
    <p class="eyebrow">Discord connected</p>
    <h1>You're signed in</h1>
    <p id="status">Opening ii Engine again. You can close this tab when the app comes forward.</p>
    <div class="actions">
      <button type="button" class="primary" id="open-btn">Open ii Engine</button>
      <button type="button" class="ghost" id="close-btn">Close this window</button>
    </div>
    <p class="hint" id="hint">If the app is already open, it should come to the front.</p>
  </main>
  <script>
    const PROTO = 'iiengine://auth-complete';
    const status = document.getElementById('status');
    const hint = document.getElementById('hint');

    function tryClose() {
      try { window.open('', '_self'); } catch (e) {}
      try { window.close(); } catch (e) {}
      // Some Chromium builds only close after navigating away first.
      try {
        window.location.href = 'about:blank';
        setTimeout(() => { try { window.close(); } catch (e) {} }, 50);
      } catch (e) {}
    }

    function openEngine() {
      status.textContent = 'Launching ii Engine…';
      try {
        const frame = document.createElement('iframe');
        frame.style.display = 'none';
        frame.src = PROTO;
        document.body.appendChild(frame);
        setTimeout(() => { try { frame.remove(); } catch (e) {} }, 1500);
      } catch (e) {}
      try {
        const link = document.createElement('a');
        link.href = PROTO;
        link.rel = 'noreferrer';
        link.style.display = 'none';
        document.body.appendChild(link);
        link.click();
        link.remove();
      } catch (e) {}
      try { window.location.href = PROTO; } catch (e) {}
      setTimeout(() => {
        status.textContent = 'ii Engine should be open. Closing this window…';
        tryClose();
      }, 500);
      setTimeout(() => {
        if (!document.hidden) {
          status.textContent = 'Sign-in is complete. Click Close if this tab is still open.';
          hint.textContent = 'Your desktop app already received the login — you can close this tab anytime.';
        }
      }, 1600);
    }

    document.getElementById('open-btn').addEventListener('click', openEngine);
    document.getElementById('close-btn').addEventListener('click', () => {
      openEngine();
      setTimeout(tryClose, 200);
    });
    setTimeout(openEngine, 350);
  </script>
</body>
</html>"""

AUTH_SECURE_HEADERS = {
    "Content-Security-Policy": (
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; "
        "base-uri 'none'; frame-ancestors 'none'"
    ),
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
}


def auth_browser_page(*, title: str, heading: str, message: str, status_code: int) -> HTMLResponse:
    """Branded callback page so Discord redirects never strand users on raw JSON."""
    safe_title = title.replace("<", "").replace(">", "")[:80]
    safe_heading = heading.replace("<", "").replace(">", "")[:80]
    safe_message = message.replace("<", "").replace(">", "")[:240]
    html = f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>{safe_title}</title>
  <style>
    :root {{ color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }}
    * {{ box-sizing: border-box; }}
    body {{ margin: 0; min-height: 100vh; display: grid; place-items: center; color: #f8f3ea;
      background: radial-gradient(circle at 50% 15%, #61300c 0, #24170f 42%, #100d0b 100%); }}
    main {{ width: min(420px, calc(100% - 32px)); padding: 36px; text-align: center; border: 1px solid #8e4a18;
      border-radius: 18px; background: rgba(24, 17, 12, .94); box-shadow: 0 24px 80px #0009; }}
    .mark {{ display: grid; place-items: center; width: 58px; height: 58px; margin: 0 auto 20px;
      border-radius: 16px; color: #17100b; background: linear-gradient(145deg, #ffad32, #ff7800);
      font-size: 28px; font-weight: 900; }}
    h1 {{ margin: 0 0 8px; font-size: 24px; }}
    p {{ margin: 0 0 24px; color: #cfc3b5; line-height: 1.55; }}
    button {{ width: 100%; border: 0; border-radius: 10px; padding: 12px 18px; cursor: pointer;
      color: white; background: #e76800; font: inherit; font-weight: 700; }}
    button:hover {{ background: #ff7b0a; }}
  </style>
</head>
<body>
  <main>
    <div class="mark" aria-hidden="true">!</div>
    <h1>{safe_heading}</h1>
    <p>{safe_message}</p>
    <button type="button" id="return-btn">Close and return to ii Engine</button>
  </main>
  <script>
    document.getElementById('return-btn').addEventListener('click', function () {{
      try {{
        var frame = document.createElement('iframe');
        frame.style.display = 'none';
        frame.src = 'iiengine://auth-complete';
        document.body.appendChild(frame);
      }} catch (e) {{}}
      try {{ window.location.href = 'iiengine://auth-complete'; }} catch (e) {{}}
      setTimeout(function () {{
        try {{ window.open('', '_self'); }} catch (e) {{}}
        try {{ window.close(); }} catch (e) {{}}
      }}, 250);
    }});
  </script>
</body>
</html>"""
    return HTMLResponse(html, status_code=status_code, headers=AUTH_SECURE_HEADERS)


def database(request: Request):
    if not request.app.state.engine:
        raise HTTPException(503, "Database is not configured")
    with Session(request.app.state.engine, expire_on_commit=False) as session:
        yield session


def revoke_sessions_for_oauth_scope_upgrade(engine) -> int:
    """Force every signed-in desktop to Discord-authorize again for expanded scopes.

    Keeps User + RoleGrant rows so membership/Pro come back immediately after re-auth.
    Idempotent via an audit marker.
    """
    with Session(engine, expire_on_commit=False) as db:
        already = db.scalar(
            select(AuditEvent.id).where(AuditEvent.event_type == OAUTH_SCOPE_REAUTH_EVENT).limit(1)
        )
        if already:
            return 0
        result = db.execute(
            update(RefreshSession)
            .where(RefreshSession.revoked_at.is_(None))
            .values(revoked_at=datetime.now(UTC))
        )
        db.add(
            AuditEvent(
                event_type=OAUTH_SCOPE_REAUTH_EVENT,
                actor_id=None,
                result=f"revoked:{int(result.rowcount or 0)}",
            )
        )
        db.commit()
        return int(result.rowcount or 0)


def settings(request: Request):
    return request.app.state.settings


def configured(request: Request):
    config = settings(request)
    if (
        len(config.access_token_signing_key.get_secret_value()) < 32
        or len(config.refresh_token_pepper.get_secret_value()) < 32
        or not config.discord_oauth_redirect_uri
        or not config.discord_client_secret.get_secret_value()
    ):
        raise HTTPException(503, "Discord authentication is not configured")
    return config


class AuthStart(BaseModel):
    challenge: str = Field(pattern=r"^[A-Za-z0-9_-]{43}$")


class AuthPoll(BaseModel):
    verifier: str = Field(min_length=43, max_length=128, pattern=r"^[A-Za-z0-9._~-]+$")


class RefreshBody(BaseModel):
    refresh_token: str = Field(min_length=40, max_length=200)


def issue_session(db, user_id, config, *, family_id=None):
    now = datetime.now(UTC)
    plaintext = token()
    session = RefreshSession(
        id=str(uuid4()),
        user_id=user_id,
        token_hash=refresh_hash(plaintext, config.refresh_token_pepper.get_secret_value()),
        family_id=family_id or str(uuid4()),
        expires_at=now + REFRESH_LIFETIME,
    )
    db.add(session)
    db.flush()
    access = jwt.encode(
        {
            "sub": user_id,
            "sid": session.id,
            "iat": now,
            "exp": now + ACCESS_LIFETIME,
            "iss": "ii-engine",
            "aud": "ii-desktop",
        },
        config.access_token_signing_key.get_secret_value(),
        algorithm="HS256",
    )
    return session, {
        "access_token": access,
        "refresh_token": plaintext,
        "token_type": "Bearer",
        "expires_in": int(ACCESS_LIFETIME.total_seconds()),
    }


def mint_access_token(session: RefreshSession, config) -> dict:
    """Issue a short-lived access JWT without rotating the refresh secret."""
    now = datetime.now(UTC)
    session.expires_at = now + REFRESH_LIFETIME
    access = jwt.encode(
        {
            "sub": session.user_id,
            "sid": session.id,
            "iat": now,
            "exp": now + ACCESS_LIFETIME,
            "iss": "ii-engine",
            "aud": "ii-desktop",
        },
        config.access_token_signing_key.get_secret_value(),
        algorithm="HS256",
    )
    return {
        "access_token": access,
        "token_type": "Bearer",
        "expires_in": int(ACCESS_LIFETIME.total_seconds()),
    }


def current_user(
    request: Request,
    credential: HTTPAuthorizationCredentials | None = Depends(bearer),
    db: Session = Depends(database),
):
    if credential is None:
        raise HTTPException(401, "Sign in to continue")
    try:
        payload = jwt.decode(
            credential.credentials,
            settings(request).access_token_signing_key.get_secret_value(),
            algorithms=["HS256"],
            issuer="ii-engine",
            audience="ii-desktop",
            options={"require": ["sub", "sid", "iat", "exp"]},
        )
        session = db.get(RefreshSession, payload["sid"])
        if (
            not session
            or session.revoked_at
            or session.user_id != payload["sub"]
            or utc(session.expires_at) <= datetime.now(UTC)
        ):
            raise ValueError("Revoked session")
        user = db.get(User, session.user_id)
        if user is None:
            raise ValueError("Deleted account")
        request.state.session_id = session.id
        return user
    except (jwt.PyJWTError, ValueError, KeyError):
        raise HTTPException(401, "Session expired; sign in again") from None


def member_view(request, user, db: Session | None = None):
    """Resolve Discord membership for UI/API.

    Two independent checks keep Engine usable when Discord flaps:
    1) Live Discord bot guild-member lookup (with in-memory cache).
    2) Last-known RoleGrant snapshot written on every successful verify.

    Never fail-closed to a 503 when the user already has an active Engine grant.
    """
    try:
        result = request.app.state.discord.membership(user.discord_id)
        request.state.member_role_ids = result.pop("role_ids", [])
        view = {"display_name": user.display_name, "avatar": user.avatar, **result}
        if db is not None and result.get("membership"):
            grant = db.get(RoleGrant, user.id) or RoleGrant(user_id=user.id)
            now = datetime.now(UTC)
            grant.granted_at = grant.granted_at or now
            grant.last_verified_at = now
            grant.removed_at = None
            grant.entitlements = list(result.get("entitlements") or ["user"])
            grant.role_ids = list(getattr(request.state, "member_role_ids", []) or [])
            grant.roles = list(result.get("roles") or [])
            db.add(grant)
            try:
                db.commit()
            except Exception:
                db.rollback()
            return view
        # Discord reported not-in-guild. Prefer a recent RoleGrant over a flaky 404 so
        # Launch/Home stay open; users can re-authorize Discord to refresh roles.
        if db is not None and not result.get("membership"):
            restored = _role_grant_membership_view(request, user, db)
            if restored is not None:
                return restored
        return view
    except ProviderUnavailable:
        restored = _role_grant_membership_view(request, user, db) if db is not None else None
        if restored is not None:
            return restored
        # Last-ditch: signed-in Engine session implies prior Discord auth; keep the
        # dashboard open with basic membership until Discord recovers.
        request.state.member_role_ids = []
        return {
            "display_name": user.display_name,
            "avatar": user.avatar,
            "membership": True,
            "roles": [],
            "entitlements": ["user"],
        }


def _role_grant_membership_view(request, user, db: Session):
    """Return a membership view from the last RoleGrant snapshot, if still usable."""
    grant = db.get(RoleGrant, user.id)
    if grant is None or grant.removed_at is not None:
        return None
    verified = utc(grant.last_verified_at) if grant.last_verified_at else None
    if verified is None or (datetime.now(UTC) - verified).days > 30:
        return None
    entitlements = list(grant.entitlements or ["user"])
    if "user" not in entitlements:
        entitlements.insert(0, "user")
    role_ids = [str(value) for value in (grant.role_ids or []) if value]
    roles = [role for role in (grant.roles or []) if isinstance(role, dict)]
    request.state.member_role_ids = role_ids
    return {
        "display_name": user.display_name,
        "avatar": user.avatar,
        "membership": True,
        "roles": roles,
        "entitlements": entitlements,
    }


def require_member(
    request: Request,
    user: User = Depends(current_user),
    db: Session = Depends(database),
):
    view = member_view(request, user, db)
    if not view["membership"]:
        raise HTTPException(403, "Join the official Discord server to continue")
    request.state.member = {
        **view,
        "role_ids": getattr(request.state, "member_role_ids", []),
    }
    return user


@router.post("/auth/requests", status_code=201)
def start(body: AuthStart, request: Request, db: Session = Depends(database)):
    configured(request)
    state = token()
    record = AuthRequest(
        id=token(),
        challenge=body.challenge,
        state_hash=digest(state),
        expires_at=datetime.now(UTC) + timedelta(minutes=5),
    )
    db.add(record)
    db.commit()
    return {
        "request_id": record.id,
        "authorize_url": request.app.state.discord.authorize_url(state),
        "expires_at": record.expires_at,
    }


@router.get("/auth/discord/callback", response_class=HTMLResponse)
def callback(
    request: Request,
    state: str = "",
    code: str = "",
    error: str = "",
    db: Session = Depends(database),
):
    if len(state) > 200 or len(code) > 2048:
        return auth_browser_page(
            title="Sign-in failed",
            heading="Invalid Discord response",
            message="Start again from ii Engine.",
            status_code=400,
        )
    record = db.scalar(
        select(AuthRequest).where(AuthRequest.state_hash == digest(state)).with_for_update()
    )
    if not record or record.state_used or utc(record.expires_at) <= datetime.now(UTC):
        return auth_browser_page(
            title="Sign-in expired",
            heading="This sign-in link expired",
            message="Return to ii Engine and start Discord sign-in again.",
            status_code=400,
        )
    record.state_used = True
    db.commit()  # Claim state before contacting Discord; replay must fail even on upstream error.
    if error or not code:
        record.status = "failed"
        db.commit()
        return auth_browser_page(
            title="Sign-in cancelled",
            heading="Discord sign-in was cancelled",
            message="Close this window and start again from ii Engine when you are ready.",
            status_code=400,
        )
    try:
        identity = request.app.state.discord.identity(code)
    except ProviderUnavailable:
        record = db.get(AuthRequest, record.id)
        record.status = "failed"
        db.commit()
        return auth_browser_page(
            title="Sign-in unavailable",
            heading="Discord is busy right now",
            message="Discord sign-in is temporarily unavailable. Close this window and start again in ii Engine.",
            status_code=503,
        )

    login_membership = identity.pop("login_membership", None)
    try:
        user = db.scalar(select(User).where(User.discord_id == identity["discord_id"]))
        if user is None:
            try:
                with db.begin_nested():
                    user = User(**identity)
                    db.add(user)
                    db.flush()
            except IntegrityError:
                # Two devices can complete their first login for the same Discord account.
                user = db.scalar(select(User).where(User.discord_id == identity["discord_id"]))
                if user is None:
                    raise
        db.scalar(select(User).where(User.id == user.id).with_for_update())
        user.display_name = identity["display_name"]
        user.avatar = identity.get("avatar")
        user.last_login_at = datetime.now(UTC)
        # Prefer user-token membership from OAuth (guilds.members.read), then bot lookup.
        # Bot rate limits must not burn a finished Discord identity exchange.
        membership = None
        if isinstance(login_membership, dict) and login_membership.get("membership"):
            membership = login_membership
        else:
            try:
                membership = request.app.state.discord.membership(user.discord_id)
            except ProviderUnavailable:
                membership = login_membership if isinstance(login_membership, dict) else None
        if membership and membership.get("membership"):
            try:
                request.app.state.discord.engine_role(user.discord_id)
            except ProviderUnavailable:
                pass
            grant = db.get(RoleGrant, user.id) or RoleGrant(user_id=user.id)
            grant.granted_at = datetime.now(UTC)
            grant.last_verified_at = grant.granted_at
            grant.removed_at = None
            grant.entitlements = list(membership.get("entitlements") or ["user"])
            grant.role_ids = list(membership.get("role_ids") or [])
            grant.roles = list(membership.get("roles") or [])
            db.add(grant)
        elif membership is None:
            # Outage with no user-token snapshot — provisional grant keeps Engine usable.
            grant = db.get(RoleGrant, user.id) or RoleGrant(user_id=user.id)
            now = datetime.now(UTC)
            grant.granted_at = grant.granted_at or now
            grant.last_verified_at = now
            grant.removed_at = None
            if not grant.entitlements:
                grant.entitlements = ["user"]
            db.add(grant)
            db.add(
                AuditEvent(
                    event_type="login_membership_deferred",
                    actor_id=user.id,
                    result="deferred",
                )
            )
        record.user_id = user.id
        record.status = "complete"
        db.add(AuditEvent(event_type="login", actor_id=user.id, result="success"))
        db.commit()
    except Exception:
        db.rollback()
        record = db.get(AuthRequest, record.id)
        if record is not None:
            record.status = "failed"
            db.commit()
        return auth_browser_page(
            title="Sign-in failed",
            heading="Could not finish sign-in",
            message="Something went wrong finishing Discord sign-in. Start again in ii Engine.",
            status_code=500,
        )
    return HTMLResponse(AUTH_COMPLETE_HTML, headers=AUTH_SECURE_HEADERS)


@router.post("/auth/requests/{request_id}/poll")
def poll(request_id: str, body: AuthPoll, request: Request, db: Session = Depends(database)):
    config = configured(request)
    record = db.scalar(select(AuthRequest).where(AuthRequest.id == request_id).with_for_update())
    if (
        not record
        or record.consumed
        or utc(record.expires_at) <= datetime.now(UTC)
        or not hmac.compare_digest(record.challenge, verifier_challenge(body.verifier))
    ):
        raise HTTPException(400, "Invalid, expired, or consumed authentication request")
    if record.status != "complete":
        return {"status": record.status}
    record.consumed = True
    _, result = issue_session(db, record.user_id, config)
    db.commit()
    return {"status": "complete", **result}


@router.post("/auth/refresh")
def refresh(body: RefreshBody, request: Request, db: Session = Depends(database)):
    config = configured(request)
    hashed = refresh_hash(body.refresh_token, config.refresh_token_pepper.get_secret_value())
    old = db.scalar(select(RefreshSession).where(RefreshSession.token_hash == hashed))
    if not old:
        raise HTTPException(401, "Invalid refresh session")
    # Lock user before session everywhere so disconnect cannot miss an in-flight refresh.
    db.scalar(select(User).where(User.id == old.user_id).with_for_update())
    old = db.scalar(
        select(RefreshSession)
        .where(RefreshSession.id == old.id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if old.revoked_at or utc(old.expires_at) <= datetime.now(UTC):
        db.execute(
            update(RefreshSession)
            .where(RefreshSession.family_id == old.family_id)
            .values(revoked_at=datetime.now(UTC))
        )
        db.commit()
        raise HTTPException(401, "Refresh replay or expiry; sign in again")
    # Keep the same refresh secret. Rotating on every call raced with Windows
    # Credential Manager and wiped whole families ("Discord could not authorize").
    result = mint_access_token(old, config)
    db.commit()
    return {**result, "refresh_token": body.refresh_token}


@router.get("/me", response_model=MemberView)
def me(request: Request, user: User = Depends(current_user), db: Session = Depends(database)):
    return member_view(request, user, db)


@router.post("/me/recheck", response_model=MemberView)
def recheck(request: Request, user: User = Depends(current_user), db: Session = Depends(database)):
    view = member_view(request, user, db)
    if view["membership"]:
        db.scalar(select(User).where(User.id == user.id).with_for_update())
        try:
            request.app.state.discord.engine_role(user.discord_id)
        except ProviderUnavailable:
            # Role sync can wait; do not force another Discord login.
            pass
        grant = db.get(RoleGrant, user.id) or RoleGrant(user_id=user.id)
        grant.granted_at = grant.granted_at or datetime.now(UTC)
        grant.last_verified_at = datetime.now(UTC)
        grant.removed_at = None
        grant.entitlements = list(view.get("entitlements") or ["user"])
        grant.role_ids = list(getattr(request.state, "member_role_ids", []) or [])
        grant.roles = list(view.get("roles") or [])
        db.add(grant)
        db.commit()
    return view


@router.post("/me/cone-kill")
def cone_kill(
    request: Request, user: User = Depends(require_member), db: Session = Depends(database)
):
    role_id = request.app.state.settings.discord_cone_killer_role_id
    already_awarded = role_id in set(request.state.member.get("role_ids", []))
    if not already_awarded:
        try:
            request.app.state.discord.grant_cone_killer_role(user.discord_id)
        except ProviderUnavailable:
            raise HTTPException(
                503, "The cone fell over, but Discord could not award the role"
            ) from None
    db.add(
        AuditEvent(
            event_type="cone_killed",
            actor_id=user.id,
            result="already_awarded" if already_awarded else "awarded",
        )
    )
    db.commit()
    if already_awarded:
        return {
            "awarded": False,
            "role_id": role_id,
            "message": "The cone is down. You already have the Discord role.",
        }
    return {
        "awarded": True,
        "role_id": role_id,
        "message": "You killed the cone — Discord role “I killed the cone” is yours.",
    }


@router.post("/auth/signout", status_code=204)
def signout(request: Request, user: User = Depends(current_user), db: Session = Depends(database)):
    db.scalar(select(User).where(User.id == user.id).with_for_update())
    session = db.get(RefreshSession, request.state.session_id)
    db.execute(
        update(RefreshSession)
        .where(RefreshSession.family_id == session.family_id)
        .values(revoked_at=datetime.now(UTC))
    )
    db.commit()


@router.post("/auth/disconnect")
def disconnect(
    request: Request, user: User = Depends(current_user), db: Session = Depends(database)
):
    db.scalar(select(User).where(User.id == user.id).with_for_update())
    db.execute(
        update(RefreshSession)
        .where(RefreshSession.user_id == user.id)
        .values(revoked_at=datetime.now(UTC))
    )
    db.commit()  # Revoke sessions even if Discord role removal fails.
    removed = False
    try:
        request.app.state.discord.engine_role(user.discord_id, remove=True)
        removed = True
    except ProviderUnavailable:
        pass
    if removed:
        grant = db.get(RoleGrant, user.id)
        if grant:
            grant.removed_at = datetime.now(UTC)
    db.add(
        AuditEvent(
            event_type="disconnect",
            actor_id=user.id,
            result="removed" if removed else "role_removal_pending",
        )
    )
    db.commit()
    return {
        "sessions_revoked": True,
        "role_removed": removed,
        "message": "Disconnected"
        if removed
        else "Sessions revoked. Contact support to remove Engine User.",
    }


@router.delete("/me")
def delete_account(
    request: Request, user: User = Depends(current_user), db: Session = Depends(database)
):
    """Erase one authenticated Engine account and its dependent records."""
    db.scalar(select(User).where(User.id == user.id).with_for_update())
    db.execute(
        update(RefreshSession)
        .where(RefreshSession.user_id == user.id)
        .values(revoked_at=datetime.now(UTC))
    )
    role_removed = False
    try:
        request.app.state.discord.engine_role(user.discord_id, remove=True)
        role_removed = True
    except ProviderUnavailable:
        pass
    db.execute(delete(User).where(User.id == user.id))
    db.add(
        AuditEvent(
            event_type="account_deleted",
            actor_id=None,
            result="role_removed" if role_removed else "role_removal_pending",
        )
    )
    db.commit()
    return {
        "account_deleted": True,
        "sessions_revoked": True,
        "role_removed": role_removed,
        "message": "Account data deleted. Contact support if the Engine User role remains.",
    }


@router.get("/channels")
def channels(request: Request, user: User = Depends(require_member)):
    staff = set(request.state.member["entitlements"]) & {"developer", "admin", "owner"}
    return {"channels": ["stable", "beta", "developer"] if staff else ["stable"]}


@router.get("/staff")
def staff(request: Request, user: User = Depends(require_member)):
    roles = set(request.state.member["entitlements"]) & {"developer", "admin", "owner"}
    if not roles:
        raise HTTPException(403, "Staff entitlement required")
    return {"read_only": True, "entitlements": sorted(roles)}
