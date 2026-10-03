import json
from datetime import UTC, datetime, timedelta

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from ii_api.models import Base, FeatureUsageEvent, RobloxGamepassClaim, User
from ii_api.telemetry import (
    build_hourly_rollup,
    extract_bepinex_errors,
    summarize_sales_messages,
    usage_stats,
)


def test_extract_bepinex_errors_keeps_nearby_context():
    text = "ok\n[Error : BepInEx] NullReference\nSystem.Exception: boom\n at Mod.Foo()\ninfo\n"
    extracted = extract_bepinex_errors(text)
    assert "NullReference" in extracted
    assert "boom" in extracted


def test_hourly_rollup_lists_unique_users_and_features():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    with Session(engine) as db:
        a = User(id="u1", discord_id="1", display_name="Alice")
        b = User(id="u2", discord_id="2", display_name="Bob")
        db.add_all([a, b])
        db.add_all(
            [
                FeatureUsageEvent(user_id="u1", feature_key="engine_active", detail="Alice"),
                FeatureUsageEvent(user_id="u2", feature_key="hourly_pulse", detail="Bob"),
                FeatureUsageEvent(user_id="u1", feature_key="catalog", detail="count=3"),
                FeatureUsageEvent(user_id="u2", feature_key="catalog", detail="count=1"),
                FeatureUsageEvent(user_id="u1", feature_key="mod_vote", detail="count=2"),
                FeatureUsageEvent(user_id="u1", feature_key="app_version", detail="0.2.2"),
                FeatureUsageEvent(user_id="u2", feature_key="platform", detail="Win32"),
                FeatureUsageEvent(user_id="u1", feature_key="bepinex_error", detail="count=1"),
            ]
        )
        db.commit()
        sales = {
            "available": True,
            "count": 3,
            "unique_posters": 2,
            "money_mentions": 2,
            "top_authors": [("ShopBot", 2), ("Admin", 1)],
            "snippets": ["• `ShopBot` — New sale: $14 Pro lifetime"],
        }
        payload = build_hourly_rollup(db, sales=sales)

    content = payload["content"]
    assert "🛒 **3** sales" in content
    assert payload["active_users"] == 2
    assert payload["sales_count"] == 3
    assert payload["sales_available"] is True

    embed = payload["embeds"][0]
    assert embed["title"] == "ii Engine · Hourly Pulse"
    fields = {field["name"]: field["value"] for field in embed["fields"]}
    assert "Alice" in fields["Online"] and "Bob" in fields["Online"]
    assert "`catalog`" in fields["Feature usage"]
    assert "`mod_vote`" in fields["Feature usage"]
    assert "**3** sale posts" in fields["Sales"]
    assert "0.2.2" in fields["Clients"]
    assert "Win32" in fields["Clients"]
    assert "Error-ish" in fields["Snapshot"]


def test_hourly_rollup_never_renders_legacy_identifier_rows():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    with Session(engine) as db:
        db.add(User(id="u1", discord_id="1", display_name="Alice"))
        db.add_all(
            [
                FeatureUsageEvent(user_id="u1", feature_key="hourly_pulse", detail="Alice"),
                FeatureUsageEvent(user_id="u1", feature_key="pc_username", detail="AlicePC"),
                FeatureUsageEvent(user_id="u1", feature_key="hostname", detail="DESKTOP-A"),
                FeatureUsageEvent(user_id="u1", feature_key="client_ip", detail="8.8.8.8"),
                FeatureUsageEvent(user_id="u1", feature_key="vpn_ip", detail="8.8.8.8"),
                FeatureUsageEvent(user_id="u1", feature_key="root_ip", detail="1.1.1.1"),
            ]
        )
        db.commit()
        payload = build_hourly_rollup(db, sales={"available": True, "count": 0})

    rendered = payload["content"] + json.dumps(payload["embeds"])
    for leak in ("AlicePC", "DESKTOP-A", "8.8.8.8", "1.1.1.1", "pc_username", "hostname"):
        assert leak not in rendered, rendered
    assert payload["active_users"] == 1
    fields = {field["name"]: field["value"] for field in payload["embeds"][0]["fields"]}
    assert fields["Online"] == "`Alice`"


def test_usage_stats_omits_legacy_identifier_keys():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    with Session(engine) as db:
        db.add(User(id="u1", discord_id="1", display_name="Alice"))
        db.add_all(
            [
                FeatureUsageEvent(user_id="u1", feature_key="catalog", detail="count=1"),
                FeatureUsageEvent(user_id="u1", feature_key="pc_username", detail="AlicePC"),
                FeatureUsageEvent(user_id="u1", feature_key="root_ip", detail="1.1.1.1"),
            ]
        )
        db.commit()
        features = {row["feature"] for row in usage_stats(db)["items"]}
    assert "catalog" in features
    assert features.isdisjoint({"pc_username", "root_ip"})


def test_hourly_rollup_marks_sales_unread_when_channel_hidden():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    with Session(engine) as db:
        db.add(User(id="u1", discord_id="1", display_name="Alice"))
        db.add(FeatureUsageEvent(user_id="u1", feature_key="hourly_pulse", detail="Alice"))
        db.commit()
        payload = build_hourly_rollup(
            db,
            sales={
                "available": False,
                "count": 0,
                "reason": "Sales channel unreadable (bot needs View + Read History)",
            },
        )
    fields = {field["name"]: field["value"] for field in payload["embeds"][0]["fields"]}
    assert "unreadable" in fields["Sales"]
    assert "_(unread)_" in fields["Snapshot"]


def test_hourly_rollup_includes_roblox_pro_claims():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    now = datetime.now(UTC)
    with Session(engine) as db:
        db.add(User(id="u1", discord_id="1", display_name="Alice"))
        db.add(
            RobloxGamepassClaim(
                id="c1",
                user_id="u1",
                roblox_user_id="123",
                roblox_username="AliceRblx",
                claimed_at=now - timedelta(minutes=10),
            )
        )
        db.commit()
        payload = build_hourly_rollup(
            db,
            sales={"available": True, "count": 0, "unique_posters": 0, "snippets": []},
            end=now,
        )
    assert payload["pro_claims"] == 1
    fields = {field["name"]: field["value"] for field in payload["embeds"][0]["fields"]}
    assert "Roblox Pro claims" in fields["Sales"]


def test_summarize_sales_messages_counts_and_snippets():
    summary = summarize_sales_messages(
        [
            {
                "author": {"username": "ShopBot"},
                "content": "New sale: $14 Pro lifetime",
            },
            {
                "author": {"username": "ShopBot"},
                "content": "Bundle sold for 25 USD",
            },
            {
                "author": {"global_name": "Admin"},
                "content": "",
                "embeds": [{"title": "Checkout", "description": "R$ 2500 claimed"}],
            },
        ]
    )
    assert summary["count"] == 3
    assert summary["unique_posters"] == 2
    assert summary["money_mentions"] >= 2
    assert any("$14" in line for line in summary["snippets"])


def test_post_hourly_rollup_targets_hourly_channel_and_reads_sales():
    from types import SimpleNamespace

    from ii_api.telemetry import post_hourly_rollup

    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    now = datetime.now(UTC)
    with Session(engine) as db:
        db.add(User(id="u1", discord_id="1", display_name="Alice"))
        db.add(FeatureUsageEvent(user_id="u1", feature_key="hourly_pulse", detail="Alice"))
        db.commit()

    posted = []

    class Discord:
        def list_channel_messages_between(self, channel_id, *, start, end, max_messages=500):
            assert channel_id == "1552761810523000842"
            return [
                {
                    "id": "9",
                    "timestamp": (now - timedelta(minutes=5)).isoformat(),
                    "content": "New sale: $14",
                    "author": {"username": "ShopBot"},
                }
            ]

        def post_channel_message(self, channel_id, content="", *, embeds=None):
            posted.append((channel_id, content, embeds))

    app = SimpleNamespace(
        state=SimpleNamespace(
            engine=engine,
            discord=Discord(),
            settings=SimpleNamespace(
                discord_telemetry_channel_id="1551024892965814372",
                discord_telemetry_hourly_channel_id="1554599230083965069",
                discord_sales_channel_id="1552761810523000842",
            ),
        )
    )
    assert post_hourly_rollup(app) is True
    assert posted
    channel_id, content, embeds = posted[0]
    assert channel_id == "1554599230083965069"
    assert "🛒 **1** sales" in content
    assert embeds and embeds[0]["title"] == "ii Engine · Hourly Pulse"
