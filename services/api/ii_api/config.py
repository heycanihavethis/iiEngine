from typing import Literal
from urllib.parse import urlsplit

from pydantic import SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")
    app_env: Literal["development", "test", "production"] = "development"
    backend_public_url: str = "http://127.0.0.1:8000"
    frontend_origin: str = "http://localhost:1420"
    database_url: SecretStr = SecretStr("")
    discord_client_id: str = "1541246974404198470"
    discord_client_secret: SecretStr = SecretStr("")
    discord_bot_token: SecretStr = SecretStr("")
    discord_guild_id: str = "1170093288557129748"
    discord_engine_user_role_id: str = "1548883777462206625"
    discord_owner_role_ids: str = ""
    # Engine Admin unlocks developer tools and chat moderation.
    discord_admin_role_ids: str = "1551668789668618343"
    discord_developer_role_ids: str = "1551668789668618343"
    # Uncapped Discord role — elevated daily AI / telemetry allowances (hard-capped).
    discord_uncapped_role_ids: str = "1555606816291954819"
    discord_beta_role_ids: str = "1549421049287020568"
    discord_full_access_role_ids: str = "1549986950793007215"
    # Comma-separated Discord role IDs that unlock ii Engine Pro ($7/mo perks).
    discord_pro_role_ids: str = "1551472794238320680"
    # Paywall role for the ii Tracker Discord feed inside Engine.
    discord_ii_tracker_role_ids: str = "1549151900073459752"
    # Beta tester role — live rare-cosmetics feed access in Engine.
    discord_ii_tracker_beta_role_ids: str = "1554650259152576513"
    # Partner tracker Discord feed (bot posts here; Engine bot needs View + Read History).
    discord_tracker_guild_id: str = "1538948955679752344"
    # Rare cosmetic alerts channel.
    discord_tracker_channel_id: str = "1552132392016420874"
    # Full-server / regular player room-sync channel (split into per-player pills).
    discord_tracker_players_channel_id: str = "1540889169642000505"
    # When false, even beta cannot pull Discord rows (emergency kill switch).
    tracker_feed_enabled: bool = True
    discord_cone_killer_role_id: str = "1550271602720247959"
    # Trusted Mod Creators publish into the verified Trusted catalog.
    discord_trusted_creator_role_id: str = "1538315600768540793"
    # Community Mod Access (granted after approved creator form) posts into Community mods.
    discord_community_creator_role_id: str = "1551029796190953562"
    # Comma-separated Discord role IDs for Jr Mods / Moderators who can delete others' chat.
    discord_moderator_role_ids: str = ""
    # Lifetime Engine Pro Roblox catalog item (classic T-shirt, 2,500 Robux).
    roblox_catalog_asset_id: str = "93620103303755"
    roblox_catalog_url: str = "https://www.roblox.com/catalog/93620103303755/ii-Engine-Pro-Lifetime"
    # Tracker + Engine Pro Roblox catalog bundle (3,250 Robux).
    roblox_bundle_catalog_asset_id: str = "112921567316975"
    roblox_bundle_catalog_url: str = (
        "https://www.roblox.com/catalog/112921567316975/ii-Engine-Pro-ii-Tracker"
    )
    # Weekend sale bundle (2,700 Robux) — Fri 4 PM to Sun midnight ET.
    roblox_weekend_bundle_catalog_asset_id: str = "140291726071649"
    roblox_weekend_bundle_catalog_url: str = (
        "https://www.roblox.com/catalog/140291726071649/ii-Engine-Pro-ii-Tracker-Weekend"
    )
    # Legacy aliases (older deploys); catalog fields take priority.
    roblox_gamepass_id: str = ""
    roblox_gamepass_url: str = ""
    roblox_open_cloud_api_key: SecretStr = SecretStr("")
    roblox_webhook_secret: SecretStr = SecretStr("")
    discord_telemetry_channel_id: str = "1551024892965814372"
    # Hourly Engine rollups (active users / features / sales) — separate from session dumps.
    discord_telemetry_hourly_channel_id: str = "1554599230083965069"
    # Private sales feed (admins + ii bot). Counted into the hourly rollup when readable.
    discord_sales_channel_id: str = "1552761810523000842"
    discord_announcement_channel_ids: str = "1537550313546981507,1548782443715240017"
    discord_update_channel_id: str = "1547774251963256893"
    discord_app_update_channel_id: str = "1548890452328194188"
    discord_oauth_redirect_uri: str = ""
    # Space-separated OAuth scopes. Must include identify. guilds.members.read enables
    # user-token guild membership at login (seamless Discord flaps). Desktop accepts either.
    discord_oauth_scopes: str = "identify guilds.members.read"
    # Prefer SiliconFlow; NVIDIA_API_KEY_2 remains as a legacy alias for older deploys.
    siliconflow_api_key: SecretStr = SecretStr("")
    nvidia_api_key_2: SecretStr = SecretStr("")
    ai_model: str = "Qwen/Qwen2.5-7B-Instruct"
    # Tracker Scout / Assist only — smarter grounded answers; Home/Studio keep ai_model.
    ai_tracker_model: str = "Qwen/Qwen3-14B"
    ai_base_url: str = "https://api.siliconflow.com/v1"
    # Shared daily AI budget across chat, autocomplete, mod-check, home, community /ai.
    ai_daily_request_limit: int = 50
    # Elevated shared / Scout daily budget for owner, admin, and Discord uncapped role.
    ai_uncapped_daily_request_limit: int = 500
    # Absolute DB + Quota ceiling (must match ai_usage_* check constraints).
    ai_hard_ceiling: int = 500
    ai_mod_check_daily_limit: int = 50
    # Kept for env compatibility; community /ai and home assistant now share ai_daily_request_limit.
    ai_community_daily_limit: int = 50
    ai_home_daily_limit: int = 50
    # Telemetry Discord dumps / presence pulses — elevated for uncapped members.
    telemetry_uncapped_session_log_per_day: int = 500
    telemetry_uncapped_hourly_pulse_per_day: int = 500
    access_token_signing_key: SecretStr = SecretStr("")
    refresh_token_pepper: SecretStr = SecretStr("")
    manifest_public_key: str = ""
    developer_password_hash: SecretStr = SecretStr("")
    developer_publish_enabled: bool = False
    expired_session_retention_days: int = 30
    audit_retention_days: int = 180
    announcement_cache_retention_days: int = 30
    ai_usage_retention_days: int = 30
    database_backup_retention_days: int = 30
    log_level: str = "INFO"

    @model_validator(mode="after")
    def production_requirements(self):
        for name in (
            "expired_session_retention_days",
            "audit_retention_days",
            "announcement_cache_retention_days",
            "ai_usage_retention_days",
            "database_backup_retention_days",
        ):
            if not 1 <= getattr(self, name) <= 3650:
                raise ValueError(f"{name.upper()} must be between 1 and 3650")
        allowed_scopes = {"identify", "guilds.members.read"}
        scopes = [part for part in self.discord_oauth_scopes.split() if part]
        if (
            "identify" not in scopes
            or not scopes
            or any(part not in allowed_scopes for part in scopes)
        ):
            raise ValueError(
                "DISCORD_OAUTH_SCOPES must include identify and only allow "
                "identify / guilds.members.read"
            )
        # identify first, then any extras once — keeps authorize URLs stable.
        ordered = ["identify"] + [part for part in dict.fromkeys(scopes) if part != "identify"]
        self.discord_oauth_scopes = " ".join(ordered)
        if self.app_env == "production":
            for name in (
                "database_url",
                "discord_client_secret",
                "discord_bot_token",
                "access_token_signing_key",
                "refresh_token_pepper",
            ):
                if not getattr(self, name).get_secret_value():
                    raise ValueError(f"Production requires {name.upper()}")
            if not self.database_url.get_secret_value().startswith("postgresql"):
                raise ValueError("Production requires PostgreSQL")
            if not self.backend_public_url.startswith("https://"):
                raise ValueError("Production requires an HTTPS public URL")
            public = urlsplit(self.backend_public_url)
            if (
                not public.hostname
                or public.username
                or public.password
                or public.query
                or public.fragment
                or public.path not in ("", "/")
            ):
                raise ValueError(
                    "Production requires a public HTTPS origin without credentials or a path"
                )
            if (
                self.discord_oauth_redirect_uri
                != self.backend_public_url.rstrip("/") + "/v1/auth/discord/callback"
            ):
                raise ValueError("Production requires the exact configured OAuth callback")
            for name in ("access_token_signing_key", "refresh_token_pepper"):
                if len(getattr(self, name).get_secret_value()) < 32:
                    raise ValueError(f"Production requires a strong {name.upper()}")
            if self.access_token_signing_key == self.refresh_token_pepper:
                raise ValueError("Production requires independent session signing and refresh keys")
            if not self.frontend_origin:
                raise ValueError("Production requires an exact frontend origin")
        return self
