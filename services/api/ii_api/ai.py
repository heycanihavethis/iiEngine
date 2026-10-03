import asyncio
import hashlib
import json
import re
from contextlib import aclosing
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from .access import member_has_uncapped_limits
from .auth import database, require_member
from .discord import ProviderUnavailable
from .menu_features import (
    CHAT_CATALOG_SYSTEM_SUFFIX,
    HOME_ASSISTANT_SYSTEM,
    STUDIO_SYSTEM,
    catalog_for_prompt,
    lookup_catalog_feature,
    structured_catalog,
)
from .models import AIBucketReservation, AIBucketUsage, AIReservation, AIUsageDaily, User
from .prompts.catalog_explain_v1 import CATALOG_EXPLAIN_SYSTEM_PROMPT
from .prompts.iigpt_v1 import SYSTEM_PROMPT
from .prompts.mod_check_v2 import MOD_CHECK_SYSTEM_PROMPT
from .prompts.tracker_assist_v1 import TRACKER_ASSIST_SYSTEM
from .prompts.tracker_scout_v1 import TRACKER_SCOUT_ANSWER_SYSTEM, TRACKER_SCOUT_PLANNER_SYSTEM
from .tracker import (
    _has_tracker_product_access,
    format_sightings_for_scout,
    resolve_scout_time_window,
    rollup_scout_players,
    search_sightings,
)

CATALOG_EXPLAIN_FOOTNOTE = (
    "AI explanations can be wrong and are not perfect. "
    "This is informational only — not a safety rating."
)

router = APIRouter(prefix="/v1/ai")

def reset_at(day):
    return datetime.combine(day + timedelta(days=1), datetime.min.time(), tzinfo=UTC).isoformat()


def configured_ai_key(settings) -> str:
    return (
        settings.siliconflow_api_key.get_secret_value().strip()
        or settings.nvidia_api_key_2.get_secret_value().strip()
    )


AI_HARD_CEILING = 500


class Quota:
    def __init__(self, engine, *, daily_limit: int = 50, hard_ceiling: int = AI_HARD_CEILING):
        self.engine = engine
        # Hard ceiling matches ai_usage_daily.check (request_count <= 500).
        ceiling = max(1, int(hard_ceiling))
        self.daily_limit = max(1, min(ceiling, int(daily_limit)))

    def reserve(self, user_id):
        now = datetime.now(UTC)
        with Session(self.engine) as db, db.begin():
            # Every reservation/completion takes the same user-row lock, across processes.
            db.scalar(select(User).where(User.id == user_id).with_for_update())
            db.execute(
                delete(AIReservation).where(
                    AIReservation.user_id == user_id, AIReservation.expires_at <= now
                )
            )
            usage = db.get(AIUsageDaily, (user_id, now.date()))
            if usage is None:
                usage = AIUsageDaily(user_id=user_id, utc_date=now.date(), request_count=0)
                db.add(usage)
            pending = db.scalar(
                select(func.count())
                .select_from(AIReservation)
                .where(AIReservation.user_id == user_id, AIReservation.utc_date == now.date())
            )
            if usage.request_count + pending >= self.daily_limit:
                raise HTTPException(
                    429,
                    detail={
                        "message": "Daily allowance is in use or exhausted",
                        "remaining": 0,
                        "reset_at": reset_at(now.date()),
                    },
                )
            reservation = AIReservation(
                id=str(uuid4()),
                user_id=user_id,
                utc_date=now.date(),
                expires_at=now + timedelta(minutes=2),
            )
            db.add(reservation)
            return reservation.id, reset_at(now.date())

    def finish(self, user_id, reservation_id, success):
        with Session(self.engine) as db, db.begin():
            db.scalar(select(User).where(User.id == user_id).with_for_update())
            reservation = db.get(AIReservation, reservation_id)
            if reservation is None:
                raise RuntimeError("AI reservation expired")
            usage = db.get(AIUsageDaily, (user_id, reservation.utc_date))
            if success:
                usage.request_count += 1
            db.delete(reservation)
            return max(0, self.daily_limit - usage.request_count)


def _ai_hard_ceiling(request: Request) -> int:
    return max(1, int(getattr(request.app.state.settings, "ai_hard_ceiling", AI_HARD_CEILING)))


def member_ai_daily_limit(request: Request, *, default_limit: int) -> int:
    """Normal members use default_limit; owner/admin/uncapped get the elevated budget."""
    settings = request.app.state.settings
    member = getattr(request.state, "member", None)
    if member_has_uncapped_limits(
        member, uncapped_role_ids=getattr(settings, "discord_uncapped_role_ids", "")
    ):
        return int(getattr(settings, "ai_uncapped_daily_request_limit", AI_HARD_CEILING))
    return int(default_limit)


def shared_ai_quota(request: Request) -> Quota:
    """One daily pool for every SiliconFlow-backed feature."""
    limit = member_ai_daily_limit(
        request, default_limit=request.app.state.settings.ai_daily_request_limit
    )
    return Quota(
        request.app.state.engine,
        daily_limit=limit,
        hard_ceiling=_ai_hard_ceiling(request),
    )


class BucketQuota:
    """Independent daily counters for community `/ai` and Home assistant."""

    def __init__(
        self, engine, *, bucket: str, daily_limit: int = 50, hard_ceiling: int = AI_HARD_CEILING
    ):
        self.engine = engine
        self.bucket = bucket[:40]
        ceiling = max(1, int(hard_ceiling))
        self.daily_limit = max(1, min(ceiling, int(daily_limit)))

    def reserve(self, user_id):
        now = datetime.now(UTC)
        with Session(self.engine) as db, db.begin():
            db.scalar(select(User).where(User.id == user_id).with_for_update())
            db.execute(
                delete(AIBucketReservation).where(
                    AIBucketReservation.user_id == user_id,
                    AIBucketReservation.bucket == self.bucket,
                    AIBucketReservation.expires_at <= now,
                )
            )
            usage = db.get(AIBucketUsage, (user_id, now.date(), self.bucket))
            if usage is None:
                usage = AIBucketUsage(
                    user_id=user_id, utc_date=now.date(), bucket=self.bucket, request_count=0
                )
                db.add(usage)
            pending = db.scalar(
                select(func.count())
                .select_from(AIBucketReservation)
                .where(
                    AIBucketReservation.user_id == user_id,
                    AIBucketReservation.utc_date == now.date(),
                    AIBucketReservation.bucket == self.bucket,
                )
            )
            if usage.request_count + pending >= self.daily_limit:
                raise HTTPException(
                    429,
                    detail={
                        "message": "Daily allowance is in use or exhausted",
                        "remaining": 0,
                        "reset_at": reset_at(now.date()),
                    },
                )
            reservation = AIBucketReservation(
                id=str(uuid4()),
                user_id=user_id,
                utc_date=now.date(),
                bucket=self.bucket,
                expires_at=now + timedelta(minutes=2),
            )
            db.add(reservation)
            return reservation.id, reset_at(now.date())

    def finish(self, user_id, reservation_id, success):
        with Session(self.engine) as db, db.begin():
            db.scalar(select(User).where(User.id == user_id).with_for_update())
            reservation = db.get(AIBucketReservation, reservation_id)
            if reservation is None:
                raise RuntimeError("AI reservation expired")
            usage = db.get(AIBucketUsage, (user_id, reservation.utc_date, reservation.bucket))
            if usage is None:
                usage = AIBucketUsage(
                    user_id=user_id,
                    utc_date=reservation.utc_date,
                    bucket=reservation.bucket,
                    request_count=0,
                )
                db.add(usage)
            if success:
                usage.request_count += 1
            db.delete(reservation)
            return max(0, self.daily_limit - usage.request_count)


class AIProvider:
    """OpenAI-compatible chat provider (SiliconFlow by default)."""

    def __init__(self, settings, transport=None):
        self.settings = settings
        self.client = httpx.AsyncClient(
            timeout=httpx.Timeout(45, connect=10), transport=transport, follow_redirects=False
        )

    async def close(self):
        await self.client.aclose()

    def _endpoint(self) -> str:
        base = (self.settings.ai_base_url or "https://api.siliconflow.com/v1").rstrip("/")
        return f"{base}/chat/completions"

    async def stream(
        self,
        prompt: str,
        *,
        system: str = SYSTEM_PROMPT,
        max_tokens: int = 1024,
        model: str | None = None,
        temperature: float = 0.2,
    ):
        key = configured_ai_key(self.settings)
        if not key:
            raise ProviderUnavailable("Private AI is not configured")
        payload = {
            "model": (model or self.settings.ai_model).strip() or self.settings.ai_model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": prompt},
            ],
            "max_tokens": max_tokens,
            "stream": True,
            "temperature": max(0.0, min(1.5, float(temperature))),
        }
        # No mid-stream retry: a partially delivered answer must not be duplicated.
        for attempt in range(2):
            yielded = False
            try:
                async with self.client.stream(
                    "POST",
                    self._endpoint(),
                    headers={"Authorization": f"Bearer {key}"},
                    json=payload,
                ) as response:
                    if response.status_code in (429, 502, 503, 504) and attempt == 0:
                        retry = response.headers.get("Retry-After", "1")
                        try:
                            delay = float(retry)
                        except ValueError:
                            delay = 1
                        if not 0 <= delay <= 2:
                            raise ProviderUnavailable("Private AI is busy")
                        await asyncio.sleep(delay)
                        continue
                    if response.status_code >= 400:
                        # Drain a small error body so the connection can close cleanly.
                        try:
                            await response.aread()
                        except httpx.HTTPError:
                            pass
                        raise ProviderUnavailable("Private AI is temporarily unavailable")
                    async for line in response.aiter_lines():
                        if len(line) > 65536:
                            raise ProviderUnavailable("Invalid AI response")
                        if not line.startswith("data:"):
                            continue
                        content = line[5:].strip()
                        if not content:
                            continue
                        if content == "[DONE]":
                            return
                        try:
                            event = json.loads(content)
                        except json.JSONDecodeError:
                            # Providers sometimes emit keepalives / partial frames.
                            continue
                        choices = event.get("choices", [])
                        if not choices:
                            continue
                        piece = choices[0].get("delta", {}).get("content")
                        if piece:
                            if not isinstance(piece, str):
                                raise ProviderUnavailable("Invalid AI response")
                            yielded = True
                            yield piece
                    # Some providers close the SSE without a trailing [DONE].
                    if yielded:
                        return
                    raise ProviderUnavailable("AI stream ended before completion")
            except ProviderUnavailable:
                raise
            except (httpx.HTTPError, ValueError, KeyError, TypeError):
                raise ProviderUnavailable("Private AI is temporarily unavailable") from None

    async def complete(
        self,
        prompt: str,
        *,
        system: str = SYSTEM_PROMPT,
        max_tokens: int = 1024,
        model: str | None = None,
        temperature: float = 0.2,
    ):
        parts: list[str] = []
        async with aclosing(
            self.stream(
                prompt,
                system=system,
                max_tokens=max_tokens,
                model=model,
                temperature=temperature,
            )
        ) as stream:
            async for piece in stream:
                parts.append(piece)
                if sum(len(part) for part in parts) >= 8000:
                    break
        text = "".join(parts).strip()
        if not text:
            raise ProviderUnavailable("No answer received. Please try again")
        return text

    def tracker_model(self) -> str:
        """SiliconFlow model for Tracker Scout/Assist (falls back to shared ai_model)."""
        configured = str(getattr(self.settings, "ai_tracker_model", "") or "").strip()
        return configured or self.settings.ai_model


# Back-compat alias for older imports/tests.
NVIDIAProvider = AIProvider


class ChatBody(BaseModel):
    message: str = Field(min_length=1, max_length=2000)
    share_telemetry: bool = False


class AutocompleteBody(BaseModel):
    prefix: str = Field(min_length=1, max_length=4000)
    language: str = Field(default="csharp", max_length=40)
    share_telemetry: bool = False


class ModCheckBody(BaseModel):
    filename: str = Field(min_length=1, max_length=180)
    sha256: str = Field(min_length=64, max_length=64)
    strings: str = Field(min_length=20, max_length=24000)
    share_telemetry: bool = False


class HomeAssistBody(BaseModel):
    message: str = Field(min_length=1, max_length=2000)
    share_telemetry: bool = False


class TrackerAssistBody(BaseModel):
    message: str = Field(min_length=1, max_length=500)
    # Client-compressed 3-day sighting digest — never raw Discord dumps.
    digest: str = Field(min_length=20, max_length=9000)
    share_telemetry: bool = False


class TrackerScoutBody(BaseModel):
    message: str = Field(min_length=1, max_length=500)
    share_telemetry: bool = False


class CatalogExplainBody(BaseModel):
    name: str = Field(min_length=1, max_length=180)
    share_telemetry: bool = False


class StudioActionBody(BaseModel):
    action: str = Field(min_length=3, max_length=20)
    selection: str = Field(min_length=1, max_length=6000)
    language: str = Field(default="csharp", max_length=40)
    instruction: str = Field(default="", max_length=400)
    share_telemetry: bool = False


def event(name, data):
    return f"event: {name}\ndata: {json.dumps(data)}\n\n"


def require_ai(request: Request):
    provider = request.app.state.ai_provider
    if isinstance(provider, AIProvider) and not configured_ai_key(request.app.state.settings):
        raise HTTPException(503, "Private AI is not configured")
    return provider


def require_pro(request: Request) -> None:
    entitlements = set(request.state.member.get("entitlements", []))
    if "pro" not in entitlements and not (entitlements & {"admin", "owner"}):
        raise HTTPException(403, "Engine Pro is required to use Catalog Ask AI")


def publish_ai_exchange(request: Request, user: User, *, source: str, prompt: str, response: str):
    """AI transcripts are included in the client session journal (one Discord upload on close)."""
    return


def grounded_chat_prompt(message: str) -> tuple[str, str, bool]:
    """Return (prompt, system, catalog_attached) for /v1/ai/chat and Home fallbacks."""
    question = message.strip()
    catalog = catalog_for_prompt(question, always=True)
    prompt = (
        f"User question:\n{question}\n\n"
        f"ii Reborn Menu feature catalog (authoritative):\n{catalog}\n"
    )
    studio_ish = bool(
        re.search(r"(?i)\b(ii\s*studio|coding help|c#|bepinex|harmony|autocomplete)\b", question)
    )
    system = (STUDIO_SYSTEM if studio_ish else SYSTEM_PROMPT) + CHAT_CATALOG_SYSTEM_SUFFIX
    return prompt, system, True


@router.post("/chat")
async def chat(body: ChatBody, request: Request, user: User = Depends(require_member)):
    if not body.message.strip():
        raise HTTPException(422, "Enter a question")
    provider = require_ai(request)
    quota = shared_ai_quota(request)
    reservation_id, reset = await asyncio.to_thread(quota.reserve, user.id)
    prompt, system, _catalog_attached = grounded_chat_prompt(body.message)

    async def generate():
        finished = False
        length = 0
        pieces: list[str] = []
        try:
            async with asyncio.timeout(60):
                async with aclosing(provider.stream(prompt, system=system)) as stream:
                    async for piece in stream:
                        if await request.is_disconnected():
                            return
                        piece = piece[: 4000 - length]
                        length += len(piece)
                        if piece:
                            pieces.append(piece)
                            yield event("token", {"text": piece})
                        if length >= 4000:
                            break
            if length == 0:
                raise ProviderUnavailable("No answer received. Please try again")
            remaining = await asyncio.to_thread(quota.finish, user.id, reservation_id, True)
            finished = True
            if getattr(body, "share_telemetry", False):
                publish_ai_exchange(
                    request,
                    user,
                    source="chat",
                    prompt=body.message,
                    response="".join(pieces),
                )
            yield event("done", {"remaining": remaining, "reset_at": reset})
        except (ProviderUnavailable, TimeoutError):
            yield event(
                "error", {"message": "Private AI is unavailable. Your request was not charged."}
            )
        finally:
            if not finished:
                # Shield cleanup from client cancellation; abandoned leases also expire in two minutes.
                await asyncio.shield(
                    asyncio.to_thread(quota.finish, user.id, reservation_id, False)
                )

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"X-Accel-Buffering": "no", "Cache-Control": "no-store"},
    )


@router.get("/menu-catalog")
def menu_catalog(user: User = Depends(require_member)):
    """Full categorized ii Reborn Menu feature list for the Catalog tab."""
    return structured_catalog()


@router.post("/catalog-explain")
async def catalog_explain(
    body: CatalogExplainBody, request: Request, user: User = Depends(require_member)
):
    """Pro-only informational explanation of one catalog mod (not a risk scan)."""
    require_pro(request)
    feature = lookup_catalog_feature(body.name)
    if feature is None:
        raise HTTPException(404, "That mod was not found in the menu catalog")
    provider = require_ai(request)
    quota = shared_ai_quota(request)
    reservation_id, reset = await asyncio.to_thread(quota.reserve, user.id)
    kind = "Action (fires once)" if feature.get("action") else "Toggle"
    prompt = (
        f"Selected mod: {feature['name']}\n"
        f"Category: {feature.get('category')}\n"
        f"Kind: {kind}\n"
        f"Catalog description: {feature.get('description') or '(none provided)'}\n\n"
        "Explain what this mod is and what it does. "
        "Do not give a risk factor or malware verdict.\n\n"
        f"End with this exact footnote line under **Footnote**:\n{CATALOG_EXPLAIN_FOOTNOTE}"
    )
    try:
        answer = await asyncio.wait_for(
            provider.complete(prompt, system=CATALOG_EXPLAIN_SYSTEM_PROMPT, max_tokens=900),
            timeout=45,
        )
        text = (answer or "").strip()[:6000]
        if CATALOG_EXPLAIN_FOOTNOTE.casefold() not in text.casefold():
            text = f"{text.rstrip()}\n\n**Footnote**\n{CATALOG_EXPLAIN_FOOTNOTE}"
        text = re.sub(
            r"(?i)\b(risk\s*score|final\s*verdict|inherently\s+malicious)\b",
            "informational note",
            text,
        )
        remaining = await asyncio.to_thread(quota.finish, user.id, reservation_id, True)
        if body.share_telemetry:
            publish_ai_exchange(
                request,
                user,
                source="catalog",
                prompt=str(feature["name"]),
                response=text[:8000],
            )
        return {
            "name": feature["name"],
            "category": feature.get("category"),
            "answer": text,
            "remaining": remaining,
            "reset_at": reset,
            "disclaimer": CATALOG_EXPLAIN_FOOTNOTE,
        }
    except (ProviderUnavailable, TimeoutError):
        await asyncio.to_thread(quota.finish, user.id, reservation_id, False)
        raise HTTPException(503, "Private AI is temporarily unavailable") from None


@router.post("/home-assistant")
async def home_assistant(
    body: HomeAssistBody, request: Request, user: User = Depends(require_member)
):
    """Home-tab helper grounded on the published ii Reborn Menu feature catalog."""
    provider = require_ai(request)
    question = body.message.strip()
    if not question:
        raise HTTPException(422, "Enter a question")
    quota = shared_ai_quota(request)
    reservation_id, reset = await asyncio.to_thread(quota.reserve, user.id)
    catalog = catalog_for_prompt(question, always=True)
    prompt = (
        f"User question:\n{question}\n\n"
        f"ii Reborn Menu feature catalog (authoritative):\n{catalog}\n"
    )
    try:
        answer = await asyncio.wait_for(
            provider.complete(prompt, system=HOME_ASSISTANT_SYSTEM, max_tokens=900),
            timeout=45,
        )
        remaining = await asyncio.to_thread(quota.finish, user.id, reservation_id, True)
        if body.share_telemetry:
            publish_ai_exchange(
                request, user, source="home", prompt=question, response=answer[:8000]
            )
        return {
            "answer": answer[:6000],
            "remaining": remaining,
            "reset_at": reset,
            "catalog_attached": True,
            "matched_features": min(36, catalog.count("\n") + 1 if catalog else 0),
        }
    except (ProviderUnavailable, TimeoutError):
        await asyncio.to_thread(quota.finish, user.id, reservation_id, False)
        raise HTTPException(503, "Private AI is temporarily unavailable") from None
    except Exception:
        await asyncio.to_thread(quota.finish, user.id, reservation_id, False)
        raise


# Scout (and legacy Assist) share this bucket — independent of Home/Studio/community AI.
TRACKER_SCOUT_DAILY_LIMIT = 25
TRACKER_SCOUT_BUCKET = "tracker_scout"
TRACKER_ASSIST_DAILY_LIMIT = TRACKER_SCOUT_DAILY_LIMIT


def tracker_scout_quota(request: Request) -> BucketQuota:
    """Scout/Assist daily bucket; uncapped members share the elevated AI hard ceiling."""
    limit = member_ai_daily_limit(request, default_limit=TRACKER_SCOUT_DAILY_LIMIT)
    return BucketQuota(
        request.app.state.engine,
        bucket=TRACKER_SCOUT_BUCKET,
        daily_limit=limit,
        hard_ceiling=_ai_hard_ceiling(request),
    )


def tracker_ai_model(request: Request) -> str:
    """SiliconFlow model id for Tracker Scout/Assist only."""
    settings = request.app.state.settings
    configured = str(getattr(settings, "ai_tracker_model", "") or "").strip()
    return configured or settings.ai_model
_SCOUT_CHAT_FALLBACK = "Hey — ask me about a player, room, or recent lobby."
_SCOUT_SEARCH_FALLBACK = (
    "Tell me a player name, ID, or room code and I’ll dig through recent sightings."
)
_SCOUT_EMPTY_HITS = (
    "Nobody matched that window in the retained lobby sightings. "
    "Try a player name, ID, room code, or a wider time."
)
# Fantasy fluff the small model invents when SEARCH_RESULTS are empty.
_SCOUT_HALLUCINATION_RE = re.compile(
    r"\b("
    r"arcane|mystic|mystical|enchanted|elven|nebula|crystal|quill|trials?|"
    r"shadow realm|fairy|phoenix|dragon|legendary cosmetic|mythic"
    r")\b",
    re.IGNORECASE,
)
_SCOUT_ROOMISH_RE = re.compile(r"\b([A-Z0-9]{2,12})\b")
_SCOUT_FENCE_RE = re.compile(r"```(?:json)?\s*|```", re.IGNORECASE)
_SCOUT_PLANISH_RE = re.compile(
    r'^\s*\{[\s\S]*"mode"\s*:\s*"(?:chat|search)"[\s\S]*\}\s*$',
    re.IGNORECASE,
)
_SCOUT_CHAT_ONLY_RE = re.compile(
    r"^(hi|hey|hello|yo|sup|thanks|thank you|thx|how are you|what can you do|"
    r"help|good morning|good night)[\s!?.]*$",
    re.IGNORECASE,
)
_SCOUT_SEARCHISH_RE = re.compile(
    r"\b(who|whom|where|when|find|track|looking|player|players|playing|online|"
    r"lobby|lobbies|room|seen|sight|was|were|ago|hour|hours|minute|minutes|"
    r"today|yesterday|recent|around|color|colour|fur|cosmetic|nick|username|id|"
    r"cool|interesting|ghost|troll|bait|toxic|blue|red|green|yellow|orange|"
    r"purple|pink|white|black|brown|cyan|someone|anybody|people)\b",
    re.IGNORECASE,
)
_SCOUT_LOOKBACK_RE = re.compile(
    r"\b(?:about|around|roughly)?\s*(\d{1,3}|an|a|one|two|three|few)\s+"
    r"(minute|minutes|min|mins|hour|hours|hr|hrs)\s+ago\b",
    re.IGNORECASE,
)
_SCOUT_WORD_NUM = {
    "an": 1,
    "a": 1,
    "one": 1,
    "two": 2,
    "three": 3,
    "few": 3,
}


def _iter_json_objects(text: str):
    """Yield brace-balanced JSON object strings (skips strings/escapes)."""
    depth = 0
    start = -1
    in_string = False
    escape = False
    for index, char in enumerate(text):
        if in_string:
            if escape:
                escape = False
            elif char == "\\":
                escape = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
            continue
        if char == "{":
            if depth == 0:
                start = index
            depth += 1
        elif char == "}" and depth:
            depth -= 1
            if depth == 0 and start >= 0:
                yield text[start : index + 1]
                start = -1


def _normalize_scout_field(raw: str) -> str:
    field = (raw or "any").strip().lower()
    if field in {"username", "player_id", "room", "color", "any", "recent"}:
        return field
    # Model sometimes echoes the schema enum literally.
    if "|" in field:
        for part in field.split("|"):
            part = part.strip().lower()
            if part in {"username", "player_id", "room", "color", "any", "recent"}:
                return part
    return "any"


def _parse_lookback_minutes(raw) -> int | None:
    if raw is None or str(raw).strip() == "":
        return None
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return None
    return max(10, min(5 * 24 * 60, value))


def _lookback_from_question(question: str) -> int | None:
    match = _SCOUT_LOOKBACK_RE.search(question or "")
    if not match:
        lowered = (question or "").lower()
        if re.search(r"\b(just now|right now|currently|online now|who's online|who is online)\b", lowered):
            return 45
        if re.search(r"\b(recent|recently|lately|who's around|who is around)\b", lowered):
            return 180
        return None
    amount_raw = match.group(1).lower()
    unit = match.group(2).lower()
    amount = _SCOUT_WORD_NUM.get(amount_raw)
    if amount is None:
        try:
            amount = int(amount_raw)
        except ValueError:
            amount = 1
    minutes = amount * (60 if unit.startswith("h") else 1)
    # Soft pad so "an hour ago" still catches sightings near that mark.
    return max(10, min(5 * 24 * 60, int(minutes * 1.25) + 15))


def _coerce_scout_plan(data) -> dict | None:
    if not isinstance(data, dict):
        return None
    mode = str(data.get("mode") or "").strip().lower()
    if mode == "chat":
        reply = _sanitize_scout_user_text(str(data.get("reply") or "").strip())
        return {
            "mode": "chat",
            "reply": reply[:1200] or _SCOUT_CHAT_FALLBACK,
        }
    if mode != "search":
        return None
    queries: list[dict] = []
    raw_queries = data.get("queries") if isinstance(data.get("queries"), list) else []
    for item in raw_queries[:6]:
        if not isinstance(item, dict):
            continue
        q = str(item.get("q") or item.get("query") or "").strip()
        field = _normalize_scout_field(str(item.get("field") or "any"))
        day = str(item.get("day") or "").strip()
        hour_raw = item.get("hour_utc", item.get("hour"))
        lookback = _parse_lookback_minutes(item.get("lookback_minutes", item.get("lookback")))
        has_time = bool(day) or hour_raw is not None or lookback is not None
        if field == "recent":
            field = "any"
            if lookback is None and not has_time:
                lookback = 180
            has_time = True
        # Allow empty q for time-window / recent browses.
        if len(q) < 2 and not has_time:
            continue
        entry: dict = {"field": field, "q": q[:64]}
        if day:
            entry["day"] = day[:16]
        if hour_raw is not None and str(hour_raw).strip() != "":
            try:
                entry["hour_utc"] = max(0, min(23, int(hour_raw)))
            except (TypeError, ValueError):
                pass
        if lookback is not None:
            entry["lookback_minutes"] = lookback
        queries.append(entry)
    if not queries:
        return {"mode": "chat", "reply": _SCOUT_SEARCH_FALLBACK}
    return {"mode": "search", "queries": queries}


_SCOUT_NAME_STOP = {
    "playing",
    "online",
    "around",
    "recent",
    "recently",
    "today",
    "yesterday",
    "anyone",
    "someone",
    "everybody",
    "blue",
    "red",
    "green",
    "yellow",
    "orange",
    "purple",
    "pink",
    "white",
    "black",
    "brown",
    "cyan",
    "cool",
    "ghost",
    "troll",
    "people",
    "players",
    "people",
    "players",
    "player",
    "was",
    "were",
    "is",
    "are",
    "the",
    "and",
    "for",
    "with",
    "from",
    "into",
    "about",
    "who",
    "whom",
    "where",
    "when",
    "what",
    "find",
    "track",
    "looking",
    "hour",
    "hours",
    "minute",
    "minutes",
    "ago",
    "lobby",
    "lobbies",
    "room",
    "last",
    "seen",
    "sight",
    "just",
    "now",
    "there",
}


def _infer_scout_search_plan(question: str) -> dict | None:
    """Force a useful search when the planner wrongly chats on a player-seeking ask."""
    from .scout_context import (
        extract_color_name,
        ghost_room_queries,
        wants_cool_online,
        wants_ghost_troll,
    )

    text = (question or "").strip()
    if not text or _SCOUT_CHAT_ONLY_RE.match(text):
        return None
    if not _SCOUT_SEARCHISH_RE.search(text):
        return None
    lookback = _lookback_from_question(text)

    if wants_ghost_troll(text):
        queries = ghost_room_queries(limit=8)
        for entry in queries:
            if lookback is not None:
                entry["lookback_minutes"] = lookback
        # Also include a recent browse so we can still answer if codes are quiet.
        queries.append(
            {"field": "any", "q": "", "lookback_minutes": lookback or 90},
        )
        return {"mode": "search", "queries": queries[:8]}

    color_name = extract_color_name(text)
    if color_name and re.search(r"\b(player|players|people|monke|monkey|fur|color|colour)\b", text, re.I):
        entry = {
            "field": "color",
            "q": color_name,
            "lookback_minutes": lookback or 180,
        }
        return {"mode": "search", "queries": [entry]}
    if color_name and re.search(rf"\b{re.escape(color_name)}\b", text, re.I) and not re.search(
        r"\b(named|called|username|nick)\b", text, re.I
    ):
        # "find me blue" / "any blue online" — treat as fur color, not username Blue.
        return {
            "mode": "search",
            "queries": [
                {"field": "color", "q": color_name, "lookback_minutes": lookback or 180},
            ],
        }

    if wants_cool_online(text):
        return {
            "mode": "search",
            "queries": [
                {"field": "any", "q": "", "lookback_minutes": lookback or 60},
            ],
        }

    room_match = re.search(
        r"(?:\broom(?:\s*code)?|lobby)\s*[\"']?([A-Za-z0-9]{2,8})[\"']?",
        text,
        re.IGNORECASE,
    )
    if room_match:
        entry: dict = {"field": "room", "q": room_match.group(1).upper()}
        if lookback is not None:
            entry["lookback_minutes"] = lookback
        return {"mode": "search", "queries": [entry]}
    name_match = re.search(r"[\"']([A-Za-z0-9 _.-]{2,32})[\"']", text)
    candidate = name_match.group(1).strip() if name_match else ""
    if not candidate:
        # "where is Volt" / "find FlowerScout" — not "who was playing".
        named = re.search(
            r"\b(?:find|track|where(?:'s| is)|is)\s+([A-Za-z][A-Za-z0-9_]{2,24})\b",
            text,
            re.IGNORECASE,
        )
        if named:
            candidate = named.group(1).strip()
    if candidate and candidate.lower() not in _SCOUT_NAME_STOP:
        if candidate.lower() in {
            "blue",
            "red",
            "green",
            "yellow",
            "orange",
            "purple",
            "pink",
            "white",
            "black",
            "brown",
            "cyan",
        }:
            return {
                "mode": "search",
                "queries": [
                    {
                        "field": "color",
                        "q": candidate.lower(),
                        "lookback_minutes": lookback or 180,
                    }
                ],
            }
        entry = {"field": "username", "q": candidate[:64]}
        if lookback is not None:
            entry["lookback_minutes"] = lookback
        return {"mode": "search", "queries": [entry]}
    return {
        "mode": "search",
        "queries": [
            {
                "field": "any",
                "q": "",
                "lookback_minutes": lookback or 180,
            }
        ],
    }


def _deterministic_scout_answer(players: list[dict], *, hits: int) -> str:
    if not players:
        return _SCOUT_EMPTY_HITS
    if len(players) == 1:
        player = players[0]
        room = str(player.get("room") or "").strip()
        seen = str(player.get("last_seen") or "").strip()
        bits = [str(player.get("username") or "Player")]
        if room:
            bits.append(f"last in {room}")
        if seen:
            bits.append(f"seen {seen} UTC")
        return " — ".join(bits) + "."
    names = [str(row.get("username") or "Player") for row in players[:8]]
    summary = ", ".join(names)
    extra = len(players) - len(names)
    if extra > 0:
        summary = f"{summary}, and {extra} more"
    return f"Recent players from indexed sightings ({hits} hits): {summary}."


def _empty_scout_answer(searches: list[dict] | None = None) -> str:
    """Honest empty-result copy — never invent alternate lobbies/cosmetics."""
    terms: list[str] = []
    for search in searches or []:
        term = str(search.get("q") or "").strip()
        if not term:
            continue
        field = str(search.get("field") or "any").strip().lower()
        if field == "room":
            terms.append(f"room {term}")
        elif field == "color":
            terms.append(f"{term} players")
        elif field == "player_id":
            terms.append(f"ID {term}")
        else:
            terms.append(term)
    if terms:
        focus = ", ".join(list(dict.fromkeys(terms))[:3])
        return (
            f"Nobody matched {focus} in the retained lobby sightings. "
            "Try another name, room code, color, or a wider time."
        )
    return _SCOUT_EMPTY_HITS


def _answer_looks_unhelpful(answer: str, *, has_hits: bool) -> bool:
    text = (answer or "").strip().lower()
    if len(text) < 8:
        return True
    if has_hits and re.search(
        r"only have (data|sightings|records).{0,40}(5 days|five days|last 5)",
        text,
    ):
        return True
    if has_hits and re.search(r"\b(no (data|information|sightings)|cannot help|can't help)\b", text):
        return True
    return False


def _answer_looks_ungrounded(answer: str, *, hits: list[dict], players: list[dict]) -> bool:
    """True when the model invents rooms/names/cosmetics absent from search results."""
    text = (answer or "").strip()
    if not text:
        return True
    if not hits:
        # Any concrete lobby claim on an empty result set is a hallucination.
        if _SCOUT_HALLUCINATION_RE.search(text):
            return True
        if re.search(
            r"\b(check out|try|you might want|busy lately|last sighting was)\b",
            text,
            re.IGNORECASE,
        ) and not re.search(r"\bnobody matched\b", text, re.IGNORECASE):
            return True
        return False

    known_rooms = {
        str(row.get("room") or "").strip().upper()
        for row in hits
        if str(row.get("room") or "").strip()
    }
    known_names = {
        str(row.get("username") or "").strip().lower()
        for row in players
        if str(row.get("username") or "").strip()
    }
    fact_blob = " ".join(
        f"{row.get('username') or ''} {row.get('room') or ''} {row.get('color') or ''}"
        for row in hits
    ).lower()
    if _SCOUT_HALLUCINATION_RE.search(text):
        for match in _SCOUT_HALLUCINATION_RE.finditer(text):
            if match.group(0).lower() not in fact_blob:
                return True
    # ALL-CAPS room-like tokens in the reply must exist in results.
    invented = 0
    for match in _SCOUT_ROOMISH_RE.finditer(text):
        token = match.group(1)
        if token in {"UTC", "ID", "EU", "NA", "AS", "OK", "HI", "AI"}:
            continue
        if len(token) < 3:
            continue
        if token.upper() not in known_rooms and token.lower() not in known_names:
            if re.search(r"\d", token) or token.isupper():
                invented += 1
    return invented >= 2


def _sanitize_scout_user_text(text: str) -> str:
    """Strip planner/answer JSON leaks so players never see raw tool output."""
    cleaned = (text or "").strip()
    if not cleaned:
        return ""
    cleaned = _SCOUT_FENCE_RE.sub(" ", cleaned).strip()
    cleaned = re.sub(r"\s{2,}", " ", cleaned)

    # Whole-blob chat plan → keep only the human reply.
    try:
        whole = json.loads(cleaned)
    except json.JSONDecodeError:
        whole = None
    if isinstance(whole, dict) and str(whole.get("mode") or "").lower() in {"chat", "search"}:
        if str(whole.get("mode") or "").lower() == "chat":
            reply = str(whole.get("reply") or "").strip()
            if reply and not reply.lstrip().startswith("{"):
                return reply[:4500]
        return ""

    pieces: list[str] = []
    cursor = 0
    for blob in _iter_json_objects(cleaned):
        start = cleaned.find(blob, cursor)
        if start < 0:
            break
        prefix = cleaned[cursor:start].strip()
        if prefix:
            pieces.append(prefix)
        try:
            parsed = json.loads(blob)
        except json.JSONDecodeError:
            pieces.append(blob)
        else:
            if isinstance(parsed, dict) and str(parsed.get("mode") or "").lower() in {
                "chat",
                "search",
            }:
                reply = str(parsed.get("reply") or "").strip()
                if reply and not reply.lstrip().startswith("{"):
                    pieces.append(reply)
            else:
                pieces.append(blob)
        cursor = start + len(blob)
    tail = cleaned[cursor:].strip()
    if tail:
        pieces.append(tail)
    out = " ".join(part for part in pieces if part).strip()
    out = re.sub(r"\s{2,}", " ", out)
    if not out or out.lstrip().startswith('{"mode"') or _SCOUT_PLANISH_RE.match(out):
        return ""
    return out[:4500]


def _parse_scout_plan(raw: str) -> dict:
    text = _SCOUT_FENCE_RE.sub(" ", (raw or "")).strip()
    if not text:
        return {"mode": "chat", "reply": _SCOUT_CHAT_FALLBACK}

    candidates: list[dict] = []
    try:
        whole = json.loads(text)
    except json.JSONDecodeError:
        whole = None
    if whole is not None:
        coerced = _coerce_scout_plan(whole)
        if coerced:
            candidates.append(coerced)

    for blob in _iter_json_objects(text):
        try:
            data = json.loads(blob)
        except json.JSONDecodeError:
            continue
        coerced = _coerce_scout_plan(data)
        if coerced:
            candidates.append(coerced)

    for plan in candidates:
        if plan.get("mode") == "search" and plan.get("queries"):
            return plan
    for plan in candidates:
        if plan.get("mode") == "chat":
            return plan

    # Plain prose (no JSON) can be a chat reply — never echo broken JSON.
    prose = _sanitize_scout_user_text(text)
    if prose and "{" not in prose:
        return {"mode": "chat", "reply": prose[:1200]}
    return {"mode": "chat", "reply": _SCOUT_CHAT_FALLBACK}


@router.post("/tracker-assist")
async def tracker_assist(
    body: TrackerAssistBody, request: Request, user: User = Depends(require_member)
):
    """Legacy digest Assist — prefer /tracker-scout for the dedicated Scout page."""
    if not _has_tracker_product_access(request):
        raise HTTPException(403, "ii Tracker access required for Tracker Assist.")
    provider = require_ai(request)
    question = body.message.strip()
    digest = body.digest.strip()
    if not question:
        raise HTTPException(422, "Enter a question")
    if not digest.startswith("TRACKER_DIGEST") and "nick|id|color" not in digest[:240]:
        raise HTTPException(422, "Sighting digest is missing or invalid")
    quota = tracker_scout_quota(request)
    reservation_id, reset = await asyncio.to_thread(quota.reserve, user.id)
    prompt = (
        f"User question:\n{question}\n\n"
        f"Authoritative public lobby sighting digest + optional watchlist "
        f"(do not invent beyond this):\n"
        f"{digest[:9000]}\n"
    )
    try:
        answer = await asyncio.wait_for(
            provider.complete(
                prompt,
                system=TRACKER_ASSIST_SYSTEM,
                max_tokens=900,
                model=tracker_ai_model(request),
                temperature=0.1,
            ),
            timeout=45,
        )
        remaining = await asyncio.to_thread(quota.finish, user.id, reservation_id, True)
        if body.share_telemetry:
            publish_ai_exchange(
                request, user, source="tracker", prompt=question, response=answer[:4000]
            )
        return {
            "answer": answer[:4500],
            "remaining": remaining,
            "reset_at": reset,
            "digest_chars": len(digest),
            "daily_limit": quota.daily_limit,
        }
    except (ProviderUnavailable, TimeoutError):
        await asyncio.to_thread(quota.finish, user.id, reservation_id, False)
        raise HTTPException(503, "Private AI is temporarily unavailable") from None
    except Exception:
        await asyncio.to_thread(quota.finish, user.id, reservation_id, False)
        raise


@router.post("/tracker-scout")
async def tracker_scout(
    body: TrackerScoutBody,
    request: Request,
    user: User = Depends(require_member),
    db: Session = Depends(database),
):
    """Tracker Scout: chat or search-backed answers over retained lobby sightings.

    Flow: planner decides chat vs search → optional DB lookups → answerer with only
    those hits. Avoids shipping the full sighting dump on every greeting.
    Requires ii Tracker (not Engine Pro alone). Daily Scout quota is independent
    of Home/Studio AI spend.
    """
    if not _has_tracker_product_access(request):
        raise HTTPException(403, "ii Tracker access required for Tracker Scout.")
    provider = require_ai(request)
    question = body.message.strip()
    if not question:
        raise HTTPException(422, "Enter a question")
    quota = tracker_scout_quota(request)
    reservation_id, reset = await asyncio.to_thread(quota.reserve, user.id)
    searches_run: list[dict] = []
    now_utc = datetime.now(UTC)
    try:
        tracker_model = tracker_ai_model(request)
        plan_raw = await asyncio.wait_for(
            provider.complete(
                f"User message:\n{question}\n\nNow UTC: {now_utc.isoformat()}\n",
                system=TRACKER_SCOUT_PLANNER_SYSTEM,
                max_tokens=320,
                model=tracker_model,
                temperature=0.1,
            ),
            timeout=30,
        )
        plan = _parse_scout_plan(plan_raw)
        inferred_first = _infer_scout_search_plan(question)
        if plan.get("mode") == "search" and inferred_first:
            planned_fields = {
                str(item.get("field") or "") for item in (plan.get("queries") or []) if isinstance(item, dict)
            }
            inferred_fields = {
                str(item.get("field") or "")
                for item in (inferred_first.get("queries") or [])
                if isinstance(item, dict)
            }
            if "color" in inferred_fields and "color" not in planned_fields:
                plan = inferred_first
            elif any(str(item.get("field")) == "room" for item in (inferred_first.get("queries") or [])) and len(
                inferred_first.get("queries") or []
            ) > len(plan.get("queries") or []):
                # Ghost/troll expansion packs more room codes than the model usually emits.
                from .scout_context import wants_ghost_troll

                if wants_ghost_troll(question):
                    plan = inferred_first
        if plan.get("mode") == "chat":
            inferred = inferred_first or _infer_scout_search_plan(question)
            if inferred:
                plan = inferred
            else:
                answer = (
                    _sanitize_scout_user_text(str(plan.get("reply") or "")) or _SCOUT_CHAT_FALLBACK
                )
                remaining = await asyncio.to_thread(quota.finish, user.id, reservation_id, True)
                if body.share_telemetry:
                    publish_ai_exchange(
                        request,
                        user,
                        source="tracker_scout",
                        prompt=question,
                        response=answer[:4000],
                    )
                return {
                    "answer": answer[:4500],
                    "remaining": remaining,
                    "reset_at": reset,
                    "mode": "chat",
                    "searches": [],
                    "players": [],
                    "daily_limit": quota.daily_limit,
                }

        hits: list[dict] = []
        seen_ids: set[str] = set()
        for query in plan.get("queries") or []:
            field = str(query.get("field") or "any")
            term = str(query.get("q") or "")
            lookback = query.get("lookback_minutes")
            if lookback is None and not term and not query.get("day") and query.get("hour_utc") is None:
                lookback = _lookback_from_question(question) or 180
            since, until = resolve_scout_time_window(
                day=str(query.get("day") or "") or None,
                hour_utc=query.get("hour_utc"),
                lookback_minutes=lookback,
                now=now_utc,
            )
            rows = await asyncio.to_thread(
                search_sightings,
                db,
                query=term,
                field=field,
                since=since,
                until=until,
                limit=60,
            )
            searches_run.append(
                {
                    "field": field,
                    "q": term,
                    "hits": len(rows),
                    "day": query.get("day"),
                    "hour_utc": query.get("hour_utc"),
                    "lookback_minutes": lookback,
                }
            )
            for row in rows:
                row_id = str(row.get("id") or "")
                if row_id and row_id in seen_ids:
                    continue
                if row_id:
                    seen_ids.add(row_id)
                hits.append(row)
                if len(hits) >= 80:
                    break
            if len(hits) >= 80:
                break

        players = rollup_scout_players(hits, limit=24)
        # Empty search → never ask the model to "be helpful"; it invents lobbies.
        if not hits:
            answer = _empty_scout_answer(searches_run)
        else:
            facts = format_sightings_for_scout(hits)
            card_lines = [
                f"- {row.get('username')}|{row.get('player_id')}|{row.get('room')}|"
                f"{row.get('color')}|{row.get('last_seen')}|x{row.get('sightings')}"
                for row in players[:16]
            ]
            cards_block = "\n".join(card_lines) if card_lines else "(none)"
            answer_raw = await asyncio.wait_for(
                provider.complete(
                    (
                        f"User question:\n{question}\n\n"
                        f"SEARCH_RESULTS ({len(hits)} rows):\n{facts}\n\n"
                        f"PLAYER_CARDS ({len(players)}):\n{cards_block}\n"
                    ),
                    system=TRACKER_SCOUT_ANSWER_SYSTEM,
                    max_tokens=900,
                    model=tracker_model,
                    temperature=0.1,
                ),
                timeout=45,
            )
            answer = _sanitize_scout_user_text(answer_raw)
            if (
                _answer_looks_unhelpful(answer, has_hits=True)
                or _answer_looks_ungrounded(answer, hits=hits, players=players)
            ):
                answer = _deterministic_scout_answer(players, hits=len(hits))
        card_players = players if players else []
        remaining = await asyncio.to_thread(quota.finish, user.id, reservation_id, True)
        if body.share_telemetry:
            publish_ai_exchange(
                request, user, source="tracker_scout", prompt=question, response=answer[:4000]
            )
        return {
            "answer": answer[:4500],
            "remaining": remaining,
            "reset_at": reset,
            "mode": "search",
            "searches": searches_run,
            "hit_count": len(hits),
            "players": card_players,
            "daily_limit": quota.daily_limit,
        }
    except (ProviderUnavailable, TimeoutError):
        await asyncio.to_thread(quota.finish, user.id, reservation_id, False)
        raise HTTPException(503, "Private AI is temporarily unavailable") from None
    except Exception:
        await asyncio.to_thread(quota.finish, user.id, reservation_id, False)
        raise


@router.post("/autocomplete")
async def autocomplete(
    body: AutocompleteBody, request: Request, user: User = Depends(require_member)
):
    """Short code completion. Shares the daily AI budget to prevent abuse."""
    provider = require_ai(request)
    prefix = body.prefix.strip()
    if len(prefix) < 8:
        raise HTTPException(422, "Need more context for autocomplete")
    # Cheap path: tiny context + low max_tokens so ghost-text stays affordable.
    quota = shared_ai_quota(request)
    reservation_id, reset = await asyncio.to_thread(quota.reserve, user.id)
    try:
        prompt = (
            f"Complete the next 1-3 lines of {body.language} code. "
            "Return ONLY the completion text to append — no markdown fences, no explanation.\n\n"
            f"```{body.language}\n{prefix[-1200:]}\n```"
        )
        text = await asyncio.wait_for(
            provider.complete(
                prompt,
                system="You are a terse C# / BepInEx coding assistant. Output completion text only.",
                max_tokens=64,
            ),
            timeout=12,
        )
        text = re.sub(r"^```(?:\w+)?\n?", "", text.strip())
        text = re.sub(r"\n?```$", "", text).strip()
        remaining = await asyncio.to_thread(quota.finish, user.id, reservation_id, True)
        if getattr(body, "share_telemetry", False):
            publish_ai_exchange(
                request,
                user,
                source="autocomplete",
                prompt=prefix[-1200:],
                response=text[:400],
            )
        return {"completion": text[:400], "remaining": remaining, "reset_at": reset}
    except (ProviderUnavailable, TimeoutError):
        await asyncio.to_thread(quota.finish, user.id, reservation_id, False)
        raise HTTPException(503, "Private AI is temporarily unavailable") from None
    except Exception:
        await asyncio.to_thread(quota.finish, user.id, reservation_id, False)
        raise


@router.post("/mod-check")
async def mod_check(body: ModCheckBody, request: Request, user: User = Depends(require_member)):
    """Analyze extracted DLL strings. Not a substitute for human review."""
    provider = require_ai(request)
    if not re.fullmatch(r"[a-f0-9]{64}", body.sha256.lower()):
        raise HTTPException(422, "Invalid file hash")
    filename = body.filename.strip()
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._ -]{0,170}\.dll", filename, re.IGNORECASE):
        raise HTTPException(422, "Upload a DLL with a safe filename")
    # Heavy endpoint shares the same daily budget so abuse stays capped.
    quota = shared_ai_quota(request)
    reservation_id, reset = await asyncio.to_thread(quota.reserve, user.id)
    digest = hashlib.sha256(body.strings.encode("utf-8", errors="ignore")).hexdigest()[:16]
    hay = f"{filename}\n{body.strings[:8000]}".casefold()
    is_stupid_menu = bool(
        re.search(
            r"iis?\.?s(?:tupid)?\.?\s*menu|iisstupidmenu|stupid\s*menu|ii\.s\.stupid\.menu",
            hay,
        )
    )
    prompt = (
        f"Filename: {filename}\n"
        f"SHA256: {body.sha256.lower()}\n"
        f"Strings fingerprint: {digest}\n"
        + (
            "NOTE: This sample matches ii Reborn Menu (first-party / official). "
            "Risk Score MUST be 0–10 and Final Verdict MUST be Safe.\n\n"
            if is_stupid_menu
            else "\n"
        )
        + f"Extracted printable strings / metadata (truncated):\n{body.strings[:22000]}"
    )
    try:
        report = await asyncio.wait_for(
            provider.complete(prompt, system=MOD_CHECK_SYSTEM_PROMPT, max_tokens=1400),
            timeout=55,
        )
        if is_stupid_menu:
            report = _force_stupid_menu_safe(report)
        remaining = await asyncio.to_thread(quota.finish, user.id, reservation_id, True)
        if getattr(body, "share_telemetry", False):
            publish_ai_exchange(
                request, user, source="mod_check", prompt=prompt[:6000], response=report[:8000]
            )
        return {
            "report": report[:8000],
            "remaining": remaining,
            "reset_at": reset,
            "disclaimer": (
                "AI mod checks are advisory only. They miss obfuscated threats, "
                "false-positive, and are not a security guarantee. Do not rely on this alone."
            ),
        }
    except (ProviderUnavailable, TimeoutError):
        await asyncio.to_thread(quota.finish, user.id, reservation_id, False)
        raise HTTPException(503, "Private AI is temporarily unavailable") from None
    except Exception:
        await asyncio.to_thread(quota.finish, user.id, reservation_id, False)
        raise


def _force_stupid_menu_safe(report: str) -> str:
    """Clamp model output so first-party ii Reborn Menu cannot be labeled Suspicious."""
    text = report or ""
    text = re.sub(
        r"(?im)^(\*\*Risk Score\*\*\s*\n)\s*\d{1,3}/100.*$",
        r"\g<1>8/100 (ii Reborn Menu — first-party; malware risk only)",
        text,
        count=1,
    )
    text = re.sub(
        r"(?im)^(\*\*Final Verdict\*\*\s*\n)\s*(Suspicious|Dangerous|Malicious|Low risk).*$",
        r"\g<1>Safe\nOfficial ii Reborn Menu — expected Gorilla Tag cheat menu, not PC malware.",
        text,
        count=1,
    )
    if "Final Verdict" not in text:
        text = (
            text.rstrip()
            + "\n\n**Risk Score**\n8/100 (ii Reborn Menu — first-party)\n"
            + "**Final Verdict**\nSafe\nOfficial ii Reborn Menu."
        )
    return text


STUDIO_ACTIONS = {
    "explain": (
        "Explain what this code does in plain language. Be concise (under 120 words).",
        280,
    ),
    "summarize": (
        "Summarize this code in 2-4 short bullets. No preamble.",
        220,
    ),
    "fix": (
        (
            "Fix bugs or obvious issues in this code. Return ONLY the corrected code — "
            "no markdown fences, no explanation."
        ),
        500,
    ),
    "change": (
        (
            "Rewrite the code following the user instruction. Return ONLY the new code — "
            "no markdown fences, no explanation."
        ),
        500,
    ),
}


@router.post("/studio-action")
async def studio_action(
    body: StudioActionBody, request: Request, user: User = Depends(require_member)
):
    """Selection actions from Studio (explain / summarize / fix / change)."""
    action = body.action.strip().lower()
    if action not in STUDIO_ACTIONS:
        raise HTTPException(422, "Unknown studio action")
    selection = body.selection.strip()
    if not selection:
        raise HTTPException(422, "Select some code first")
    instruction = body.instruction.strip()
    if action == "change" and not instruction:
        raise HTTPException(422, "Describe the change you want")
    provider = require_ai(request)
    quota = shared_ai_quota(request)
    reservation_id, reset = await asyncio.to_thread(quota.reserve, user.id)
    guide, max_tokens = STUDIO_ACTIONS[action]
    prompt = (
        f"{guide}\nLanguage: {body.language}\n"
        + (f"Instruction: {instruction}\n" if instruction else "")
        + f"\n```{body.language}\n{selection[:5000]}\n```"
    )
    try:
        text = await asyncio.wait_for(
            provider.complete(
                prompt,
                system=STUDIO_SYSTEM,
                max_tokens=max_tokens,
            ),
            timeout=30,
        )
        if action in {"fix", "change"}:
            text = re.sub(r"^```(?:\w+)?\n?", "", text.strip())
            text = re.sub(r"\n?```$", "", text).strip()
        remaining = await asyncio.to_thread(quota.finish, user.id, reservation_id, True)
        if body.share_telemetry:
            publish_ai_exchange(
                request,
                user,
                source=f"studio_{action}",
                prompt=prompt[:4000],
                response=text[:4000],
            )
        return {
            "action": action,
            "result": text[:4000],
            "remaining": remaining,
            "reset_at": reset,
        }
    except (ProviderUnavailable, TimeoutError):
        await asyncio.to_thread(quota.finish, user.id, reservation_id, False)
        raise HTTPException(503, "Private AI is temporarily unavailable") from None
    except Exception:
        await asyncio.to_thread(quota.finish, user.id, reservation_id, False)
        raise
