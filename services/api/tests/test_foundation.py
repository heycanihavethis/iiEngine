import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlalchemy import create_engine, inspect

from ii_api.config import Settings
from ii_api.main import create_app
from ii_api.models import Base


def test_liveness_and_unconfigured_readiness():
    # CI intentionally exports DATABASE_URL for migration tests; this case must explicitly
    # exercise the unconfigured service rather than inherit that process variable.
    with TestClient(create_app(Settings(_env_file=None, database_url=""))) as client:
        assert client.get("/health/live").json()["status"] == "ok"
        response = client.get("/health/ready")
        assert response.status_code == 503
        assert response.headers["x-request-id"]


def test_schema_constraints():
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    assert set(inspect(engine).get_table_names()) == {
        "users",
        "auth_requests",
        "refresh_sessions",
        "role_grants",
        "ai_usage_daily",
        "announcement_cache",
        "audit_events",
        "ai_reservations",
        "developer_access",
        "managed_content",
        "platform_settings",
        "release_candidates",
        "trusted_mods",
        "studio_templates",
        "community_messages",
        "community_mods",
        "feature_usage_events",
        "creator_applications",
        "invite_campaigns",
        "invite_redemptions",
        "pro_trials",
        "tracker_presences",
        "tracker_sightings",
        "ai_bucket_usage",
        "ai_bucket_reservations",
        "appearance_preset_shares",
        "background_tracks",
        "roblox_gamepass_claims",
        "mod_votes",
    }
    assert inspect(engine).get_check_constraints("ai_usage_daily")


def test_production_refuses_missing_secrets():
    with pytest.raises(ValidationError, match="Production requires"):
        Settings(app_env="production", _env_file=None)


def test_production_requires_matching_origin_callback_and_independent_keys():
    import secrets

    config = {
        "app_env": "production",
        "_env_file": None,
        "database_url": "postgresql+psycopg://engine@db.invalid/engine",
        "discord_bot_token": secrets.token_urlsafe(32),
        "discord_client_secret": secrets.token_urlsafe(32),
        "access_token_signing_key": secrets.token_urlsafe(48),
        "refresh_token_pepper": secrets.token_urlsafe(48),
        "backend_public_url": "https://engine.example.invalid",
        "discord_oauth_redirect_uri": "https://engine.example.invalid/v1/auth/discord/callback",
    }
    assert Settings(**config).app_env == "production"
    for override in (
        {"discord_oauth_redirect_uri": "https://wrong.invalid/callback"},
        {"access_token_signing_key": "short"},
        {"refresh_token_pepper": config["access_token_signing_key"]},
        {"backend_public_url": "https://user:password@example.invalid"},
    ):
        with pytest.raises(ValidationError):
            Settings(**{**config, **override})
