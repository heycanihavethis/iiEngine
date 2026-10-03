"""Explicit local demo entrypoint. Excluded from the production container/package."""

import asyncio
import json
import re
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from ii_api.auth import require_member
from ii_api.config import Settings
from ii_api.developer import router as developer_router
from ii_api.models import Base, User


class DemoReleases:
    """Offline release metadata for the isolated desktop demo."""

    def get(self):
        return {
            "version": "1.0.5",
            "channel": "stable",
            "signature": "GitHub release digest",
            "published_at": "2026-09-26T06:40:23+00:00",
            "sha256": "a" * 64,
            "byte_size": 3_256_832,
            "download_url": (
                "https://github.com/iireborn/menu/releases/latest/download/ii.Reborn.dll"
            ),
            "release_url": "https://github.com/iireborn/menu/releases/tag/1.0.5",
            "canonical_filename": "ii.Reborn.dll",
            "baseline_id": "bepinex-5.4.23.5-win-x64",
        }


@asynccontextmanager
async def lifespan(app):
    work = Path(__file__).resolve().parents[2] / "work" / "developer-access"
    work.mkdir(parents=True, exist_ok=True)
    configs = sorted(work.glob("developer-config-*.json"))
    private = json.loads(configs[-1].read_text()) if configs else {}
    app.state.settings = Settings(
        _env_file=None, app_env="test", developer_publish_enabled=True, **private
    )
    app.state.releases = DemoReleases()
    app.state.engine = create_engine("sqlite:///" + str(work / "sandbox.db"))
    Base.metadata.create_all(app.state.engine)
    with Session(app.state.engine) as db:
        if not db.get(User, "local-demo-developer"):
            db.add(
                User(
                    id="local-demo-developer",
                    discord_id="local-demo",
                    display_name="Local developer",
                )
            )
            db.commit()
    yield
    app.state.engine.dispose()


app = FastAPI(title="ii Engine LOCAL DEMO — synthetic data", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:1420", "http://localhost:1420"],
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=[
        "Content-Type",
        "X-Developer-Token",
        "Authorization",
        "X-Thumbnail-Base64",
        "X-Thumbnail-Size",
    ],
)


def local_developer(request: Request):
    # This entrypoint is excluded from production; never bind it to a public interface.
    if request.client and request.client.host not in ("127.0.0.1", "::1", "testclient"):
        raise HTTPException(403, "Local demo only")
    request.state.member = {
        "membership": True,
        "entitlements": ["developer", "pro", "admin"],
    }
    request.state.session_id = "local-demo-only"
    return User(id="local-demo-developer", discord_id="local-demo", display_name="Local developer")


app.dependency_overrides[require_member] = local_developer
app.include_router(developer_router)

from ii_api.presets import router as presets_router

app.include_router(presets_router)

FIXTURE = Path(__file__).resolve().parents[2] / "fixtures/demo/dashboard.json"


@app.get("/v1/dashboard")
def dashboard(scenario: str = Query("member", pattern="^(member|nonmember|offline)$")):
    payload = json.loads(FIXTURE.read_text(encoding="utf-8"))
    if scenario == "nonmember":
        payload["member"].update(membership=False, roles=[], entitlements=[])
    return payload


@app.get("/health/live")
def live():
    return {"status": "ok", "mode": "demo"}


class DemoQuestion(BaseModel):
    message: str = Field(min_length=1, max_length=2000)


@app.post("/v1/ai/chat")
def demo_chat(body: DemoQuestion):
    from ii_api.menu_features import catalog_for_prompt

    question = body.message.strip()
    catalog = catalog_for_prompt(question, always=True)
    staffish = bool(
        re.search(r"(?i)\b(staff|owner|admin|dev|moderator|king|drifted|useless|doggo|lucy|tag)\b", question)
    )
    enginish = bool(re.search(r"(?i)\b(engine|plans?|pro|tracker|soundlab|studio)\b", question))

    async def stream():
        if staffish:
            pieces = [
                "Staff roster: King (Owner), Drifted (Head Admin — built ii Engine), ",
                "Useless (Head Dev), Tag and Lucy (Devs), Doggo (Moderator).",
            ]
        elif enginish:
            pieces = [
                "ii Engine is the Windows app for Gorilla Tag + ii Reborn Menu. ",
                "Pro unlocks AI, SoundLab, Tracker share, Customize, and more. ",
                "Plans: $7/mo, $14 lifetime, $25 lifetime + Tracker pack, or 2500 Robux.",
            ]
        else:
            pieces = [
                "From the live ii Reborn Menu catalog: try ",
                "**Platforms**, **Fly [A]**, **Iron Man**, **Speed Boost**, and **Frozone**. ",
                "Browse Movement / Visual / Fun tabs in-menu for the full list — ",
                f"the catalog indexes {catalog.count(chr(10)) + 1} feature lines.",
            ]
        for piece in pieces:
            yield f"event: token\ndata: {json.dumps({'text': piece})}\n\n"
            await asyncio.sleep(0.08)
        yield 'event: done\ndata: {"remaining": 9, "reset_at": null}\n\n'

    return StreamingResponse(stream(), media_type="text/event-stream")


@app.post("/v1/ai/home-assistant")
def demo_home_assistant(body: DemoQuestion):
    from ii_api.menu_features import catalog_for_prompt

    question = body.message.strip()
    catalog = catalog_for_prompt(question, always=True)
    if re.search(r"(?i)\b(staff|owner|admin|dev|moderator|king|drifted|useless|doggo)\b", question):
        answer = (
            "King is Owner. Drifted is Head Admin and built ii Engine. Useless is Head Dev. "
            "Tag and Lucy are Devs. Doggo is Moderator."
        )
    elif re.search(r"(?i)\b(engine|plans?|pro|tracker|soundlab)\b", question):
        answer = (
            "ii Engine launches Gorilla Tag with ii Reborn Menu. Engine Pro adds AI, SoundLab, "
            "Tracker presence sharing, Customize, Studio Pro, and Discord Perks. "
            "Buy via card on iistupid.com or 2500 Robux lifetime in Plans."
        )
    else:
        answer = (
            "From the live ii Reborn Menu catalog, popular picks include Platforms, Fly [A], "
            "Iron Man, Speed Boost, Ghost [A], Infection Box ESP, and Frozone. "
            "Open Movement Mods, Visual Mods, or Fun Mods from Main for more — "
            "I only suggest titles that appear in the published feature list."
        )
    return {
        "answer": answer,
        "remaining": 9,
        "reset_at": None,
        "catalog_attached": True,
        "matched_features": min(36, catalog.count("\n") + 1 if catalog else 0),
    }
