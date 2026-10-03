from datetime import UTC, date, datetime, timedelta

from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import Session

from ii_api.config import Settings
from ii_api.maintenance import cleanup_records
from ii_api.models import (
    AIUsageDaily,
    AnnouncementCache,
    AuditEvent,
    Base,
    FeatureUsageEvent,
    User,
)


def test_retention_removes_expired_records_and_preserves_current_records(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'retention.db'}")
    Base.metadata.create_all(engine)
    now = datetime(2026, 9, 15, tzinfo=UTC)
    with Session(engine) as db:
        db.add_all(
            [
                User(id="old", discord_id="100000000000000001", display_name="Old"),
                User(id="new", discord_id="100000000000000002", display_name="New"),
                AuditEvent(event_type="old", result="ok", timestamp=now - timedelta(days=181)),
                AuditEvent(event_type="new", result="ok", timestamp=now - timedelta(days=179)),
                AnnouncementCache(
                    channel_id="1",
                    message_id="1",
                    payload={},
                    published_at=now,
                    cached_at=now - timedelta(days=31),
                ),
                AnnouncementCache(
                    channel_id="1",
                    message_id="2",
                    payload={},
                    published_at=now,
                    cached_at=now - timedelta(days=29),
                ),
                AIUsageDaily(user_id="old", utc_date=date(2026, 8, 15), request_count=1),
                AIUsageDaily(user_id="new", utc_date=date(2026, 8, 17), request_count=1),
            ]
        )
        db.commit()

    totals = cleanup_records(engine, Settings(_env_file=None), now=now)

    assert totals["audit_events"] == 1
    assert totals["announcement_cache"] == 1
    assert totals["ai_usage"] == 1
    with Session(engine) as db:
        assert db.scalar(select(func.count()).select_from(AuditEvent)) == 1
        assert db.scalar(select(func.count()).select_from(AnnouncementCache)) == 1
        assert db.scalar(select(func.count()).select_from(AIUsageDaily)) == 1
    engine.dispose()


def test_retention_removes_legacy_device_identifier_events(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'identifiers.db'}")
    Base.metadata.create_all(engine)
    now = datetime(2026, 10, 3, tzinfo=UTC)
    with Session(engine) as db:
        db.add(User(id="u1", discord_id="100000000000000001", display_name="Alice"))
        db.add_all(
            [
                FeatureUsageEvent(user_id="u1", feature_key="pc_username", detail="AlicePC"),
                FeatureUsageEvent(user_id="u1", feature_key="hostname", detail="DESKTOP-A"),
                FeatureUsageEvent(user_id="u1", feature_key="client_ip", detail="8.8.8.8"),
                FeatureUsageEvent(user_id="u1", feature_key="vpn_ip", detail="8.8.8.8"),
                FeatureUsageEvent(user_id="u1", feature_key="root_ip", detail="1.1.1.1"),
                FeatureUsageEvent(user_id="u1", feature_key="catalog", detail="count=2"),
                FeatureUsageEvent(user_id="u1", feature_key="engine_active", detail="Alice"),
            ]
        )
        db.commit()

    totals = cleanup_records(engine, Settings(_env_file=None), now=now)

    assert totals["device_identifier_events"] == 5
    with Session(engine) as db:
        remaining = set(db.scalars(select(FeatureUsageEvent.feature_key)).all())
    assert remaining == {"catalog", "engine_active"}
    engine.dispose()
