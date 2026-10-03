"""Telemetry: session journals, BepInEx error extracts, and hourly Discord rollups."""

from __future__ import annotations

import logging
import re
from collections import Counter, defaultdict
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .access import member_has_uncapped_limits
from .auth import database, require_member
from .discord import ProviderUnavailable
from .models import FeatureUsageEvent, RobloxGamepassClaim, User

router = APIRouter(prefix="/v1")
log = logging.getLogger("ii_api.telemetry")

MAX_SESSION_LOG_DISCORD_PER_DAY = 6
MAX_HOURLY_PULSE_PER_DAY = 30
ERROR_LINE = re.compile(r"(?i)\b(error|exception|fatal|fail(ed|ure)?|crash|stack\s*trace)\b")
MONEY_LINE = re.compile(
    r"(?i)(\$\s?\d[\d,]*(?:\.\d{1,2})?|\d[\d,]*(?:\.\d{1,2})?\s?(?:usd|eur|gbp)|"
    r"\d[\d,]*(?:\.\d{1,2})?\s?robux|\bR\$\s?\d[\d,]*)"
)

# Soft brand accent used for Discord embeds (matches Engine orange accents).
HOURLY_EMBED_COLOR = 0xED7602

FEATURE_GROUPS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("Catalog & mods", ("catalog", "mod_", "vote", "preset", "loadout", "install", "menu")),
    ("AI & assistants", ("ai_", "iigpt", "mod_check", "assistant", "home_ai", "community_ai")),
    ("Studio & tools", ("studio", "soundlab", "tracker", "appearance", "music")),
    ("Errors & issues", ("error", "bepinex", "crash", "fail")),
)

# Device/network identifiers Engine telemetry must not accept, store, or display.
# Older desktop builds still send some of these, so the endpoints drop them on arrival
# and the rollup ignores any rows an earlier release already wrote.
DEVICE_IDENTIFIER_KEYS = frozenset(
    {
        "client_ip",
        "direct_ip",
        "egress_ip",
        "host",
        "hostname",
        "ip",
        "ipv4",
        "ipv6",
        "local_ip",
        "mac",
        "mac_address",
        "machine",
        "machine_name",
        "pc_name",
        "pc_username",
        "public_ip",
        "root_ip",
        "username",
        "vpn_ip",
        "vpn_suspected",
    }
)
_LABELLED_LINE = re.compile(r"^\s*([A-Za-z][A-Za-z0-9_\- ]{0,31})\s*:")
_IP_LITERAL = re.compile(
    r"\b(?:\d{1,3}\.){3}\d{1,3}\b|\b(?:[0-9A-Fa-f]{1,4}:){2,7}[0-9A-Fa-f]{1,4}\b"
)
# Profile directories embed the OS account name; keep the path shape, drop the name.
_USER_PROFILE_PATH = re.compile(
    r"([A-Za-z]:[\\/]+Users[\\/]+|[\\/](?:home|Users)[\\/]+)([^\\/\s\"'<>|*?]+)"
)
_KEPT_PROFILE_SEGMENTS = frozenset({"public", "default"})


def redact_user_paths(text: str) -> str:
    """Replace the account-name segment of OS profile paths with a placeholder."""

    def replace(match: re.Match[str]) -> str:
        if match.group(2).lower() in _KEPT_PROFILE_SEGMENTS:
            return match.group(0)
        return f"{match.group(1)}<user>"

    return _USER_PROFILE_PATH.sub(replace, text or "")


class SessionLogBody(BaseModel):
    # Unknown keys from stale desktop builds are dropped instead of stored.
    model_config = ConfigDict(extra="ignore")

    kind: str = Field(default="launch", pattern=r"^(launch|studio)$")
    log_text: str = Field(min_length=1, max_length=500_000)
    game_path: str = Field(default="", max_length=400)
    app_version: str = Field(default="", max_length=40)
    platform: str = Field(default="", max_length=40)
    features: dict[str, int] = Field(default_factory=dict)
    bepinex_errors: str = Field(default="", max_length=200_000)


class HourlyPulseBody(BaseModel):
    """Compact once-per-hour presence + feature counts (keeps Discord rollups cheap)."""

    model_config = ConfigDict(extra="ignore")

    features: dict[str, int] = Field(default_factory=dict)
    app_version: str = Field(default="", max_length=40)
    platform: str = Field(default="", max_length=40)


def _member_bits(request: Request) -> str:
    member = getattr(request.state, "member", {}) or {}
    entitlements = ",".join(sorted(set(member.get("entitlements", [])))) or "none"
    return entitlements


def scrub_device_identifiers(text: str, *, journal_header: bool = False) -> str:
    """Remove labelled device/network identifier lines from submitted log text.

    Stale clients render a journal header with `hostname:` / `public_ip:` style lines.
    Those lines are dropped, IP literals inside that header block are redacted, and OS
    profile paths lose the account name, so nothing reaches the staff channel or the
    stored summary.
    """
    if not text:
        return ""
    in_header = journal_header
    kept: list[str] = []
    for line in text.splitlines():
        if line.startswith("==="):
            in_header = False
        match = _LABELLED_LINE.match(line)
        if match:
            key = match.group(1).strip().lower().replace(" ", "_").replace("-", "_")
            if key in DEVICE_IDENTIFIER_KEYS:
                continue
        if in_header and _IP_LITERAL.search(line):
            line = _IP_LITERAL.sub("[removed]", line)
        kept.append(line)
    return redact_user_paths("\n".join(kept))


def _today_count(db: Session, user_id: str, feature_key: str) -> int:
    today = datetime.now(UTC).date()
    start = datetime(today.year, today.month, today.day, tzinfo=UTC)
    return int(
        db.scalar(
            select(func.count())
            .select_from(FeatureUsageEvent)
            .where(
                FeatureUsageEvent.user_id == user_id,
                FeatureUsageEvent.feature_key == feature_key,
                FeatureUsageEvent.created_at >= start,
            )
        )
        or 0
    )


def _telemetry_daily_cap(request: Request, *, default: int, uncapped_attr: str) -> int:
    settings = request.app.state.settings
    member = getattr(request.state, "member", None)
    if member_has_uncapped_limits(
        member, uncapped_role_ids=getattr(settings, "discord_uncapped_role_ids", "")
    ):
        return max(default, int(getattr(settings, uncapped_attr, 500)))
    return default


def _record_features(db: Session, user_id: str, features: dict[str, int], *, prefix=""):
    for raw_key, count in (features or {}).items():
        key = re.sub(r"[^a-z0-9_.:-]+", "_", str(raw_key).lower())[:40]
        if not key:
            continue
        n = max(0, min(int(count or 0), 500))
        if n <= 0:
            continue
        # One row per feature with count in detail — avoids hundreds of inserts.
        db.add(
            FeatureUsageEvent(
                user_id=user_id,
                feature_key=(prefix + key)[:40],
                detail=f"count={n}"[:200],
            )
        )


def extract_bepinex_errors(text: str) -> str:
    if not text:
        return ""
    # Prefer an explicit errors section if the client already extracted one.
    marker = "=== BEPINEX ERRORS ==="
    if marker in text:
        return text.split(marker, 1)[1].strip()[:200_000]
    bepinex = text
    if "=== BEPINEX LOGOUTPUT ===" in text:
        bepinex = text.split("=== BEPINEX LOGOUTPUT ===", 1)[1]
    lines = bepinex.splitlines()
    hits: list[str] = []
    for index, line in enumerate(lines):
        if ERROR_LINE.search(line):
            start = max(0, index - 1)
            end = min(len(lines), index + 3)
            chunk = "\n".join(lines[start:end]).strip()
            if chunk and chunk not in hits:
                hits.append(chunk)
        if len(hits) >= 80:
            break
    return ("\n\n---\n\n".join(hits))[:200_000]


def _issue_digest(text: str, error_text: str) -> str:
    source = error_text or text
    keys = Counter()
    for line in source.splitlines():
        cleaned = re.sub(r"\s+", " ", line.strip())
        if len(cleaned) < 12:
            continue
        if ERROR_LINE.search(cleaned):
            keys[cleaned[:160]] += 1
    if not keys:
        return "No clear error signatures in this journal."
    top = keys.most_common(5)
    return "\n".join(f"• ({count}×) `{sig}`" for sig, count in top)


def _post_file(discord, channel_id: str, summary: str, filename: str, blob: bytes):
    discord.post_channel_message_with_file(
        channel_id,
        summary,
        filename=filename,
        file_bytes=blob,
    )


@router.post("/telemetry/session-log")
def submit_session_log(
    body: SessionLogBody,
    request: Request,
    user: User = Depends(require_member),
    db: Session = Depends(database),
):
    """One staff Discord dump per Engine session (readable summary + journal + errors)."""
    text = scrub_device_identifiers(body.log_text.strip(), journal_header=True).strip()
    if len(text) < 20:
        raise HTTPException(422, "Log is empty")
    session_cap = _telemetry_daily_cap(
        request,
        default=MAX_SESSION_LOG_DISCORD_PER_DAY,
        uncapped_attr="telemetry_uncapped_session_log_per_day",
    )
    if _today_count(db, user.id, "session_log") >= session_cap:
        raise HTTPException(429, "Daily session-log telemetry budget reached")

    db.add(
        FeatureUsageEvent(
            user_id=user.id,
            feature_key="session_log",
            detail=f"{body.kind}:{len(text)}"[:200],
        )
    )
    db.add(
        FeatureUsageEvent(
            user_id=user.id,
            feature_key="engine_active",
            detail=user.display_name[:200],
        )
    )
    _record_features(db, user.id, body.features)
    db.commit()

    discord = getattr(request.app.state, "discord", None)
    settings = getattr(request.app.state, "settings", None)
    if not discord or not settings:
        return {"accepted": 1}

    stamp = datetime.now(UTC).strftime("%Y%m%d-%H%M%S")
    errors = scrub_device_identifiers((body.bepinex_errors or "").strip()) or (
        extract_bepinex_errors(text)
    )
    digest = _issue_digest(text, errors)
    filename = f"session-{body.kind}-{user.discord_id}-{stamp}.txt"
    header = (
        f"kind: {body.kind}\n"
        f"user: {user.display_name} ({user.discord_id})\n"
        f"entitlements: {_member_bits(request)}\n"
        f"app_version: {body.app_version or '?'}\n"
        f"platform: {body.platform or '?'}\n"
        f"game_path: {redact_user_paths(body.game_path) or '?'}\n"
        f"at: {datetime.now(UTC).isoformat()}\n\n"
        f"=== ISSUE DIGEST ===\n{digest}\n\n"
    )
    blob = (header + text).encode("utf-8", errors="replace")
    lines = text.count("\n") + 1
    error_count = len([block for block in errors.split("---") if block.strip()]) if errors else 0
    summary = (
        f"**ii Engine session** · `{body.kind}`\n"
        f"👤 **{user.display_name}** (`{user.discord_id}`)\n"
        f"🧾 {lines} journal lines · `{body.app_version or '?'}` · `{body.platform or '?'}`\n"
        f"🧨 BepInEx error clusters: **{error_count}**\n"
        f"**Top issues**\n{digest}\n"
        f"📎 `{filename}`"
    )
    try:
        _post_file(discord, settings.discord_telemetry_channel_id, summary, filename, blob)
        if errors.strip():
            err_name = f"bepinex-errors-{user.discord_id}-{stamp}.txt"
            err_body = (
                f"user: {user.display_name} ({user.discord_id})\n"
                f"kind: {body.kind}\n"
                f"at: {datetime.now(UTC).isoformat()}\n\n"
                f"{errors.strip()}\n"
            ).encode("utf-8", errors="replace")
            _post_file(
                discord,
                settings.discord_telemetry_channel_id,
                f"**BepInEx errors** · **{user.display_name}** · `{error_count}` clusters\n📎 `{err_name}`",
                err_name,
                err_body,
            )
    except ProviderUnavailable:
        try:
            discord.post_channel_message(
                settings.discord_telemetry_channel_id,
                summary + f"\n```\n{text[-1200:]}\n```",
            )
        except ProviderUnavailable:
            pass
    return {"accepted": 1}


@router.post("/telemetry/hourly")
def hourly_pulse(
    body: HourlyPulseBody,
    request: Request,
    user: User = Depends(require_member),
    db: Session = Depends(database),
):
    """One small presence pulse per hour while Engine is open — feeds the hourly Discord rollup."""
    pulse_cap = _telemetry_daily_cap(
        request,
        default=MAX_HOURLY_PULSE_PER_DAY,
        uncapped_attr="telemetry_uncapped_hourly_pulse_per_day",
    )
    if _today_count(db, user.id, "hourly_pulse") >= pulse_cap:
        return {"accepted": 0, "skipped": True}
    db.add(
        FeatureUsageEvent(
            user_id=user.id,
            feature_key="hourly_pulse",
            detail=user.display_name[:200],
        )
    )
    db.add(
        FeatureUsageEvent(
            user_id=user.id,
            feature_key="engine_active",
            detail=user.display_name[:200],
        )
    )
    _record_features(db, user.id, body.features)
    if body.app_version:
        db.add(
            FeatureUsageEvent(
                user_id=user.id,
                feature_key="app_version",
                detail=body.app_version[:200],
            )
        )
    if body.platform:
        db.add(
            FeatureUsageEvent(
                user_id=user.id,
                feature_key="platform",
                detail=body.platform[:200],
            )
        )
    db.commit()
    return {"accepted": 1}


def _truncate_field(text: str, limit: int = 1020) -> str:
    text = text.strip()
    if len(text) <= limit:
        return text
    return text[: limit - 1].rstrip() + "…"


def _group_for_feature(key: str) -> str:
    lowered = key.lower()
    for label, needles in FEATURE_GROUPS:
        if any(needle in lowered for needle in needles):
            return label
    return "Everything else"


def _format_name_block(names: list[str], *, limit: int = 60) -> str:
    if not names:
        return "_Nobody pulsed this hour._"
    shown = names[:limit]
    block = ", ".join(f"`{name}`" for name in shown)
    if len(names) > limit:
        block += f"\n… +**{len(names) - limit}** more"
    return block


def _format_feature_sections(
    feature_counts: Counter[str],
    feature_users: dict[str, set[str]],
    *,
    skip: set[str],
) -> str:
    grouped: dict[str, list[tuple[str, int, int]]] = defaultdict(list)
    for key, total in feature_counts.most_common():
        if key in skip:
            continue
        uniques = len(feature_users.get(key, set()))
        grouped[_group_for_feature(key)].append((key, total, uniques))

    if not grouped:
        return "_No feature events this hour._"

    order = [label for label, _ in FEATURE_GROUPS] + ["Everything else"]
    sections: list[str] = []
    for label in order:
        rows = grouped.get(label) or []
        if not rows:
            continue
        lines = [f"**{label}**"]
        for key, total, uniques in rows[:12]:
            lines.append(
                f"• `{key}` — **{total}** · **{uniques}** user{'s' if uniques != 1 else ''}"
            )
        leftover = len(rows) - 12
        if leftover > 0:
            lines.append(f"• _{leftover} more in this group_")
        sections.append("\n".join(lines))
    return "\n\n".join(sections) if sections else "_No feature events this hour._"


def summarize_sales_messages(messages: list[dict]) -> dict:
    """Turn raw Discord sales-channel messages into rollup-friendly stats."""
    snippets: list[str] = []
    money_hits: list[str] = []
    authors: Counter[str] = Counter()
    for row in messages:
        author = row.get("author") if isinstance(row.get("author"), dict) else {}
        author_name = str(author.get("global_name") or author.get("username") or "unknown")[:40]
        authors[author_name] += 1
        content = re.sub(r"\s+", " ", str(row.get("content") or "")).strip()
        if not content and row.get("embeds"):
            embed0 = row["embeds"][0] if isinstance(row["embeds"], list) and row["embeds"] else {}
            if isinstance(embed0, dict):
                content = re.sub(
                    r"\s+",
                    " ",
                    f"{embed0.get('title') or ''} {embed0.get('description') or ''}",
                ).strip()
        if content:
            for match in MONEY_LINE.findall(content):
                money_hits.append(match if isinstance(match, str) else match[0])
            if len(snippets) < 6:
                snippets.append(f"• `{author_name}` — {content[:120]}")
    return {
        "available": True,
        "count": len(messages),
        "unique_posters": len(authors),
        "money_mentions": len(money_hits),
        "top_authors": authors.most_common(5),
        "snippets": snippets,
    }


def fetch_sales_window(discord, channel_id: str, start: datetime, end: datetime) -> dict:
    """Read #sales for the rollup window. Soft-fails when the channel is hidden from the bot."""
    if not channel_id or not str(channel_id).isdigit():
        return {"available": False, "count": 0, "reason": "Sales channel is not configured"}
    try:
        messages = discord.list_channel_messages_between(
            channel_id,
            start=start,
            end=end,
            max_messages=500,
        )
    except ProviderUnavailable as error:
        log.warning("hourly sales channel read failed: %s", error)
        return {
            "available": False,
            "count": 0,
            "reason": "Sales channel unreadable (bot needs View + Read History)",
        }
    except Exception:
        log.exception("hourly sales channel read crashed")
        return {
            "available": False,
            "count": 0,
            "reason": "Sales channel read failed unexpectedly",
        }
    return summarize_sales_messages(messages)


def _pro_claims_in_window(db: Session, start: datetime, end: datetime) -> int:
    return int(
        db.scalar(
            select(func.count())
            .select_from(RobloxGamepassClaim)
            .where(
                RobloxGamepassClaim.claimed_at.is_not(None),
                RobloxGamepassClaim.claimed_at >= start,
                RobloxGamepassClaim.claimed_at < end,
            )
        )
        or 0
    )


def build_hourly_rollup(
    db: Session,
    *,
    window: timedelta = timedelta(hours=1),
    sales: dict | None = None,
    end: datetime | None = None,
) -> dict:
    """Build Discord content + embed payload for the hourly staff pulse."""
    end = end or datetime.now(UTC)
    start = end - window
    rows = db.execute(
        select(
            FeatureUsageEvent.feature_key,
            FeatureUsageEvent.user_id,
            FeatureUsageEvent.detail,
            User.display_name,
        )
        .join(User, User.id == FeatureUsageEvent.user_id)
        .where(FeatureUsageEvent.created_at >= start, FeatureUsageEvent.created_at < end)
    ).all()

    active_users: dict[str, str] = {}
    feature_users: dict[str, set[str]] = defaultdict(set)
    feature_counts: Counter[str] = Counter()
    versions: Counter[str] = Counter()
    platforms: Counter[str] = Counter()
    session_logs = 0
    hourly_pulses = 0
    error_events = 0

    for feature_key, user_id, detail, display_name in rows:
        if feature_key in DEVICE_IDENTIFIER_KEYS:
            # Rows an earlier release wrote. Never rendered, never counted.
            continue
        name = (display_name or detail or user_id)[:80]
        detail_text = detail or ""
        if feature_key in {"engine_active", "hourly_pulse", "session_log"}:
            active_users[user_id] = name
        if feature_key == "session_log":
            session_logs += 1
        elif feature_key == "hourly_pulse":
            hourly_pulses += 1
        elif feature_key == "app_version" and detail_text:
            versions[detail_text[:40]] += 1
            continue
        elif feature_key == "platform" and detail_text:
            platforms[detail_text[:40]] += 1
            continue

        if feature_key.startswith("count="):
            continue
        # Feature rows from _record_features use detail count=N
        if detail_text.startswith("count="):
            try:
                amount = int(detail_text.split("=", 1)[1])
            except ValueError:
                amount = 1
            feature_counts[feature_key] += amount
        else:
            feature_counts[feature_key] += 1
        feature_users[feature_key].add(user_id)

    error_events = sum(
        total
        for key, total in feature_counts.items()
        if any(token in key for token in ("error", "bepinex", "crash", "fail"))
    )

    skip = {
        "engine_active",
        "hourly_pulse",
        "session_log",
        "app_version",
        "platform",
    } | set(DEVICE_IDENTIFIER_KEYS)
    feature_event_total = sum(total for key, total in feature_counts.items() if key not in skip)
    names = [name for _, name in sorted(active_users.items(), key=lambda row: row[1].lower())]
    sales_info = sales if isinstance(sales, dict) else {"available": False, "count": 0}
    pro_claims = _pro_claims_in_window(db, start, end)

    window_label = f"{start.strftime('%H:%M')}–{end.strftime('%H:%M')} UTC"
    date_label = start.strftime("%Y-%m-%d")

    sales_lines: list[str] = []
    if sales_info.get("available"):
        sales_lines.append(f"**{int(sales_info.get('count') or 0)}** sale posts this hour")
        posters = int(sales_info.get("unique_posters") or 0)
        if posters:
            sales_lines.append(f"Unique posters: **{posters}**")
        money = int(sales_info.get("money_mentions") or 0)
        if money:
            sales_lines.append(f"Money-like mentions: **{money}**")
        top_authors = sales_info.get("top_authors") or []
        if top_authors:
            sales_lines.append(
                "Top posters: " + ", ".join(f"`{name}` ×{count}" for name, count in top_authors[:3])
            )
        snippets = sales_info.get("snippets") or []
        if snippets:
            sales_lines.append("")
            sales_lines.append("**Recent**")
            sales_lines.extend(snippets[:5])
    else:
        reason = sales_info.get("reason") or "Sales channel unavailable"
        sales_lines.append(f"_{reason}_")
    if pro_claims:
        sales_lines.append(f"Roblox Pro claims (API): **{pro_claims}**")

    version_line = (
        ", ".join(f"`{ver}` ×{count}" for ver, count in versions.most_common(6))
        or "_No version pulses_"
    )
    platform_line = (
        ", ".join(f"`{plat}` ×{count}" for plat, count in platforms.most_common(6))
        or "_No platform pulses_"
    )

    snapshot = "\n".join(
        [
            f"👥 Active users · **{len(active_users)}**",
            f"📡 Hourly pulses · **{hourly_pulses}**",
            f"🧾 Session journals · **{session_logs}**",
            f"⚙️ Feature events · **{feature_event_total}**",
            f"🧨 Error-ish events · **{error_events}**",
            f"🛒 Sales posts · **{int(sales_info.get('count') or 0)}**"
            + ("" if sales_info.get("available") else " _(unread)_"),
            f"💎 Roblox Pro claims · **{pro_claims}**",
        ]
    )

    features_text = _format_feature_sections(feature_counts, feature_users, skip=skip)
    online_text = _format_name_block(names)
    sales_text = "\n".join(sales_lines)
    build_text = f"**Versions**\n{version_line}\n\n**Platforms**\n{platform_line}"

    embed = {
        "title": "ii Engine · Hourly Pulse",
        "description": f"`{window_label}` · **{date_label}**",
        "color": HOURLY_EMBED_COLOR,
        "fields": [
            {"name": "Snapshot", "value": _truncate_field(snapshot), "inline": False},
            {"name": "Sales", "value": _truncate_field(sales_text), "inline": False},
            {"name": "Online", "value": _truncate_field(online_text), "inline": False},
            {"name": "Feature usage", "value": _truncate_field(features_text), "inline": False},
            {"name": "Clients", "value": _truncate_field(build_text), "inline": False},
        ],
        "footer": {"text": "ii Engine telemetry · past 60 minutes"},
        "timestamp": end.isoformat().replace("+00:00", "Z"),
    }

    # Plain-text fallback for logs / older consumers / tests.
    content = (
        f"**ii Engine hourly rollup** · `{window_label}`\n"
        f"👥 **{len(active_users)}** active · 🛒 **{int(sales_info.get('count') or 0)}** sales"
        + ("" if sales_info.get("available") else " _(unread)_")
        + f" · 💎 **{pro_claims}** Pro claims"
    )

    return {
        "content": content,
        "embeds": [embed],
        "start": start,
        "end": end,
        "active_users": len(active_users),
        "sales_count": int(sales_info.get("count") or 0),
        "sales_available": bool(sales_info.get("available")),
        "pro_claims": pro_claims,
    }


def post_hourly_rollup(app) -> bool:
    """Called by the app lifespan loop. One Discord message, no client fan-out."""
    engine = getattr(app.state, "engine", None)
    discord = getattr(app.state, "discord", None)
    settings = getattr(app.state, "settings", None)
    if not engine or not discord or not settings:
        return False
    from sqlalchemy.orm import Session as SaSession

    end = datetime.now(UTC)
    start = end - timedelta(hours=1)
    sales_channel = getattr(settings, "discord_sales_channel_id", "") or ""
    sales = fetch_sales_window(discord, sales_channel, start, end)

    with SaSession(engine) as db:
        payload = build_hourly_rollup(db, sales=sales, end=end)

    hourly_channel = (
        getattr(settings, "discord_telemetry_hourly_channel_id", "")
        or settings.discord_telemetry_channel_id
    )
    try:
        discord.post_channel_message(
            hourly_channel,
            payload["content"],
            embeds=payload["embeds"],
        )
        return True
    except ProviderUnavailable:
        log.warning("hourly telemetry Discord post failed")
        return False


def usage_stats(db: Session):
    rows = db.execute(
        select(
            FeatureUsageEvent.feature_key,
            func.count().label("events"),
            func.count(func.distinct(FeatureUsageEvent.user_id)).label("users"),
        ).group_by(FeatureUsageEvent.feature_key)
    ).all()
    by_key = {
        key: {"feature": key, "events": int(events), "unique_users": int(users)}
        for key, events, users in rows
        if key not in DEVICE_IDENTIFIER_KEYS
    }
    keys = sorted(set(by_key) | {"session_log", "engine_active", "hourly_pulse"})
    return {
        "generated_at": datetime.now(UTC),
        "items": [
            by_key.get(key, {"feature": key, "events": 0, "unique_users": 0}) for key in keys
        ],
    }
