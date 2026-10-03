"""Bounded per-process abuse guard. Railway edge also filters volumetric DDoS."""

import hashlib
import hmac
import secrets
import threading
import time
from collections import OrderedDict


class RequestLimits:
    def __init__(self, clock=time.monotonic):
        self.clock = clock
        self.salt = secrets.token_bytes(32)
        self.buckets = OrderedDict()
        self.lock = threading.Lock()

    def check(self, client, path):
        if path.startswith("/health/"):
            return 0
        if path == "/v1/developer/unlock":
            category, limit, seconds = "developer", 10, 900
        elif path == "/v1/auth/requests":
            category, limit, seconds = "start", 10, 600
        elif path.startswith("/v1/auth/requests/") and path.endswith("/poll"):
            category, limit, seconds = "poll", 240, 300
        elif path == "/v1/auth/refresh":
            category, limit, seconds = "refresh", 30, 60
        elif path.startswith("/v1/ai"):
            # SiliconFlow-backed — tight per-IP burst so one client cannot burn the shared AI budget.
            category, limit, seconds = "ai", 20, 60
        elif path.startswith("/v1/telemetry"):
            # Discord-bound staff posts — keep bursts tiny.
            category, limit, seconds = "telemetry", 12, 60
        elif path.startswith("/v1/tracker/feed"):
            # Live feed — very tight to raise scrape/relay cost.
            category, limit, seconds = "tracker_feed", 12, 60
        elif path.startswith("/v1/tracker/session"):
            category, limit, seconds = "tracker_session", 10, 60
        elif path.startswith("/v1/tracker"):
            category, limit, seconds = "tracker", 30, 60
        elif path.startswith("/v1/billing"):
            category, limit, seconds = "billing", 30, 60
        elif path.startswith("/v1/presets"):
            category, limit, seconds = "presets", 20, 60
        else:
            # General authenticated traffic. Lower than before to raise the cost of scrapers.
            category, limit, seconds = "general", 120, 60
        # Ephemeral HMAC: do not retain IP addresses or honor arbitrary forwarded headers here.
        identity = hmac.new(self.salt, client.encode(), hashlib.sha256).digest()
        key = (identity, category)
        now = self.clock()
        with self.lock:
            count, expiry = self.buckets.get(key, (0, now + seconds))
            if expiry <= now:
                count, expiry = 0, now + seconds
            if count >= limit:
                return max(1, int(expiry - now) + 1)
            if key not in self.buckets and len(self.buckets) >= 10000:
                # Remove expired buckets only. Saturation fails closed instead of evicting live limits.
                expired = [k for k, (_, end) in self.buckets.items() if end <= now]
                for item in expired:
                    del self.buckets[item]
                if len(self.buckets) >= 10000:
                    return 60
            self.buckets[key] = (count + 1, expiry)
        return 0
