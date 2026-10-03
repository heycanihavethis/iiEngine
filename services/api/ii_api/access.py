"""Membership privilege helpers shared across AI, telemetry, and other caps."""

from __future__ import annotations

# Discord role that lifts normal daily allowances (still bound by the hard ceiling).
DEFAULT_UNCAPPED_ROLE_ID = "1555606816291954819"

UNCAPPED_ENTITLEMENTS = frozenset({"owner", "admin", "uncapped"})


def member_has_uncapped_limits(member: dict | None, *, uncapped_role_ids: str | None = None) -> bool:
    """True for owners, admins, or holders of the Discord uncapped role/entitlement."""
    if not member:
        return False
    entitlements = {str(item) for item in (member.get("entitlements") or [])}
    if entitlements & UNCAPPED_ENTITLEMENTS:
        return True
    role_ids = {str(item) for item in (member.get("role_ids") or [])}
    configured = uncapped_role_ids if uncapped_role_ids is not None else DEFAULT_UNCAPPED_ROLE_ID
    wanted = {part.strip() for part in configured.split(",") if part.strip()}
    return bool(role_ids & wanted)
