import re
import threading
import time
from urllib.parse import urlencode

import httpx

from .config import Settings


class ProviderUnavailable(Exception):
    """Safe upstream error. Never retain upstream bodies, headers or tokens."""

    def __init__(self, message: str, *, status: int | None = None, kind: str | None = None):
        super().__init__(message)
        self.status = status
        self.kind = kind or "unavailable"


class DiscordREST:
    """Official Discord REST client. OAuth identify (+ optional guilds.members.read); bot for live checks."""

    def __init__(self, settings: Settings, transport=None):
        self.settings = settings
        self.rate_lock = threading.Lock()
        # Bot traffic (membership, roles, posts) must not block OAuth token exchange.
        self.bot_retry_until = 0.0
        self.oauth_retry_until = 0.0
        self._membership_cache: dict[str, tuple[float, dict]] = {}
        self._roles_cache: tuple[float, list] | None = None
        self.client = httpx.Client(
            base_url="https://discord.com/api/v10",
            timeout=10,
            follow_redirects=False,
            transport=transport,
        )

    @property
    def OAUTH_SCOPES(self) -> str:
        return self.settings.discord_oauth_scopes or "identify guilds.members.read"

    def close(self):
        self.client.close()

    def request(self, method: str, path: str, *, bot=True, **kwargs):
        retry_attr = "bot_retry_until" if bot else "oauth_retry_until"
        with self.rate_lock:
            if time.monotonic() < getattr(self, retry_attr):
                raise ProviderUnavailable(
                    "Discord is rate limited; try again shortly",
                    status=429,
                    kind="rate_limited",
                )
        if bot:
            secret = self.settings.discord_bot_token.get_secret_value()
            if not secret:
                raise ProviderUnavailable(
                    "Discord is not configured",
                    status=None,
                    kind="not_configured",
                )
            kwargs["headers"] = {"Authorization": f"Bot {secret}"}
        try:
            response = self.client.request(method, path, **kwargs)
            if response.status_code == 429:
                try:
                    delay = float(response.headers.get("Retry-After", "5"))
                    delay = min(300, max(1, delay))
                except ValueError:
                    delay = 5
                # OAuth login: wait briefly and retry once so a single 429 does not
                # burn the one-time authorization code / force "could not authorize".
                if not bot and delay <= 8:
                    time.sleep(delay)
                    response = self.client.request(method, path, **kwargs)
                    if response.status_code != 429 and response.status_code in (
                        200,
                        201,
                        204,
                        404,
                    ):
                        return response
                with self.rate_lock:
                    setattr(self, retry_attr, time.monotonic() + delay)
                raise ProviderUnavailable(
                    "Discord is rate limited; try again shortly",
                    status=429,
                    kind="rate_limited",
                )
            if response.status_code not in (200, 201, 204, 404):
                kind = "forbidden" if response.status_code in (401, 403) else "unavailable"
                raise ProviderUnavailable(
                    "Discord is temporarily unavailable",
                    status=response.status_code,
                    kind=kind,
                )
            return response
        except httpx.TimeoutException:
            raise ProviderUnavailable(
                "Discord timed out",
                status=None,
                kind="timeout",
            ) from None
        except httpx.HTTPError:
            raise ProviderUnavailable(
                "Discord is temporarily unavailable",
                status=None,
                kind="unavailable",
            ) from None

    def authorize_url(self, state: str):
        return "https://discord.com/oauth2/authorize?" + urlencode(
            {
                "client_id": self.settings.discord_client_id,
                "response_type": "code",
                "redirect_uri": self.settings.discord_oauth_redirect_uri,
                "scope": self.OAUTH_SCOPES,
                "state": state,
            }
        )

    def _entitlements_for_role_ids(self, ids: set[str]) -> list[str]:
        entitlements = ["user"]
        for entitlement in (
            "beta",
            "full_access",
            "pro",
            "developer",
            "admin",
            "owner",
            "uncapped",
            "ii_tracker",
            "ii_tracker_beta",
        ):
            configured = getattr(self.settings, f"discord_{entitlement}_role_ids", "")
            if ids.intersection(x.strip() for x in configured.split(",") if x.strip()):
                entitlements.append(entitlement)
        if "pro" in entitlements and "beta" not in entitlements:
            entitlements.append("beta")
        return entitlements

    def _roles_for_ids(self, ids: set[str], role_rows: list) -> list[dict]:
        guild = self.settings.discord_guild_id
        roles = [
            {
                "id": str(role["id"]),
                "name": str(role["name"])[:100],
                "color": f"#{int(role['color']):06x}" if int(role["color"]) else "#cbd5e1",
                "emoji": str(role["unicode_emoji"])[:16] if role.get("unicode_emoji") else None,
                "icon_url": (
                    f"https://cdn.discordapp.com/role-icons/{role['id']}/{role['icon']}.png"
                    if re.fullmatch(r"[0-9a-f]{32}", str(role.get("icon", "")))
                    else None
                ),
                "position": int(role.get("position", 0)),
            }
            for role in role_rows
            if role["id"] in ids and role["id"] != guild and not role.get("managed")
        ]
        roles.sort(key=lambda role: role["position"], reverse=True)
        return roles

    def membership_via_user_token(self, access_token: str) -> dict | None:
        """Guild membership via the user's OAuth token (guilds.members.read). Best-effort."""
        guild = self.settings.discord_guild_id
        try:
            response = self.request(
                "GET",
                f"/users/@me/guilds/{guild}/member",
                bot=False,
                headers={"Authorization": f"Bearer {access_token}"},
            )
            if response.status_code == 404:
                return {
                    "membership": False,
                    "roles": [],
                    "entitlements": [],
                    "role_ids": [],
                }
            member = response.json()
            ids = {str(role_id) for role_id in member.get("roles", [])}
            try:
                role_rows = self.request("GET", f"/guilds/{guild}/roles").json()
            except ProviderUnavailable:
                role_rows = []
            roles = self._roles_for_ids(ids, role_rows) if role_rows else []
            return {
                "membership": True,
                "roles": roles,
                "entitlements": self._entitlements_for_role_ids(ids),
                "role_ids": list(ids),
            }
        except (ProviderUnavailable, ValueError, KeyError, TypeError):
            return None

    def identity(self, code: str):
        """Exchange the one-time OAuth code for a Discord profile (+ optional membership).

        Retries only the token exchange on transient Discord failures. Once Discord
        accepts the code, it cannot be reused — profile fetch is not retried with
        the same code. Membership via guilds.members.read is captured before revoke.
        """
        data = {
            "client_id": self.settings.discord_client_id,
            "client_secret": self.settings.discord_client_secret.get_secret_value(),
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": self.settings.discord_oauth_redirect_uri,
        }
        access = None
        last_error: ProviderUnavailable | None = None
        for attempt in range(3):
            try:
                response = self.request("POST", "/oauth2/token", bot=False, data=data)
                access = response.json()["access_token"]
                break
            except ProviderUnavailable as error:
                last_error = error
            except (ValueError, KeyError, TypeError):
                last_error = ProviderUnavailable("Discord sign-in failed")
            if attempt < 2:
                time.sleep(0.45 * (attempt + 1))
        if not access:
            raise last_error or ProviderUnavailable("Discord sign-in failed")
        try:
            profile = self.request(
                "GET", "/users/@me", bot=False, headers={"Authorization": f"Bearer {access}"}
            ).json()
            discord_id = str(profile["id"])
            if not discord_id.isdigit() or not 15 <= len(discord_id) <= 20:
                raise ValueError("Invalid Discord identity")
            avatar_hash = str(profile.get("avatar", ""))
            login_membership = self.membership_via_user_token(access)
            result = {
                "discord_id": discord_id,
                "display_name": str(profile.get("global_name") or profile["username"])[:100],
                "avatar": f"https://cdn.discordapp.com/avatars/{discord_id}/{avatar_hash}.png"
                if re.fullmatch(r"(?:a_)?[0-9a-f]{32}", avatar_hash)
                else None,
            }
            if login_membership is not None:
                result["login_membership"] = login_membership
            return result
        except (ValueError, KeyError, TypeError):
            raise ProviderUnavailable("Discord returned an invalid identity") from None
        finally:
            try:
                self.request(
                    "POST",
                    "/oauth2/token/revoke",
                    bot=False,
                    data={
                        "client_id": self.settings.discord_client_id,
                        "client_secret": self.settings.discord_client_secret.get_secret_value(),
                        "token": access,
                        "token_type_hint": "access_token",
                    },
                )
            except ProviderUnavailable:
                pass  # Token is discarded locally even if upstream revocation is unavailable.

    def membership(self, discord_id: str):
        now = time.monotonic()
        cached = self._membership_cache.get(discord_id)
        # Fresh cache (~2 min) avoids hammering Discord on every API call.
        if cached and now - cached[0] < 120:
            return dict(cached[1])
        try:
            result = self._membership_uncached(discord_id)
            self._membership_cache[discord_id] = (now, result)
            if len(self._membership_cache) > 2000:
                oldest = sorted(self._membership_cache.items(), key=lambda item: item[1][0])[:500]
                for key, _ in oldest:
                    self._membership_cache.pop(key, None)
            return dict(result)
        except ProviderUnavailable:
            # Serve stale membership for up to 6 hours rather than failing Engine UI.
            if cached and now - cached[0] < 21600:
                return dict(cached[1])
            raise

    def _membership_uncached(self, discord_id: str):
        guild = self.settings.discord_guild_id
        response = self.request("GET", f"/guilds/{guild}/members/{discord_id}")
        if response.status_code == 404:
            return {"membership": False, "roles": [], "entitlements": [], "role_ids": []}
        try:
            member = response.json()
            ids = {str(role_id) for role_id in member["roles"]}
            roles_response = self.request("GET", f"/guilds/{guild}/roles")
            roles = self._roles_for_ids(ids, roles_response.json())
        except (KeyError, ValueError, TypeError):
            raise ProviderUnavailable("Discord membership could not be verified") from None
        return {
            "membership": True,
            "roles": roles,
            "entitlements": self._entitlements_for_role_ids(ids),
            "role_ids": list(ids),
        }

    def guild_roles(self):
        now = time.monotonic()
        if self._roles_cache and now - self._roles_cache[0] < 300:
            return list(self._roles_cache[1])
        guild = self.settings.discord_guild_id
        try:
            response = self.request("GET", f"/guilds/{guild}/roles")
            roles = [
                {
                    "id": str(role["id"]),
                    "name": str(role["name"])[:100],
                    "color": f"#{int(role['color']):06x}" if int(role["color"]) else "#cbd5e1",
                    "position": int(role.get("position", 0)),
                }
                for role in response.json()
                if role.get("id") != guild and not role.get("managed")
            ]
        except (KeyError, ValueError, TypeError):
            raise ProviderUnavailable("Discord roles could not be loaded") from None
        except ProviderUnavailable:
            if self._roles_cache and now - self._roles_cache[0] < 900:
                return list(self._roles_cache[1])
            raise
        roles = sorted(roles, key=lambda role: role["position"], reverse=True)
        self._roles_cache = (now, roles)
        return list(roles)

    def engine_role(self, discord_id: str, *, remove=False):
        response = self.request(
            "DELETE" if remove else "PUT",
            f"/guilds/{self.settings.discord_guild_id}/members/{discord_id}"
            f"/roles/{self.settings.discord_engine_user_role_id}",
        )
        if response.status_code == 404 and not remove:
            raise ProviderUnavailable("Membership changed; recheck membership")

    def grant_cone_killer_role(self, discord_id: str):
        role_id = self.settings.discord_cone_killer_role_id
        if not role_id.isdigit():
            raise ProviderUnavailable("Cone role is not configured")
        response = self.request(
            "PUT",
            f"/guilds/{self.settings.discord_guild_id}/members/{discord_id}/roles/{role_id}",
        )
        if response.status_code == 404:
            raise ProviderUnavailable("Membership changed; recheck membership")

    def grant_member_role(self, discord_id: str, role_id: str):
        if not role_id.isdigit() or not 15 <= len(role_id) <= 20:
            raise ProviderUnavailable("Role is not configured")
        response = self.request(
            "PUT",
            f"/guilds/{self.settings.discord_guild_id}/members/{discord_id}/roles/{role_id}",
        )
        if response.status_code == 404:
            raise ProviderUnavailable("Membership changed; recheck membership")

    def revoke_member_role(self, discord_id: str, role_id: str):
        if not role_id.isdigit() or not 15 <= len(role_id) <= 20:
            raise ProviderUnavailable("Role is not configured")
        response = self.request(
            "DELETE",
            f"/guilds/{self.settings.discord_guild_id}/members/{discord_id}/roles/{role_id}",
        )
        if response.status_code not in (200, 204, 404):
            raise ProviderUnavailable("Could not remove Discord role")

    @staticmethod
    def _valid_channel_id(channel_id: str) -> bool:
        return bool(channel_id) and channel_id.isdigit() and 15 <= len(channel_id) <= 20

    @staticmethod
    def snowflake_after(moment) -> str:
        """Discord snowflake strictly after `moment` (UTC-aware datetime)."""
        # Discord epoch: 2015-01-01T00:00:00.000Z
        millis = int(moment.timestamp() * 1000) - 1_420_070_400_000
        return str(max(0, millis) << 22)

    def post_channel_message(
        self, channel_id: str, content: str = "", *, embeds: list | None = None
    ):
        if not self._valid_channel_id(channel_id):
            raise ProviderUnavailable("Telemetry channel is not configured")
        text = str(content or "")[:1900]
        payload: dict = {"content": text}
        if embeds:
            # Discord allows up to 10 embeds; keep the payload bounded.
            payload["embeds"] = embeds[:10]
        if not text and not payload.get("embeds"):
            raise ProviderUnavailable("Could not post to Discord")
        response = self.request(
            "POST",
            f"/channels/{channel_id}/messages",
            json=payload,
        )
        if response.status_code not in (200, 201):
            raise ProviderUnavailable("Could not post to Discord")

    def post_channel_message_with_file(
        self,
        channel_id: str,
        content: str,
        *,
        filename: str,
        file_bytes: bytes,
        content_type: str = "text/plain",
    ):
        """Post a short summary plus an attached text file (keeps Discord readable)."""
        import json as _json

        if not self._valid_channel_id(channel_id):
            raise ProviderUnavailable("Telemetry channel is not configured")
        safe_name = re.sub(r"[^A-Za-z0-9._-]+", "_", filename)[:80] or "attachment.txt"
        payload = _json.dumps({"content": str(content)[:1800]})
        # Cap attachment size for Discord bot uploads (~8 MiB typical; keep smaller).
        blob = file_bytes[: 6 * 1024 * 1024]
        response = self.request(
            "POST",
            f"/channels/{channel_id}/messages",
            data={"payload_json": payload},
            files={"files[0]": (safe_name, blob, content_type)},
        )
        if response.status_code not in (200, 201):
            raise ProviderUnavailable("Could not post file to Discord")

    def list_channel_messages(
        self,
        channel_id: str,
        *,
        after: str | None = None,
        before: str | None = None,
        limit: int = 100,
    ) -> list[dict]:
        """Fetch recent channel messages (bot needs View Channel + Read Message History)."""
        if not self._valid_channel_id(channel_id):
            raise ProviderUnavailable("Sales channel is not configured")
        params: dict[str, str | int] = {"limit": max(1, min(int(limit), 100))}
        if after and str(after).isdigit():
            params["after"] = str(after)
        if before and str(before).isdigit():
            params["before"] = str(before)
        response = self.request("GET", f"/channels/{channel_id}/messages", params=params)
        if response.status_code == 404:
            raise ProviderUnavailable("Sales channel is not visible to the bot")
        if response.status_code != 200:
            raise ProviderUnavailable("Could not read Discord channel")
        try:
            rows = response.json()
        except (ValueError, TypeError):
            raise ProviderUnavailable("Could not read Discord channel") from None
        if not isinstance(rows, list):
            raise ProviderUnavailable("Could not read Discord channel")
        return [row for row in rows if isinstance(row, dict)]

    def list_channel_messages_between(
        self,
        channel_id: str,
        *,
        start,
        end,
        max_messages: int = 500,
    ) -> list[dict]:
        """All messages with timestamps in [start, end). Paginates with `after` snowflakes."""
        from datetime import datetime

        if not isinstance(start, datetime) or not isinstance(end, datetime):
            raise ProviderUnavailable("Invalid sales window")
        collected: list[dict] = []
        cursor = self.snowflake_after(start)
        # Walk forward so `after` keeps advancing; Discord returns newest-first per page.
        while len(collected) < max_messages:
            batch = self.list_channel_messages(
                channel_id,
                after=cursor,
                limit=min(100, max_messages - len(collected)),
            )
            if not batch:
                break
            # API returns newest first; re-sort ascending for cursor progress.
            batch_sorted = sorted(batch, key=lambda row: str(row.get("id") or "0"))
            progressed = False
            for row in batch_sorted:
                message_id = str(row.get("id") or "")
                if not message_id.isdigit():
                    continue
                stamp_raw = str(row.get("timestamp") or "")
                try:
                    stamp = datetime.fromisoformat(stamp_raw)
                except ValueError:
                    continue
                if stamp < start:
                    continue
                if stamp >= end:
                    continue
                collected.append(row)
                if message_id > cursor:
                    cursor = message_id
                    progressed = True
            if not progressed:
                # Advance past the newest id in the batch so we do not loop forever.
                newest = batch_sorted[-1] if batch_sorted else None
                newest_id = str((newest or {}).get("id") or "")
                if newest_id.isdigit() and newest_id > cursor:
                    cursor = newest_id
                else:
                    break
            if len(batch) < 100:
                break
        return collected[:max_messages]

    def delete_channel_message(self, channel_id: str, message_id: str):
        if not self._valid_channel_id(channel_id):
            raise ProviderUnavailable("Announcement channel is not configured")
        if not message_id.isdigit() or not 15 <= len(message_id) <= 20:
            raise ProviderUnavailable("Message id is invalid")
        response = self.request(
            "DELETE",
            f"/channels/{channel_id}/messages/{message_id}",
        )
        if response.status_code not in (200, 204):
            raise ProviderUnavailable("Could not delete Discord message")
