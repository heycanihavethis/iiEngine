from datetime import UTC, date, datetime
from uuid import uuid4

from sqlalchemy import (
    JSON,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Integer,
    LargeBinary,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


def now():
    return datetime.now(UTC)


def identifier():
    return str(uuid4())


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=identifier)
    discord_id: Mapped[str] = mapped_column(String(20), unique=True)
    display_name: Mapped[str] = mapped_column(String(100))
    avatar: Mapped[str | None] = mapped_column(String(300))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    last_login_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class AuthRequest(Base):
    __tablename__ = "auth_requests"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    challenge: Mapped[str] = mapped_column(String(64))
    state_hash: Mapped[str] = mapped_column(String(64), unique=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    state_used: Mapped[bool] = mapped_column(default=False)
    consumed: Mapped[bool] = mapped_column(default=False)
    status: Mapped[str] = mapped_column(String(20), default="pending")
    user_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))


class RefreshSession(Base):
    __tablename__ = "refresh_sessions"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=identifier)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    family_id: Mapped[str] = mapped_column(String(36), index=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    replaced_by: Mapped[str | None] = mapped_column(String(36))
    device_label: Mapped[str] = mapped_column(String(80), default="Windows desktop")


class RoleGrant(Base):
    __tablename__ = "role_grants"
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    granted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    removed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Last-known Discord membership snapshot so Engine stays usable when Discord is down.
    entitlements: Mapped[list | None] = mapped_column(JSON)
    role_ids: Mapped[list | None] = mapped_column(JSON)
    roles: Mapped[list | None] = mapped_column(JSON)


class AIUsageDaily(Base):
    __tablename__ = "ai_usage_daily"
    __table_args__ = (CheckConstraint("request_count >= 0 AND request_count <= 500"),)
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    utc_date: Mapped[date] = mapped_column(primary_key=True)
    request_count: Mapped[int] = mapped_column(default=0)


class AnnouncementCache(Base):
    __tablename__ = "announcement_cache"
    __table_args__ = (UniqueConstraint("channel_id", "message_id"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=identifier)
    channel_id: Mapped[str] = mapped_column(String(20), index=True)
    message_id: Mapped[str] = mapped_column(String(20))
    payload: Mapped[dict] = mapped_column(JSON)
    published_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    edited_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    cached_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class AIReservation(Base):
    __tablename__ = "ai_reservations"
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    utc_date: Mapped[date] = mapped_column()
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class AIBucketUsage(Base):
    """Separate daily counters for community /ai and home assistant (not the Studio quota)."""

    __tablename__ = "ai_bucket_usage"
    __table_args__ = (CheckConstraint("request_count >= 0 AND request_count <= 500"),)
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    utc_date: Mapped[date] = mapped_column(primary_key=True)
    bucket: Mapped[str] = mapped_column(String(40), primary_key=True)
    request_count: Mapped[int] = mapped_column(default=0)


class AIBucketReservation(Base):
    __tablename__ = "ai_bucket_reservations"
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    utc_date: Mapped[date] = mapped_column()
    bucket: Mapped[str] = mapped_column(String(40), index=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class AuditEvent(Base):
    __tablename__ = "audit_events"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=identifier)
    event_type: Mapped[str] = mapped_column(String(60))
    actor_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    result: Mapped[str] = mapped_column(String(80))
    timestamp: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, index=True)


class DeveloperAccess(Base):
    __tablename__ = "developer_access"
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    attempts: Mapped[int] = mapped_column(default=0)
    locked_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class ManagedContent(Base):
    __tablename__ = "managed_content"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=identifier)
    kind: Mapped[str] = mapped_column(String(20))
    title: Mapped[str] = mapped_column(String(120))
    payload: Mapped[dict] = mapped_column(JSON)
    revision: Mapped[int] = mapped_column(default=1)
    published_payload: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    published_title: Mapped[str | None] = mapped_column(String(120))
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    updated_by: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))


class PlatformSetting(Base):
    __tablename__ = "platform_settings"
    key: Mapped[str] = mapped_column(String(40), primary_key=True)
    value: Mapped[dict] = mapped_column(JSON)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    updated_by: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))


class ReleaseCandidate(Base):
    __tablename__ = "release_candidates"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=identifier)
    version: Mapped[str] = mapped_column(String(80), index=True)
    filename: Mapped[str] = mapped_column(String(180))
    sha256: Mapped[str] = mapped_column(String(64))
    byte_size: Mapped[int]
    artifact: Mapped[bytes] = mapped_column(LargeBinary)
    status: Mapped[str] = mapped_column(String(30), default="awaiting_publish")
    display_name: Mapped[str] = mapped_column(String(120), default="")
    changelog: Mapped[dict] = mapped_column(JSON, default=dict)
    release_notes: Mapped[str] = mapped_column(String(6000), default="")
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)
    published_by: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    created_by: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))


class TrustedMod(Base):
    __tablename__ = "trusted_mods"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=identifier)
    name: Mapped[str] = mapped_column(String(120))
    description: Mapped[str] = mapped_column(String(1000))
    filename: Mapped[str] = mapped_column(String(180), unique=True)
    sha256: Mapped[str] = mapped_column(String(64))
    byte_size: Mapped[int]
    artifact: Mapped[bytes] = mapped_column(LargeBinary)
    thumbnail: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)
    thumbnail_mime: Mapped[str | None] = mapped_column(String(40), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    created_by: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))


class StudioTemplate(Base):
    __tablename__ = "studio_templates"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=identifier)
    name: Mapped[str] = mapped_column(String(120))
    description: Mapped[str] = mapped_column(String(1000))
    filename: Mapped[str] = mapped_column(String(180), unique=True)
    sha256: Mapped[str] = mapped_column(String(64))
    byte_size: Mapped[int]
    artifact: Mapped[bytes] = mapped_column(LargeBinary)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    created_by: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))


class CommunityMessage(Base):
    __tablename__ = "community_messages"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=identifier)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    category: Mapped[str] = mapped_column(String(20), default="chat")
    body: Mapped[str] = mapped_column(String(800))
    anonymous: Mapped[bool] = mapped_column(default=False)
    is_assistant: Mapped[bool] = mapped_column(default=False)
    author_role_name: Mapped[str | None] = mapped_column(String(100), nullable=True)
    author_role_color: Mapped[str | None] = mapped_column(String(7), nullable=True)
    mentioned_user_ids: Mapped[list | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, index=True)


class CommunityMod(Base):
    __tablename__ = "community_mods"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=identifier)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(120))
    description: Mapped[str] = mapped_column(String(1000))
    filename: Mapped[str] = mapped_column(String(180))
    sha256: Mapped[str] = mapped_column(String(64))
    byte_size: Mapped[int]
    artifact: Mapped[bytes] = mapped_column(LargeBinary)
    thumbnail: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)
    thumbnail_mime: Mapped[str | None] = mapped_column(String(40), nullable=True)
    status: Mapped[str] = mapped_column(String(20), default="pending", index=True)
    review_note: Mapped[str] = mapped_column(String(500), default="")
    ai_info_status: Mapped[str] = mapped_column(String(20), default="idle")
    ai_info_report: Mapped[str | None] = mapped_column(Text, nullable=True)
    ai_info_error: Mapped[str] = mapped_column(String(300), default="")
    ai_info_updated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, index=True)


class FeatureUsageEvent(Base):
    __tablename__ = "feature_usage_events"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=identifier)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    feature_key: Mapped[str] = mapped_column(String(40), index=True)
    detail: Mapped[str] = mapped_column(String(200), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, index=True)


class ModVote(Base):
    __tablename__ = "mod_votes"
    __table_args__ = (
        UniqueConstraint("user_id", "target_type", "target_id", name="uq_mod_votes_user_target"),
    )
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=identifier)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    target_type: Mapped[str] = mapped_column(String(20), index=True)  # trusted | community
    target_id: Mapped[str] = mapped_column(String(36), index=True)
    value: Mapped[int] = mapped_column(Integer)  # 1 or -1
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, onupdate=now)


class CreatorApplication(Base):
    __tablename__ = "creator_applications"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=identifier)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    pitch: Mapped[str] = mapped_column(String(2000))
    experience: Mapped[str] = mapped_column(String(1000))
    status: Mapped[str] = mapped_column(String(20), default="pending")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, index=True)
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    reviewed_by: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    review_note: Mapped[str] = mapped_column(String(500), default="")


class InviteCampaign(Base):
    """One-time invite drive: 4 authorized invitees unlock Pro trials."""

    __tablename__ = "invite_campaigns"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=identifier)
    inviter_user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), unique=True, index=True
    )
    code_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    code_prefix: Mapped[str] = mapped_column(String(8))
    # Stored so the inviter can re-open their code in Settings (owner-only API).
    code_plain: Mapped[str | None] = mapped_column(String(32))
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class InviteRedemption(Base):
    __tablename__ = "invite_redemptions"
    __table_args__ = (UniqueConstraint("invitee_user_id"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=identifier)
    campaign_id: Mapped[str] = mapped_column(
        ForeignKey("invite_campaigns.id", ondelete="CASCADE"), index=True
    )
    invitee_user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    authorized_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class ProTrial(Base):
    __tablename__ = "pro_trials"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=identifier)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    source: Mapped[str] = mapped_column(String(40))
    role_id: Mapped[str] = mapped_column(String(20))
    had_pro_before: Mapped[bool] = mapped_column(default=False)
    starts_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class TrackerPresence(Base):
    __tablename__ = "tracker_presences"
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    username: Mapped[str] = mapped_column(String(100), default="")
    room_code: Mapped[str] = mapped_column(String(32), default="")
    in_room: Mapped[bool] = mapped_column(default=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now, index=True)


class TrackerSighting(Base):
    """Lobby / rare-cosmetic sightings mirrored from the Discord tracker channels.

    Rows older than 5 days are permanently deleted; a player reappears only when
    seen again in a fresh Discord hit.
    """

    __tablename__ = "tracker_sightings"
    id: Mapped[str] = mapped_column(String(120), primary_key=True)
    player_id: Mapped[str] = mapped_column(String(64), default="", index=True)
    username: Mapped[str] = mapped_column(String(100), default="")
    room: Mapped[str] = mapped_column(String(32), default="")
    region: Mapped[str] = mapped_column(String(16), default="")
    cosmetic: Mapped[str] = mapped_column(String(200), default="")
    color: Mapped[str] = mapped_column(String(64), default="")
    platform: Mapped[str] = mapped_column(String(32), default="")
    track_kind: Mapped[str] = mapped_column(String(16), default="player", index=True)
    author: Mapped[str] = mapped_column(String(100), default="")
    avatar: Mapped[str | None] = mapped_column(String(300))
    text: Mapped[str] = mapped_column(Text, default="")
    embed_title: Mapped[str] = mapped_column(String(200), default="")
    seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class AppearancePresetShare(Base):
    """Short share codes for Customize presets (Pro import)."""

    __tablename__ = "appearance_preset_shares"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=identifier)
    code: Mapped[str] = mapped_column(String(16), unique=True, index=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    payload: Mapped[dict] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)


class BackgroundTrack(Base):
    """Staff-uploaded quiet background music presets for Engine."""

    __tablename__ = "background_tracks"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=identifier)
    title: Mapped[str] = mapped_column(String(120))
    artist: Mapped[str] = mapped_column(String(120), default="")
    filename: Mapped[str] = mapped_column(String(180), unique=True)
    sha256: Mapped[str] = mapped_column(String(64))
    byte_size: Mapped[int]
    artifact: Mapped[bytes] = mapped_column(LargeBinary)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    created_by: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))


class RobloxGamepassClaim(Base):
    """Links a Discord Engine user to a Roblox account for lifetime Pro catalog claims."""

    __tablename__ = "roblox_gamepass_claims"
    __table_args__ = (UniqueConstraint("roblox_user_id"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=identifier)
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), unique=True, index=True
    )
    roblox_user_id: Mapped[str] = mapped_column(String(20), index=True)
    roblox_username: Mapped[str] = mapped_column(String(40))
    claimed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_checked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
