"""Scheduled weekend Robux sale for the Engine + Tracker bundle.

Window (America/New_York):
- Starts Friday 16:00
- Ends Monday 00:00 (covers all of Sunday through Sunday midnight)
"""

from __future__ import annotations

from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

SALE_TZ = ZoneInfo("America/New_York")
UTC = ZoneInfo("UTC")
WEEKEND_BUNDLE_ASSET_ID = "140291726071649"
WEEKEND_BUNDLE_CATALOG_URL = (
    "https://www.roblox.com/catalog/140291726071649/ii-Engine-Pro-ii-Tracker-Weekend"
)
WEEKEND_BUNDLE_PRICE = 2700
REGULAR_BUNDLE_PRICE = 3250
WINDOW_LABEL = "Fri 4 PM – Sun midnight ET"


def _as_utc(now: datetime | None) -> datetime:
    moment = now or datetime.now(UTC)
    if moment.tzinfo is None:
        return moment.replace(tzinfo=UTC)
    return moment.astimezone(UTC)


def _friday_start_on_or_before(local: datetime) -> datetime:
    """Friday 16:00 ET of the week that contains `local`'s Friday anchor."""
    days_since_friday = (local.weekday() - 4) % 7
    friday_date = (local - timedelta(days=days_since_friday)).date()
    return datetime(
        friday_date.year,
        friday_date.month,
        friday_date.day,
        16,
        0,
        0,
        tzinfo=SALE_TZ,
    )


def sale_window_for(now: datetime | None = None) -> tuple[datetime, datetime]:
    """Active-or-most-recent window: Fri 16:00 ET → Mon 00:00 ET."""
    local = _as_utc(now).astimezone(SALE_TZ)
    start = _friday_start_on_or_before(local)
    # If local is before this week's Friday 4pm, the current/most-recent window is last week.
    if local < start:
        start = start - timedelta(days=7)
    end = start + timedelta(days=2, hours=8)  # Fri 16:00 + 56h = Mon 00:00
    return start, end


def next_sale_start(now: datetime | None = None) -> datetime:
    local = _as_utc(now).astimezone(SALE_TZ)
    candidate = _friday_start_on_or_before(local)
    if local < candidate:
        return candidate
    return candidate + timedelta(days=7)


def is_weekend_sale_active(now: datetime | None = None) -> bool:
    moment = _as_utc(now)
    start, end = sale_window_for(moment)
    local = moment.astimezone(SALE_TZ)
    return start <= local < end


def weekend_sale_status(now: datetime | None = None) -> dict:
    moment = _as_utc(now)
    start, end = sale_window_for(moment)
    active = is_weekend_sale_active(moment)
    nxt = next_sale_start(moment)
    return {
        "active": active,
        "timezone": "America/New_York",
        "window_label": WINDOW_LABEL,
        "price": WEEKEND_BUNDLE_PRICE,
        "regular_price": REGULAR_BUNDLE_PRICE,
        "asset_id": WEEKEND_BUNDLE_ASSET_ID,
        "catalog_url": WEEKEND_BUNDLE_CATALOG_URL,
        "starts_at": start.isoformat(),
        "ends_at": end.isoformat(),
        "next_starts_at": nxt.isoformat(),
        "hint": (
            "Weekend deal live — Engine + Tracker is 2,700 R$ until Sunday midnight ET."
            if active
            else (
                "Want a discount? Engine + Tracker drops to 2,700 R$ every weekend "
                "(Fri 4 PM – Sun midnight ET). You can buy the sale item early and claim "
                "when the window opens."
            )
        ),
    }
