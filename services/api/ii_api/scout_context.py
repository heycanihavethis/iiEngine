"""Extra Scout context: fur colors, ghost-troll rooms, and intent expansion."""

from __future__ import annotations

import colorsys
import re

# Common Gorilla Tag ghost / troll / bait lobby codes (uppercase). Expanded over time.
GHOST_TROLL_ROOMS: tuple[str, ...] = (
    "J3VU",
    "DAISY09",
    "DAISY",
    "GHOST",
    "GHOST1",
    "GHOST2",
    "TOXIC",
    "TOXIC1",
    "CODERD",
    "CODE99",
    "BANANA",
    "MONKE",
    "MONKEY",
    "TROLL",
    "TROLL1",
    "TROLL2",
    "BAIT",
    "BAIT1",
    "SCAM",
    "FREE",
    "FREE1",
    "VIP",
    "VIP1",
    "MOD",
    "ADMIN",
    "OWNER",
    "STAFF",
    "HACK",
    "HACKER",
    "CHEAT",
    "REPORT",
    "MUTED",
    "BANNED",
    "SUS",
    "L",
    "RATIO",
    "SKID",
    "EZ",
    "NZ",
    "GG",
    "RR",
    "WTF",
    "LOL",
    "OMG",
    "POOP",
    "FART",
    "STINKY",
    "SMELLY",
    "CRINGE",
    "NPC",
    "BOT",
    "FAKE",
    "REAL",
    "TRUST",
    "SAFE",
    "JOIN",
    "JOINME",
    "COME",
    "HERE",
    "PARTY",
    "PARTY1",
    "CHILL",
    "CHILL1",
    "VOID",
    "SHADOW",
    "NIGHT",
    "DARK",
    "SPOOKY",
    "HAUNT",
    "CREEP",
    "SCARE",
    "BOO",
    "YEEK",
    "YEET",
    "NOOB",
    "PRO",
    "TRYHARD",
    "SWEAT",
    "SWEATY",
    "BOXING",
    "FIST",
    "FIGHT",
    "1V1",
    "2V2",
    "WAR",
    "RAID",
    "GRIEF",
    "DESTROY",
    "CRASH",
    "LAG",
    "PING",
    "RAGE",
    "MAD",
    "CRY",
)

# Named fur colors → approximate RGB samples (Gorilla Tag palette leaning).
COLOR_NAME_SAMPLES: dict[str, list[tuple[int, int, int]]] = {
    "blue": [(30, 90, 220), (60, 140, 255), (100, 180, 255), (0, 120, 255), (40, 60, 200)],
    "red": [(220, 40, 40), (255, 60, 60), (200, 20, 20), (255, 100, 80)],
    "green": [(40, 180, 70), (20, 140, 50), (80, 220, 100), (0, 200, 80)],
    "yellow": [(240, 210, 40), (255, 230, 60), (220, 180, 20)],
    "orange": [(255, 140, 30), (255, 100, 0), (230, 120, 20), (255, 160, 60)],
    "purple": [(150, 60, 220), (120, 40, 180), (180, 100, 255), (100, 0, 160)],
    "pink": [(255, 120, 180), (255, 80, 160), (230, 100, 170), (255, 160, 200)],
    "white": [(245, 245, 245), (230, 230, 230), (255, 255, 255), (220, 220, 220)],
    "black": [(20, 20, 20), (35, 35, 35), (10, 10, 10), (50, 50, 50)],
    "brown": [(120, 70, 35), (90, 50, 25), (150, 90, 50)],
    "cyan": [(40, 220, 230), (0, 200, 220), (80, 240, 255)],
    "teal": [(20, 160, 160), (40, 180, 170)],
    "lime": [(140, 255, 40), (100, 230, 30)],
    "gold": [(230, 190, 50), (255, 200, 60)],
    "gray": [(120, 120, 120), (150, 150, 150), (90, 90, 90)],
    "grey": [(120, 120, 120), (150, 150, 150), (90, 90, 90)],
}

_COLOR_WORD_RE = re.compile(
    r"\b(blue|red|green|yellow|orange|purple|pink|white|black|brown|cyan|teal|lime|gold|gray|grey)\b",
    re.IGNORECASE,
)
_GHOST_INTENT_RE = re.compile(
    r"\b(ghost\s*troll|ghosting|ghost\s*codes?|troll\s*codes?|bait\s*(lobby|codes?|room)|"
    r"toxic\s*(lobby|codes?|room)|scam\s*(lobby|codes?)?|fake\s*(mod|admin|owner)|"
    r"people\s*to\s*(ghost|troll)|someone\s*to\s*(ghost|troll)|"
    r"find\s*(a\s*)?(ghost|troll|bait))\b",
    re.IGNORECASE,
)
_COOL_ONLINE_RE = re.compile(
    r"\b(cool|interesting|fun|wild|active|busy|lit|popping|good)\b.+\b(people|players|lobbies|rooms)?\b|"
    r"\b(who'?s|who is|anyone)\s+(online|around|on|playing)\b|"
    r"\b(show|find|give)\s+me\s+(some\s+)?(cool|interesting|random|active)\b|"
    r"\bany(one)?\s+(cool|interesting)\b",
    re.IGNORECASE,
)


def parse_rgb(color: str) -> tuple[int, int, int] | None:
    raw = (color or "").strip()
    if not raw:
        return None
    hex_match = re.fullmatch(r"#?([0-9A-Fa-f]{6})", raw)
    if hex_match:
        value = hex_match.group(1)
        return int(value[0:2], 16), int(value[2:4], 16), int(value[4:6], 16)
    parts = re.split(r"[\s,]+", raw)
    if len(parts) == 3 and all(part.isdigit() and 0 <= int(part) <= 255 for part in parts):
        return int(parts[0]), int(parts[1]), int(parts[2])
    return None


def color_distance(a: tuple[int, int, int], b: tuple[int, int, int]) -> float:
    return ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2) ** 0.5


def color_matches_name(color: str, name: str, *, max_distance: float = 110.0) -> bool:
    rgb = parse_rgb(color)
    if not rgb:
        return False
    key = (name or "").strip().lower()
    samples = COLOR_NAME_SAMPLES.get(key)
    if not samples:
        return key in (color or "").lower()
    if any(color_distance(rgb, sample) <= max_distance for sample in samples):
        return True
    # Hue-band fallback for saturated colors.
    r, g, b = [c / 255.0 for c in rgb]
    h, s, v = colorsys.rgb_to_hsv(r, g, b)
    if s < 0.18 and key in {"white", "gray", "grey", "black"}:
        if key == "white":
            return v > 0.82
        if key == "black":
            return v < 0.28
        return 0.25 <= v <= 0.75
    if s < 0.22:
        return False
    hue = h * 360
    bands = {
        "red": (hue <= 18 or hue >= 345),
        "orange": 18 <= hue <= 45,
        "yellow": 45 <= hue <= 70,
        "lime": 70 <= hue <= 100,
        "green": 90 <= hue <= 160,
        "teal": 160 <= hue <= 185,
        "cyan": 170 <= hue <= 200,
        "blue": 190 <= hue <= 255,
        "purple": 255 <= hue <= 310,
        "pink": 310 <= hue <= 345,
        "brown": 15 <= hue <= 45 and v < 0.65,
        "gold": 40 <= hue <= 55 and v > 0.55,
    }
    return bool(bands.get(key))


def extract_color_name(question: str) -> str | None:
    match = _COLOR_WORD_RE.search(question or "")
    if not match:
        return None
    return match.group(1).lower()


def wants_ghost_troll(question: str) -> bool:
    return bool(_GHOST_INTENT_RE.search(question or ""))


def wants_cool_online(question: str) -> bool:
    return bool(_COOL_ONLINE_RE.search(question or ""))


def filter_items_by_color_name(items: list[dict], name: str) -> list[dict]:
    key = (name or "").strip().lower()
    if not key:
        return items
    return [item for item in items if color_matches_name(str(item.get("color") or ""), key)]


def ghost_room_queries(*, limit: int = 10) -> list[dict]:
    """Planner-style room queries covering popular ghost/troll codes."""
    out: list[dict] = []
    for code in GHOST_TROLL_ROOMS[: max(1, min(limit, len(GHOST_TROLL_ROOMS)))]:
        out.append({"field": "room", "q": code, "lookback_minutes": 180})
    return out
