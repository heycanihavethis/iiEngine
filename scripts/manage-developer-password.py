"""Generate a developer password and scrypt hash into ignored local handoff files.

Run once per rotation, then place the hash in the backend's secret variable store.
Never prints a password/hash to build logs. Existing files are never overwritten.
"""
import hashlib
import json
import secrets
from pathlib import Path
from datetime import datetime, UTC

root = Path(__file__).resolve().parents[1] / "work" / "developer-access"
root.mkdir(parents=True, exist_ok=True)
stamp = datetime.now(UTC).strftime("%Y%m%d-%H%M%S")
password = secrets.token_urlsafe(32)
salt = secrets.token_bytes(16)
hashed = hashlib.scrypt(password.encode(), salt=salt, n=16384, r=8, p=1).hex()
encoded = f"scrypt${salt.hex()}${hashed}"
handoff = root / f"developer-password-{stamp}.txt"
with handoff.open("x", encoding="utf-8") as stream:
    stream.write("ii Engine developer group password\n\n" + password + "\n\n"
                 "Store this in your team's password manager. This file is local and excluded from Git.\n"
                 "For a reviewed backend set DEVELOPER_PASSWORD_HASH to the hash in the sibling JSON.\n"
                 "Rotation invalidates existing panel unlocks after the backend reloads its settings.\n")
config = root / f"developer-config-{stamp}.json"
with config.open("x", encoding="utf-8") as stream:
    json.dump({"developer_password_hash": encoded,
               "access_token_signing_key": secrets.token_urlsafe(48)}, stream)
print(f"Password handoff: {handoff}")
print(f"Private local demo configuration: {config}")
