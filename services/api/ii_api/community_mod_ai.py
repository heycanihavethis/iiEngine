"""Helpers for advisory AI briefs on approved community mods."""

from __future__ import annotations

import logging
import re
from datetime import UTC, datetime

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from .discord import ProviderUnavailable
from .models import CommunityMod, User
from .prompts.community_mod_info_v1 import COMMUNITY_MOD_INFO_SYSTEM_PROMPT

logger = logging.getLogger("ii_api")

MIN_STRING_LEN = 5
MAX_STRING_CHARS = 22000

FOOTNOTE = (
    "AI reviews can be wrong and are not perfect. Treat this as informal information only."
)


def extract_printable_strings(blob: bytes, *, limit: int = MAX_STRING_CHARS) -> str:
    chunks: list[str] = []
    current: list[str] = []
    total = 0
    for value in blob:
        if 32 <= value <= 126:
            current.append(chr(value))
            continue
        if len(current) >= MIN_STRING_LEN:
            piece = "".join(current)
            chunks.append(piece)
            total += len(piece) + 1
            if total >= limit:
                break
        current = []
    if len(current) >= MIN_STRING_LEN and total < limit:
        chunks.append("".join(current))

    interesting = [
        line
        for line in chunks
        if re.search(
            r"https?:|discord|webhook|harmony|bepinex|melon|il2cpp|photon|http|socket|"
            r"password|token|key|inject|patch|gorilla|menu|esp|fly",
            line,
            re.I,
        )
    ]
    rest = [line for line in chunks if line not in interesting]
    ordered = [*interesting, *rest]
    out = []
    size = 0
    for line in ordered:
        if size + len(line) + 1 > limit:
            break
        out.append(line)
        size += len(line) + 1
    return "\n".join(out).strip() or "\n".join(chunks[:40])


def history_context(db: Session, row: CommunityMod) -> str:
    author = db.get(User, row.user_id)
    author_name = author.display_name if author else "unknown"
    related = db.execute(
        select(CommunityMod, User)
        .join(User, User.id == CommunityMod.user_id)
        .where(
            CommunityMod.id != row.id,
            or_(
                CommunityMod.sha256 == row.sha256,
                CommunityMod.filename == row.filename,
                CommunityMod.name == row.name,
                CommunityMod.user_id == row.user_id,
            ),
        )
        .order_by(CommunityMod.created_at.desc())
        .limit(12)
    ).all()
    lines = [
        f"Current author: {author_name} (user_id={row.user_id})",
        f"Current filename: {row.filename}",
        f"Current SHA256: {row.sha256}",
        f"Current description: {row.description[:500]}",
    ]
    if not related:
        lines.append("No prior catalog history matched name, filename, hash, or author.")
        return "\n".join(lines)
    lines.append("Related catalog history:")
    for prior, prior_author in related:
        lines.append(
            "- "
            f"{prior.created_at.isoformat()} · status={prior.status} · "
            f"name={prior.name!r} · file={prior.filename!r} · "
            f"sha256={prior.sha256[:16]}… · author={prior_author.display_name} "
            f"(user_id={prior_author.id})"
        )
    return "\n".join(lines)


async def generate_community_mod_ai_info(app, mod_id: str) -> None:
    """Background worker: fill ai_info_* fields for an approved community mod."""
    engine = getattr(app.state, "engine", None)
    provider = getattr(app.state, "ai_provider", None)
    if engine is None or provider is None:
        return
    with Session(engine) as db:
        row = db.get(CommunityMod, mod_id)
        if row is None or row.status != "approved":
            return
        row.ai_info_status = "running"
        row.ai_info_error = ""
        row.ai_info_updated_at = datetime.now(UTC)
        db.add(row)
        db.commit()
        name = row.name
        description = row.description
        filename = row.filename
        sha256 = row.sha256
        history = history_context(db, row)
        strings = extract_printable_strings(row.artifact or b"")

    prompt = (
        f"Mod name: {name}\n"
        f"Uploader description: {description}\n"
        f"Filename: {filename}\n"
        f"SHA256: {sha256}\n\n"
        f"History:\n{history}\n\n"
        f"Extracted printable strings / metadata (truncated):\n{strings[:22000]}\n\n"
        f"End with this exact footnote line under **Footnote**:\n{FOOTNOTE}"
    )
    try:
        report = await provider.complete(
            prompt, system=COMMUNITY_MOD_INFO_SYSTEM_PROMPT, max_tokens=1200
        )
        text = (report or "").strip()[:8000]
        if FOOTNOTE.lower() not in text.lower():
            text = f"{text.rstrip()}\n\n**Footnote**\n{FOOTNOTE}"
        # Soften accidental hard malware labels from the model.
        text = re.sub(
            r"(?i)\b(inherently|definitely|clearly)\s+malicious\b",
            "potentially malicious",
            text,
        )
        text = re.sub(
            r"(?im)^(\*\*Final Verdict\*\*.*)$",
            "**Community Caution**\nPotentially malicious (unsigned community DLL) — informational only.",
            text,
        )
        status = "ready"
        error = ""
    except (ProviderUnavailable, TimeoutError) as exc:
        logger.warning("community_mod_ai_info unavailable mod=%s err=%s", mod_id, exc)
        text = None
        status = "failed"
        error = "Private AI is temporarily unavailable"
    except Exception:
        logger.exception("community_mod_ai_info failed mod=%s", mod_id)
        text = None
        status = "failed"
        error = "AI info review failed"

    with Session(engine) as db:
        row = db.get(CommunityMod, mod_id)
        if row is None:
            return
        row.ai_info_status = status
        row.ai_info_report = text
        row.ai_info_error = error[:300]
        row.ai_info_updated_at = datetime.now(UTC)
        db.add(row)
        db.commit()
