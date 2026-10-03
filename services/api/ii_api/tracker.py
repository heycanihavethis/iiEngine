"""Self Tracker presence list + paywalled ii Tracker Discord feed."""

from __future__ import annotations

import logging
import re
import secrets
from datetime import UTC, datetime, timedelta

import jwt
from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy import delete, or_, select
from sqlalchemy.orm import Session

from .auth import database, require_member
from .discord import ProviderUnavailable
from .models import TrackerPresence, TrackerSighting, User

router = APIRouter(prefix="/v1/tracker")
log = logging.getLogger("ii_api.tracker")

SCHEMA_VERSION = 1
STALE_AFTER = timedelta(minutes=12)
FEED_SCHEMA_VERSION = 1
TRACKER_SESSION_AUDIENCE = "ii-tracker-feed"
TRACKER_SESSION_TTL = timedelta(hours=1)
FEED_ITEM_CAP = 40
FEED_HISTORY_CAP = 400
# How many Discord messages to pull per channel before expanding room-sync embeds.
FEED_MESSAGE_LIMIT_RARE = 20
FEED_MESSAGE_LIMIT_PLAYERS = 8
# Sightings older than this are permanently deleted from Postgres.
SIGHTING_RETENTION = timedelta(days=5)
# Allowed client lookback windows (seconds). Live Discord fills the short end;
# longer windows merge persisted sightings.
LOOKBACK_CHOICES_SECONDS = (
    3 * 60,
    15 * 60,
    60 * 60,
    3 * 60 * 60,
)
DEFAULT_LOOKBACK_SECONDS = 3 * 60
TRACK_KIND_RARE = "rare"
TRACK_KIND_PLAYER = "player"
_PLAYER_HEADER_RE = re.compile(r"^\**\s*player\s*(\d+)\s*\**$", re.IGNORECASE)
_PLAYER_FIELD_RE = re.compile(r"^\**\s*player\s*(\d+)\s*\**$", re.IGNORECASE)
_ATTR_LINE_RE = re.compile(
    r"^\s*[*_`]*\s*(username|player\s*id|playerid|user\s*id|userid|id|colou?r|fur\s*colou?r|"
    r"platform|cosmetics?|fit|item)\s*[*_`]*\s*[:\-–]?\s*(.+?)\s*$",
    re.IGNORECASE,
)
_HEX_ID_RE = re.compile(r"\b([A-Fa-f0-9]{8,32})\b")
_RGB_COLOR_RE = re.compile(r"\b(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\b")


def _no_store(response: Response) -> None:
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, private"
    response.headers["Pragma"] = "no-cache"


class PresenceBody(BaseModel):
    username: str = Field(default="", max_length=100)
    room_code: str = Field(default="", max_length=32)
    in_room: bool = False
    updated_at: str = Field(min_length=10, max_length=64)


def _parse_updated_at(value: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError as error:
        raise HTTPException(400, "updated_at must be ISO-8601") from error
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def _aware(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


def _member_role_ids(member: dict) -> set[str]:
    role_ids = {str(value) for value in (member.get("role_ids") or []) if value}
    if role_ids:
        return role_ids
    return {
        str(role.get("id")) for role in (member.get("roles") or []) if isinstance(role, dict)
    }


def _role_configured(settings, attr: str) -> set[str]:
    raw = getattr(settings, attr, "") if settings else ""
    return {part.strip() for part in str(raw or "").split(",") if part.strip()}


def _has_staff_access(member: dict) -> bool:
    return bool(set(member.get("entitlements") or []) & {"admin", "owner", "developer"})


def _has_ii_tracker_unlock(request: Request) -> bool:
    """Paid / early-access unlock (coming-soon badge). Not enough for live feed."""
    member = getattr(request.state, "member", {}) or {}
    entitlements = set(member.get("entitlements") or [])
    if entitlements & {"ii_tracker"} or _has_staff_access(member):
        return True
    settings = getattr(request.app.state, "settings", None)
    allowed = _role_configured(settings, "discord_ii_tracker_role_ids")
    return bool(allowed and _member_role_ids(member).intersection(allowed))


def _has_tracker_beta_access(request: Request) -> bool:
    """Live rare-cosmetics feed. Beta role or staff only."""
    member = getattr(request.state, "member", {}) or {}
    entitlements = set(member.get("entitlements") or [])
    if entitlements & {"ii_tracker_beta"} or _has_staff_access(member):
        return True
    settings = getattr(request.app.state, "settings", None)
    allowed = _role_configured(settings, "discord_ii_tracker_beta_role_ids")
    return bool(allowed and _member_role_ids(member).intersection(allowed))


def _feature_access_allows(request: Request, key: str) -> bool | None:
    """Return True/False when Dev Panel has a rule; None if unavailable."""
    try:
        from .developer import operation_view

        engine = getattr(request.app.state, "engine", None)
        if engine is None:
            return None
        with Session(engine) as db:
            rule = operation_view(db).get("feature_access", {}).get(key) or {}
        if not rule.get("enabled", False):
            return False
        if rule.get("everyone", False):
            return True
        member = getattr(request.state, "member", {}) or {}
        return bool(
            set(rule.get("role_ids") or []) & _member_role_ids(member)
            or set(rule.get("entitlements") or []) & set(member.get("entitlements") or [])
        )
    except Exception:
        return None


def _has_tracker_product_access(request: Request) -> bool:
    """Player / Target / Scout — Dev Panel feature_access.tracker, else Discord unlock."""
    panel = _feature_access_allows(request, "tracker")
    if panel is not None:
        return panel
    return _has_ii_tracker_unlock(request) or _has_tracker_beta_access(request)


def _signing_key(request: Request) -> str:
    secret = request.app.state.settings.access_token_signing_key.get_secret_value()
    if len(secret) < 32:
        raise HTTPException(503, "Tracker sessions are not configured")
    return secret


def _issue_tracker_session(request: Request, user: User) -> dict:
    now = datetime.now(UTC)
    expires_at = now + TRACKER_SESSION_TTL
    # Day claim forces tokens to stop working after UTC midnight even if TTL remains —
    # closer to Mega's "rotating key" idea without a shared client secret.
    day = now.strftime("%Y-%m-%d")
    token = jwt.encode(
        {
            "sub": user.id,
            "aud": TRACKER_SESSION_AUDIENCE,
            "iss": "ii-engine",
            "iat": now,
            "exp": expires_at,
            "jti": secrets.token_urlsafe(16),
            "day": day,
            "scope": "tracker.feed",
        },
        _signing_key(request),
        algorithm="HS256",
    )
    return {
        "token": token,
        "expires_at": expires_at.isoformat(),
        "ttl_seconds": int(TRACKER_SESSION_TTL.total_seconds()),
        "day": day,
    }


def _require_tracker_session(
    request: Request,
    user: User,
    x_tracker_session: str | None,
) -> None:
    if not x_tracker_session or not x_tracker_session.strip():
        raise HTTPException(401, "Tracker session required")
    try:
        claim = jwt.decode(
            x_tracker_session.strip(),
            _signing_key(request),
            algorithms=["HS256"],
            audience=TRACKER_SESSION_AUDIENCE,
            issuer="ii-engine",
            options={"require": ["sub", "exp", "iat", "jti", "day", "scope"]},
        )
    except jwt.PyJWTError as error:
        raise HTTPException(401, "Tracker session is invalid or expired") from error
    if str(claim.get("sub") or "") != user.id:
        raise HTTPException(401, "Tracker session does not match this account")
    if claim.get("scope") != "tracker.feed":
        raise HTTPException(401, "Tracker session is invalid or expired")
    today = datetime.now(UTC).strftime("%Y-%m-%d")
    if str(claim.get("day") or "") != today:
        raise HTTPException(401, "Tracker session expired for today — refresh the session")


def _player_view(row: TrackerPresence, user: User, *, now: datetime):
    updated = _aware(row.updated_at)
    age = max(0, int((now - updated).total_seconds()))
    online = now - updated <= STALE_AFTER
    in_room = bool(row.in_room and online and row.room_code)
    if not online:
        status = "offline"
    elif in_room:
        status = "in_room"
    else:
        status = "online"
    return {
        "display_name": user.display_name,
        "username": row.username,
        "avatar": user.avatar,
        "room_code": row.room_code if in_room else "",
        "in_room": in_room,
        "updated_at": updated.isoformat(),
        "online": online,
        "seconds_ago": age,
        "status": status,
        # Kept for React keys / Engine account identity only — UI must not show it.
        "user_id": user.id,
    }


@router.post("/presence")
def upsert_presence(
    body: PresenceBody,
    request: Request,
    user: User = Depends(require_member),
    db: Session = Depends(database),
):
    del request
    updated_at = _parse_updated_at(body.updated_at)
    now = datetime.now(UTC)
    if updated_at > now + timedelta(minutes=2):
        raise HTTPException(400, "updated_at is too far in the future")
    row = db.get(TrackerPresence, user.id)
    if row is None:
        row = TrackerPresence(user_id=user.id)
        db.add(row)
    row.username = body.username.strip()[:100]
    row.room_code = body.room_code.strip().upper()[:32] if body.in_room else ""
    row.in_room = bool(body.in_room and row.room_code)
    row.updated_at = updated_at
    db.commit()
    db.refresh(row)
    return _player_view(row, user, now=now)


@router.delete("/presence")
def clear_presence(
    user: User = Depends(require_member),
    db: Session = Depends(database),
):
    row = db.get(TrackerPresence, user.id)
    if row is not None:
        db.delete(row)
        db.commit()
    return {"ok": True}


@router.get("/players")
def list_players(
    user: User = Depends(require_member),
    db: Session = Depends(database),
):
    del user
    now = datetime.now(UTC)
    rows = db.execute(
        select(TrackerPresence, User)
        .join(User, User.id == TrackerPresence.user_id)
        .order_by(TrackerPresence.updated_at.desc())
    ).all()
    players = [_player_view(presence, member, now=now) for presence, member in rows]
    return {
        "schema_version": SCHEMA_VERSION,
        "stale_after_seconds": int(STALE_AFTER.total_seconds()),
        "players": players,
    }


def _plain(value: object, limit: int = 200) -> str:
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    # Partner embeds sometimes leave Discord markdown markers on field values.
    text = (
        text.replace("**", "")
        .replace("__", "")
        .replace("`", "")
        .replace("*", "")
        .strip(" _•-–—")
    )
    return text[:limit]


def _normalize_color(value: object) -> str:
    """Normalize embed color to `R G B` (preferred) or `#RRGGBB`."""
    raw = _plain(value, 32)
    if not raw:
        return ""
    hex_match = re.fullmatch(r"#?([0-9A-Fa-f]{6})", raw)
    if hex_match:
        return f"#{hex_match.group(1).upper()}"
    parts = re.split(r"[\s,]+", raw)
    if len(parts) == 3 and all(part.isdigit() and 0 <= int(part) <= 255 for part in parts):
        return f"{int(parts[0])} {int(parts[1])} {int(parts[2])}"
    return raw[:32]


def _embed_sidebar_color(embed: dict) -> str:
    """Convert Discord embed sidebar color integer to `R G B` when present."""
    raw = embed.get("color")
    if raw is None or raw == "":
        return ""
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return ""
    if value <= 0:
        return ""
    red = (value >> 16) & 255
    green = (value >> 8) & 255
    blue = value & 255
    return f"{red} {green} {blue}"


def _discord_feed_reason(error: ProviderUnavailable) -> tuple[str, bool]:
    """Map Discord bot failures to a player-safe reason + whether it's a bot/channel issue."""
    kind = getattr(error, "kind", None) or ""
    status = getattr(error, "status", None)
    message = str(error)
    if kind == "not_configured" or "not configured" in message.lower():
        return (
            "Engine Discord bot token is missing on the API. Staff need to set DISCORD_BOT_TOKEN.",
            True,
        )
    if kind in {"forbidden", "not_found"} or status in (401, 403, 404):
        return (
            (
                "Engine bot can't read the tracker channel. Invite the bot to that Discord "
                "and give it View Channel + Read Message History."
            ),
            True,
        )
    if kind == "rate_limited" or status == 429:
        return ("Discord rate-limited the tracker channel. Try Refresh in a minute.", True)
    if kind == "timeout" or "timed out" in message.lower():
        return ("Discord timed out while reading the tracker channel. Try Refresh.", True)
    return ("Tracker feed is temporarily unavailable.", True)


def _embed_field_map(embed: dict) -> dict[str, str]:
    """Normalize Discord embed field name → value (case-insensitive keys)."""
    fields = embed.get("fields") if isinstance(embed.get("fields"), list) else []
    mapped: dict[str, str] = {}
    for field in fields:
        if not isinstance(field, dict):
            continue
        name = _plain(field.get("name") or "", 80).lower()
        value = _plain(field.get("value") or "", 200)
        if name and value:
            mapped[name] = value
    return mapped


def _field_value(fields: dict[str, str], *names: str) -> str:
    """Look up embed fields by name. Prefer exact matches, then safe prefixes.

    Prefix matches only when the remainder is not a reserved qualifier (e.g. looking
    for ``player`` must not steal ``player id``).
    """
    reserved_tails = {"id", "ids", "code", "count", "name", "color", "colour"}
    for name in names:
        key = name.lower().strip()
        if not key:
            continue
        if key in fields:
            return fields[key]
        for existing, value in fields.items():
            if existing == key:
                return value
            if existing.startswith(f"{key} "):
                tail = existing[len(key) :].strip().split(" ", 1)[0]
                if tail in reserved_tails:
                    continue
                return value
        # Substring match only for longer, distinctive labels.
        if len(key) >= 6 and " " in key:
            for existing, value in fields.items():
                if key in existing:
                    return value
    return ""


def _message_stamp(message: dict) -> datetime:
    stamp_raw = str(message.get("timestamp") or "")
    try:
        return datetime.fromisoformat(stamp_raw).astimezone(UTC)
    except ValueError:
        return datetime.now(UTC)


def _message_avatar(author: dict) -> str | None:
    avatar_hash = str(author.get("avatar") or "")
    author_id = str(author.get("id") or "")
    if author_id.isdigit() and re.fullmatch(r"(?:a_)?[0-9a-f]{32}", avatar_hash):
        return f"https://cdn.discordapp.com/avatars/{author_id}/{avatar_hash}.png"
    return None


def _parse_attr_blob(blob: str) -> dict[str, str]:
    """Pull Username/ID/Color/Platform/Cosmetics from a freeform player block."""
    found: dict[str, str] = {}
    # Prefer labeled lines (newlines preserved by callers).
    for raw_line in re.split(r"[\r\n]+", blob):
        # Strip Discord markdown wrappers like **Player ID:** before matching.
        line = re.sub(r"^[\s*_`•\-–—]+", "", raw_line.strip())
        line = line.replace("**", "").replace("__", "").replace("`", "")
        if not line:
            continue
        match = _ATTR_LINE_RE.match(line)
        if not match:
            continue
        key = re.sub(r"\s+", "", match.group(1).lower())
        value = _plain(match.group(2), 200)
        if key.startswith("cosmetic") or key in {"fit", "item"}:
            found["cosmetics"] = value
        elif key == "username":
            found["username"] = value
        elif key in {"id", "playerid", "userid"}:
            cleaned = _plain(value, 64)
            found["id"] = (
                cleaned.upper() if re.fullmatch(r"[A-Fa-f0-9]{6,32}", cleaned) else cleaned
            )
        elif key in {"color", "colour", "furcolor", "furcolour"}:
            found["color"] = _normalize_color(value)
        elif key == "platform":
            found["platform"] = value
    # Fallback: "Username: X · ID: Y" on one line (also tolerate markdown wrappers).
    scrubbed = blob.replace("**", "").replace("__", "").replace("`", "")
    if "username" not in found:
        match = re.search(r"username\s*[:\-–]?\s*([^\n·|•]+)", scrubbed, re.IGNORECASE)
        if match:
            found["username"] = _plain(match.group(1), 100)
    if "id" not in found:
        match = re.search(
            r"\b(?:player\s*id|playerid|user\s*id|userid|id)\s*[:\-–]?\s*([A-Fa-f0-9]{8,32})\b",
            scrubbed,
            re.IGNORECASE,
        )
        if match:
            found["id"] = match.group(1).upper()
    if "cosmetics" not in found:
        match = re.search(r"cosmetics?\s*[:\-–]?\s*([^\n]+)", scrubbed, re.IGNORECASE)
        if match:
            found["cosmetics"] = _plain(match.group(1), 200)
    if "color" not in found:
        match = re.search(
            r"(?:fur\s*)?colou?r\s*[:\-–]?\s*"
            r"(#?[0-9A-Fa-f]{6}|[0-9]{1,3}(?:\s*[,\s]\s*[0-9]{1,3}){2})",
            scrubbed,
            re.IGNORECASE,
        )
        if match:
            found["color"] = _normalize_color(match.group(1))
    if "platform" not in found:
        match = re.search(r"platform\s*[:\-–]?\s*([A-Za-z0-9_\- ]+)", scrubbed, re.IGNORECASE)
        if match:
            found["platform"] = _plain(match.group(1), 40)
    # Unlabeled multiline Player N blobs: Name / hex ID / RGB / platform.
    if "id" not in found or "color" not in found or "username" not in found:
        lines = [ln.strip() for ln in re.split(r"[\r\n]+", scrubbed) if ln.strip()]
        if "id" not in found:
            for line in lines:
                hex_match = _HEX_ID_RE.fullmatch(_plain(line, 64))
                if hex_match:
                    found["id"] = hex_match.group(1).upper()
                    break
        if "color" not in found:
            for line in lines:
                rgb = _RGB_COLOR_RE.fullmatch(_plain(line, 32).replace(",", " "))
                if not rgb:
                    rgb = _RGB_COLOR_RE.search(_plain(line, 32))
                if rgb and all(0 <= int(part) <= 255 for part in rgb.groups()):
                    found["color"] = f"{int(rgb.group(1))} {int(rgb.group(2))} {int(rgb.group(3))}"
                    break
        if "username" not in found:
            for line in lines:
                candidate = _plain(line, 100)
                if (
                    candidate
                    and not _HEX_ID_RE.fullmatch(candidate)
                    and not _RGB_COLOR_RE.fullmatch(candidate.replace(",", " "))
                    and not re.fullmatch(r"(?i)pc|quest|steam|oculus|pico", candidate)
                    and not re.search(r"(?i)username|player\s*id|colou?r|platform|cosmetic", candidate)
                ):
                    found["username"] = candidate
                    break
    return found


def _room_meta_from_fields(fields: dict[str, str]) -> tuple[str, str]:
    room = _field_value(fields, "directory", "room", "room code", "code").upper()
    region = _field_value(fields, "region").upper()
    return room, region


def _players_from_room_sync_embed(embed: dict) -> tuple[str, str, list[dict[str, str]]]:
    """Split a Room Sync Data embed into per-player attribute dicts."""
    fields_list = embed.get("fields") if isinstance(embed.get("fields"), list) else []
    flat_fields = _embed_field_map(embed)
    room, region = _room_meta_from_fields(flat_fields)
    players: list[dict[str, str]] = []

    # Shape A: "Player N" fields whose values hold the attribute blob (newlines kept).
    for field in fields_list:
        if not isinstance(field, dict):
            continue
        name = str(field.get("name") or "").strip()
        if not _PLAYER_FIELD_RE.match(re.sub(r"\s+", " ", name)):
            continue
        raw_value = str(field.get("value") or "")
        attrs = _parse_attr_blob(raw_value)
        # Sometimes the Player N value is just the username.
        if not attrs.get("username") and raw_value.strip() and "\n" not in raw_value:
            maybe = _plain(raw_value, 100)
            if maybe and not re.fullmatch(r"\d+", maybe):
                attrs["username"] = maybe
        if attrs.get("username") or attrs.get("id"):
            players.append(attrs)

    # Shape B: description markdown blocks under **Player N** headers.
    if not players:
        description = str(embed.get("description") or "")
        if description.strip():
            chunks = re.split(r"(?i)\n\s*\**\s*player\s*\d+\s*\**\s*\n", "\n" + description)
            # First chunk is preamble before Player 1.
            for chunk in chunks[1:]:
                attrs = _parse_attr_blob(chunk)
                if attrs.get("username") or attrs.get("id"):
                    players.append(attrs)

    # Shape C: flat repeating Username/ID/Color/Platform/Cosmetics fields.
    if not players:
        current: dict[str, str] = {}
        for field in fields_list:
            if not isinstance(field, dict):
                continue
            name = _plain(field.get("name") or "", 80).lower()
            # Keep newlines out — flat values are single-line.
            value = _plain(field.get("value") or "", 200)
            if not name:
                continue
            if _PLAYER_HEADER_RE.match(name):
                if current.get("username") or current.get("id"):
                    players.append(current)
                current = {}
                if value and not re.fullmatch(r"\d+", value):
                    current["username"] = value
                continue
            if name in {"directory", "region", "players", "player count", "alerts"}:
                continue
            if name in {"username", "user", "nick"}:
                if current.get("username") and (current.get("id") or current.get("cosmetics")):
                    players.append(current)
                    current = {}
                current["username"] = value
            elif name in {"id", "player id", "player_id", "playerid", "userid", "user id"}:
                current["id"] = value.upper()
            elif name in {"color", "colour", "fur color", "fur colour"}:
                current["color"] = _normalize_color(value)
            elif name == "platform":
                current["platform"] = value
            elif name in {"cosmetics", "cosmetic", "fit", "item"}:
                current["cosmetics"] = value
        if current.get("username") or current.get("id"):
            players.append(current)

    return room, region, players


def _feed_item(
    *,
    item_id: str,
    author_name: str,
    avatar: str | None,
    stamp: datetime,
    track_kind: str,
    username: str = "",
    player_id: str = "",
    room: str = "",
    region: str = "",
    cosmetic: str = "",
    color: str = "",
    platform: str = "",
    embed_title: str = "",
) -> dict | None:
    username = _plain(username, 100)
    player_id = _plain(player_id, 64).upper()
    room = _plain(room, 16).upper()
    region = _plain(region, 16).upper()
    cosmetic = _plain(cosmetic, 200)
    color = _normalize_color(color)
    platform = _plain(platform, 40)
    if not username and not player_id and not cosmetic and not embed_title:
        return None
    display_author = username or author_name
    summary_bits = [
        bit
        for bit in (
            username,
            cosmetic,
            f"Room {room}" if room else "",
            f"Region {region}" if region else "",
            f"ID {player_id}" if player_id else "",
            platform,
        )
        if bit
    ]
    content = _plain(" · ".join(summary_bits), 1800) if summary_bits else _plain(embed_title, 1800)
    title = embed_title
    if track_kind == TRACK_KIND_RARE and cosmetic:
        if not title or "detected" in title.lower() or "alert" in title.lower():
            title = cosmetic
    elif track_kind == TRACK_KIND_PLAYER:
        title = title or username or "Player"
    return {
        "id": item_id,
        "author": display_author,
        "avatar": avatar,
        "text": content,
        "embed_title": title,
        "embed_description": content,
        "username": username,
        "player_id": player_id,
        "room": room,
        "region": region,
        "cosmetic": cosmetic,
        "color": color,
        "platform": platform,
        "track_kind": track_kind,
        "timestamp": stamp.isoformat(),
        "url": "",
    }


def _tracker_feed_items(message: dict, *, track_kind: str) -> list[dict]:
    """Turn one Discord message into zero or more feed pills.

    Empty plain-text noise (no embeds / no usable content) is ignored.
    Room Sync Data embeds expand into one pill per player.
    """
    message_id = str(message.get("id") or "")
    if not message_id.isdigit():
        return []
    author = message.get("author") if isinstance(message.get("author"), dict) else {}
    author_name = _plain(author.get("global_name") or author.get("username") or "Tracker", 100)
    avatar = _message_avatar(author)
    stamp = _message_stamp(message)
    content_raw = str(message.get("content") or "").strip()
    embeds = message.get("embeds") if isinstance(message.get("embeds"), list) else []
    usable_embeds = [embed for embed in embeds if isinstance(embed, dict)]

    # Ignore empty / random plain-text channel noise with no embed payload.
    if not usable_embeds:
        return []
    if not content_raw and not any(
        str(embed.get("title") or "").strip()
        or str(embed.get("description") or "").strip()
        or (isinstance(embed.get("fields"), list) and embed.get("fields"))
        for embed in usable_embeds
    ):
        return []

    items: list[dict] = []
    for embed_index, embed in enumerate(usable_embeds):
        title = _plain(embed.get("title") or "", 160)
        fields = _embed_field_map(embed)
        is_room_sync = (
            track_kind == TRACK_KIND_PLAYER
            or "room sync" in title.lower()
            or bool(_field_value(fields, "directory"))
            or any(
                _PLAYER_FIELD_RE.match(_plain(f.get("name") or "", 40))
                for f in (embed.get("fields") or [])
                if isinstance(f, dict)
            )
        )
        if is_room_sync:
            room, region, players = _players_from_room_sync_embed(embed)
            for index, player in enumerate(players):
                item = _feed_item(
                    item_id=f"{message_id}:{embed_index}:{index}:{player.get('id') or index}",
                    author_name=author_name,
                    avatar=avatar,
                    stamp=stamp,
                    track_kind=TRACK_KIND_PLAYER,
                    username=player.get("username", ""),
                    player_id=player.get("id", ""),
                    room=room,
                    region=region,
                    cosmetic=player.get("cosmetics", ""),
                    color=player.get("color", ""),
                    platform=player.get("platform", ""),
                    embed_title=player.get("username", "") or "Player",
                )
                if item:
                    items.append(item)
            continue

        # Rare / single-player cosmetic embed (Username / ID / Room / Region / Color / Cosmetics).
        # Do not use bare "player" here — it prefix-matches "Player ID" and steals the ID.
        username = _field_value(fields, "username", "user", "nick")
        player_id = _field_value(
            fields, "player id", "player_id", "playerid", "user id", "userid", "id"
        )
        room = _field_value(fields, "room", "room code", "code", "directory").upper()
        region = _field_value(fields, "region").upper()
        cosmetic = _field_value(fields, "cosmetics", "cosmetic", "fit", "item")
        color = _normalize_color(_field_value(fields, "color", "colour", "fur color", "fur colour"))
        platform = _field_value(fields, "platform")
        # Also scrape description / title blob when fields omit ID or color.
        attr_blob = "\n".join(
            [
                str(embed.get("description") or ""),
                title,
                *(f"{k}: {v}" for k, v in fields.items()),
            ]
        )
        scraped = _parse_attr_blob(attr_blob)
        if not player_id:
            player_id = scraped.get("id", "")
        if not color:
            color = scraped.get("color", "") or _embed_sidebar_color(embed)
        if not platform:
            platform = scraped.get("platform", "")
        if not username:
            username = scraped.get("username", "")
        item = _feed_item(
            item_id=message_id if embed_index == 0 else f"{message_id}:{embed_index}",
            author_name=author_name,
            avatar=avatar,
            stamp=stamp,
            track_kind=TRACK_KIND_RARE if track_kind == TRACK_KIND_RARE else TRACK_KIND_PLAYER,
            username=username,
            player_id=player_id,
            room=room,
            region=region,
            cosmetic=cosmetic,
            color=color,
            platform=platform,
            embed_title=title,
        )
        if item:
            items.append(item)
    return items


def _read_tracker_channel(discord, channel_id: str, *, limit: int) -> list[dict]:
    discord_response = discord.request(
        "GET",
        f"/channels/{channel_id}/messages",
        params={"limit": limit},
    )
    if discord_response.status_code == 404:
        raise ProviderUnavailable(
            "Tracker channel is not visible to the bot",
            status=404,
            kind="not_found",
        )
    if discord_response.status_code != 200:
        raise ProviderUnavailable(
            "Tracker feed unavailable",
            status=discord_response.status_code,
            kind="forbidden" if discord_response.status_code in (401, 403) else "unavailable",
        )
    rows = discord_response.json()
    if not isinstance(rows, list):
        raise ProviderUnavailable("Tracker feed unavailable", kind="bad_payload")
    return [row for row in rows if isinstance(row, dict)]


def _normalize_lookback_seconds(value: int | None) -> int:
    if value is None:
        return DEFAULT_LOOKBACK_SECONDS
    try:
        seconds = int(value)
    except (TypeError, ValueError):
        return DEFAULT_LOOKBACK_SECONDS
    # Snap to the nearest allowed choice (clients may send exact presets).
    if seconds in LOOKBACK_CHOICES_SECONDS:
        return seconds
    return min(LOOKBACK_CHOICES_SECONDS, key=lambda choice: abs(choice - seconds))


def _sighting_to_item(row: TrackerSighting) -> dict:
    return {
        "id": row.id,
        "author": row.author or row.username or "Tracker",
        "avatar": row.avatar,
        "text": row.text or "",
        "embed_title": row.embed_title or row.username or "",
        "embed_description": row.text or "",
        "username": row.username or "",
        "player_id": row.player_id or "",
        "room": row.room or "",
        "region": row.region or "",
        "cosmetic": row.cosmetic or "",
        "color": row.color or "",
        "platform": row.platform or "",
        "track_kind": row.track_kind or TRACK_KIND_PLAYER,
        "timestamp": _aware(row.seen_at).isoformat(),
        "url": "",
    }


def _purge_expired_sightings(db: Session, *, now: datetime) -> int:
    cutoff = now - SIGHTING_RETENTION
    result = db.execute(delete(TrackerSighting).where(TrackerSighting.seen_at < cutoff))
    deleted = int(result.rowcount or 0)
    if deleted:
        db.commit()
    return deleted


def _persist_sightings(db: Session, items: list[dict]) -> None:
    if not items:
        return
    for item in items:
        item_id = str(item.get("id") or "").strip()
        if not item_id or len(item_id) > 120:
            continue
        stamp_raw = str(item.get("timestamp") or "")
        try:
            seen_at = _parse_updated_at(stamp_raw)
        except HTTPException:
            continue
        row = db.get(TrackerSighting, item_id)
        if row is None:
            row = TrackerSighting(id=item_id)
            db.add(row)
        row.player_id = str(item.get("player_id") or "")[:64]
        row.username = str(item.get("username") or "")[:100]
        row.room = str(item.get("room") or "")[:32]
        row.region = str(item.get("region") or "")[:16]
        row.cosmetic = str(item.get("cosmetic") or "")[:200]
        row.color = str(item.get("color") or "")[:64]
        row.platform = str(item.get("platform") or "")[:32]
        row.track_kind = str(item.get("track_kind") or TRACK_KIND_PLAYER)[:16]
        row.author = str(item.get("author") or row.username or "Tracker")[:100]
        avatar = item.get("avatar")
        row.avatar = str(avatar)[:300] if avatar else None
        row.text = str(item.get("text") or item.get("embed_description") or "")[:4000]
        row.embed_title = str(item.get("embed_title") or row.username or "")[:200]
        row.seen_at = seen_at
    db.commit()


def _load_sightings_window(db: Session, *, since: datetime, limit: int) -> list[dict]:
    rows = db.scalars(
        select(TrackerSighting)
        .where(TrackerSighting.seen_at >= since)
        .order_by(TrackerSighting.seen_at.desc())
        .limit(limit)
    ).all()
    return [_sighting_to_item(row) for row in rows]


def _sanitize_search_term(raw: str, *, max_len: int = 64) -> str:
    term = re.sub(r"[%_\\]", "", (raw or "").strip())
    term = re.sub(r"\s+", " ", term)
    return term[:max_len]


def resolve_scout_time_window(
    *,
    day: str | None = None,
    hour_utc: int | None = None,
    lookback_minutes: int | None = None,
    now: datetime | None = None,
) -> tuple[datetime | None, datetime | None]:
    """Turn planner day/hour/lookback hints into a UTC [since, until) window."""
    clock = now or datetime.now(UTC)
    if clock.tzinfo is None:
        clock = clock.replace(tzinfo=UTC)
    else:
        clock = clock.astimezone(UTC)

    if lookback_minutes is not None:
        try:
            mins = int(lookback_minutes)
        except (TypeError, ValueError):
            mins = 0
        # Clamp to retention; minimum 10 minutes so "just now" still has room.
        mins = max(10, min(int(SIGHTING_RETENTION.total_seconds() // 60), mins))
        return clock - timedelta(minutes=mins), clock

    day_key = (day or "").strip().lower()
    base_day = clock.date()
    if day_key in {"", "today"}:
        base_day = clock.date()
    elif day_key in {"yesterday", "yday"}:
        base_day = clock.date() - timedelta(days=1)
    else:
        try:
            base_day = datetime.strptime(day_key[:10], "%Y-%m-%d").date()
        except ValueError:
            base_day = clock.date() if hour_utc is not None else None
            if base_day is None:
                return None, None

    if hour_utc is None and day_key in {"", "today"} and day is None:
        return None, None

    if hour_utc is None:
        start = datetime(base_day.year, base_day.month, base_day.day, tzinfo=UTC)
        return start, start + timedelta(days=1)

    hour = max(0, min(23, int(hour_utc)))
    start = datetime(base_day.year, base_day.month, base_day.day, hour, 0, 0, tzinfo=UTC)
    # Soft hour bucket: target hour ± 30 minutes so "around 2pm" still matches.
    return start - timedelta(minutes=30), start + timedelta(minutes=90)


def search_sightings(
    db: Session,
    *,
    query: str = "",
    field: str = "any",
    since: datetime | None = None,
    until: datetime | None = None,
    limit: int = 40,
) -> list[dict]:
    """Cheap indexed lookup over retained lobby sightings for Tracker Scout.

    Text term optional when a time window is provided — used for
    "who was playing an hour ago" style recent-player browses.
    """
    term = _sanitize_search_term(query)
    now = datetime.now(UTC)
    window_start = since or (now - SIGHTING_RETENTION)
    retention_floor = now - SIGHTING_RETENTION
    if window_start < retention_floor:
        window_start = retention_floor
    # Text-only browse needs an explicit window; bare empty query is a no-op.
    if len(term) < 2 and since is None and until is None:
        return []
    kind = (field or "any").strip().lower()
    if kind not in {"username", "player_id", "room", "color", "any", "recent"}:
        kind = "any"
    if kind == "recent":
        kind = "any"
    # Color-name searches need a wider raw pull, then HSV/RGB matching in Python.
    color_name = ""
    if kind == "color":
        from .scout_context import COLOR_NAME_SAMPLES, filter_items_by_color_name

        color_name = term.lower().strip()
        if color_name in COLOR_NAME_SAMPLES:
            term = ""
    cap = max(1, min(120 if color_name else 80, int(limit)))
    pull = max(cap, 160 if color_name else cap)
    stmt = select(TrackerSighting).where(TrackerSighting.seen_at >= window_start)
    if until is not None:
        stmt = stmt.where(TrackerSighting.seen_at < until)
    if len(term) >= 2:
        like = f"%{term}%"
        if kind == "username":
            stmt = stmt.where(TrackerSighting.username.ilike(like))
        elif kind == "player_id":
            stmt = stmt.where(TrackerSighting.player_id.ilike(like))
        elif kind == "room":
            # Prefer exact room codes (HI, RUN, ZZ2A) but still allow partials.
            stmt = stmt.where(
                or_(
                    TrackerSighting.room.ilike(term),
                    TrackerSighting.room.ilike(like),
                )
            )
        elif kind == "color":
            stmt = stmt.where(TrackerSighting.color.ilike(like))
        else:
            stmt = stmt.where(
                or_(
                    TrackerSighting.username.ilike(like),
                    TrackerSighting.player_id.ilike(like),
                    TrackerSighting.room.ilike(like),
                    TrackerSighting.cosmetic.ilike(like),
                    TrackerSighting.color.ilike(like),
                    TrackerSighting.region.ilike(like),
                )
            )
    elif color_name:
        # Named color: require a stored color value, then filter by distance/hue.
        stmt = stmt.where(TrackerSighting.color != "")
    rows = db.scalars(stmt.order_by(TrackerSighting.seen_at.desc()).limit(pull)).all()
    items = [_sighting_to_item(row) for row in rows]
    if color_name:
        from .scout_context import filter_items_by_color_name

        items = filter_items_by_color_name(items, color_name)
    return items[:cap]


def rollup_scout_players(items: list[dict], *, limit: int = 24) -> list[dict]:
    """Collapse raw sighting rows into compact player pills for the Scout UI."""
    rollups: dict[str, dict] = {}
    for item in items:
        username = _plain(item.get("username") or "", 100)
        player_id = _plain(item.get("player_id") or "", 64).upper()
        key = f"ID:{player_id}" if player_id else f"NICK:{(username or 'player').upper()}"
        stamp = str(item.get("timestamp") or "")
        row = rollups.get(key)
        if row is None:
            rollups[key] = {
                "key": key,
                "username": username or (player_id[:8] if player_id else "Player"),
                "player_id": player_id,
                "room": _plain(item.get("room") or "", 16).upper(),
                "region": _plain(item.get("region") or "", 12).upper(),
                "color": _normalize_color(item.get("color") or ""),
                "platform": _plain(item.get("platform") or "", 24),
                "track_kind": _plain(item.get("track_kind") or "player", 16),
                "last_seen": stamp,
                "sightings": 1,
            }
            continue
        row["sightings"] = int(row.get("sightings") or 0) + 1
        if stamp > str(row.get("last_seen") or ""):
            row["last_seen"] = stamp
            row["room"] = _plain(item.get("room") or row.get("room") or "", 16).upper()
            row["region"] = _plain(item.get("region") or row.get("region") or "", 12).upper()
            color = _normalize_color(item.get("color") or "")
            if color:
                row["color"] = color
            if username:
                row["username"] = username
    ordered = sorted(
        rollups.values(),
        key=lambda row: (str(row.get("last_seen") or ""), int(row.get("sightings") or 0)),
        reverse=True,
    )
    return ordered[: max(1, min(40, int(limit)))]


def format_sightings_for_scout(items: list[dict], *, max_chars: int = 4500) -> str:
    """Compress search hits into a compact facts block for the answerer model."""
    if not items:
        return "(no matching sightings in the retained window)"
    lines = ["nick|id|room|region|color|cosmetic|platform|kind|seen_at_utc"]
    for item in items:
        line = "|".join(
            [
                _plain(str(item.get("username") or ""), 40),
                _plain(str(item.get("player_id") or ""), 32),
                _plain(str(item.get("room") or ""), 16),
                _plain(str(item.get("region") or ""), 12),
                _plain(str(item.get("color") or ""), 24),
                _plain(str(item.get("cosmetic") or ""), 40),
                _plain(str(item.get("platform") or ""), 16),
                _plain(str(item.get("track_kind") or ""), 12),
                _plain(str(item.get("timestamp") or ""), 32),
            ]
        )
        if sum(len(row) + 1 for row in lines) + len(line) > max_chars:
            lines.append("…truncated")
            break
        lines.append(line)
    return "\n".join(lines)


@router.post("/session")
def issue_tracker_session(
    request: Request,
    response: Response,
    user: User = Depends(require_member),
):
    """Mint a short-lived, per-user, day-bound capability token for the live feed."""
    _no_store(response)
    if not _has_tracker_beta_access(request):
        raise HTTPException(
            403,
            "Live tracker beta access required.",
        )
    return _issue_tracker_session(request, user)


@router.get("/feed")
def tracker_discord_feed(
    request: Request,
    response: Response,
    user: User = Depends(require_member),
    db: Session = Depends(database),
    x_tracker_session: str | None = Header(default=None, alias="X-Tracker-Session"),
    lookback_seconds: int | None = Query(
        default=None,
        ge=60,
        le=3 * 60 * 60,
        description="How far back to include persisted sightings (3m–3h presets).",
    ),
):
    """Live rare-cosmetics feed for beta testers. Requires a fresh tracker session token."""
    _no_store(response)
    lookback = _normalize_lookback_seconds(lookback_seconds)
    # Paid unlock without beta: soft coming-soon (no Discord read).
    if not _has_tracker_beta_access(request):
        if _has_ii_tracker_unlock(request):
            return {
                "schema_version": FEED_SCHEMA_VERSION,
                "enabled": False,
                "live": False,
                "configured": True,
                "unavailable": True,
                "items": [],
                "lookback_seconds": lookback,
                "retention_seconds": int(SIGHTING_RETENTION.total_seconds()),
                "reason": "Rare cosmetics tracker is coming soon.",
            }
        raise HTTPException(
            403,
            "ii Tracker unlock required. Buy ii Tracker or ask staff to grant the role.",
        )

    _require_tracker_session(request, user, x_tracker_session)
    settings = request.app.state.settings
    if not bool(getattr(settings, "tracker_feed_enabled", False)):
        return {
            "schema_version": FEED_SCHEMA_VERSION,
            "enabled": False,
            "live": False,
            "configured": bool((getattr(settings, "discord_tracker_channel_id", "") or "").strip()),
            "unavailable": True,
            "items": [],
            "lookback_seconds": lookback,
            "retention_seconds": int(SIGHTING_RETENTION.total_seconds()),
            "reason": "Live tracker feed is temporarily disabled.",
        }

    discord = request.app.state.discord
    rare_channel = (getattr(settings, "discord_tracker_channel_id", "") or "").strip()
    players_channel = (getattr(settings, "discord_tracker_players_channel_id", "") or "").strip()
    channels: list[tuple[str, str, int]] = []
    if rare_channel.isdigit() and 15 <= len(rare_channel) <= 20:
        channels.append((rare_channel, TRACK_KIND_RARE, FEED_MESSAGE_LIMIT_RARE))
    if players_channel.isdigit() and 15 <= len(players_channel) <= 20:
        channels.append((players_channel, TRACK_KIND_PLAYER, FEED_MESSAGE_LIMIT_PLAYERS))
    if not channels:
        return {
            "schema_version": FEED_SCHEMA_VERSION,
            "enabled": True,
            "live": True,
            "configured": False,
            "unavailable": True,
            "items": [],
            "lookback_seconds": lookback,
            "retention_seconds": int(SIGHTING_RETENTION.total_seconds()),
            "reason": "Tracker feed channel is not configured yet.",
        }

    items: list[dict] = []
    last_error: ProviderUnavailable | None = None
    readable = 0
    for channel_id, track_kind, limit in channels:
        try:
            rows = _read_tracker_channel(discord, channel_id, limit=limit)
            readable += 1
        except ProviderUnavailable as error:
            last_error = error
            log.warning(
                "ii tracker feed unreadable for channel %s (kind=%s status=%s)",
                channel_id,
                getattr(error, "kind", None),
                getattr(error, "status", None),
            )
            continue
        for row in rows:
            items.extend(_tracker_feed_items(row, track_kind=track_kind))

    now = datetime.now(UTC)
    try:
        _purge_expired_sightings(db, now=now)
        _persist_sightings(db, items)
    except Exception:
        log.exception("tracker sighting persist/purge failed")
        db.rollback()

    # Longer windows merge the Postgres archive so clients are not limited to the
    # few newest Discord messages (~minutes of live room-sync traffic).
    if lookback > DEFAULT_LOOKBACK_SECONDS:
        try:
            archived = _load_sightings_window(
                db,
                since=now - timedelta(seconds=lookback),
                limit=FEED_HISTORY_CAP,
            )
            by_id = {str(item.get("id")): item for item in archived}
            for item in items:
                by_id[str(item.get("id"))] = item
            items = list(by_id.values())
        except Exception:
            log.exception("tracker sighting history load failed")
            db.rollback()

    if readable == 0 and last_error is not None and not items:
        reason, bot_issue = _discord_feed_reason(last_error)
        payload = {
            "schema_version": FEED_SCHEMA_VERSION,
            "enabled": True,
            "live": True,
            "configured": True,
            "unavailable": True,
            "items": [],
            "lookback_seconds": lookback,
            "retention_seconds": int(SIGHTING_RETENTION.total_seconds()),
            "reason": reason,
            "bot_issue": bot_issue,
        }
        if _has_staff_access(getattr(request.state, "member", {}) or {}):
            payload["admin_hint"] = {
                "kind": getattr(last_error, "kind", None),
                "discord_http_status": getattr(last_error, "status", None),
                "channel_configured": True,
            }
        return payload

    # Drop anything older than the selected window (and never past retention).
    cutoff = now - timedelta(seconds=min(lookback, int(SIGHTING_RETENTION.total_seconds())))
    windowed: list[dict] = []
    for item in items:
        try:
            stamp = _parse_updated_at(str(item.get("timestamp") or ""))
        except HTTPException:
            continue
        if stamp >= cutoff:
            windowed.append(item)
    windowed.sort(key=lambda row: str(row.get("timestamp") or ""), reverse=True)
    cap = FEED_HISTORY_CAP if lookback > DEFAULT_LOOKBACK_SECONDS else FEED_ITEM_CAP
    return {
        "schema_version": FEED_SCHEMA_VERSION,
        "enabled": True,
        "live": True,
        "configured": True,
        "unavailable": False,
        "items": windowed[:cap],
        "lookback_seconds": lookback,
        "retention_seconds": int(SIGHTING_RETENTION.total_seconds()),
        "lookback_choices_seconds": list(LOOKBACK_CHOICES_SECONDS),
        "reason": None,
    }
