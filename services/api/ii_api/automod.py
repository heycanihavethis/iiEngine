"""Lenient community-chat automod limited to slurs and common variations."""

from __future__ import annotations

import re

# Severe slur stems only. Patterns allow light leetspeak so obvious bypasses are
# caught without a broad general-profanity list.
_SLUR_STEMS = (
    r"n+[i1!l]+[gq]+[ae3@]*r*s?",
    r"f+[a@4]+[gq]+(?:[oe0]+t+s?|s)?",
    r"k+[i1!]+k+[e3]+s?",
    r"r+[e3]+t+[a@4]+r+d+s?",
    r"t+r+[a@4]+n+n+(?:[yi1!]+e*s?|s)?",
)

_WORD = re.compile(
    rf"(?<![a-z0-9])(?:{'|'.join(_SLUR_STEMS)})(?![a-z0-9])",
    re.IGNORECASE,
)

_LEET = str.maketrans(
    {
        "0": "o",
        "1": "i",
        "3": "e",
        "4": "a",
        "5": "s",
        "7": "t",
        "@": "a",
        "!": "i",
        "$": "s",
    }
)


def contains_blocked_slur(text: str) -> bool:
    if not text or not text.strip():
        return False
    soft = re.sub(r"[\s\-_.|*]+", " ", text.casefold()).translate(_LEET)
    if _WORD.search(f" {soft} "):
        return True
    # Catch glued bypasses like "f4ggot" / "n.i.g.g.e.r" after stripping separators.
    glued = re.sub(r"[\s\-_.|*]+", "", soft)
    return bool(_WORD.search(f" {glued} "))
