"""Response contracts exported through OpenAPI for the desktop client."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


class RoleView(BaseModel):
    id: str
    name: str
    color: str
    emoji: str | None = None
    icon_url: str | None = None
    position: int


class MemberView(BaseModel):
    display_name: str
    avatar: str | None = None
    membership: bool
    roles: list[RoleView]
    entitlements: list[
        Literal[
            "user",
            "beta",
            "full_access",
            "pro",
            "developer",
            "admin",
            "owner",
            "ii_tracker",
            "ii_tracker_beta",
        ]
    ]


class AnnouncementView(BaseModel):
    id: str
    channel: str
    source: str
    author: str
    text: str
    timestamp: datetime
    url: str | None
    images: list[str] = Field(default_factory=list)
    avatar: str | None = None
    mentions: dict[str, str] = Field(default_factory=dict)
    author_color: str | None = None
    author_emoji: str | None = None
    edited_at: datetime | None = None
    pinned: bool = False


class FeedView(BaseModel):
    items: list[AnnouncementView]
    stale: bool
    unavailable: bool
    next_cursor: str | None
    can_moderate: bool = False
    pinned_ids: list[str] = Field(default_factory=list)


class ReleaseView(BaseModel):
    version: str
    channel: Literal["stable", "beta", "developer"]
    signature: str
    published_at: datetime | None
    sha256: str | None = None
    byte_size: int | None = None
    download_url: str | None = None
    release_url: str | None = None
    canonical_filename: str | None = None
    baseline_id: str | None = None


class DashboardView(BaseModel):
    demo: bool
    member: MemberView
    release: ReleaseView
    announcements: list[AnnouncementView]
    announcements_stale: bool = False
