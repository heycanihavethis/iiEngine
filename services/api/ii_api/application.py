import asyncio
import json
import logging
import uuid
from contextlib import asynccontextmanager
from ipaddress import ip_address

from fastapi import FastAPI, Response
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import create_engine, text
from sqlalchemy.exc import SQLAlchemyError

from .ai import AIProvider
from .ai import router as ai_router
from .auth import revoke_sessions_for_oauth_scope_upgrade
from .auth import router as auth_router
from .community import Announcements
from .community import router as community_router
from .config import Settings
from .developer import router as developer_router
from .discord import DiscordREST
from .invites import router as invites_router
from .limits import RequestLimits
from .maintenance import cleanup_records
from .menu_bridge import router as menu_bridge_router
from .presets import router as presets_router
from .releases import Releases
from .releases import router as releases_router
from .roblox_billing import router as roblox_billing_router
from .mod_votes import router as mod_votes_router
from .telemetry import post_hourly_rollup
from .telemetry import router as telemetry_router
from .tracker import router as tracker_router


def create_app(settings: Settings | None = None, discord=None, ai_provider=None, releases=None):
    settings = settings or Settings()

    @asynccontextmanager
    async def lifespan(app):
        url = settings.database_url.get_secret_value()
        app.state.engine = create_engine(url, pool_pre_ping=True) if url else None
        app.state.discord = discord or DiscordREST(settings)
        app.state.releases = releases or Releases()
        app.state.ai_provider = ai_provider or AIProvider(settings)
        app.state.announcements = Announcements(settings, app.state.discord, app.state.engine)
        if app.state.engine and settings.app_env != "test":
            try:
                revoked = await asyncio.to_thread(
                    revoke_sessions_for_oauth_scope_upgrade, app.state.engine
                )
                if revoked:
                    logging.getLogger("ii_api").info(
                        "oauth_scope_reauth revoked_refresh_sessions=%s", revoked
                    )
            except Exception:
                logging.getLogger("ii_api").exception("oauth_scope_reauth failed")
        stop_maintenance = asyncio.Event()

        async def maintenance_loop():
            while not stop_maintenance.is_set():
                try:
                    if app.state.engine:
                        await asyncio.to_thread(
                            cleanup_records,
                            app.state.engine,
                            settings,
                            discord=app.state.discord,
                        )
                except Exception:
                    logging.getLogger("ii_api").exception("retention_cleanup failed")
                try:
                    await asyncio.wait_for(stop_maintenance.wait(), timeout=24 * 60 * 60)
                except TimeoutError:
                    pass

        stop_hourly = asyncio.Event()

        async def hourly_telemetry_loop():
            # Align roughly to the top of the next hour, then every 3600s.
            while not stop_hourly.is_set():
                from datetime import UTC, datetime, timedelta

                wall = datetime.now(UTC)
                nxt = wall.replace(minute=0, second=5, microsecond=0) + timedelta(hours=1)
                delay = max(30.0, (nxt - wall).total_seconds())
                try:
                    await asyncio.wait_for(stop_hourly.wait(), timeout=delay)
                    break
                except TimeoutError:
                    pass
                try:
                    if app.state.engine:
                        await asyncio.to_thread(post_hourly_rollup, app)
                except Exception:
                    logging.getLogger("ii_api").exception("hourly_telemetry_rollup failed")

        maintenance_task = (
            asyncio.create_task(maintenance_loop()) if settings.app_env == "production" else None
        )
        hourly_task = (
            asyncio.create_task(hourly_telemetry_loop())
            if settings.app_env in {"production", "development"}
            else None
        )
        yield
        stop_maintenance.set()
        stop_hourly.set()
        if maintenance_task:
            await maintenance_task
        if hourly_task:
            await hourly_task
        await app.state.ai_provider.close()
        app.state.releases.close()
        app.state.discord.close()
        if app.state.engine:
            app.state.engine.dispose()

    app = FastAPI(title="ii Engine API", version="0.2.2", lifespan=lifespan)
    app.state.settings = settings
    app.state.request_limits = RequestLimits()

    @app.exception_handler(RequestValidationError)
    async def invalid_request(request, error):
        # Pydantic's default response echoes the invalid input, including chat or tokens.
        return JSONResponse(status_code=422, content={"detail": "Invalid request fields"})

    app.include_router(auth_router)
    app.include_router(community_router)
    app.include_router(ai_router)
    app.include_router(invites_router)
    app.include_router(menu_bridge_router)
    app.include_router(presets_router)
    app.include_router(releases_router)
    app.include_router(developer_router)
    app.include_router(telemetry_router)
    app.include_router(mod_votes_router)
    app.include_router(tracker_router)
    app.include_router(roblox_billing_router)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[settings.frontend_origin],
        allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
        allow_headers=[
            "Authorization",
            "Content-Type",
            "X-Developer-Token",
            "X-Thumbnail-Base64",
            "X-Thumbnail-Size",
            "X-Roblox-Webhook-Secret",
            "X-Tracker-Session",
        ],
    )

    @app.middleware("http")
    async def request_id(request, call_next):
        rid = str(uuid.uuid4())
        client = request.client.host if request.client else "unknown"
        # Railway terminates public TLS and supplies the original client in X-Real-IP.
        # Use it only in the production deployment; local/test callers cannot select buckets.
        if settings.app_env == "production":
            forwarded = request.headers.get("x-real-ip", "")
            try:
                client = str(ip_address(forwarded))
            except ValueError:
                pass
        retry = app.state.request_limits.check(client, request.url.path)
        if retry:
            response = JSONResponse(
                status_code=429,
                content={"detail": "Too many requests; try again shortly"},
                headers={"Retry-After": str(retry)},
            )
            if request.headers.get("origin") == settings.frontend_origin:
                response.headers["Access-Control-Allow-Origin"] = settings.frontend_origin
                response.headers["Vary"] = "Origin"
        else:
            response = await call_next(request)
        response.headers["X-Request-ID"] = rid
        response.headers["Cache-Control"] = "no-store"
        # Never include query strings, headers, paths, request/response bodies or identities.
        logging.getLogger("ii_api").info(
            json.dumps({"request_id": rid, "status": response.status_code})
        )
        return response

    @app.get("/health/live")
    def live():
        return {"status": "ok", "version": "0.2.2"}

    @app.get("/health/ready")
    def ready(response: Response):
        try:
            if app.state.engine is None:
                raise RuntimeError("Database not configured")
            with app.state.engine.connect() as connection:
                revision = connection.scalar(
                    text("SELECT version_num FROM alembic_version LIMIT 1")
                )
                if revision != "0028_purge_device_identifier_telemetry":
                    raise RuntimeError("Database migration does not match this application")
            return {"status": "ready"}
        except (SQLAlchemyError, RuntimeError):
            response.status_code = 503
            return {"status": "unavailable", "component": "database"}

    return app
