import asyncio
import hashlib
import re
import threading
import time
from datetime import UTC, datetime
from html.parser import HTMLParser
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy import Numeric, cast, delete, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Session

from .ai import publish_ai_exchange, require_ai, shared_ai_quota
from .auth import database, require_member
from .automod import contains_blocked_slur
from .developer import require_feature
from .discord import ProviderUnavailable
from .menu_features import CHAT_CATALOG_SYSTEM_SUFFIX, catalog_for_prompt
from .mod_upload import parse_thumbnail
from .models import (
    AnnouncementCache,
    CommunityMessage,
    CommunityMod,
    CreatorApplication,
    PlatformSetting,
    TrustedMod,
    User,
)
from .prompts.iigpt_v1 import SYSTEM_PROMPT
from .schemas import FeedView

router = APIRouter(prefix="/v1")
IMAGE_HOSTS = {"cdn.discordapp.com", "media.discordapp.net"}
SOURCE_NAMES = {
    "1537550313546981507": "Main announcements",
    "1548782443715240017": "Menu announcements",
    "1547774251963256893": "Changelog/updates",
}
MAX_COMMUNITY_MOD_BYTES = 25 * 1024 * 1024
MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024
MODERATOR_NAME_HINTS = ("jr mod", "junior mod", "moderator", "admin", "staff")
ENGINE_MENTION_RE = re.compile(r"<@([0-9a-fA-F-]{36})>")
MENTION_PLACEHOLDER = "⟦mention:{index}⟧"


class CommunityMessageInput(BaseModel):
    category: str = Field(default="chat", pattern=r"^(chat|bug|suggestion|pro|engine)$")
    body: str = Field(min_length=1, max_length=800)
    anonymous: bool = False
    share_telemetry: bool = False


class CommunityAiInput(BaseModel):
    category: str = Field(default="chat", pattern=r"^(chat|bug|suggestion|pro)$")
    prompt: str = Field(min_length=1, max_length=700)
    anonymous: bool = False
    share_telemetry: bool = False


class CreatorApplicationInput(BaseModel):
    pitch: str = Field(min_length=20, max_length=2000)
    experience: str = Field(min_length=10, max_length=1000)


def community_creator_role_id(request: Request) -> str:
    return request.app.state.settings.discord_community_creator_role_id


def trusted_creator_role_id(request: Request) -> str:
    return request.app.state.settings.discord_trusted_creator_role_id


def creator_role_id(request: Request) -> str:
    """Back-compat alias for Community Mod Access role."""
    return community_creator_role_id(request)


def has_community_creator_role(request: Request) -> bool:
    role = community_creator_role_id(request)
    return bool(role) and role in set(request.state.member.get("role_ids", []))


def has_trusted_creator_role(request: Request) -> bool:
    role = trusted_creator_role_id(request)
    return bool(role) and role in set(request.state.member.get("role_ids", []))


def has_creator_role(request: Request) -> bool:
    """Community Mod Access — can post unreviewed community mods."""
    return has_community_creator_role(request)


def has_pro_entitlement(request: Request) -> bool:
    return "pro" in set(request.state.member.get("entitlements", []))


def can_post_engine_announcements(request: Request) -> bool:
    """Engine announcements are staff-authored in-app posts (not Discord-synced)."""
    entitlements = set(request.state.member.get("entitlements", []))
    return bool(entitlements & {"admin", "owner", "developer"})


def configured_ids(value: str) -> set[str]:
    return {item.strip() for item in value.split(",") if item.strip()}


def is_chat_moderator(request: Request) -> bool:
    member = request.state.member
    entitlements = set(member.get("entitlements", []))
    if entitlements & {"admin", "owner", "developer"}:
        return True
    role_ids = set(member.get("role_ids", []))
    settings = request.app.state.settings
    if role_ids & configured_ids(settings.discord_moderator_role_ids):
        return True
    if role_ids & configured_ids(settings.discord_admin_role_ids):
        return True
    for role in member.get("roles", []):
        name = str(role.get("name", "")).casefold()
        if any(hint in name for hint in MODERATOR_NAME_HINTS):
            return True
    return False


def highest_role(member: dict, guild_roles: list | None = None) -> tuple[str | None, str | None]:
    roles = [role for role in member.get("roles", []) if isinstance(role, dict)]
    if not roles and guild_roles:
        owned = {str(value) for value in member.get("role_ids", [])}
        roles = [
            role
            for role in guild_roles
            if isinstance(role, dict) and str(role.get("id", "")) in owned
        ]
    if not roles:
        return None, None
    # Prefer the highest-position role that has a real Discord color when possible.
    painted = [
        role
        for role in roles
        if str(role.get("color", "")).startswith("#")
        and str(role.get("color", "")).lower() not in {"#000000", "#cbd5e1"}
    ]
    pool = painted or roles
    top = max(pool, key=lambda role: int(role.get("position", 0) or 0))
    name = str(top.get("name", "")).strip()[:100] or None
    color = str(top.get("color", "")).strip()
    if not re.fullmatch(r"#[0-9a-fA-F]{6}", color or ""):
        color = None
    elif color.lower() in {"#000000", "#cbd5e1"}:
        # Keep a readable fallback tint for colorless Discord roles.
        color = "#dee0e2"
    return name, color


def member_highest_role(
    request: Request, member: dict | None = None
) -> tuple[str | None, str | None]:
    payload = member or getattr(request.state, "member", {}) or {}
    name, color = highest_role(payload)
    if name:
        return name, color
    try:
        guild_roles = request.app.state.discord.guild_roles()
    except ProviderUnavailable:
        guild_roles = []
    return highest_role(payload, guild_roles)


_role_cache: dict[str, tuple[float, tuple[str | None, str | None]]] = {}


def cached_author_role(request: Request, discord_id: str) -> tuple[str | None, str | None]:
    now = time.time()
    hit = _role_cache.get(discord_id)
    if hit and now - hit[0] < 90:
        return hit[1]
    try:
        membership = request.app.state.discord.membership(discord_id)
        role = member_highest_role(request, membership)
    except ProviderUnavailable:
        role = (None, None)
    _role_cache[discord_id] = (now, role)
    if len(_role_cache) > 500:
        oldest = sorted(_role_cache.items(), key=lambda item: item[1][0])[:100]
        for key, _ in oldest:
            _role_cache.pop(key, None)
    return role


def application_view(row: CreatorApplication, author: User | None = None):
    payload = {
        "id": row.id,
        "user_id": row.user_id,
        "pitch": row.pitch,
        "experience": row.experience,
        "status": row.status,
        "created_at": row.created_at,
        "reviewed_at": row.reviewed_at,
        "review_note": row.review_note,
    }
    if author is not None:
        payload["author"] = community_identity(author)
    return payload


def community_identity(user: User):
    return {"id": user.id, "display_name": user.display_name, "avatar": user.avatar}


def protect_engine_mentions(text: str) -> tuple[str, list[str]]:
    tokens: list[str] = []

    def repl(match: re.Match[str]) -> str:
        tokens.append(match.group(0))
        return MENTION_PLACEHOLDER.format(index=len(tokens) - 1)

    return ENGINE_MENTION_RE.sub(repl, text), tokens


def restore_engine_mentions(text: str, tokens: list[str]) -> str:
    out = text
    for index, token in enumerate(tokens):
        out = out.replace(MENTION_PLACEHOLDER.format(index=index), token)
    return out


def resolve_mentions(db: Session, body: str) -> tuple[str, list[str], dict[str, str]]:
    """Keep <@userId> tokens, drop unknown ones, return ids + label map."""
    ids: list[str] = []
    labels: dict[str, str] = {}

    def repl(match: re.Match[str]) -> str:
        user_id = match.group(1)
        person = db.get(User, user_id)
        if person is None:
            return match.group(0)
        token = f"<@{user_id}>"
        if user_id not in ids:
            ids.append(user_id)
        labels[token] = f"@{person.display_name}"
        return token

    cleaned = ENGINE_MENTION_RE.sub(repl, body)
    return cleaned, ids[:20], labels


def message_view(
    row: CommunityMessage,
    author: User,
    viewer_id: str,
    can_moderate: bool,
    request: Request | None = None,
    mention_labels: dict[str, str] | None = None,
):
    mentioned_ids = list(getattr(row, "mentioned_user_ids", None) or [])
    labels = dict(mention_labels or {})
    if not labels and mentioned_ids:
        # Best-effort labels when not preloaded.
        pass
    if bool(getattr(row, "is_assistant", False)):
        author_payload = {
            "id": "iigpt",
            "display_name": "iiGPT",
            "avatar": None,
            "role_name": "Assistant",
            "role_color": "#f0a05a",
        }
        return {
            "id": row.id,
            "category": row.category,
            "body": row.body,
            "created_at": row.created_at,
            "anonymous": False,
            "is_assistant": True,
            "author": author_payload,
            "mine": False,
            "can_delete": can_moderate,
            "mentioned_user_ids": [],
            "mentioned_me": False,
            "mentions": {},
        }
    anonymous = bool(getattr(row, "anonymous", False))
    if anonymous:
        author_payload = {
            "id": "anonymous",
            "display_name": "Anonymous",
            "avatar": None,
            "role_name": None,
            "role_color": None,
        }
    else:
        role_name = row.author_role_name
        role_color = row.author_role_color
        # Prefer live Discord highest role so badges stay correct even for older rows.
        if request is not None and author.discord_id:
            live_name, live_color = cached_author_role(request, author.discord_id)
            role_name = live_name or role_name
            role_color = live_color or role_color
        author_payload = {
            **community_identity(author),
            "role_name": role_name,
            "role_color": role_color,
        }
    return {
        "id": row.id,
        "category": row.category,
        "body": row.body,
        "created_at": row.created_at,
        "anonymous": anonymous,
        "is_assistant": False,
        "author": author_payload,
        "mine": row.user_id == viewer_id,
        "can_delete": row.user_id == viewer_id or can_moderate,
        "mentioned_user_ids": mentioned_ids,
        "mentioned_me": viewer_id in mentioned_ids,
        "mentions": labels,
    }


class PlainText(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []

    def handle_data(self, data):
        self.parts.append(data)


def plain(value, limit=4000):
    parser = PlainText()
    parser.feed(str(value)[: limit * 2])
    return re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", "".join(parser.parts))[:limit]


def safe_image(value):
    if not isinstance(value, str) or len(value) > 2048:
        return None
    try:
        parsed = urlparse(value)
        if (
            parsed.scheme != "https"
            or parsed.hostname not in IMAGE_HOSTS
            or parsed.username
            or parsed.password
            or parsed.port not in (None, 443)
            or not parsed.path.lower().endswith((".png", ".jpg", ".jpeg", ".gif", ".webp"))
        ):
            return None
    except ValueError:
        return None
    return value


def sanitize_message(message, channel, guild, roles=None, channel_names=None):
    message_id = str(message.get("id", ""))
    if not message_id.isdigit() or not 15 <= len(message_id) <= 20:
        raise ValueError("Invalid message ID")
    published = datetime.fromisoformat(message["timestamp"])
    if published.tzinfo is None:
        raise ValueError("Missing timezone")
    edited = message.get("edited_timestamp")
    if edited:
        edited = datetime.fromisoformat(edited)
        if edited.tzinfo is None:
            raise ValueError("Missing timezone")
    author = message.get("author", {})
    avatar_hash = str(author.get("avatar", ""))
    avatar_id = str(author.get("id", ""))
    avatar = None
    if re.fullmatch(r"[a-zA-Z0-9_]{1,80}", avatar_hash) and re.fullmatch(r"\d{15,20}", avatar_id):
        avatar = f"https://cdn.discordapp.com/avatars/{avatar_id}/{avatar_hash}.png"
    images = []
    for attachment in message.get("attachments", [])[:10]:
        image = safe_image(attachment.get("url"))
        if image and attachment.get("content_type", "").startswith("image/"):
            images.append(image)
    raw_content = str(message.get("content", ""))[:8000]
    discord_tokens = list(dict.fromkeys(re.findall(r"<(?:@!?|@&|#)\d{15,20}>", raw_content)))
    protected_content = raw_content
    for index, token in enumerate(discord_tokens):
        protected_content = protected_content.replace(token, f"DiscordMentionToken{index}")
    content = plain(protected_content)
    for index, token in enumerate(discord_tokens):
        content = content.replace(f"DiscordMentionToken{index}", token)
    mentions = {}
    for mentioned in message.get("mentions", [])[:100]:
        mention_id = str(mentioned.get("id", ""))
        if re.fullmatch(r"\d{15,20}", mention_id):
            mentions[f"<@{mention_id}>"] = "@" + plain(
                mentioned.get("global_name") or mentioned.get("username", "member"), 100
            )
            mentions[f"<@!{mention_id}>"] = mentions[f"<@{mention_id}>"]
    roles = roles or {}
    for role_id in set(re.findall(r"<@&(\d{15,20})>", raw_content)):
        role = roles.get(role_id)
        if role:
            mentions[f"<@&{role_id}>"] = "@" + plain(role.get("name", "role"), 100)
    channel_names = channel_names or {}
    for channel_id in set(re.findall(r"<#(\d{15,20})>", raw_content)):
        name = channel_names.get(channel_id) or SOURCE_NAMES.get(channel_id)
        if name:
            mentions[f"<#{channel_id}>"] = "#" + plain(name, 100)
    member_roles = message.get("member", {}).get("roles", [])
    top_role = max(
        (roles[role_id] for role_id in member_roles if role_id in roles),
        key=lambda role: role.get("position", 0),
        default=None,
    )
    author_color = None
    author_emoji = None
    if top_role:
        color = int(top_role.get("color", 0) or 0)
        if color:
            author_color = f"#{color:06x}"
        author_emoji = plain(top_role.get("unicode_emoji", ""), 20) or None
    return {
        "id": message_id,
        "channel": channel,
        "source": SOURCE_NAMES.get(channel, "Announcements"),
        "author": plain(author.get("global_name") or author.get("username", "Community"), 100),
        "avatar": avatar,
        "text": content,
        "mentions": mentions,
        "author_color": author_color,
        "author_emoji": author_emoji,
        "timestamp": published.isoformat(),
        "edited_at": edited.isoformat() if edited else None,
        "images": images,
        "url": f"https://discord.com/channels/{guild}/{channel}/{message_id}",
    }


class Announcements:
    def __init__(self, settings, discord, engine):
        self.settings, self.discord, self.engine = settings, discord, engine
        self.channels = list(
            dict.fromkeys(
                [
                    x.strip()
                    for x in settings.discord_announcement_channel_ids.split(",")
                    if x.strip()
                ]
                + [settings.discord_update_channel_id]
            )
        )
        self.fresh = {}
        self.lock = threading.Lock()

    def feed(self, channel=None, before=None, limit=20):
        if channel and channel not in self.channels:
            raise HTTPException(403, "Channel is not in the public announcement allowlist")
        selected = [channel] if channel else self.channels
        stale = False
        # Serialize refreshes; at most one upstream read per channel/page per 60 seconds.
        with self.lock, Session(self.engine) as db:
            self.fresh = {
                key: expiry for key, expiry in self.fresh.items() if expiry > time.monotonic()
            }
            for source in selected:
                key = (source, before)
                if self.fresh.get(key, 0) > time.monotonic():
                    continue
                try:
                    params = {"limit": 100}
                    if before:
                        params["before"] = before
                    response = self.discord.request(
                        "GET", f"/channels/{source}/messages", params=params
                    )
                    if response.status_code != 200:
                        raise ProviderUnavailable("Announcements unavailable")
                    messages = response.json()
                    if not isinstance(messages, list):
                        raise TypeError("Invalid feed")
                    roles, channel_names = {}, {}
                    if any(
                        item.get("member", {}).get("roles")
                        or re.search(r"<@&\d{15,20}>|<#\d{15,20}>", item.get("content", ""))
                        for item in messages[:100]
                    ):
                        try:
                            role_response = self.discord.request(
                                "GET", f"/guilds/{self.settings.discord_guild_id}/roles"
                            )
                            if role_response.status_code == 200:
                                roles = {str(item["id"]): item for item in role_response.json()}
                            channel_response = self.discord.request(
                                "GET", f"/guilds/{self.settings.discord_guild_id}/channels"
                            )
                            if channel_response.status_code == 200:
                                channel_names = {
                                    str(item["id"]): str(item.get("name", "channel"))
                                    for item in channel_response.json()
                                }
                        except (ProviderUnavailable, TypeError, KeyError):
                            pass
                    clean = [
                        sanitize_message(
                            x,
                            source,
                            self.settings.discord_guild_id,
                            roles,
                            channel_names,
                        )
                        for x in messages[:100]
                    ]
                    for item in clean:
                        values = {
                            "payload": item,
                            "published_at": datetime.fromisoformat(item["timestamp"]),
                            "edited_at": (
                                datetime.fromisoformat(item["edited_at"])
                                if item["edited_at"]
                                else None
                            ),
                            "cached_at": datetime.now(UTC),
                        }
                        insert = (
                            pg_insert if self.engine.dialect.name == "postgresql" else sqlite_insert
                        )
                        db.execute(
                            insert(AnnouncementCache)
                            .values(channel_id=source, message_id=item["id"], **values)
                            .on_conflict_do_update(
                                index_elements=["channel_id", "message_id"], set_=values
                            )
                        )
                    db.commit()
                    if len(self.fresh) < 1000:
                        self.fresh[key] = time.monotonic() + 60
                except (ProviderUnavailable, ValueError, TypeError, KeyError):
                    db.rollback()
                    stale = True
            query = select(AnnouncementCache).where(AnnouncementCache.channel_id.in_(selected))
            if before:
                query = query.where(
                    cast(AnnouncementCache.message_id, Numeric(20, 0)) < int(before)
                )
            query = query.order_by(cast(AnnouncementCache.message_id, Numeric(20, 0)).desc()).limit(
                limit + 1
            )
            items = [row.payload for row in db.scalars(query)]
            page = items[:limit]
            return {
                "items": page,
                "stale": stale,
                "unavailable": stale and not page,
                "next_cursor": page[-1]["id"] if len(items) > limit else None,
            }


PINNED_ANNOUNCEMENTS_KEY = "pinned_announcements"


def _pinned_keys(db: Session) -> list[str]:
    row = db.get(PlatformSetting, PINNED_ANNOUNCEMENTS_KEY)
    if not row or not isinstance(row.value, dict):
        return []
    raw = row.value.get("keys")
    if not isinstance(raw, list):
        return []
    return [str(item) for item in raw if isinstance(item, str) and ":" in item][:40]


def _announcement_key(channel_id: str, message_id: str) -> str:
    return f"{channel_id}:{message_id}"


def _apply_pins(items: list[dict], pinned: list[str]) -> list[dict]:
    pinned_set = set(pinned)
    marked = []
    for item in items:
        copy = dict(item)
        key = _announcement_key(str(copy.get("channel", "")), str(copy.get("id", "")))
        copy["pinned"] = key in pinned_set
        marked.append(copy)
    marked.sort(key=lambda item: (0 if item.get("pinned") else 1))
    return marked


@router.get("/announcements", response_model=FeedView)
def announcements(
    request: Request,
    channel: str | None = None,
    before: str | None = Query(None, pattern=r"^\d{15,20}$"),
    limit: int = Query(20, ge=1, le=50),
    user: User = Depends(require_member),
    db: Session = Depends(database),
):
    del user
    feed = request.app.state.announcements.feed(channel, before, limit)
    pinned = _pinned_keys(db)
    items = _apply_pins(list(feed.get("items") or []), pinned)
    return {
        **feed,
        "items": items,
        "can_moderate": is_chat_moderator(request),
        "pinned_ids": pinned,
    }


@router.post("/announcements/{channel_id}/{message_id}/pin", status_code=200)
def pin_announcement(
    channel_id: str,
    message_id: str,
    request: Request,
    user: User = Depends(require_member),
    db: Session = Depends(database),
):
    """Admins / chat moderators can pin an announcement inside ii Engine."""
    if not is_chat_moderator(request):
        raise HTTPException(403, "Admin or moderator role required to pin announcements")
    if not re.fullmatch(r"\d{15,20}", channel_id) or not re.fullmatch(r"\d{15,20}", message_id):
        raise HTTPException(422, "Invalid announcement reference")
    allowed = {
        item.strip()
        for item in (
            request.app.state.settings.discord_announcement_channel_ids
            + ","
            + request.app.state.settings.discord_update_channel_id
        ).split(",")
        if item.strip()
    }
    if channel_id not in allowed:
        raise HTTPException(404, "Announcement channel not found")
    key = _announcement_key(channel_id, message_id)
    keys = [item for item in _pinned_keys(db) if item != key]
    keys.insert(0, key)
    row = db.get(PlatformSetting, PINNED_ANNOUNCEMENTS_KEY) or PlatformSetting(
        key=PINNED_ANNOUNCEMENTS_KEY, value={}
    )
    row.value = {"keys": keys[:40]}
    row.updated_at = datetime.now(UTC)
    row.updated_by = user.id
    db.add(row)
    db.commit()
    return {"ok": True, "pinned": True, "key": key, "pinned_ids": keys[:40]}


@router.delete("/announcements/{channel_id}/{message_id}/pin", status_code=200)
def unpin_announcement(
    channel_id: str,
    message_id: str,
    request: Request,
    user: User = Depends(require_member),
    db: Session = Depends(database),
):
    if not is_chat_moderator(request):
        raise HTTPException(403, "Admin or moderator role required to unpin announcements")
    if not re.fullmatch(r"\d{15,20}", channel_id) or not re.fullmatch(r"\d{15,20}", message_id):
        raise HTTPException(422, "Invalid announcement reference")
    key = _announcement_key(channel_id, message_id)
    keys = [item for item in _pinned_keys(db) if item != key]
    row = db.get(PlatformSetting, PINNED_ANNOUNCEMENTS_KEY) or PlatformSetting(
        key=PINNED_ANNOUNCEMENTS_KEY, value={}
    )
    row.value = {"keys": keys}
    row.updated_at = datetime.now(UTC)
    row.updated_by = user.id
    db.add(row)
    db.commit()
    return {"ok": True, "pinned": False, "key": key, "pinned_ids": keys}


@router.delete("/announcements/{channel_id}/{message_id}", status_code=204)
def delete_announcement(
    channel_id: str,
    message_id: str,
    request: Request,
    user: User = Depends(require_member),
    db: Session = Depends(database),
):
    """Admins / chat moderators can remove an announcement from Discord + local cache."""
    if not is_chat_moderator(request):
        raise HTTPException(403, "Admin or moderator role required to delete announcements")
    if not re.fullmatch(r"\d{15,20}", channel_id) or not re.fullmatch(r"\d{15,20}", message_id):
        raise HTTPException(422, "Invalid announcement reference")
    allowed = {
        item.strip()
        for item in (
            request.app.state.settings.discord_announcement_channel_ids
            + ","
            + request.app.state.settings.discord_update_channel_id
        ).split(",")
        if item.strip()
    }
    if channel_id not in allowed:
        raise HTTPException(404, "Announcement channel not found")
    discord = getattr(request.app.state, "discord", None)
    if discord:
        try:
            discord.delete_channel_message(channel_id, message_id)
        except ProviderUnavailable as error:
            raise HTTPException(503, str(error)) from error
    db.execute(
        delete(AnnouncementCache).where(
            AnnouncementCache.channel_id == channel_id,
            AnnouncementCache.message_id == message_id,
        )
    )
    key = _announcement_key(channel_id, message_id)
    keys = [item for item in _pinned_keys(db) if item != key]
    row = db.get(PlatformSetting, PINNED_ANNOUNCEMENTS_KEY)
    if row is not None:
        row.value = {"keys": keys}
        row.updated_at = datetime.now(UTC)
        row.updated_by = user.id
        db.add(row)
    db.commit()
    return Response(status_code=204)


def _mention_labels_for_rows(db: Session, rows: list) -> dict[str, dict[str, str]]:
    """Build message_id -> {<@id>: @Name} maps for a page of messages."""
    needed: set[str] = set()
    for row, _author in rows:
        for user_id in list(getattr(row, "mentioned_user_ids", None) or []):
            needed.add(str(user_id))
        for match in ENGINE_MENTION_RE.finditer(row.body or ""):
            needed.add(match.group(1))
    if not needed:
        return {}
    people = {
        person.id: person.display_name
        for person in db.scalars(select(User).where(User.id.in_(list(needed)))).all()
    }
    out: dict[str, dict[str, str]] = {}
    for row, _author in rows:
        labels: dict[str, str] = {}
        for match in ENGINE_MENTION_RE.finditer(row.body or ""):
            user_id = match.group(1)
            name = people.get(user_id)
            if name:
                labels[f"<@{user_id}>"] = f"@{name}"
        out[row.id] = labels
    return out


@router.get("/community/messages")
def community_messages(
    request: Request, user: User = Depends(require_member), db: Session = Depends(database)
):
    require_feature(request, db, "community_chat")
    can_moderate = is_chat_moderator(request)
    rows = db.execute(
        select(CommunityMessage, User)
        .join(User, User.id == CommunityMessage.user_id)
        .order_by(CommunityMessage.created_at.desc())
        .limit(2000)
    ).all()
    labels_by_id = _mention_labels_for_rows(db, rows)
    return {
        "items": [
            message_view(
                row,
                author,
                user.id,
                can_moderate,
                request,
                mention_labels=labels_by_id.get(row.id),
            )
            for row, author in reversed(rows)
        ]
    }


@router.get("/community/mentionables")
def community_mentionables(
    request: Request, user: User = Depends(require_member), db: Session = Depends(database)
):
    """Recent chatters available for @mentions in community chat."""
    require_feature(request, db, "community_chat")
    author_ids = list(
        db.scalars(
            select(CommunityMessage.user_id)
            .where(CommunityMessage.anonymous.is_(False))
            .where(CommunityMessage.is_assistant.is_(False))
            .order_by(CommunityMessage.created_at.desc())
            .limit(400)
        ).all()
    )
    ordered: list[str] = []
    seen: set[str] = set()
    for author_id in author_ids:
        if author_id in seen:
            continue
        seen.add(author_id)
        ordered.append(author_id)
        if len(ordered) >= 80:
            break
    if user.id not in seen:
        ordered.insert(0, user.id)
    people = {
        person.id: person
        for person in db.scalars(select(User).where(User.id.in_(ordered or [user.id]))).all()
    }
    return {
        "items": [
            community_identity(people[author_id])
            for author_id in ordered
            if author_id in people
        ]
    }


@router.post("/community/messages", status_code=201)
def create_community_message(
    body: CommunityMessageInput,
    request: Request,
    user: User = Depends(require_member),
    db: Session = Depends(database),
):
    require_feature(request, db, "community_chat")
    require_feature(request, db, "community_posts")
    if body.category == "pro" and not has_pro_entitlement(request):
        raise HTTPException(403, "Engine Pro is required to post in the Pro forum")
    if body.category == "engine":
        if not can_post_engine_announcements(request):
            raise HTTPException(403, "Only Engine staff can post Engine announcements")
        if body.anonymous:
            raise HTTPException(422, "Engine announcements cannot be anonymous")
    protected, tokens = protect_engine_mentions(body.body.strip())
    text = restore_engine_mentions(plain(protected, 800), tokens)
    text, mentioned_ids, mention_labels = resolve_mentions(db, text)
    if not text:
        raise HTTPException(422, "Message cannot be empty")
    if contains_blocked_slur(text):
        raise HTTPException(422, "Message blocked by automod. Keep chat respectful.")
    if body.anonymous and mentioned_ids:
        raise HTTPException(422, "Anonymous messages cannot mention people")
    recent = db.scalar(
        select(CommunityMessage)
        .where(CommunityMessage.user_id == user.id)
        .order_by(CommunityMessage.created_at.desc())
        .limit(1)
    )
    if recent:
        created = recent.created_at
        if created.tzinfo is None:
            created = created.replace(tzinfo=UTC)
        if (datetime.now(UTC) - created).total_seconds() < 2:
            raise HTTPException(429, "Wait a moment before sending another message")
    role_name = role_color = None
    if not body.anonymous:
        role_name, role_color = member_highest_role(request)
    row = CommunityMessage(
        user_id=user.id,
        category=body.category,
        body=text,
        anonymous=bool(body.anonymous),
        author_role_name=None if body.anonymous else role_name,
        author_role_color=None if body.anonymous else role_color,
        mentioned_user_ids=mentioned_ids or None,
    )
    db.add(row)
    db.flush()
    overflow = list(
        db.scalars(
            select(CommunityMessage.id).order_by(CommunityMessage.created_at.desc()).offset(2000)
        )
    )
    if overflow:
        db.execute(delete(CommunityMessage).where(CommunityMessage.id.in_(overflow)))
    db.commit()
    return message_view(
        row,
        user,
        user.id,
        is_chat_moderator(request),
        request,
        mention_labels=mention_labels,
    )


@router.post("/community/ai", status_code=201)
async def community_ai_command(
    body: CommunityAiInput,
    request: Request,
    user: User = Depends(require_member),
    db: Session = Depends(database),
):
    """Pro-only `/ai` in community chat — posts the question and an iiGPT reply."""
    require_feature(request, db, "community_chat")
    require_feature(request, db, "community_posts")
    if not has_pro_entitlement(request):
        raise HTTPException(403, "Engine Pro is required to use /ai in community chat")
    if body.category == "pro" and not has_pro_entitlement(request):
        raise HTTPException(403, "Engine Pro is required to post in the Pro forum")
    question = plain(body.prompt.strip(), 700)
    if not question:
        raise HTTPException(422, "Ask iiGPT something after /ai")
    if contains_blocked_slur(question):
        raise HTTPException(422, "Message blocked by automod. Keep chat respectful.")

    provider = require_ai(request)
    quota = shared_ai_quota(request)
    reservation_id, reset = await asyncio.to_thread(quota.reserve, user.id)
    catalog = catalog_for_prompt(question, always=True)
    prompt = (
        f"User question:\n{question}\n\n"
        f"ii Reborn Menu feature catalog (authoritative):\n{catalog}\n"
    )
    system = (
        SYSTEM_PROMPT
        + "\nYou are answering inside ii Engine community chat after a /ai command. "
        "A menu feature catalog is attached — use it as authoritative. "
        "Keep replies under 700 characters when possible."
        + CHAT_CATALOG_SYSTEM_SUFFIX
    )

    try:
        answer = await asyncio.wait_for(
            provider.complete(
                prompt,
                system=system,
                max_tokens=500,
            ),
            timeout=45,
        )
        remaining = await asyncio.to_thread(quota.finish, user.id, reservation_id, True)
    except (ProviderUnavailable, TimeoutError):
        await asyncio.to_thread(quota.finish, user.id, reservation_id, False)
        raise HTTPException(503, "iiGPT is temporarily unavailable") from None
    except Exception:
        await asyncio.to_thread(quota.finish, user.id, reservation_id, False)
        raise

    role_name = role_color = None
    if not body.anonymous:
        role_name, role_color = member_highest_role(request)
    reply_text = plain(answer.strip(), 800) or "I could not form a reply. Try again shortly."
    user_row = CommunityMessage(
        user_id=user.id,
        category=body.category,
        body=f"/ai {question}"[:800],
        anonymous=bool(body.anonymous),
        is_assistant=False,
        author_role_name=None if body.anonymous else role_name,
        author_role_color=None if body.anonymous else role_color,
    )
    assistant_row = CommunityMessage(
        user_id=user.id,
        category=body.category,
        body=reply_text,
        anonymous=False,
        is_assistant=True,
        author_role_name="Assistant",
        author_role_color="#f0a05a",
    )
    db.add(user_row)
    db.add(assistant_row)
    db.flush()
    overflow = list(
        db.scalars(
            select(CommunityMessage.id).order_by(CommunityMessage.created_at.desc()).offset(2000)
        )
    )
    if overflow:
        db.execute(delete(CommunityMessage).where(CommunityMessage.id.in_(overflow)))
    db.commit()
    db.refresh(user_row)
    db.refresh(assistant_row)

    if body.share_telemetry:
        publish_ai_exchange(request, user, source="community", prompt=question, response=reply_text)

    can_moderate = is_chat_moderator(request)
    return {
        "remaining": remaining,
        "reset_at": reset,
        "items": [
            message_view(user_row, user, user.id, can_moderate, request),
            message_view(assistant_row, user, user.id, can_moderate, request),
        ],
    }


@router.delete("/community/messages/{identifier}", status_code=204)
def delete_community_message(
    identifier: str,
    request: Request,
    user: User = Depends(require_member),
    db: Session = Depends(database),
):
    require_feature(request, db, "community_chat")
    row = db.get(CommunityMessage, identifier)
    if row is None:
        raise HTTPException(404, "Message not found")
    if row.user_id != user.id and not is_chat_moderator(request):
        raise HTTPException(403, "You can only delete your own messages")
    db.delete(row)
    db.commit()
    return Response(status_code=204)


def community_mod_view(row: CommunityMod, author: User):
    return {
        "id": row.id,
        "name": row.name,
        "description": row.description,
        "filename": row.filename,
        "sha256": row.sha256,
        "byte_size": row.byte_size,
        "created_at": row.created_at,
        "author": community_identity(author),
        "status": row.status,
        "review_note": row.review_note,
        "reviewed": row.status == "approved",
        "has_thumbnail": bool(row.thumbnail),
        "thumbnail_url": f"/v1/community/mods/{row.id}/thumbnail" if row.thumbnail else None,
        "ai_info_status": getattr(row, "ai_info_status", None) or "idle",
        "has_ai_info": bool(getattr(row, "ai_info_report", None)),
    }


@router.get("/community/mods/{identifier}/ai-info")
def community_mod_ai_info(
    identifier: str,
    request: Request,
    user: User = Depends(require_member),
    db: Session = Depends(database),
):
    """Informational AI brief for an approved community mod (not a malware verdict)."""
    require_feature(request, db, "community_mods")
    row = db.get(CommunityMod, identifier)
    if row is None or row.status != "approved":
        raise HTTPException(404, "Community mod not found")
    return {
        "id": row.id,
        "status": getattr(row, "ai_info_status", None) or "idle",
        "report": getattr(row, "ai_info_report", None),
        "error": getattr(row, "ai_info_error", None) or "",
        "updated_at": getattr(row, "ai_info_updated_at", None),
        "disclaimer": (
            "AI reviews can be wrong and are not perfect. This brief is informational only "
            "and never proves a community mod is safe. Treat community DLLs as potentially malicious."
        ),
    }


@router.get("/community/creator-status")
def creator_status(
    request: Request, user: User = Depends(require_member), db: Session = Depends(database)
):
    approved = has_creator_role(request)
    pending = db.scalar(
        select(CreatorApplication)
        .where(
            CreatorApplication.user_id == user.id,
            CreatorApplication.status == "pending",
        )
        .order_by(CreatorApplication.created_at.desc())
        .limit(1)
    )
    latest = db.scalar(
        select(CreatorApplication)
        .where(CreatorApplication.user_id == user.id)
        .order_by(CreatorApplication.created_at.desc())
        .limit(1)
    )
    return {
        "can_post": approved,
        "can_publish_trusted": has_trusted_creator_role(request),
        "role_id": community_creator_role_id(request),
        "trusted_role_id": trusted_creator_role_id(request),
        "pending": application_view(pending) if pending else None,
        "latest": application_view(latest) if latest else None,
    }


@router.post("/community/creator-applications", status_code=201)
def apply_creator(
    body: CreatorApplicationInput,
    request: Request,
    user: User = Depends(require_member),
    db: Session = Depends(database),
):
    require_feature(request, db, "creator_application")
    if has_creator_role(request):
        raise HTTPException(409, "You already have community creator access")
    existing = db.scalar(
        select(CreatorApplication).where(
            CreatorApplication.user_id == user.id,
            CreatorApplication.status == "pending",
        )
    )
    if existing:
        raise HTTPException(409, "Your creator application is already pending review")
    pitch = plain(body.pitch.strip(), 2000)
    experience = plain(body.experience.strip(), 1000)
    if len(pitch) < 20 or len(experience) < 10:
        raise HTTPException(422, "Tell us more about your mods and experience")
    row = CreatorApplication(user_id=user.id, pitch=pitch, experience=experience, status="pending")
    db.add(row)
    db.commit()
    discord = getattr(request.app.state, "discord", None)
    settings = getattr(request.app.state, "settings", None)
    if discord and settings:
        try:
            discord.post_channel_message(
                settings.discord_telemetry_channel_id,
                (
                    f"**Creator application** · {user.display_name} (`{user.discord_id}`)\n"
                    f"Pitch: {pitch[:280]}\n"
                    f"Experience: {experience[:200]}"
                ),
            )
        except ProviderUnavailable:
            pass
    return application_view(row, user)


@router.get("/community/mods")
def community_mods(
    request: Request, user: User = Depends(require_member), db: Session = Depends(database)
):
    require_feature(request, db, "community_mods")
    from .mod_votes import attach_votes

    rows = db.execute(
        select(CommunityMod, User)
        .join(User, User.id == CommunityMod.user_id)
        .where(CommunityMod.status == "approved")
        .order_by(CommunityMod.created_at.desc())
        .limit(100)
    ).all()
    items = [community_mod_view(row, author) for row, author in rows]
    return {"items": attach_votes(db, items, "community", user.id)}


@router.post("/community/mods", status_code=201)
async def create_community_mod(
    request: Request,
    name: str = Query(min_length=1, max_length=120),
    description: str = Query(min_length=1, max_length=1000),
    filename: str = Query(min_length=5, max_length=180),
    user: User = Depends(require_member),
    db: Session = Depends(database),
):
    """Anyone can submit a community DLL for review. Approved mods appear in the public list."""
    require_feature(request, db, "community_mods")
    filename = filename.strip()
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._ -]{0,170}\.dll", filename, re.IGNORECASE):
        raise HTTPException(422, "Upload a DLL with a safe filename")
    content_length = request.headers.get("content-length", "")
    if content_length.isdigit() and int(content_length) > MAX_COMMUNITY_MOD_BYTES:
        raise HTTPException(413, "Community DLLs are limited to 25 MB")
    content = bytearray()
    async for chunk in request.stream():
        content.extend(chunk)
        if len(content) > MAX_COMMUNITY_MOD_BYTES:
            raise HTTPException(413, "Community DLLs are limited to 25 MB")
    data = bytes(content)
    if len(data) < 2 or data[:2] != b"MZ":
        raise HTTPException(422, "The uploaded file is not a Windows DLL")
    data, thumbnail, thumbnail_mime = parse_thumbnail(request, data)
    if len(data) < 2 or data[:2] != b"MZ":
        raise HTTPException(422, "The uploaded file is not a Windows DLL")
    row = CommunityMod(
        user_id=user.id,
        name=plain(name.strip(), 120),
        description=plain(description.strip(), 1000),
        filename=filename,
        sha256=hashlib.sha256(data).hexdigest(),
        byte_size=len(data),
        artifact=data,
        thumbnail=thumbnail,
        thumbnail_mime=thumbnail_mime,
        status="pending",
        review_note="",
    )
    db.add(row)
    db.commit()
    discord = getattr(request.app.state, "discord", None)
    settings = getattr(request.app.state, "settings", None)
    if discord and settings:
        try:
            discord.post_channel_message(
                settings.discord_telemetry_channel_id,
                (
                    f"**Community mod for review** · {user.display_name} (`{user.discord_id}`)\n"
                    f"{row.name} · `{row.filename}` · {row.byte_size} bytes"
                ),
            )
        except ProviderUnavailable:
            pass
    return community_mod_view(row, user)


@router.get("/community/mods/{identifier}/thumbnail")
def community_mod_thumbnail(
    identifier: str,
    request: Request,
    user: User = Depends(require_member),
    db: Session = Depends(database),
):
    require_feature(request, db, "community_mods")
    row = db.get(CommunityMod, identifier)
    if row is None or not row.thumbnail:
        raise HTTPException(404, "Thumbnail not found")
    return Response(row.thumbnail, media_type=row.thumbnail_mime or "image/jpeg")


@router.get("/community/mods/{identifier}/download")
def download_community_mod(
    identifier: str,
    request: Request,
    user: User = Depends(require_member),
    db: Session = Depends(database),
):
    require_feature(request, db, "community_mods")
    row = db.get(CommunityMod, identifier)
    if row is None or row.status != "approved":
        raise HTTPException(404, "Community mod not found")
    return Response(
        row.artifact,
        media_type="application/octet-stream",
        headers={
            "Content-Disposition": f'attachment; filename="{row.filename}"',
            "X-Content-SHA256": row.sha256,
        },
    )


@router.post("/trusted-mods/publish", status_code=201)
async def publish_trusted_mod(
    request: Request,
    name: str = Query(min_length=1, max_length=120),
    description: str = Query(min_length=1, max_length=1000),
    filename: str = Query(min_length=5, max_length=180),
    user: User = Depends(require_member),
    db: Session = Depends(database),
):
    """Trusted Mod Creators can publish into the Trusted catalog."""
    require_feature(request, db, "mod_library")
    if not has_trusted_creator_role(request):
        raise HTTPException(
            403,
            "The Trusted Mod Creator Discord role is required to publish trusted mods",
        )
    filename = filename.strip()
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._ -]{0,170}\.dll", filename, re.IGNORECASE):
        raise HTTPException(422, "Upload a DLL with a safe filename")
    content = bytearray()
    async for chunk in request.stream():
        content.extend(chunk)
        if len(content) > MAX_COMMUNITY_MOD_BYTES:
            raise HTTPException(413, "Trusted DLLs are limited to 25 MB")
    data = bytes(content)
    if len(data) < 2 or data[:2] != b"MZ":
        raise HTTPException(422, "The uploaded file is not a Windows DLL")
    if db.scalar(select(TrustedMod).where(TrustedMod.filename == filename)):
        raise HTTPException(409, "A trusted mod already uses that DLL filename")
    data, thumbnail, thumbnail_mime = parse_thumbnail(request, data)
    if len(data) < 2 or data[:2] != b"MZ":
        raise HTTPException(422, "The uploaded file is not a Windows DLL")
    from .developer import trusted_mod_view

    row = TrustedMod(
        name=plain(name.strip(), 120),
        description=plain(description.strip(), 1000),
        filename=filename,
        sha256=hashlib.sha256(data).hexdigest(),
        byte_size=len(data),
        artifact=data,
        thumbnail=thumbnail,
        thumbnail_mime=thumbnail_mime,
        created_by=user.id,
    )
    db.add(row)
    db.commit()
    return trusted_mod_view(row)


# Keep the legacy path for older clients; prefer /trusted-mods/publish.
@router.post("/trusted-mods", status_code=201, include_in_schema=False)
async def publish_trusted_mod_legacy(
    request: Request,
    name: str = Query(min_length=1, max_length=120),
    description: str = Query(min_length=1, max_length=1000),
    filename: str = Query(min_length=5, max_length=180),
    user: User = Depends(require_member),
    db: Session = Depends(database),
):
    return await publish_trusted_mod(request, name, description, filename, user, db)
