import os
import secrets
from urllib.parse import parse_qs, urlparse

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine

from ii_api.config import Settings
from ii_api.discord import ProviderUnavailable
from ii_api.main import create_app
from ii_api.models import Base
from ii_api.security import verifier_challenge


class FakeDiscord:
    """Injected fixture only; no network and no production identities."""

    member = True
    fail = False
    fail_membership = False
    staff = False
    staff_role = "admin"

    def __init__(self):
        self.grants = []
        self.removals = []
        self.extra_entitlements = []
        self.extra_role_ids = []
        self.discord_id = "100000000000000001"

    def authorize_url(self, state):
        return (
            f"https://discord.com/oauth2/authorize?scope=identify+guilds.members.read&state={state}"
        )

    def request(self, method, path, **kwargs):
        if self.fail or self.fail_membership:
            raise ProviderUnavailable("fixture outage")

        class FakeResponse:
            status_code = 200

            @staticmethod
            def json():
                return []

        return FakeResponse()

    def identity(self, code):
        if self.fail:
            raise ProviderUnavailable("fixture outage")
        return {
            "discord_id": self.discord_id,
            "display_name": "Synthetic Member",
            "avatar": None,
        }

    def membership(self, discord_id):
        if self.fail or self.fail_membership:
            raise ProviderUnavailable("fixture outage")
        role_catalog = {role["id"]: role for role in self.guild_roles()}
        roles = []
        for role_id in self.extra_role_ids:
            known = role_catalog.get(role_id)
            roles.append(
                known
                or {
                    "id": role_id,
                    "name": "Trusted Mod Creator",
                    "color": "#f59e0b",
                    "position": 8,
                }
            )
        result = {
            "membership": self.member,
            "roles": roles,
            "entitlements": (
                ["user", self.staff_role, *self.extra_entitlements]
                if self.staff
                else ["user", *self.extra_entitlements]
            )
            if self.member
            else [],
            "role_ids": list(self.extra_role_ids),
        }
        # Mirror production: Engine Pro includes Engine Beta.
        ents = result["entitlements"]
        if self.member and "pro" in ents and "beta" not in ents:
            ents.append("beta")
        return result

    def engine_role(self, discord_id, *, remove=False):
        if self.fail or self.fail_membership:
            raise ProviderUnavailable("fixture outage")
        (self.removals if remove else self.grants).append(discord_id)

    def grant_cone_killer_role(self, discord_id):
        if self.fail:
            raise ProviderUnavailable("fixture outage")
        self.grants.append(("cone", discord_id))

    def grant_member_role(self, discord_id, role_id):
        if self.fail:
            raise ProviderUnavailable("fixture outage")
        self.grants.append(("role", discord_id, role_id))

    def revoke_member_role(self, discord_id, role_id):
        if self.fail:
            raise ProviderUnavailable("fixture outage")
        self.removals.append(("role", discord_id, role_id))

    def post_channel_message(self, channel_id, content="", *, embeds=None):
        if self.fail:
            raise ProviderUnavailable("fixture outage")
        self.grants.append(("message", channel_id, (content or "")[:80], len(embeds or [])))

    def post_channel_message_with_file(
        self, channel_id, content, *, filename, file_bytes, content_type="text/plain"
    ):
        if self.fail:
            raise ProviderUnavailable("fixture outage")
        self.grants.append(("file", channel_id, filename, len(file_bytes)))

    def list_channel_messages(self, channel_id, *, after=None, before=None, limit=100):
        if self.fail:
            raise ProviderUnavailable("fixture outage")
        return list(getattr(self, "channel_messages", {}).get(channel_id, []))[:limit]

    def list_channel_messages_between(self, channel_id, *, start, end, max_messages=500):
        if self.fail:
            raise ProviderUnavailable("fixture outage")
        from datetime import datetime

        rows = []
        for row in getattr(self, "channel_messages", {}).get(channel_id, []):
            stamp_raw = str(row.get("timestamp") or "")
            try:
                stamp = datetime.fromisoformat(stamp_raw)
            except ValueError:
                continue
            if start <= stamp < end:
                rows.append(row)
            if len(rows) >= max_messages:
                break
        return rows

    def delete_channel_message(self, channel_id, message_id):
        if self.fail:
            raise ProviderUnavailable("fixture outage")
        self.grants.append(("delete_message", channel_id, message_id))

    def guild_roles(self):
        if self.fail:
            raise ProviderUnavailable("fixture outage")
        return [
            {
                "id": "1549421049287020568",
                "name": "Beta Engine User",
                "color": "#22c55e",
                "position": 10,
            },
            {
                "id": "1549986950793007215",
                "name": "Full Engine Access",
                "color": "#f97316",
                "position": 9,
            },
            {
                "id": "1538315600768540793",
                "name": "Trusted Mod Creator",
                "color": "#f59e0b",
                "position": 8,
            },
            {
                "id": "1551029796190953562",
                "name": "Community Mod Access",
                "color": "#ed7602",
                "position": 7,
            },
            {
                "id": "1551472794238320680",
                "name": "Engine Pro",
                "color": "#ed7602",
                "position": 6,
            },
        ]

    def close(self):
        pass


@pytest.fixture
def identity_client(tmp_path):
    url = os.environ.get("TEST_DATABASE_URL", f"sqlite:///{tmp_path / 'identity.db'}")
    if url.startswith("postgresql") and not url.endswith("/engine_test"):
        raise RuntimeError("Tests only allow PostgreSQL database named engine_test")
    config = Settings(
        _env_file=None,
        app_env="test",
        database_url=url,
        access_token_signing_key=secrets.token_urlsafe(48),
        refresh_token_pepper=secrets.token_urlsafe(48),
        discord_client_secret=secrets.token_urlsafe(32),
        discord_oauth_redirect_uri="https://example.invalid/v1/auth/discord/callback",
    )
    engine = create_engine(url)
    Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)
    engine.dispose()
    fake = FakeDiscord()
    with TestClient(create_app(config, discord=fake)) as client:
        yield client, fake


def begin_login(client):
    verifier = secrets.token_urlsafe(48)
    response = client.post("/v1/auth/requests", json={"challenge": verifier_challenge(verifier)})
    assert response.status_code == 201, response.text
    payload = response.json()
    state = parse_qs(urlparse(payload["authorize_url"]).query)["state"][0]
    return payload["request_id"], verifier, state


def login(client):
    request_id, verifier, state = begin_login(client)
    callback = client.get(
        "/v1/auth/discord/callback", params={"state": state, "code": "fixture-code"}
    )
    assert callback.status_code == 200, callback.text
    response = client.post(f"/v1/auth/requests/{request_id}/poll", json={"verifier": verifier})
    assert response.status_code == 200, response.text
    return response.json()
