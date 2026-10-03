"""Versioned app content. Staff identity plus a short-lived password unlock is required."""

import hashlib
import hmac
import io
import re
import zipfile
from datetime import UTC, datetime, timedelta
from typing import Literal
from urllib.parse import urlsplit

import jwt
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, Request, Response
from pydantic import BaseModel, Field, SecretStr, model_validator
from sqlalchemy import func, select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from .auth import database, require_member
from .discord import ProviderUnavailable
from .mod_upload import parse_thumbnail
from .models import (
    AuditEvent,
    BackgroundTrack,
    CommunityMod,
    CreatorApplication,
    DeveloperAccess,
    ManagedContent,
    PlatformSetting,
    ReleaseCandidate,
    StudioTemplate,
    TrustedMod,
    User,
)
from .security import digest, utc
from .signed_releases import verify_manifest
from .telemetry import usage_stats

router = APIRouter(prefix="/v1")


def password_matches(password, encoded):
    try:
        algorithm, salt, expected = encoded.split("$")
        if algorithm != "scrypt" or len(bytes.fromhex(salt)) != 16:
            return False
        actual = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=16384, r=8, p=1)
        return hmac.compare_digest(actual.hex(), expected)
    except (ValueError, TypeError):
        return False


def staff(request: Request, user: User = Depends(require_member)):
    if not set(request.state.member["entitlements"]) & {"admin", "owner"}:
        raise HTTPException(403, "Admin or owner role required")
    return user


class Unlock(BaseModel):
    password: SecretStr = Field(min_length=16, max_length=256)


@router.post("/developer/unlock")
def unlock(
    body: Unlock, request: Request, user: User = Depends(staff), db: Session = Depends(database)
):
    config = request.app.state.settings
    encoded = config.developer_password_hash.get_secret_value()
    if not encoded or len(config.access_token_signing_key.get_secret_value()) < 32:
        raise HTTPException(503, "Developer password is not configured")
    db.scalar(select(User).where(User.id == user.id).with_for_update())
    access = db.get(DeveloperAccess, user.id) or DeveloperAccess(user_id=user.id, attempts=0)
    now = datetime.now(UTC)
    if access.locked_until and utc(access.locked_until) > now:
        raise HTTPException(
            429, "Developer unlock is locked for 15 minutes after repeated failures"
        )
    if access.locked_until:
        access.attempts = 0
        access.locked_until = None
    if not password_matches(body.password.get_secret_value(), encoded):
        access.attempts += 1
        if access.attempts >= 5:
            access.locked_until = now + timedelta(minutes=15)
        db.add(access)
        db.add(AuditEvent(actor_id=user.id, event_type="developer_unlock", result="denied"))
        db.commit()
        raise HTTPException(403, "Incorrect developer password")
    access.attempts = 0
    db.add(access)
    db.add(AuditEvent(actor_id=user.id, event_type="developer_unlock", result="success"))
    db.commit()
    token = jwt.encode(
        {
            "sub": user.id,
            "sid": request.state.session_id,
            "aud": "ii-developer",
            "iss": "ii-engine",
            "iat": now,
            "exp": now + timedelta(minutes=15),
            "credential": digest(encoded),
        },
        config.access_token_signing_key.get_secret_value(),
        algorithm="HS256",
    )
    return {
        "token": token,
        "expires_in": 900,
        "publishing_enabled": config.developer_publish_enabled,
    }


def unlocked(request: Request, user: User = Depends(staff)):
    config = request.app.state.settings
    try:
        claim = jwt.decode(
            request.headers.get("X-Developer-Token", ""),
            config.access_token_signing_key.get_secret_value(),
            algorithms=["HS256"],
            audience="ii-developer",
            issuer="ii-engine",
            options={"require": ["sub", "sid", "iat", "exp", "credential"]},
        )
        if (
            claim["sub"] != user.id
            or not config.developer_password_hash.get_secret_value()
            or not hmac.compare_digest(
                claim["credential"], digest(config.developer_password_hash.get_secret_value())
            )
        ):
            raise ValueError()
    except (jwt.PyJWTError, ValueError, TypeError):
        raise HTTPException(403, "Unlock the developer panel again") from None
    return user


class ContentInput(BaseModel):
    kind: Literal["announcement", "release", "source", "notice"]
    title: str = Field(min_length=1, max_length=120)
    text: str = Field(default="", max_length=6000)
    url: str = Field(default="", max_length=2048)
    channel: Literal["stable", "beta", "developer"] = "stable"
    version: str = Field(default="", max_length=80)
    sha256: str = Field(default="", max_length=64)
    source_commit: str = Field(default="", max_length=40)
    manifest: str = Field(default="", max_length=16000)
    expected_revision: int = Field(default=0, ge=0)

    @model_validator(mode="after")
    def valid(self):
        if not self.title.strip():
            raise ValueError("Title required")
        if self.url:
            parsed = urlsplit(self.url)
            if (
                parsed.scheme != "https"
                or not parsed.hostname
                or parsed.username
                or parsed.password
            ):
                raise ValueError("Public HTTPS link required")
            if self.kind in ("release", "source") and (
                parsed.hostname != "github.com"
                or not (
                    parsed.path.startswith("/iireborn/menu/")
                    or parsed.path.startswith("/iireborn/ii.stupid.menu/")
                    or parsed.path.startswith("/iireborn/iis.Stupid.Menu/")
                )
            ):
                raise ValueError("Use the official menu repository")
        if self.kind == "source" and (
            not self.url or not re.fullmatch(r"[0-9a-f]{40}", self.source_commit)
        ):
            raise ValueError("Source requires an official URL and full commit SHA")
        if self.kind == "release" and (
            not self.url
            or not re.fullmatch(r"\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?", self.version)
            or not re.fullmatch(r"[0-9a-f]{64}", self.sha256)
        ):
            raise ValueError("Release requires version, official link and SHA-256")
        return self


def view(row):
    return {
        "id": row.id,
        "kind": row.kind,
        "title": row.title,
        **row.payload,
        "revision": row.revision,
        "published_at": row.published_at,
        "published_title": row.published_title,
        "updated_at": row.updated_at,
    }


@router.get("/developer/content")
def content(user: User = Depends(unlocked), db: Session = Depends(database)):
    rows = db.scalars(select(ManagedContent).order_by(ManagedContent.updated_at.desc()).limit(200))
    return {"items": [view(row) for row in rows]}


@router.post("/developer/sync-stable", status_code=201)
def sync_stable(request: Request, user: User = Depends(unlocked), db: Session = Depends(database)):
    """Import the verified official stable metadata as a draft; no DLL is uploaded or run."""
    try:
        release = request.app.state.releases.get()
    except ProviderUnavailable:
        raise HTTPException(503, "The official stable release could not be verified") from None
    existing = db.scalar(
        select(ManagedContent)
        .where(ManagedContent.kind == "release")
        .order_by(ManagedContent.updated_at.desc())
    )
    payload = {
        "text": f"ii Reborn Menu {release['version']} is available from the official repository.",
        "url": release["release_url"],
        "channel": "stable",
        "version": release["version"],
        "sha256": release["sha256"],
        "source_commit": "",
        "manifest": "",
    }
    if existing and existing.payload.get("version") == release["version"]:
        if (
            existing.payload.get("sha256") != release["sha256"]
            or existing.payload.get("url") != release["release_url"]
        ):
            raise HTTPException(409, "The official release changed without a version change")
        return view(existing)
    row = ManagedContent(
        kind="release",
        title=f"Menu {release['version']}",
        payload=payload,
        updated_by=user.id,
    )
    db.add(row)
    db.add(AuditEvent(actor_id=user.id, event_type="release_sync", result="draft"))
    db.commit()
    return view(row)


@router.post("/developer/content", status_code=201)
def create(body: ContentInput, user: User = Depends(unlocked), db: Session = Depends(database)):
    row = ManagedContent(
        kind=body.kind,
        title=body.title,
        updated_by=user.id,
        payload=body.model_dump(exclude={"kind", "title", "expected_revision"}),
    )
    db.add(row)
    db.add(AuditEvent(actor_id=user.id, event_type="content_create", result="draft"))
    db.commit()
    return view(row)


def locked_row(db, identifier, revision):
    row = db.scalar(select(ManagedContent).where(ManagedContent.id == identifier).with_for_update())
    if not row:
        raise HTTPException(404, "Content not found")
    if row.revision != revision:
        raise HTTPException(409, "Another developer changed this item. Reload before saving.")
    return row


@router.post("/developer/content/{identifier}")
def edit(
    identifier: str,
    body: ContentInput,
    user: User = Depends(unlocked),
    db: Session = Depends(database),
):
    row = locked_row(db, identifier, body.expected_revision)
    if row.kind != body.kind:
        raise HTTPException(409, "Content type cannot change")
    row.title = body.title
    row.payload = body.model_dump(exclude={"kind", "title", "expected_revision"})
    row.revision += 1
    row.updated_at, row.updated_by = datetime.now(UTC), user.id
    db.add(AuditEvent(actor_id=user.id, event_type="content_edit", result="draft"))
    db.commit()
    return view(row)


class PublishInput(BaseModel):
    expected_revision: int = Field(ge=1)
    publish: bool


@router.post("/developer/content/{identifier}/visibility")
def visibility(
    identifier: str,
    body: PublishInput,
    request: Request,
    user: User = Depends(unlocked),
    db: Session = Depends(database),
):
    if not request.app.state.settings.developer_publish_enabled:
        raise HTTPException(403, "Publishing is disabled until owner review")
    row = locked_row(db, identifier, body.expected_revision)
    # Release posts announce artifacts; they do not bypass the native signed installer.
    if body.publish and row.kind == "release" and row.payload.get("manifest"):
        try:
            manifest = verify_manifest(
                row.payload["manifest"],
                request.app.state.settings.manifest_public_key,
                row.payload["channel"],
            )
            if (
                manifest["menu_version"] != row.payload["version"]
                or manifest["sha256"] != row.payload["sha256"]
                or manifest["release_url"] != row.payload["url"]
            ):
                raise ValueError("Release post must match its signed manifest")
        except ValueError as error:
            raise HTTPException(422, str(error)) from None
    row.published_payload = dict(row.payload) if body.publish else None
    row.published_title = row.title if body.publish else None
    row.published_at = datetime.now(UTC) if body.publish else None
    row.revision += 1
    row.updated_at, row.updated_by = datetime.now(UTC), user.id
    db.add(
        AuditEvent(
            actor_id=user.id,
            event_type="content_publish" if body.publish else "content_withdraw",
            result="success",
        )
    )
    db.commit()
    return view(row)


@router.get("/content")
def published(
    request: Request, user: User = Depends(require_member), db: Session = Depends(database)
):
    staff_access = bool(set(request.state.member["entitlements"]) & {"developer", "admin", "owner"})
    rows = db.scalars(
        select(ManagedContent)
        .where(ManagedContent.published_at.is_not(None))
        .order_by(ManagedContent.published_at.desc())
        .limit(100)
    )
    return {
        "items": [
            {
                "id": row.id,
                "kind": row.kind,
                "title": row.published_title,
                **row.published_payload,
                "published_at": row.published_at,
            }
            for row in rows
            if row.published_payload
            and (row.published_payload.get("channel") == "stable" or staff_access)
        ]
    }


DEFAULT_OPERATIONS = {
    "countdown": {"enabled": False, "title": "Next menu update", "target_at": None},
    "menu": {"status": "operational", "message": "Menu services are running normally."},
    "pricing": {
        "lifetime_usd": 14,
        "lifetime_on_sale": False,
        "lifetime_sale_name": "",
        "lifetime_was_usd": None,
        "bundle_usd": 25,
        "bundle_on_sale": False,
        "bundle_sale_name": "",
        "bundle_was_usd": None,
        "tracker_solo_usd": 20,
        "tracker_solo_on_sale": False,
        "tracker_solo_sale_name": "",
        "tracker_solo_was_usd": None,
        "robux_price": 2500,
        "robux_on_sale": False,
        "robux_sale_name": "",
        "robux_was_price": None,
        "bundle_robux_price": 3250,
        "bundle_robux_on_sale": False,
        "bundle_robux_sale_name": "",
        "bundle_robux_was_price": None,
    },
    "feature_access": {
        "app_access": {
            "enabled": True,
            "everyone": True,
            "role_ids": [],
            "entitlements": [],
        },
        "developer_panel": {
            "enabled": True,
            "everyone": False,
            "role_ids": [],
            "entitlements": ["developer", "admin", "owner"],
        },
        "studio": {
            "enabled": True,
            "everyone": False,
            "role_ids": ["1549421049287020568"],
            "entitlements": ["beta", "admin", "owner"],
        },
        "mod_library": {
            "enabled": True,
            "everyone": True,
            "role_ids": [],
            "entitlements": [],
        },
        "community_mods": {
            "enabled": True,
            "everyone": True,
            "role_ids": [],
            "entitlements": [],
        },
        "community_chat": {
            "enabled": True,
            "everyone": True,
            "role_ids": [],
            "entitlements": [],
        },
        "community_posts": {
            "enabled": True,
            "everyone": True,
            "role_ids": [],
            "entitlements": [],
        },
        "launch_game": {
            "enabled": True,
            "everyone": True,
            "role_ids": [],
            "entitlements": [],
        },
        "health_repair": {
            "enabled": True,
            "everyone": True,
            "role_ids": [],
            "entitlements": [],
        },
        "announcements": {
            "enabled": True,
            "everyone": True,
            "role_ids": [],
            "entitlements": [],
        },
        "backups": {
            "enabled": True,
            "everyone": True,
            "role_ids": [],
            "entitlements": [],
        },
        "creator_application": {
            "enabled": True,
            "everyone": True,
            "role_ids": [],
            "entitlements": [],
        },
        "plans_tab": {
            "enabled": True,
            "everyone": True,
            "role_ids": [],
            "entitlements": [],
        },
        "tracker": {
            "enabled": True,
            "everyone": False,
            "role_ids": ["1549151900073459752", "1554650259152576513"],
            "entitlements": ["ii_tracker", "ii_tracker_beta", "developer", "admin", "owner"],
        },
        "target_tracker": {
            "enabled": True,
            "everyone": False,
            "role_ids": ["1549151900073459752", "1554650259152576513"],
            "entitlements": ["ii_tracker", "ii_tracker_beta", "developer", "admin", "owner"],
        },
        "tracker_scout": {
            "enabled": True,
            "everyone": False,
            "role_ids": ["1549151900073459752", "1554650259152576513"],
            "entitlements": ["ii_tracker", "ii_tracker_beta", "developer", "admin", "owner"],
        },
        "self_tracker": {
            "enabled": True,
            "everyone": True,
            "role_ids": [],
            "entitlements": [],
        },
        "soundlab": {
            "enabled": True,
            "everyone": False,
            "role_ids": [],
            "entitlements": ["pro", "admin", "owner"],
        },
        "customize": {
            "enabled": True,
            "everyone": False,
            "role_ids": [],
            "entitlements": ["pro", "admin", "owner"],
        },
        "catalog": {
            "enabled": True,
            "everyone": True,
            "role_ids": [],
            "entitlements": [],
        },
        "home_ai": {
            "enabled": True,
            "everyone": False,
            "role_ids": [],
            "entitlements": ["pro", "admin", "owner"],
        },
    },
}


def operation_view(db):
    values = {key: dict(value) for key, value in DEFAULT_OPERATIONS.items()}
    for row in db.scalars(select(PlatformSetting)):
        if row.key in values and isinstance(row.value, dict):
            values[row.key] = {**values[row.key], **row.value}
    pricing = values.setdefault("pricing", dict(DEFAULT_OPERATIONS["pricing"]))
    values["pricing"] = {**DEFAULT_OPERATIONS["pricing"], **pricing}
    features = values.setdefault("feature_access", {})
    for key, default in DEFAULT_OPERATIONS["feature_access"].items():
        if key not in features or not isinstance(features.get(key), dict):
            features[key] = dict(default)
        else:
            features[key] = {**default, **features[key]}
            rule = features[key]
            features[key] = {
                **rule,
                "role_ids": list(rule.get("role_ids") or []),
                "entitlements": list(rule.get("entitlements") or []),
            }
        # Only heal the historic app_access lockout shape. Other features keep
        # intentional role-gated saves from the developer panel.
        rule = features[key]
        if (
            key == "app_access"
            and rule.get("enabled", False)
            and not rule.get("everyone", False)
            and not rule.get("role_ids")
            and not rule.get("entitlements")
        ):
            features[key] = dict(default)
    return values


def require_feature(request: Request, db: Session, key: str):
    """Honor Dev Panel feature_access rules (including everyone / selected roles)."""
    rule = operation_view(db)["feature_access"][key]
    member = request.state.member
    allowed = rule.get("enabled", False) and (
        rule.get("everyone", False)
        or bool(set(rule.get("role_ids", [])) & set(member.get("role_ids", [])))
        or bool(set(rule.get("entitlements", [])) & set(member.get("entitlements", [])))
    )
    if not allowed:
        raise HTTPException(403, "Your Discord roles do not include access to this feature")


class CountdownInput(BaseModel):
    enabled: bool = False
    title: str = Field(default="Next menu update", min_length=1, max_length=100)
    target_at: datetime | None = None

    @model_validator(mode="after")
    def valid_target(self):
        if self.enabled and (not self.target_at or not self.target_at.tzinfo):
            raise ValueError("An enabled countdown requires a timezone-aware target")
        return self


class MenuStatusInput(BaseModel):
    status: Literal["operational", "degraded", "maintenance", "offline"]
    message: str = Field(min_length=1, max_length=240)


class PricingInput(BaseModel):
    """Plans page prices editable from the developer panel."""

    lifetime_usd: int = Field(default=14, ge=1, le=999)
    lifetime_on_sale: bool = False
    lifetime_sale_name: str = Field(default="", max_length=80)
    lifetime_was_usd: int | None = Field(default=None, ge=1, le=999)
    bundle_usd: int = Field(default=25, ge=1, le=999)
    bundle_on_sale: bool = False
    bundle_sale_name: str = Field(default="", max_length=80)
    bundle_was_usd: int | None = Field(default=None, ge=1, le=999)
    tracker_solo_usd: int = Field(default=20, ge=1, le=999)
    tracker_solo_on_sale: bool = False
    tracker_solo_sale_name: str = Field(default="", max_length=80)
    tracker_solo_was_usd: int | None = Field(default=None, ge=1, le=999)
    robux_price: int = Field(default=2500, ge=1, le=1_000_000)
    robux_on_sale: bool = False
    robux_sale_name: str = Field(default="", max_length=80)
    robux_was_price: int | None = Field(default=None, ge=1, le=1_000_000)
    bundle_robux_price: int = Field(default=3250, ge=1, le=1_000_000)
    bundle_robux_on_sale: bool = False
    bundle_robux_sale_name: str = Field(default="", max_length=80)
    bundle_robux_was_price: int | None = Field(default=None, ge=1, le=1_000_000)

    @model_validator(mode="after")
    def normalize_sales(self):
        self.lifetime_sale_name = self.lifetime_sale_name.strip()
        self.bundle_sale_name = self.bundle_sale_name.strip()
        self.tracker_solo_sale_name = self.tracker_solo_sale_name.strip()
        self.robux_sale_name = self.robux_sale_name.strip()
        self.bundle_robux_sale_name = self.bundle_robux_sale_name.strip()
        if not self.lifetime_on_sale:
            self.lifetime_sale_name = ""
            self.lifetime_was_usd = None
        elif self.lifetime_was_usd is not None and self.lifetime_was_usd <= self.lifetime_usd:
            raise ValueError("Lifetime was-price must be higher than the sale price")
        if not self.tracker_solo_on_sale:
            self.tracker_solo_sale_name = ""
            self.tracker_solo_was_usd = None
        elif (
            self.tracker_solo_was_usd is not None
            and self.tracker_solo_was_usd <= self.tracker_solo_usd
        ):
            raise ValueError("Tracker solo was-price must be higher than the sale price")
        if not self.bundle_on_sale:
            self.bundle_sale_name = ""
            self.bundle_was_usd = None
        elif self.bundle_was_usd is not None and self.bundle_was_usd <= self.bundle_usd:
            raise ValueError("Bundle was-price must be higher than the sale price")
        if not self.robux_on_sale:
            self.robux_sale_name = ""
            self.robux_was_price = None
        elif self.robux_was_price is not None and self.robux_was_price <= self.robux_price:
            raise ValueError("Robux was-price must be higher than the sale price")
        if not self.bundle_robux_on_sale:
            self.bundle_robux_sale_name = ""
            self.bundle_robux_was_price = None
        elif (
            self.bundle_robux_was_price is not None
            and self.bundle_robux_was_price <= self.bundle_robux_price
        ):
            raise ValueError("Bundle Robux was-price must be higher than the sale price")
        return self


class FeatureRuleInput(BaseModel):
    enabled: bool = True
    everyone: bool = False
    role_ids: list[str] = Field(default_factory=list, max_length=100)
    entitlements: list[
        Literal[
            "beta",
            "full_access",
            "pro",
            "ii_tracker",
            "ii_tracker_beta",
            "developer",
            "admin",
            "owner",
            "uncapped",
        ]
    ] = Field(default_factory=list, max_length=12)

    @model_validator(mode="after")
    def valid_roles(self):
        if any(not value.isdigit() or not 15 <= len(value) <= 20 for value in self.role_ids):
            raise ValueError("Feature role IDs must be Discord snowflakes")
        self.role_ids = list(dict.fromkeys(self.role_ids))
        self.entitlements = list(dict.fromkeys(self.entitlements))
        if self.enabled and not self.everyone and not self.role_ids and not self.entitlements:
            raise ValueError(
                "Selected Discord roles mode requires at least one role or entitlement"
            )
        return self


def open_feature_rule():
    return FeatureRuleInput(enabled=True, everyone=True)


class FeatureAccessInput(BaseModel):
    app_access: FeatureRuleInput = Field(default_factory=open_feature_rule)
    developer_panel: FeatureRuleInput = Field(
        default_factory=lambda: FeatureRuleInput(
            enabled=True, everyone=False, entitlements=["developer", "admin", "owner"]
        )
    )
    studio: FeatureRuleInput = Field(
        default_factory=lambda: FeatureRuleInput(
            enabled=True,
            everyone=False,
            role_ids=["1549421049287020568"],
            entitlements=["beta", "admin", "owner"],
        )
    )
    mod_library: FeatureRuleInput = Field(default_factory=open_feature_rule)
    community_mods: FeatureRuleInput = Field(default_factory=open_feature_rule)
    community_chat: FeatureRuleInput = Field(default_factory=open_feature_rule)
    community_posts: FeatureRuleInput = Field(default_factory=open_feature_rule)
    launch_game: FeatureRuleInput = Field(default_factory=open_feature_rule)
    health_repair: FeatureRuleInput = Field(default_factory=open_feature_rule)
    announcements: FeatureRuleInput = Field(default_factory=open_feature_rule)
    backups: FeatureRuleInput = Field(default_factory=open_feature_rule)
    creator_application: FeatureRuleInput = Field(default_factory=open_feature_rule)
    plans_tab: FeatureRuleInput = Field(default_factory=open_feature_rule)
    tracker: FeatureRuleInput = Field(
        default_factory=lambda: FeatureRuleInput(
            enabled=True,
            everyone=False,
            role_ids=["1549151900073459752", "1554650259152576513"],
            entitlements=["ii_tracker", "ii_tracker_beta", "developer", "admin", "owner"],
        )
    )
    target_tracker: FeatureRuleInput = Field(
        default_factory=lambda: FeatureRuleInput(
            enabled=True,
            everyone=False,
            role_ids=["1549151900073459752", "1554650259152576513"],
            entitlements=["ii_tracker", "ii_tracker_beta", "developer", "admin", "owner"],
        )
    )
    tracker_scout: FeatureRuleInput = Field(
        default_factory=lambda: FeatureRuleInput(
            enabled=True,
            everyone=False,
            role_ids=["1549151900073459752", "1554650259152576513"],
            entitlements=["ii_tracker", "ii_tracker_beta", "developer", "admin", "owner"],
        )
    )
    self_tracker: FeatureRuleInput = Field(default_factory=open_feature_rule)
    soundlab: FeatureRuleInput = Field(
        default_factory=lambda: FeatureRuleInput(
            enabled=True, everyone=False, entitlements=["pro", "admin", "owner"]
        )
    )
    customize: FeatureRuleInput = Field(
        default_factory=lambda: FeatureRuleInput(
            enabled=True, everyone=False, entitlements=["pro", "admin", "owner"]
        )
    )
    catalog: FeatureRuleInput = Field(default_factory=open_feature_rule)
    home_ai: FeatureRuleInput = Field(
        default_factory=lambda: FeatureRuleInput(
            enabled=True, everyone=False, entitlements=["pro", "admin", "owner"]
        )
    )


def save_setting(db, key, value, user):
    row = db.get(PlatformSetting, key) or PlatformSetting(key=key, value={})
    row.value = value
    row.updated_at, row.updated_by = datetime.now(UTC), user.id
    db.add(row)
    db.add(AuditEvent(actor_id=user.id, event_type=f"operations_{key}", result="success"))
    db.commit()
    return value


@router.get("/developer/operations")
def operations(request: Request, user: User = Depends(unlocked), db: Session = Depends(database)):
    values = operation_view(db)
    try:
        github_menu = request.app.state.releases.status()
        values["menu"] = {
            "status": github_menu["status"],
            "message": github_menu["message"],
        }
    except (AttributeError, KeyError, TypeError):
        pass
    checks = []
    try:
        db.execute(select(User.id).limit(1))
        checks.append({"name": "Database", "status": "operational", "detail": "Connected"})
    except SQLAlchemyError:
        checks.append({"name": "Database", "status": "offline", "detail": "Unavailable"})
    try:
        release = request.app.state.releases.get()
        checks.append(
            {"name": "Menu release feed", "status": "operational", "detail": release["version"]}
        )
    except (ProviderUnavailable, KeyError, TypeError):
        checks.append({"name": "Menu release feed", "status": "degraded", "detail": "Unavailable"})
    settings = request.app.state.settings
    for name, configured in (
        ("Discord integration", bool(settings.discord_bot_token.get_secret_value())),
        (
            "AI service",
            bool(
                settings.siliconflow_api_key.get_secret_value()
                or settings.nvidia_api_key_2.get_secret_value()
            ),
        ),
    ):
        checks.append(
            {
                "name": name,
                "status": "operational" if configured else "degraded",
                "detail": "Configured" if configured else "Not configured",
            }
        )
    checks.append(
        {"name": "Menu", "status": values["menu"]["status"], "detail": values["menu"]["message"]}
    )
    candidates = db.scalars(
        select(ReleaseCandidate).order_by(ReleaseCandidate.created_at.desc()).limit(20)
    )
    try:
        available_roles = request.app.state.discord.guild_roles()
    except (ProviderUnavailable, AttributeError):
        available_roles = []
    return {
        **values,
        "checks": checks,
        "available_roles": available_roles,
        "usage_stats": usage_stats(db),
        "release_candidates": [
            {
                "id": item.id,
                "version": item.version,
                "filename": item.filename,
                "sha256": item.sha256,
                "byte_size": item.byte_size,
                "status": item.status,
                "created_at": item.created_at,
                "display_name": item.display_name,
                "changelog": item.changelog,
                "release_notes": item.release_notes,
                "published_at": item.published_at,
            }
            for item in candidates
        ],
    }


@router.post("/developer/operations/countdown")
def set_countdown(
    body: CountdownInput, user: User = Depends(unlocked), db: Session = Depends(database)
):
    return save_setting(db, "countdown", body.model_dump(mode="json"), user)


@router.post("/developer/operations/menu")
def set_menu_status(
    body: MenuStatusInput, user: User = Depends(unlocked), db: Session = Depends(database)
):
    return save_setting(db, "menu", body.model_dump(), user)


@router.post("/developer/operations/pricing")
def set_pricing(
    body: PricingInput, user: User = Depends(unlocked), db: Session = Depends(database)
):
    return save_setting(db, "pricing", body.model_dump(mode="json"), user)


@router.post("/developer/operations/features")
def set_feature_access(
    body: FeatureAccessInput, user: User = Depends(unlocked), db: Session = Depends(database)
):
    saved = save_setting(db, "feature_access", body.model_dump(), user)
    # Return the persisted payload (not the healed view) so the panel reflects Save.
    return {"feature_access": saved}


@router.post("/developer/releases", status_code=201)
async def stage_release(
    request: Request,
    version: str = Query(min_length=5, max_length=80),
    filename: str = Query(min_length=5, max_length=180),
    user: User = Depends(unlocked),
    db: Session = Depends(database),
):
    del request, version, filename, user, db
    # Legal: Engine must not store menu DLL bytes. Members pull from GitHub Releases.
    raise HTTPException(
        410,
        "Menu DLLs are no longer stored by ii Engine. Publish ii.Reborn.dll on "
        "https://github.com/iireborn/menu/releases — launch and Health check that feed.",
    )


class PublishReleaseInput(BaseModel):
    display_name: str = Field(min_length=1, max_length=120)
    added: list[str] = Field(default_factory=list, max_length=40)
    removed: list[str] = Field(default_factory=list, max_length=40)
    changed: list[str] = Field(default_factory=list, max_length=40)
    fixes: list[str] = Field(default_factory=list, max_length=40)
    release_notes: str = Field(default="", max_length=6000)

    @model_validator(mode="after")
    def clean(self):
        self.display_name = self.display_name.strip()
        for field in ("added", "removed", "changed", "fixes"):
            values = [value.strip() for value in getattr(self, field) if value.strip()]
            if any(len(value) > 300 for value in values):
                raise ValueError("Changelog entries must be 300 characters or fewer")
            setattr(self, field, values)
        self.release_notes = self.release_notes.strip()
        return self


def managed_release_view(row):
    changelog = row.changelog if isinstance(row.changelog, dict) else {}
    return {
        "id": row.id,
        "name": row.display_name or f"ii Menu {row.version}",
        "version": row.version,
        "published_at": row.published_at,
        "sha256": row.sha256,
        "byte_size": row.byte_size,
        "changelog": {
            key: list(changelog.get(key, [])) for key in ("added", "removed", "changed", "fixes")
        },
        "release_notes": row.release_notes,
    }


def trusted_mod_view(row):
    return {
        "id": row.id,
        "name": row.name,
        "description": row.description,
        "filename": row.filename,
        "sha256": row.sha256,
        "byte_size": row.byte_size,
        "created_at": row.created_at,
        "has_thumbnail": bool(row.thumbnail),
        "thumbnail_url": f"/v1/trusted-mods/{row.id}/thumbnail" if row.thumbnail else None,
    }


def studio_template_view(row):
    return {
        "id": row.id,
        "name": row.name,
        "description": row.description,
        "filename": row.filename,
        "sha256": row.sha256,
        "byte_size": row.byte_size,
        "created_at": row.created_at,
    }


def validate_template(artifact: bytes):
    if not artifact or len(artifact) > 50 * 1024 * 1024:
        raise HTTPException(413, "Template ZIP must be between 1 byte and 50 MB")
    try:
        with zipfile.ZipFile(io.BytesIO(artifact)) as archive:
            files = [item for item in archive.infolist() if not item.is_dir()]
            if not files or len(files) > 5_000:
                raise ValueError
            total = 0
            names = []
            for item in files:
                name = item.filename.replace("\\", "/")
                if (
                    name.startswith("/")
                    or "\x00" in name
                    or any(part in {"", ".", ".."} for part in name.split("/"))
                    or (item.external_attr >> 16) & 0o170000 == 0o120000
                ):
                    raise ValueError
                total += item.file_size
                if total > 150 * 1024 * 1024:
                    raise ValueError
                names.append(name.lower())
            if not any(name.endswith(".csproj") for name in names) or not any(
                name.endswith(".cs") for name in names
            ):
                raise ValueError
    except (OSError, ValueError, zipfile.BadZipFile):
        raise HTTPException(
            422, "Template must be a safe ZIP with C# source and a .csproj"
        ) from None


@router.post("/developer/releases/{identifier}/publish")
def publish_release(
    identifier: str,
    body: PublishReleaseInput,
    request: Request,
    user: User = Depends(unlocked),
    db: Session = Depends(database),
):
    del identifier, body, request, user, db
    raise HTTPException(
        410,
        "Managed menu publishing is retired. Ship ii.Reborn.dll on the official GitHub Releases page.",
    )


@router.get("/menu-releases")
def menu_releases(request: Request, user: User = Depends(require_member)):
    """Compatibility catalog for desktop: always the live GitHub latest (metadata only)."""
    del user
    try:
        release = request.app.state.releases.get()
    except ProviderUnavailable:
        raise HTTPException(503, "Release metadata is temporarily unavailable") from None
    item = {
        "id": "github-latest",
        "name": f"ii Menu {release['version']}",
        "version": release["version"],
        "published_at": release["published_at"],
        "sha256": release["sha256"],
        "byte_size": release["byte_size"],
        "download_url": release["download_url"],
        "release_url": release["release_url"],
        "canonical_filename": release["canonical_filename"],
        "changelog": {"added": [], "removed": [], "changed": [], "fixes": []},
        "release_notes": (
            "Pulled from https://github.com/iireborn/menu "
            "(menuversion.json + menustatus.json + releases/latest/download/ii.Reborn.dll). "
            "ii Engine does not store this DLL."
        ),
    }
    return {"latest_id": item["id"], "items": [item]}


@router.post("/menu-releases/{identifier}/ticket")
def release_ticket(
    identifier: str,
    request: Request,
    user: User = Depends(require_member),
    db: Session = Depends(database),
):
    del identifier, request, user, db
    raise HTTPException(
        410,
        "Menu DLLs are downloaded from GitHub Releases, not the ii Engine API.",
    )


@router.get("/menu-releases/{identifier}/download")
def download_release(
    identifier: str,
    request: Request,
    ticket: str = Query(min_length=40, max_length=4096),
    db: Session = Depends(database),
):
    del identifier, request, ticket, db
    raise HTTPException(
        410,
        "Menu DLLs are downloaded from GitHub Releases, not the ii Engine API.",
    )


@router.get("/developer/trusted-mods")
def developer_trusted_mods(user: User = Depends(unlocked), db: Session = Depends(database)):
    rows = db.scalars(select(TrustedMod).order_by(TrustedMod.created_at.desc()).limit(200))
    return {"items": [trusted_mod_view(row) for row in rows]}


@router.post("/developer/trusted-mods", status_code=201)
async def upload_trusted_mod(
    request: Request,
    name: str = Query(min_length=1, max_length=120),
    description: str = Query(min_length=1, max_length=1000),
    filename: str = Query(min_length=5, max_length=180),
    user: User = Depends(unlocked),
    db: Session = Depends(database),
):
    name = name.strip()
    description = description.strip()
    if not name or not description:
        raise HTTPException(422, "Name and description are required")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._ -]*\.dll", filename, re.IGNORECASE):
        raise HTTPException(422, "Upload a DLL with a safe filename")
    artifact = await request.body()
    if not artifact or len(artifact) > 25 * 1024 * 1024 + 2 * 1024 * 1024:
        raise HTTPException(413, "DLL must be between 1 byte and 25 MB")
    artifact, thumbnail, thumbnail_mime = parse_thumbnail(request, artifact)
    if not artifact or len(artifact) > 25 * 1024 * 1024:
        raise HTTPException(413, "DLL must be between 1 byte and 25 MB")
    if artifact[:2] != b"MZ":
        raise HTTPException(422, "The uploaded file is not a Windows DLL")
    existing = db.scalar(select(TrustedMod).where(TrustedMod.filename == filename))
    if existing:
        raise HTTPException(409, "A trusted mod already uses that DLL filename")
    row = TrustedMod(
        name=name,
        description=description,
        filename=filename,
        sha256=hashlib.sha256(artifact).hexdigest(),
        byte_size=len(artifact),
        artifact=artifact,
        thumbnail=thumbnail,
        thumbnail_mime=thumbnail_mime,
        created_by=user.id,
    )
    db.add(row)
    db.add(AuditEvent(actor_id=user.id, event_type="trusted_mod_add", result="success"))
    db.commit()
    return trusted_mod_view(row)


@router.delete("/developer/trusted-mods/{identifier}", status_code=204)
def delete_trusted_mod(
    identifier: str,
    user: User = Depends(unlocked),
    db: Session = Depends(database),
):
    row = db.get(TrustedMod, identifier)
    if not row:
        raise HTTPException(404, "Trusted mod not found")
    db.delete(row)
    db.add(AuditEvent(actor_id=user.id, event_type="trusted_mod_remove", result="success"))
    db.commit()


@router.get("/trusted-mods")
def trusted_mods(
    request: Request, user: User = Depends(require_member), db: Session = Depends(database)
):
    require_feature(request, db, "mod_library")
    from .mod_votes import attach_votes

    rows = db.scalars(select(TrustedMod).order_by(TrustedMod.name).limit(200))
    items = [trusted_mod_view(row) for row in rows]
    return {"items": attach_votes(db, items, "trusted", user.id)}


@router.get("/trusted-mods/{identifier}/thumbnail")
def trusted_mod_thumbnail(
    identifier: str,
    request: Request,
    user: User = Depends(require_member),
    db: Session = Depends(database),
):
    require_feature(request, db, "mod_library")
    row = db.get(TrustedMod, identifier)
    if row is None or not row.thumbnail:
        raise HTTPException(404, "Thumbnail not found")
    return Response(row.thumbnail, media_type=row.thumbnail_mime or "image/jpeg")


@router.post("/trusted-mods/{identifier}/ticket")
def trusted_mod_ticket(
    identifier: str,
    request: Request,
    user: User = Depends(require_member),
    db: Session = Depends(database),
):
    require_feature(request, db, "mod_library")
    row = db.get(TrustedMod, identifier)
    if not row:
        raise HTTPException(404, "Trusted mod not found")
    now = datetime.now(UTC)
    token = jwt.encode(
        {
            "sub": user.id,
            "mid": row.id,
            "sha256": row.sha256,
            "aud": "ii-mod-download",
            "iss": "ii-engine",
            "iat": now,
            "exp": now + timedelta(minutes=5),
        },
        request.app.state.settings.access_token_signing_key.get_secret_value(),
        algorithm="HS256",
    )
    base = request.app.state.settings.backend_public_url.rstrip("/")
    return {"download_url": f"{base}/v1/trusted-mods/{row.id}/download?ticket={token}"}


@router.get("/trusted-mods/{identifier}/download")
def download_trusted_mod(
    identifier: str,
    request: Request,
    ticket: str = Query(min_length=40, max_length=4096),
    db: Session = Depends(database),
):
    try:
        claim = jwt.decode(
            ticket,
            request.app.state.settings.access_token_signing_key.get_secret_value(),
            algorithms=["HS256"],
            audience="ii-mod-download",
            issuer="ii-engine",
            options={"require": ["sub", "mid", "sha256", "iat", "exp"]},
        )
    except jwt.PyJWTError:
        raise HTTPException(401, "Mod download ticket is invalid or expired") from None
    row = db.get(TrustedMod, identifier)
    if (
        not row
        or claim.get("mid") != row.id
        or not hmac.compare_digest(str(claim.get("sha256", "")), row.sha256)
    ):
        raise HTTPException(404, "Trusted mod not found")
    safe_name = row.filename.replace('"', "")
    return Response(
        row.artifact,
        media_type="application/octet-stream",
        headers={
            "Content-Disposition": f'attachment; filename="{safe_name}"',
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
            "X-Mod-SHA256": row.sha256,
        },
    )


@router.get("/developer/studio-templates")
def developer_studio_templates(user: User = Depends(unlocked), db: Session = Depends(database)):
    rows = db.scalars(select(StudioTemplate).order_by(StudioTemplate.created_at.desc()).limit(100))
    return {"items": [studio_template_view(row) for row in rows]}


@router.post("/developer/studio-templates", status_code=201)
async def upload_studio_template(
    request: Request,
    name: str = Query(min_length=1, max_length=120),
    description: str = Query(min_length=1, max_length=1000),
    filename: str = Query(min_length=5, max_length=180),
    user: User = Depends(unlocked),
    db: Session = Depends(database),
):
    name, description = name.strip(), description.strip()
    if not name or not description:
        raise HTTPException(422, "Name and description are required")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._ -]*\.zip", filename, re.IGNORECASE):
        raise HTTPException(422, "Upload a ZIP with a safe filename")
    artifact = await request.body()
    validate_template(artifact)
    if db.scalar(select(StudioTemplate).where(StudioTemplate.filename == filename)):
        raise HTTPException(409, "A Studio template already uses that filename")
    row = StudioTemplate(
        name=name,
        description=description,
        filename=filename,
        sha256=hashlib.sha256(artifact).hexdigest(),
        byte_size=len(artifact),
        artifact=artifact,
        created_by=user.id,
    )
    db.add(row)
    db.add(AuditEvent(actor_id=user.id, event_type="studio_template_add", result="success"))
    db.commit()
    return studio_template_view(row)


@router.delete("/developer/studio-templates/{identifier}", status_code=204)
def delete_studio_template(
    identifier: str, user: User = Depends(unlocked), db: Session = Depends(database)
):
    row = db.get(StudioTemplate, identifier)
    if not row:
        raise HTTPException(404, "Studio template not found")
    db.delete(row)
    db.add(AuditEvent(actor_id=user.id, event_type="studio_template_remove", result="success"))
    db.commit()


@router.get("/studio-templates")
def studio_templates(
    request: Request, user: User = Depends(require_member), db: Session = Depends(database)
):
    require_feature(request, db, "studio")
    rows = db.scalars(select(StudioTemplate).order_by(StudioTemplate.created_at.desc()).limit(100))
    return {"items": [studio_template_view(row) for row in rows]}


@router.post("/studio-templates/{identifier}/ticket")
def studio_template_ticket(
    identifier: str,
    request: Request,
    user: User = Depends(require_member),
    db: Session = Depends(database),
):
    require_feature(request, db, "studio")
    row = db.get(StudioTemplate, identifier)
    if not row:
        raise HTTPException(404, "Studio template not found")
    now = datetime.now(UTC)
    token = jwt.encode(
        {
            "sub": user.id,
            "tid": row.id,
            "sha256": row.sha256,
            "aud": "ii-template-download",
            "iss": "ii-engine",
            "iat": now,
            "exp": now + timedelta(minutes=5),
        },
        request.app.state.settings.access_token_signing_key.get_secret_value(),
        algorithm="HS256",
    )
    base = request.app.state.settings.backend_public_url.rstrip("/")
    return {"download_url": f"{base}/v1/studio-templates/{row.id}/download?ticket={token}"}


@router.get("/studio-templates/{identifier}/download")
def download_studio_template(
    identifier: str,
    request: Request,
    ticket: str = Query(min_length=40, max_length=4096),
    db: Session = Depends(database),
):
    try:
        claim = jwt.decode(
            ticket,
            request.app.state.settings.access_token_signing_key.get_secret_value(),
            algorithms=["HS256"],
            audience="ii-template-download",
            issuer="ii-engine",
            options={"require": ["sub", "tid", "sha256", "iat", "exp"]},
        )
    except jwt.PyJWTError:
        raise HTTPException(401, "Template download ticket is invalid or expired") from None
    row = db.get(StudioTemplate, identifier)
    if (
        not row
        or claim.get("tid") != row.id
        or not hmac.compare_digest(str(claim.get("sha256", "")), row.sha256)
    ):
        raise HTTPException(404, "Studio template not found")
    return Response(
        row.artifact,
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="{row.filename.replace(chr(34), "")}"',
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
            "X-Template-SHA256": row.sha256,
        },
    )


@router.get("/platform/operations")
def public_operations(
    request: Request, user: User = Depends(require_member), db: Session = Depends(database)
):
    del user
    view = operation_view(db)
    # Prefer live GitHub menustatus.json over the developer-panel override when reachable.
    try:
        github_menu = request.app.state.releases.status()
        view["menu"] = {
            "status": github_menu["status"],
            "message": github_menu["message"],
        }
    except (AttributeError, KeyError, TypeError):
        pass
    return view


class CreatorReviewInput(BaseModel):
    approve: bool
    note: str = Field(default="", max_length=500)


def creator_application_view(row: CreatorApplication, author: User):
    return {
        "id": row.id,
        "user_id": row.user_id,
        "pitch": row.pitch,
        "experience": row.experience,
        "status": row.status,
        "created_at": row.created_at,
        "reviewed_at": row.reviewed_at,
        "review_note": row.review_note,
        "author": {
            "id": author.id,
            "display_name": author.display_name,
            "avatar": author.avatar,
            "discord_id": author.discord_id,
        },
    }


@router.get("/developer/creator-applications")
def list_creator_applications(user: User = Depends(unlocked), db: Session = Depends(database)):
    rows = db.execute(
        select(CreatorApplication, User)
        .join(User, User.id == CreatorApplication.user_id)
        .where(CreatorApplication.status == "pending")
        .order_by(CreatorApplication.created_at.asc())
        .limit(100)
    ).all()
    return {"items": [creator_application_view(row, author) for row, author in rows]}


@router.post("/developer/creator-applications/{identifier}/review")
def review_creator_application(
    identifier: str,
    body: CreatorReviewInput,
    request: Request,
    user: User = Depends(unlocked),
    db: Session = Depends(database),
):
    row = db.get(CreatorApplication, identifier)
    if row is None:
        raise HTTPException(404, "Creator application not found")
    if row.status != "pending":
        raise HTTPException(409, "This application was already reviewed")
    applicant = db.get(User, row.user_id)
    if applicant is None:
        raise HTTPException(404, "Applicant not found")
    row.status = "approved" if body.approve else "rejected"
    row.reviewed_at = datetime.now(UTC)
    row.reviewed_by = user.id
    row.review_note = body.note.strip()[:500]
    if body.approve:
        role_id = request.app.state.settings.discord_community_creator_role_id
        try:
            request.app.state.discord.grant_member_role(applicant.discord_id, role_id)
        except ProviderUnavailable as error:
            raise HTTPException(503, str(error)) from error
    db.add(row)
    db.add(
        AuditEvent(
            actor_id=user.id,
            event_type="creator_application_review",
            result="approved" if body.approve else "rejected",
        )
    )
    db.commit()
    return creator_application_view(row, applicant)


@router.get("/developer/community-mods")
def list_developer_community_mods(
    status: str | None = None,
    user: User = Depends(unlocked),
    db: Session = Depends(database),
):
    query = (
        select(CommunityMod, User)
        .join(User, User.id == CommunityMod.user_id)
        .order_by(CommunityMod.created_at.desc())
        .limit(200)
    )
    wanted = (status or "").strip().lower()
    if wanted in {"pending", "approved", "rejected"}:
        query = query.where(CommunityMod.status == wanted)
    elif wanted in {"", "active"}:
        # Default: pending reviews + live approved catalog (not rejected).
        query = query.where(CommunityMod.status.in_(("pending", "approved")))
    rows = db.execute(query).all()
    return {
        "items": [
            {
                "id": row.id,
                "name": row.name,
                "description": row.description,
                "filename": row.filename,
                "sha256": row.sha256,
                "byte_size": row.byte_size,
                "created_at": row.created_at,
                "author": {
                    "id": author.id,
                    "display_name": author.display_name,
                    "discord_id": author.discord_id,
                },
                "status": row.status,
            }
            for row, author in rows
        ]
    }


@router.post("/developer/community-mods/{identifier}/review")
def review_community_mod(
    identifier: str,
    body: CreatorReviewInput,
    request: Request,
    background: BackgroundTasks,
    user: User = Depends(unlocked),
    db: Session = Depends(database),
):
    row = db.get(CommunityMod, identifier)
    if row is None:
        raise HTTPException(404, "Community mod not found")
    if row.status != "pending":
        raise HTTPException(409, "This community mod was already reviewed")
    row.status = "approved" if body.approve else "rejected"
    row.review_note = body.note.strip()[:500]
    if body.approve:
        row.ai_info_status = "queued"
        row.ai_info_error = ""
        row.ai_info_report = None
    db.add(row)
    db.add(
        AuditEvent(
            actor_id=user.id,
            event_type="community_mod_review",
            result="approved" if body.approve else "rejected",
        )
    )
    db.commit()
    if body.approve:
        from .community_mod_ai import generate_community_mod_ai_info

        background.add_task(generate_community_mod_ai_info, request.app, row.id)
    return {
        "id": row.id,
        "status": row.status,
        "review_note": row.review_note,
        "ai_info_status": row.ai_info_status if body.approve else "idle",
    }


@router.delete("/developer/community-mods/{identifier}", status_code=204)
def delete_community_mod(
    identifier: str,
    user: User = Depends(unlocked),
    db: Session = Depends(database),
):
    row = db.get(CommunityMod, identifier)
    if row is None:
        raise HTTPException(404, "Community mod not found")
    db.delete(row)
    db.add(AuditEvent(actor_id=user.id, event_type="community_mod_remove", result="success"))
    db.commit()


def background_track_view(row: BackgroundTrack):
    return {
        "id": row.id,
        "title": row.title,
        "artist": row.artist or "",
        "filename": row.filename,
        "sha256": row.sha256,
        "byte_size": row.byte_size,
        "created_at": row.created_at,
        "stream_url": f"/v1/background-tracks/{row.id}/stream",
    }


@router.get("/developer/background-tracks")
def developer_background_tracks(user: User = Depends(unlocked), db: Session = Depends(database)):
    rows = db.scalars(select(BackgroundTrack).order_by(BackgroundTrack.created_at.desc()).limit(100))
    return {"items": [background_track_view(row) for row in rows]}


@router.post("/developer/background-tracks", status_code=201)
async def upload_background_track(
    request: Request,
    title: str = Query(min_length=1, max_length=120),
    artist: str = Query(default="", max_length=120),
    filename: str = Query(min_length=5, max_length=180),
    user: User = Depends(unlocked),
    db: Session = Depends(database),
):
    title = title.strip()
    artist = artist.strip()
    if not title:
        raise HTTPException(422, "Title is required")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._ -]*\.mp3", filename, re.IGNORECASE):
        raise HTTPException(422, "Upload an MP3 with a safe filename")
    count = int(db.scalar(select(func.count()).select_from(BackgroundTrack)) or 0)
    if count >= 50:
        raise HTTPException(429, "Background track catalog is full (50 max)")
    artifact = await request.body()
    if not artifact or len(artifact) > 8 * 1024 * 1024:
        raise HTTPException(413, "MP3 must be between 1 byte and 8 MB")
    # Soft MP3 check — ID3 tag or MPEG frame sync.
    looks_mp3 = artifact[:3] == b"ID3" or artifact[0:1] == b"\xff" or artifact[0:2] == b"\xff\xfb"
    if not looks_mp3 and len(artifact) < 128:
        raise HTTPException(422, "File does not look like an MP3")
    existing = db.scalar(select(BackgroundTrack).where(BackgroundTrack.filename == filename))
    if existing:
        raise HTTPException(409, "A track already uses that filename")
    row = BackgroundTrack(
        title=title,
        artist=artist,
        filename=filename,
        sha256=hashlib.sha256(artifact).hexdigest(),
        byte_size=len(artifact),
        artifact=artifact,
        created_by=user.id,
    )
    db.add(row)
    db.add(AuditEvent(actor_id=user.id, event_type="background_track_add", result="success"))
    db.commit()
    return background_track_view(row)


@router.delete("/developer/background-tracks/{identifier}", status_code=204)
def delete_background_track(
    identifier: str,
    user: User = Depends(unlocked),
    db: Session = Depends(database),
):
    row = db.get(BackgroundTrack, identifier)
    if not row:
        raise HTTPException(404, "Track not found")
    db.delete(row)
    db.add(AuditEvent(actor_id=user.id, event_type="background_track_remove", result="success"))
    db.commit()


@router.get("/background-tracks")
def list_background_tracks(user: User = Depends(require_member), db: Session = Depends(database)):
    rows = db.scalars(select(BackgroundTrack).order_by(BackgroundTrack.title).limit(100))
    return {"items": [background_track_view(row) for row in rows]}


@router.get("/background-tracks/{identifier}/stream")
def stream_background_track(
    identifier: str,
    user: User = Depends(require_member),
    db: Session = Depends(database),
):
    row = db.get(BackgroundTrack, identifier)
    if not row:
        raise HTTPException(404, "Track not found")
    safe_name = row.filename.replace('"', "")
    return Response(
        row.artifact,
        media_type="audio/mpeg",
        headers={
            "Content-Disposition": f'inline; filename="{safe_name}"',
            "Cache-Control": "private, max-age=3600",
            "X-Content-Type-Options": "nosniff",
            "Accept-Ranges": "bytes",
        },
    )
