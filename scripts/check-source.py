"""Scan only Git-visible project files; never read ignored user data or downloaded tools."""
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PATTERNS = [
    re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    re.compile(r"\bnvapi-[A-Za-z0-9_-]{30,}\b"),
    re.compile(r"\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{30,}\b"),
    re.compile(r"\b[A-Za-z0-9_-]{23,30}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}\b"),
]


def main():
    paths = subprocess.check_output(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], cwd=ROOT
    ).decode().split("\0")
    failures = []
    for name in sorted(set(paths) - {""}):
        path = ROOT / name
        if not path.resolve().is_relative_to(ROOT) or path.is_symlink():
            failures.append((name, "Unsafe source path"))
            continue
        if not path.is_file():
            continue
        lower = path.name.lower()
        if (lower.startswith(".env") and lower != ".env.example") or lower in {
            "installid.txt", "libraryfolders.vdf", "loginusers.vdf"
        } or path.suffix.lower() in {".key", ".pem", ".pfx", ".p12", ".db", ".sqlite", ".log", ".dll", ".exe", ".zip"}:
            failures.append((name, "Private/local/binary artifact must not be in source"))
            continue
        try:
            content = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        if any(pattern.search(content) for pattern in PATTERNS):
            failures.append((name, "Potential credential/private key; content withheld"))
    for name, message in failures:
        print(f"{name}: {message}")
    if failures:
        raise SystemExit(1)
    print(f"Source boundary scan passed ({len(set(paths) - {''})} Git-visible files).")


if __name__ == "__main__":
    main()
