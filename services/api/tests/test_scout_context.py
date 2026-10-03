from ii_api.ai import _infer_scout_search_plan
from ii_api.scout_context import (
    color_matches_name,
    extract_color_name,
    wants_ghost_troll,
)


def test_color_matches_blue_rgb():
    assert color_matches_name("40 120 255", "blue")
    assert color_matches_name("#2864FF", "blue")
    assert not color_matches_name("220 40 40", "blue")
    assert color_matches_name("220 40 40", "red")


def test_extract_color_and_ghost_intent():
    assert extract_color_name("find me blue players") == "blue"
    assert wants_ghost_troll("people to ghost troll")
    assert wants_ghost_troll("any daisy09 ghost codes?")


def test_infer_scout_color_not_username():
    plan = _infer_scout_search_plan("find me blue players")
    assert plan is not None
    assert plan["queries"][0]["field"] == "color"
    assert plan["queries"][0]["q"] == "blue"


def test_infer_scout_ghost_expands_rooms():
    plan = _infer_scout_search_plan("find people to ghost troll")
    assert plan is not None
    rooms = [row["q"] for row in plan["queries"] if row.get("field") == "room"]
    assert "J3VU" in rooms
    assert "DAISY09" in rooms
    assert len(rooms) >= 5


def test_infer_scout_cool_online():
    plan = _infer_scout_search_plan("who are some cool people online")
    assert plan is not None
    assert plan["queries"][0]["field"] == "any"
    assert plan["queries"][0]["lookback_minutes"] <= 90
