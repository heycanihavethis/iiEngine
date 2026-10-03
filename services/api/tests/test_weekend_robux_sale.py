"""Weekend Robux sale window helpers."""

from datetime import datetime
from zoneinfo import ZoneInfo

from ii_api.weekend_robux_sale import (
    WEEKEND_BUNDLE_ASSET_ID,
    WEEKEND_BUNDLE_PRICE,
    is_weekend_sale_active,
    next_sale_start,
    weekend_sale_status,
)

ET = ZoneInfo("America/New_York")


def test_weekend_sale_active_friday_evening_through_sunday():
    # Friday 4:00 PM ET
    assert is_weekend_sale_active(datetime(2026, 10, 2, 16, 0, tzinfo=ET))
    # Saturday noon
    assert is_weekend_sale_active(datetime(2026, 10, 3, 12, 0, tzinfo=ET))
    # Sunday 11:59 PM ET still active
    assert is_weekend_sale_active(datetime(2026, 10, 4, 23, 59, tzinfo=ET))
    # Monday 00:00 ET closed
    assert not is_weekend_sale_active(datetime(2026, 10, 5, 0, 0, tzinfo=ET))
    # Thursday afternoon closed
    assert not is_weekend_sale_active(datetime(2026, 10, 1, 15, 0, tzinfo=ET))


def test_weekend_sale_status_payload_and_next_start():
    thursday = datetime(2026, 10, 1, 12, 0, tzinfo=ET)
    status = weekend_sale_status(thursday)
    assert status["active"] is False
    assert status["price"] == WEEKEND_BUNDLE_PRICE
    assert status["asset_id"] == WEEKEND_BUNDLE_ASSET_ID
    assert status["window_label"].startswith("Fri 4 PM")
    nxt = next_sale_start(thursday)
    assert nxt == datetime(2026, 10, 2, 16, 0, tzinfo=ET)

    friday_live = datetime(2026, 10, 2, 17, 0, tzinfo=ET)
    live = weekend_sale_status(friday_live)
    assert live["active"] is True
    assert "2,700" in live["hint"] or "2700" in live["hint"].replace(",", "")
