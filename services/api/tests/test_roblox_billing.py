"""Automated Roblox catalog item → Discord Engine Pro / Tracker grants."""

from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest
from conftest import login
from pydantic import SecretStr
from test_identity import authorization

from ii_api.roblox_billing import resolve_roblox_username, user_owns_catalog_asset

CATALOG_ASSET_ID = "93620103303755"
CATALOG_URL = "https://www.roblox.com/catalog/93620103303755/ii-Engine-Pro-Lifetime"
BUNDLE_ASSET_ID = "112921567316975"
BUNDLE_URL = "https://www.roblox.com/catalog/112921567316975/ii-Engine-Pro-ii-Tracker"
PRO_ROLE_ID = "1551472794238320680"
TRACKER_ROLE_ID = "1549151900073459752"


def _owns_only(*owned_ids: str):
    owned = set(owned_ids)

    async def _check(_settings, _roblox_user_id, asset_id):
        return str(asset_id) in owned

    return AsyncMock(side_effect=_check)


def test_roblox_status_defaults_to_catalog_item(identity_client):
    client, _ = identity_client
    headers = authorization(login(client))
    response = client.get("/v1/billing/roblox/status", headers=headers)
    assert response.status_code == 200
    payload = response.json()
    assert payload["configured"] is True
    assert payload["product_kind"] == "catalog_asset"
    assert payload["asset_id"] == CATALOG_ASSET_ID
    assert payload["catalog_url"] == CATALOG_URL
    assert payload["gamepass_id"] == CATALOG_ASSET_ID
    assert payload["robux_price"] == 2500
    assert payload["bundle_asset_id"] in {BUNDLE_ASSET_ID, "140291726071649"}
    assert payload["bundle_robux_price"] in {3250, 2700}
    assert "weekend_sale" in payload
    assert payload["weekend_sale"]["asset_id"] == "140291726071649"
    assert len(payload["products"]) == 2
    assert payload["linked"] is False
    assert payload["shop_url"] == "https://iistupid.com/product/ii-engine"


def test_public_catalog_endpoint(identity_client):
    client, _ = identity_client
    response = client.get("/v1/billing/roblox/catalog")
    assert response.status_code == 200
    payload = response.json()
    assert payload["asset_id"] == CATALOG_ASSET_ID
    assert payload["catalog_url"] == CATALOG_URL
    assert payload["product_name"] == "ii Engine Pro — Lifetime"
    assert payload["bundle_asset_id"] == BUNDLE_ASSET_ID
    assert payload["bundle_robux_price"] == 3250
    assert payload["products"][1]["grants"] == ["pro", "ii_tracker"]


def test_link_and_claim_grants_pro_role(identity_client):
    client, discord = identity_client
    headers = authorization(login(client))

    with patch(
        "ii_api.roblox_billing.resolve_roblox_username",
        new=AsyncMock(return_value=("424242", "iiBuyer")),
    ):
        linked = client.post(
            "/v1/billing/roblox/link",
            headers=headers,
            json={"username": "iiBuyer"},
        )
    assert linked.status_code == 200, linked.text
    assert linked.json()["linked"] is True
    assert linked.json()["roblox_user_id"] == "424242"
    assert linked.json()["asset_id"] == CATALOG_ASSET_ID

    with patch(
        "ii_api.roblox_billing.user_owns_catalog_asset",
        new=_owns_only(CATALOG_ASSET_ID),
    ):
        claimed = client.post("/v1/billing/roblox/claim", headers=headers)
    assert claimed.status_code == 200, claimed.text
    assert claimed.json()["claimed"] is True
    assert claimed.json()["claimed_grants"] == ["pro"]
    assert ("role", discord.discord_id, PRO_ROLE_ID) in discord.grants
    assert ("role", discord.discord_id, TRACKER_ROLE_ID) not in discord.grants


def test_link_and_claim_bundle_grants_pro_and_tracker(identity_client):
    client, discord = identity_client
    headers = authorization(login(client))

    with patch(
        "ii_api.roblox_billing.resolve_roblox_username",
        new=AsyncMock(return_value=("515151", "BundleBuyer")),
    ):
        linked = client.post(
            "/v1/billing/roblox/link",
            headers=headers,
            json={"username": "BundleBuyer"},
        )
    assert linked.status_code == 200, linked.text

    with patch(
        "ii_api.roblox_billing.user_owns_catalog_asset",
        new=_owns_only(BUNDLE_ASSET_ID),
    ):
        claimed = client.post("/v1/billing/roblox/claim", headers=headers)
    assert claimed.status_code == 200, claimed.text
    body = claimed.json()
    assert body["claimed"] is True
    assert set(body["claimed_grants"]) == {"pro", "ii_tracker"}
    assert ("role", discord.discord_id, PRO_ROLE_ID) in discord.grants
    assert ("role", discord.discord_id, TRACKER_ROLE_ID) in discord.grants

    # Re-claim must not crash on audit_events.result width (ii_tracker:existing).
    with patch(
        "ii_api.roblox_billing.user_owns_catalog_asset",
        new=_owns_only(BUNDLE_ASSET_ID),
    ):
        again = client.post("/v1/billing/roblox/claim", headers=headers)
    assert again.status_code == 200, again.text
    assert set(again.json()["claimed_grants"]) == {"pro", "ii_tracker"}


def test_engine_claim_can_upgrade_with_bundle(identity_client):
    client, discord = identity_client
    headers = authorization(login(client))
    with patch(
        "ii_api.roblox_billing.resolve_roblox_username",
        new=AsyncMock(return_value=("616161", "UpgradeBuyer")),
    ):
        assert (
            client.post(
                "/v1/billing/roblox/link",
                headers=headers,
                json={"username": "UpgradeBuyer"},
            ).status_code
            == 200
        )
    with patch(
        "ii_api.roblox_billing.user_owns_catalog_asset",
        new=_owns_only(CATALOG_ASSET_ID),
    ):
        first = client.post("/v1/billing/roblox/claim", headers=headers)
    assert first.status_code == 200
    assert first.json()["claimed_grants"] == ["pro"]
    assert ("role", discord.discord_id, TRACKER_ROLE_ID) not in discord.grants

    with patch(
        "ii_api.roblox_billing.user_owns_catalog_asset",
        new=_owns_only(CATALOG_ASSET_ID, BUNDLE_ASSET_ID),
    ):
        upgraded = client.post("/v1/billing/roblox/claim", headers=headers)
    assert upgraded.status_code == 200, upgraded.text
    assert "ii_tracker" in upgraded.json()["claimed_grants"]
    assert ("role", discord.discord_id, TRACKER_ROLE_ID) in discord.grants


def test_claim_without_catalog_item_returns_402(identity_client):
    client, _ = identity_client
    headers = authorization(login(client))
    with patch(
        "ii_api.roblox_billing.resolve_roblox_username",
        new=AsyncMock(return_value=("99", "NoPass")),
    ):
        assert (
            client.post(
                "/v1/billing/roblox/link", headers=headers, json={"username": "NoPass"}
            ).status_code
            == 200
        )
    with patch(
        "ii_api.roblox_billing.user_owns_catalog_asset",
        new=AsyncMock(return_value=False),
    ):
        response = client.post("/v1/billing/roblox/claim", headers=headers)
    assert response.status_code == 402
    assert "catalog item" in response.json()["detail"].lower()


def test_claimed_roblox_username_cannot_be_linked_by_another_user(identity_client):
    client, discord = identity_client
    headers_a = authorization(login(client))
    with patch(
        "ii_api.roblox_billing.resolve_roblox_username",
        new=AsyncMock(return_value=("777", "TakenName")),
    ), patch(
        "ii_api.roblox_billing.user_owns_catalog_asset",
        new=AsyncMock(return_value=True),
    ):
        assert (
            client.post(
                "/v1/billing/roblox/link",
                headers=headers_a,
                json={"username": "TakenName"},
            ).status_code
            == 200
        )
        assert client.post("/v1/billing/roblox/claim", headers=headers_a).status_code == 200

    discord.discord_id = "999888777666555444"
    headers_b = authorization(login(client))
    with patch(
        "ii_api.roblox_billing.resolve_roblox_username",
        new=AsyncMock(return_value=("777", "TakenName")),
    ):
        blocked = client.post(
            "/v1/billing/roblox/link",
            headers=headers_b,
            json={"username": "TakenName"},
        )
    assert blocked.status_code == 409
    detail = blocked.json()["detail"].lower()
    assert "already" in detail


@pytest.mark.asyncio
async def test_open_cloud_invalid_key_returns_actionable_503():
    settings = MagicMock()
    settings.roblox_open_cloud_api_key = SecretStr("not-a-real-key")

    response = MagicMock()
    response.status_code = 401
    response.json.return_value = {"errors": [{"message": "Invalid API Key"}]}
    response.raise_for_status.side_effect = httpx.HTTPStatusError(
        "401", request=MagicMock(), response=response
    )

    client = AsyncMock()
    client.__aenter__.return_value = client
    client.__aexit__.return_value = None
    client.get = AsyncMock(return_value=response)

    with patch("ii_api.roblox_billing.httpx.AsyncClient", return_value=client):
        with pytest.raises(Exception) as raised:
            await user_owns_catalog_asset(settings, "1", BUNDLE_ASSET_ID)
    error = raised.value
    assert getattr(error, "status_code", None) == 503
    detail = str(getattr(error, "detail", error)).lower()
    assert "open cloud" in detail
    assert "inventory-item" in detail


@pytest.mark.asyncio
async def test_resolve_roblox_username_exact_match():
    exact = MagicMock()
    exact.status_code = 200
    exact.json.return_value = {
        "data": [
            {
                "requestedUsername": "Builderman",
                "id": 156,
                "name": "Builderman",
                "displayName": "Builderman",
            }
        ]
    }

    client = AsyncMock()
    client.__aenter__.return_value = client
    client.__aexit__.return_value = None
    client.post = AsyncMock(return_value=exact)

    with patch("ii_api.roblox_billing.httpx.AsyncClient", return_value=client):
        user_id, name = await resolve_roblox_username("Builderman")
    assert user_id == "156"
    assert name == "Builderman"


@pytest.mark.asyncio
async def test_resolve_roblox_username_display_name_search():
    empty = MagicMock()
    empty.status_code = 200
    empty.json.return_value = {"data": []}

    search = MagicMock()
    search.status_code = 200
    search.json.return_value = {
        "data": [
            {"id": 42, "name": "RealHandle", "displayName": "Cool Display"},
        ]
    }

    client = AsyncMock()
    client.__aenter__.return_value = client
    client.__aexit__.return_value = None
    client.post = AsyncMock(return_value=empty)
    client.get = AsyncMock(return_value=search)

    with patch("ii_api.roblox_billing.httpx.AsyncClient", return_value=client):
        user_id, name = await resolve_roblox_username("Cool Display")
    assert user_id == "42"
    assert name == "RealHandle"
