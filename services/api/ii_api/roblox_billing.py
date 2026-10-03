"""Roblox catalog purchases → Discord Engine Pro / ii Tracker roles.

Flow:
1. Signed-in Discord member links their Roblox username in Plans.
2. They buy either:
   - ii Engine Pro lifetime catalog item (2,500 Robux), or
   - Tracker + Engine Pro bundle (3,250 Robux).
3. Engine verifies Asset ownership (Open Cloud inventory or public is-owned) and
   grants Discord roles permanently (Pro only, or Pro + ii Tracker for the bundle).
"""

from __future__ import annotations

from datetime import UTC, datetime
from urllib.parse import quote
import re

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from .auth import database, require_member
from .discord import ProviderUnavailable
from .models import AuditEvent, RobloxGamepassClaim, User
from .weekend_robux_sale import (
    REGULAR_BUNDLE_PRICE,
    WEEKEND_BUNDLE_ASSET_ID,
    WEEKEND_BUNDLE_CATALOG_URL,
    WEEKEND_BUNDLE_PRICE,
    is_weekend_sale_active,
    weekend_sale_status,
)

router = APIRouter(prefix="/v1/billing/roblox")

USERS_API = "https://users.roblox.com"
INVENTORY_API = "https://inventory.roblox.com"
OPEN_CLOUD_API = "https://apis.roblox.com"

# Live Marketplace item: https://www.roblox.com/catalog/93620103303755
DEFAULT_CATALOG_ASSET_ID = "93620103303755"
DEFAULT_CATALOG_URL = (
    "https://www.roblox.com/catalog/93620103303755/ii-Engine-Pro-Lifetime"
)
# Tracker + Engine bundle: https://www.roblox.com/catalog/112921567316975
DEFAULT_BUNDLE_CATALOG_ASSET_ID = "112921567316975"
DEFAULT_BUNDLE_CATALOG_URL = (
    "https://www.roblox.com/catalog/112921567316975/ii-Engine-Pro-ii-Tracker"
)
DEFAULT_SHOP_URL = "https://iistupid.com/product/ii-engine"
DEFAULT_ROBUX_PRICE = 2500
DEFAULT_BUNDLE_ROBUX_PRICE = REGULAR_BUNDLE_PRICE
DEFAULT_TRACKER_ROLE_ID = "1549151900073459752"


def _pro_role_id(settings) -> str:
    roles = [item.strip() for item in settings.discord_pro_role_ids.split(",") if item.strip()]
    if not roles or not roles[0].isdigit():
        raise HTTPException(503, "Pro role is not configured")
    return roles[0]


def _tracker_role_id(settings) -> str:
    configured = getattr(settings, "discord_ii_tracker_role_ids", "") or ""
    roles = [item.strip() for item in configured.split(",") if item.strip()]
    if roles and roles[0].isdigit():
        return roles[0]
    return DEFAULT_TRACKER_ROLE_ID


def _catalog_asset_id(settings) -> str:
    for name in ("roblox_catalog_asset_id", "roblox_gamepass_id"):
        value = (getattr(settings, name, "") or "").strip()
        if value.isdigit():
            return value
    return DEFAULT_CATALOG_ASSET_ID


def _bundle_asset_id(settings) -> str:
    value = (getattr(settings, "roblox_bundle_catalog_asset_id", "") or "").strip()
    if value.isdigit():
        return value
    return DEFAULT_BUNDLE_CATALOG_ASSET_ID


def _weekend_bundle_asset_id(settings) -> str:
    value = (getattr(settings, "roblox_weekend_bundle_catalog_asset_id", "") or "").strip()
    if value.isdigit():
        return value
    return WEEKEND_BUNDLE_ASSET_ID


def _weekend_bundle_catalog_url(settings) -> str:
    explicit = (getattr(settings, "roblox_weekend_bundle_catalog_url", "") or "").strip()
    if explicit:
        return explicit
    asset_id = _weekend_bundle_asset_id(settings)
    if asset_id == WEEKEND_BUNDLE_ASSET_ID:
        return WEEKEND_BUNDLE_CATALOG_URL
    return f"https://www.roblox.com/catalog/{asset_id}/ii-Engine-Pro-ii-Tracker-Weekend"


def _catalog_url(settings) -> str:
    explicit = (getattr(settings, "roblox_catalog_url", "") or "").strip()
    if explicit:
        return explicit
    legacy = (getattr(settings, "roblox_gamepass_url", "") or "").strip()
    if legacy and "catalog" in legacy:
        return legacy
    asset_id = _catalog_asset_id(settings)
    if asset_id == DEFAULT_CATALOG_ASSET_ID:
        return DEFAULT_CATALOG_URL
    return f"https://www.roblox.com/catalog/{asset_id}/ii-Engine-Pro-Lifetime"


def _bundle_catalog_url(settings) -> str:
    explicit = (getattr(settings, "roblox_bundle_catalog_url", "") or "").strip()
    if explicit:
        return explicit
    asset_id = _bundle_asset_id(settings)
    if asset_id == DEFAULT_BUNDLE_CATALOG_ASSET_ID:
        return DEFAULT_BUNDLE_CATALOG_URL
    return f"https://www.roblox.com/catalog/{asset_id}/ii-Engine-Pro-ii-Tracker"


def _robux_pricing(pricing: dict | None) -> tuple[int, bool, str, int | None]:
    robux_price = DEFAULT_ROBUX_PRICE
    robux_on_sale = False
    robux_sale_name = ""
    robux_was_price = None
    if isinstance(pricing, dict):
        try:
            robux_price = int(pricing.get("robux_price") or DEFAULT_ROBUX_PRICE)
        except (TypeError, ValueError):
            robux_price = DEFAULT_ROBUX_PRICE
        robux_price = max(1, min(1_000_000, robux_price))
        robux_on_sale = bool(pricing.get("robux_on_sale"))
        robux_sale_name = str(pricing.get("robux_sale_name") or "").strip()
        was = pricing.get("robux_was_price")
        try:
            robux_was_price = int(was) if was is not None else None
        except (TypeError, ValueError):
            robux_was_price = None
    return robux_price, robux_on_sale, robux_sale_name, robux_was_price


def _bundle_pricing(pricing: dict | None, *, weekend_active: bool) -> tuple[int, bool, str, int | None]:
    """Resolve bundle list price. Automatic weekend sale wins over ops overrides."""
    if weekend_active:
        return WEEKEND_BUNDLE_PRICE, True, "Weekend deal", DEFAULT_BUNDLE_ROBUX_PRICE
    bundle_price = DEFAULT_BUNDLE_ROBUX_PRICE
    on_sale = False
    sale_name = ""
    was_price = None
    if isinstance(pricing, dict):
        try:
            bundle_price = int(pricing.get("bundle_robux_price") or DEFAULT_BUNDLE_ROBUX_PRICE)
        except (TypeError, ValueError):
            bundle_price = DEFAULT_BUNDLE_ROBUX_PRICE
        bundle_price = max(1, min(1_000_000, bundle_price))
        on_sale = bool(pricing.get("bundle_robux_on_sale"))
        sale_name = str(pricing.get("bundle_robux_sale_name") or "").strip()
        was = pricing.get("bundle_robux_was_price")
        try:
            was_price = int(was) if was is not None else None
        except (TypeError, ValueError):
            was_price = None
    return bundle_price, on_sale, sale_name, was_price


def _product_cards(settings, pricing: dict | None = None) -> list[dict]:
    robux_price, robux_on_sale, robux_sale_name, robux_was_price = _robux_pricing(pricing)
    weekend = weekend_sale_status()
    weekend_active = bool(weekend["active"])
    bundle_price, bundle_on_sale, bundle_sale_name, bundle_was = _bundle_pricing(
        pricing, weekend_active=weekend_active
    )
    active_bundle_asset = (
        _weekend_bundle_asset_id(settings) if weekend_active else _bundle_asset_id(settings)
    )
    active_bundle_url = (
        _weekend_bundle_catalog_url(settings) if weekend_active else _bundle_catalog_url(settings)
    )
    return [
        {
            "id": "engine",
            "product_kind": "catalog_asset",
            "asset_id": _catalog_asset_id(settings),
            "catalog_url": _catalog_url(settings),
            "robux_price": robux_price,
            "product_name": "ii Engine Pro — Lifetime",
            "grants": ["pro"],
            "robux_on_sale": robux_on_sale,
            "robux_sale_name": robux_sale_name,
            "robux_was_price": robux_was_price,
        },
        {
            "id": "bundle",
            "product_kind": "catalog_asset",
            "asset_id": active_bundle_asset,
            "catalog_url": active_bundle_url,
            "robux_price": bundle_price,
            "product_name": "ii Engine Pro + ii Tracker — Lifetime",
            "grants": ["pro", "ii_tracker"],
            "robux_on_sale": bundle_on_sale,
            "robux_sale_name": bundle_sale_name,
            "robux_was_price": bundle_was,
            "regular_asset_id": _bundle_asset_id(settings),
            "regular_catalog_url": _bundle_catalog_url(settings),
            "weekend_asset_id": _weekend_bundle_asset_id(settings),
            "weekend_catalog_url": _weekend_bundle_catalog_url(settings),
        },
    ]


def _public_config(settings, pricing: dict | None = None) -> dict:
    products = _product_cards(settings, pricing)
    engine = products[0]
    bundle = products[1]
    weekend = weekend_sale_status()
    return {
        "configured": True,
        "product_kind": "catalog_asset",
        "asset_id": engine["asset_id"],
        "catalog_url": engine["catalog_url"],
        # Legacy keys kept so older desktop builds keep rendering a buy link.
        "gamepass_id": engine["asset_id"],
        "gamepass_url": engine["catalog_url"],
        "robux_price": engine["robux_price"],
        "shop_url": DEFAULT_SHOP_URL,
        "product_name": engine["product_name"],
        "robux_on_sale": engine["robux_on_sale"],
        "robux_sale_name": engine["robux_sale_name"],
        "robux_was_price": engine["robux_was_price"],
        "bundle_asset_id": bundle["asset_id"],
        "bundle_catalog_url": bundle["catalog_url"],
        "bundle_robux_price": bundle["robux_price"],
        "bundle_product_name": bundle["product_name"],
        "bundle_robux_on_sale": bundle["robux_on_sale"],
        "bundle_robux_sale_name": bundle["robux_sale_name"],
        "bundle_robux_was_price": bundle["robux_was_price"],
        "weekend_sale": weekend,
        "products": products,
    }


class LinkInput(BaseModel):
    # Accept pasted display names (spaces / longer) — resolve_roblox_username maps them.
    username: str = Field(min_length=1, max_length=50)


def _claim_view(row: RobloxGamepassClaim | None, settings, pricing: dict | None = None) -> dict:
    base = _public_config(settings, pricing)
    if row is None:
        return {
            **base,
            "linked": False,
            "roblox_username": None,
            "roblox_user_id": None,
            "claimed": False,
            "claimed_at": None,
            "claimed_grants": [],
            "weekend_claim_pending": False,
            "owns_weekend_item": False,
        }
    return {
        **base,
        "linked": True,
        "roblox_username": row.roblox_username,
        "roblox_user_id": row.roblox_user_id,
        "claimed": row.claimed_at is not None,
        "claimed_at": row.claimed_at,
        "claimed_grants": [],
        "weekend_claim_pending": False,
        "owns_weekend_item": False,
    }


def _roblox_row_id_name(row: dict) -> tuple[str, str] | None:
    user_id = str(row.get("id") or "")
    name = str(row.get("name") or "").strip()
    if user_id.isdigit() and name:
        return user_id, name
    return None


async def resolve_roblox_username(username: str) -> tuple[str, str]:
    """Resolve a Roblox username or display name to (user_id, canonical_username).

    Order: exact username API (incl. banned) → users search by username → users
    search by display name → profile URL redirect scrape.
    """
    raw = username.strip().lstrip("@")
    # Username-shaped candidate (no spaces); also keep the raw phrase for display-name search.
    handle = re.sub(r"\s+", "", raw)
    phrase = re.sub(r"\s+", " ", raw).strip()
    if not phrase or len(phrase) < 3:
        raise HTTPException(
            422,
            "Enter your Roblox username or display name (at least 3 characters).",
        )
    if len(phrase) > 50:
        raise HTTPException(422, "That name is too long. Paste the username from your profile.")

    handle_ok = bool(handle) and len(handle) <= 20 and re.fullmatch(r"[A-Za-z0-9_]+", handle)

    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(20.0, connect=10.0),
            follow_redirects=False,
            headers={"User-Agent": "ii-Engine/1.0 (+https://iistupid.com)"},
        ) as client:
            # 1) Exact username API — include banned so moderated accounts can still link.
            if handle_ok:
                response = await client.post(
                    f"{USERS_API}/v1/usernames/users",
                    json={"usernames": [handle], "excludeBannedUsers": False},
                )
                if response.status_code == 200:
                    for row in (response.json() or {}).get("data") or []:
                        parsed = _roblox_row_id_name(row)
                        if not parsed:
                            continue
                        requested = str(row.get("requestedUsername") or handle)
                        # Skip placeholder "not found" rows Roblox sometimes returns.
                        if str(row.get("id")) in {"", "None", "null"}:
                            continue
                        if requested.casefold() == handle.casefold() or parsed[1].casefold() == handle.casefold():
                            return parsed

            # 2) Search — match username first, then display name (exact, case-insensitive).
            search_terms: list[str] = []
            if handle_ok:
                search_terms.append(handle)
            if phrase.casefold() not in {t.casefold() for t in search_terms}:
                search_terms.append(phrase)

            for term in search_terms:
                search = await client.get(
                    f"{USERS_API}/v1/users/search",
                    params={"keyword": term[:50], "limit": 25},
                )
                if search.status_code != 200:
                    continue
                rows = (search.json() or {}).get("data") or []
                for row in rows:
                    parsed = _roblox_row_id_name(row)
                    if parsed and parsed[1].casefold() == term.casefold():
                        return parsed
                for row in rows:
                    display = str(row.get("displayName") or "").strip()
                    parsed = _roblox_row_id_name(row)
                    if parsed and display.casefold() == term.casefold():
                        return parsed

            # 3) Profile URL — Roblox redirects /users/profile?username=X → /users/<id>/profile
            if handle_ok:
                profile = await client.get(
                    "https://www.roblox.com/users/profile",
                    params={"username": handle},
                )
                location = profile.headers.get("location") or profile.headers.get("Location") or ""
                match = re.search(r"/users/(\d+)/profile", location)
                if match:
                    user_id = match.group(1)
                    details = await client.get(f"{USERS_API}/v1/users/{user_id}")
                    if details.status_code == 200:
                        parsed = _roblox_row_id_name(details.json() or {})
                        if parsed:
                            return parsed
                    return user_id, handle
    except httpx.HTTPError as error:
        raise HTTPException(503, "Roblox username lookup is temporarily unavailable") from error

    raise HTTPException(
        404,
        "That Roblox account was not found. Paste the username shown on your Roblox "
        "profile URL (roblox.com/users/…), or the exact display name — then try again.",
    )


def _ownership_verify_error(status_code: int | None, *, using_open_cloud: bool) -> HTTPException:
    if using_open_cloud and status_code in {401, 403}:
        return HTTPException(
            503,
            "Roblox Open Cloud API key is invalid or missing user.inventory-item:read. "
            "Create a new key in Creator Dashboard → Open Cloud → API Keys, enable "
            "user.inventory-item:read, paste it into Railway ROBLOX_OPEN_CLOUD_API_KEY, "
            "then try Claim again.",
        )
    if not using_open_cloud and status_code in {401, 403}:
        return HTTPException(
            503,
            "Could not verify Roblox catalog ownership — set ROBLOX_OPEN_CLOUD_API_KEY "
            "with user.inventory-item:read (public inventory lookups are blocked).",
        )
    return HTTPException(503, "Could not verify Roblox catalog ownership")


async def user_owns_catalog_asset(settings, roblox_user_id: str, asset_id: str) -> bool:
    api_key = settings.roblox_open_cloud_api_key.get_secret_value().strip()
    if api_key:
        try:
            async with httpx.AsyncClient(timeout=15.0) as client:
                response = await client.get(
                    f"{OPEN_CLOUD_API}/cloud/v2/users/{quote(roblox_user_id)}/inventory-items",
                    params={"filter": f"assetIds={asset_id}"},
                    headers={"x-api-key": api_key},
                )
                if response.status_code == 404:
                    return False
                if response.status_code in {401, 403}:
                    raise _ownership_verify_error(response.status_code, using_open_cloud=True)
                response.raise_for_status()
                items = (response.json() or {}).get("inventoryItems") or []
                return len(items) > 0
        except HTTPException:
            raise
        except httpx.HTTPError as error:
            status = getattr(getattr(error, "response", None), "status_code", None)
            raise _ownership_verify_error(status, using_open_cloud=True) from error

    url = (
        f"{INVENTORY_API}/v1/users/{quote(roblox_user_id)}"
        f"/items/Asset/{quote(asset_id)}/is-owned"
    )
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            response = await client.get(url)
            if response.status_code == 404:
                return False
            if response.status_code in {401, 403}:
                raise _ownership_verify_error(response.status_code, using_open_cloud=False)
            response.raise_for_status()
            return bool(response.json())
    except HTTPException:
        raise
    except httpx.HTTPError as error:
        status = getattr(getattr(error, "response", None), "status_code", None)
        raise _ownership_verify_error(status, using_open_cloud=False) from error


def _grant_roles(
    request: Request,
    db: Session,
    user: User,
    *,
    include_tracker: bool,
    source: str,
) -> list[str]:
    settings = request.app.state.settings
    role_specs: list[tuple[str, str]] = [("pro", _pro_role_id(settings))]
    if include_tracker:
        role_specs.append(("ii_tracker", _tracker_role_id(settings)))

    try:
        membership = request.app.state.discord.membership(user.discord_id)
    except ProviderUnavailable as error:
        raise HTTPException(503, "Discord is temporarily unavailable") from error
    have = set(membership.get("role_ids") or [])
    granted: list[str] = []

    for entitlement, role_id in role_specs:
        already = role_id in have
        if not already:
            try:
                request.app.state.discord.grant_member_role(user.discord_id, role_id)
            except ProviderUnavailable as error:
                label = "ii Tracker" if entitlement == "ii_tracker" else "Engine Pro"
                raise HTTPException(503, f"Could not assign {label} on Discord") from error
            have.add(role_id)
        granted.append(entitlement)
        event_type = (
            "roblox_catalog_bundle" if include_tracker else "roblox_catalog_pro"
        )
        if entitlement == "ii_tracker":
            event_type = "roblox_catalog_tracker"
        # Keep under audit_events.result width (80). Older DBs were varchar(30).
        result = f"{source}:{entitlement}:{'existing' if already else 'granted'}"[:80]
        db.add(
            AuditEvent(
                actor_id=user.id,
                event_type=event_type,
                result=result,
            )
        )
    return granted


async def _ensure_claim(
    request: Request,
    db: Session,
    row: RobloxGamepassClaim,
    *,
    source: str,
    require_owned: bool = True,
) -> tuple[RobloxGamepassClaim, list[str], dict]:
    """Returns (row, grants, meta). meta may include weekend_claim_pending."""
    settings = request.app.state.settings
    engine_asset = _catalog_asset_id(settings)
    bundle_asset = _bundle_asset_id(settings)
    weekend_asset = _weekend_bundle_asset_id(settings)
    weekend_active = is_weekend_sale_active()
    user = db.get(User, row.user_id)
    if user is None:
        raise HTTPException(404, "Linked Engine account was not found")

    owns_weekend = await user_owns_catalog_asset(settings, row.roblox_user_id, weekend_asset)
    owns_bundle = await user_owns_catalog_asset(settings, row.roblox_user_id, bundle_asset)
    # Weekend SKU counts as a full bundle grant only while the sale window is open.
    bundle_ok = owns_bundle or (owns_weekend and weekend_active)
    meta = {
        "weekend_claim_pending": bool(owns_weekend and not weekend_active and not owns_bundle),
        "owns_weekend_item": owns_weekend,
    }

    # Already redeemed: still allow a later bundle / weekend purchase to add ii Tracker.
    if row.claimed_at is not None:
        row.last_checked_at = datetime.now(UTC)
        if bundle_ok:
            grants = _grant_roles(
                request,
                db,
                user,
                include_tracker=True,
                source=f"{source}:bundle_upgrade",
            )
            db.commit()
            db.refresh(row)
            return row, grants, meta
        if meta["weekend_claim_pending"] and require_owned and source == "manual_claim":
            db.commit()
            raise HTTPException(
                402,
                "You already own the weekend bundle item. Claim ii Tracker when the "
                "weekend deal opens (Fri 4 PM – Sun midnight ET).",
            )
        db.commit()
        return row, ["pro"], meta

    owns_engine = await user_owns_catalog_asset(settings, row.roblox_user_id, engine_asset)
    row.last_checked_at = datetime.now(UTC)

    if not owns_engine and not bundle_ok:
        if meta["weekend_claim_pending"]:
            if require_owned:
                db.commit()
                raise HTTPException(
                    402,
                    "You own the weekend Engine + Tracker item. Claim opens Friday 4 PM ET "
                    "through Sunday midnight ET.",
                )
            db.commit()
            return row, [], meta
        if require_owned:
            db.commit()
            raise HTTPException(
                402,
                "That Roblox account does not own an ii Engine Robux catalog item yet",
            )
        db.commit()
        return row, [], meta

    grants = _grant_roles(
        request,
        db,
        user,
        include_tracker=bundle_ok,
        source=source,
    )
    row.claimed_at = datetime.now(UTC)
    row.last_checked_at = datetime.now(UTC)
    db.commit()
    db.refresh(row)
    return row, grants, meta


@router.get("/status")
async def roblox_billing_status(
    request: Request,
    user: User = Depends(require_member),
    db: Session = Depends(database),
):
    from .developer import operation_view

    row = db.scalar(select(RobloxGamepassClaim).where(RobloxGamepassClaim.user_id == user.id))
    settings = request.app.state.settings
    pricing = operation_view(db).get("pricing")
    claimed_grants: list[str] = []
    claim_meta: dict = {}
    if row is not None:
        try:
            row, claimed_grants, claim_meta = await _ensure_claim(
                request, db, row, source="auto_status"
            )
        except HTTPException as error:
            if error.status_code not in {402, 503}:
                raise
            detail = str(error.detail or "")
            if "weekend" in detail.lower():
                claim_meta = {"weekend_claim_pending": True}
            db.rollback()
            row = db.scalar(
                select(RobloxGamepassClaim).where(RobloxGamepassClaim.user_id == user.id)
            )
    view = _claim_view(row, settings, pricing)
    view["claimed_grants"] = claimed_grants
    view["weekend_claim_pending"] = bool(claim_meta.get("weekend_claim_pending"))
    view["owns_weekend_item"] = bool(claim_meta.get("owns_weekend_item"))
    return view


@router.get("/catalog")
def roblox_catalog_public():
    """Unauthenticated product card used by Plans (and health checks)."""
    settings = type(
        "S",
        (),
        {
            "roblox_catalog_asset_id": DEFAULT_CATALOG_ASSET_ID,
            "roblox_catalog_url": DEFAULT_CATALOG_URL,
            "roblox_bundle_catalog_asset_id": DEFAULT_BUNDLE_CATALOG_ASSET_ID,
            "roblox_bundle_catalog_url": DEFAULT_BUNDLE_CATALOG_URL,
            "roblox_weekend_bundle_catalog_asset_id": WEEKEND_BUNDLE_ASSET_ID,
            "roblox_weekend_bundle_catalog_url": WEEKEND_BUNDLE_CATALOG_URL,
            "roblox_gamepass_id": "",
            "roblox_gamepass_url": "",
        },
    )()
    base = _public_config(settings)
    return {
        "configured": True,
        "product_kind": "catalog_asset",
        "asset_id": base["asset_id"],
        "catalog_url": base["catalog_url"],
        "robux_price": base["robux_price"],
        "shop_url": DEFAULT_SHOP_URL,
        "product_name": base["product_name"],
        "bundle_asset_id": base["bundle_asset_id"],
        "bundle_catalog_url": base["bundle_catalog_url"],
        "bundle_robux_price": base["bundle_robux_price"],
        "bundle_product_name": base["bundle_product_name"],
        "bundle_robux_on_sale": base["bundle_robux_on_sale"],
        "weekend_sale": base["weekend_sale"],
        "products": base["products"],
    }


@router.post("/link")
async def link_roblox_account(
    body: LinkInput,
    request: Request,
    user: User = Depends(require_member),
    db: Session = Depends(database),
):
    roblox_user_id, roblox_username = await resolve_roblox_username(body.username)
    # A Roblox account that already redeemed Pro/bundle is permanently owned for that claim.
    redeemed = db.scalar(
        select(RobloxGamepassClaim).where(
            RobloxGamepassClaim.roblox_user_id == roblox_user_id,
            RobloxGamepassClaim.claimed_at.is_not(None),
        )
    )
    if redeemed is not None and redeemed.user_id != user.id:
        raise HTTPException(
            409,
            "That Roblox username has already been used to redeem an Engine Robux product",
        )
    taken = db.scalar(
        select(RobloxGamepassClaim).where(
            RobloxGamepassClaim.roblox_user_id == roblox_user_id,
            RobloxGamepassClaim.user_id != user.id,
        )
    )
    if taken is not None:
        raise HTTPException(409, "That Roblox account is already linked to another Engine user")
    row = db.scalar(select(RobloxGamepassClaim).where(RobloxGamepassClaim.user_id == user.id))
    if row is None:
        row = RobloxGamepassClaim(
            user_id=user.id,
            roblox_user_id=roblox_user_id,
            roblox_username=roblox_username,
        )
        db.add(row)
    else:
        if row.claimed_at is not None and row.roblox_user_id != roblox_user_id:
            raise HTTPException(409, "Pro was already claimed for a different Roblox account")
        row.roblox_user_id = roblox_user_id
        row.roblox_username = roblox_username
    db.commit()
    db.refresh(row)
    from .developer import operation_view

    return _claim_view(row, request.app.state.settings, operation_view(db).get("pricing"))


@router.post("/claim")
async def claim_roblox_catalog_item(
    request: Request,
    user: User = Depends(require_member),
    db: Session = Depends(database),
):
    from .developer import operation_view

    row = db.scalar(select(RobloxGamepassClaim).where(RobloxGamepassClaim.user_id == user.id))
    if row is None:
        raise HTTPException(400, "Link your Roblox username before claiming Pro")
    row, grants, claim_meta = await _ensure_claim(request, db, row, source="manual_claim")
    view = _claim_view(row, request.app.state.settings, operation_view(db).get("pricing"))
    view["claimed_grants"] = grants
    view["weekend_claim_pending"] = bool(claim_meta.get("weekend_claim_pending"))
    view["owns_weekend_item"] = bool(claim_meta.get("owns_weekend_item"))
    return view
