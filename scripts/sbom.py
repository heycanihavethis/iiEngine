"""Emit a deterministic CycloneDX dependency inventory from committed dependency locks."""
import json
import re
import tomllib
from pathlib import Path
from urllib.parse import quote

import yaml

root = Path(__file__).resolve().parents[1]
components = {}


def add(kind, name, version):
    purl = f"pkg:{kind}/{quote(name, safe='/')}@{quote(version, safe='')}"
    components[purl] = {"type": "library", "name": name, "version": version, "purl": purl, "bom-ref": purl}


pnpm = yaml.safe_load((root / "pnpm-lock.yaml").read_text(encoding="utf-8"))
for key in pnpm["packages"]:
    name, version = key.rsplit("@", 1)
    add("npm", name, version)
rust = tomllib.loads((root / "apps/desktop/src-tauri/Cargo.lock").read_text(encoding="utf-8"))
for package in rust["package"]:
    if package.get("source", "").startswith("registry+"):
        add("cargo", package["name"], package["version"])
for line in (root / "services/api/requirements-dev.lock").read_text(encoding="utf-8-sig").splitlines():
    if match := re.fullmatch(r"([A-Za-z0-9_.-]+)==([A-Za-z0-9_.+!-]+)", line):
        add("pypi", match[1].lower().replace("_", "-"), match[2])
bom = {"bomFormat": "CycloneDX", "specVersion": "1.6", "version": 1,
       "metadata": {"component": {"type": "application", "name": "ii Engine", "version": "0.1.0"},
                    "properties": [{"name": "ii:scope", "value": "Runtime and development lockfile dependencies; not a vulnerability attestation"}]},
       "components": [components[key] for key in sorted(components)]}
destination = root / "outputs" / "sbom.cdx.json"
destination.parent.mkdir(exist_ok=True)
destination.write_text(json.dumps(bom, indent=2) + "\n", encoding="utf-8")
print(f"SBOM written: {len(components)} components from dependency locks.")
