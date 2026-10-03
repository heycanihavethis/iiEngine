"""Inspect the explicitly supplied upload without executing code or extracting secrets."""
import hashlib
import json
import tarfile
import zipfile
from pathlib import Path

source = Path("C:/Users/Blake Chesebro/OneDrive/Desktop/upload.zip")
destination = Path(__file__).resolve().parents[1] / "work" / "owner-upload"
destination.mkdir(parents=True, exist_ok=True)
report = {}
with zipfile.ZipFile(source) as archive:
    for entry in archive.infolist():
        if entry.filename not in {"iis.Stupid.Menu-main.zip", "ii.s.Stupid.Menu.dll", "BepInEx.zip", "wfavshre.tar.gz", "iireborn settings.zip"}:
            continue
        target = destination / entry.filename
        if not target.exists():
            with archive.open(entry) as src, target.open("xb") as out:
                while chunk := src.read(1024 * 1024):
                    out.write(chunk)
        report[entry.filename] = {"bytes": entry.file_size}
        if target.suffix == ".zip":
            with zipfile.ZipFile(target) as inner:
                names = inner.namelist()
                report[entry.filename]["entries"] = len(names)
                report[entry.filename]["bootstrap_files"] = [n for n in names if Path(n).name.lower() in {"winhttp.dll", "doorstop_config.ini", "bepinex.dll"}]
                report[entry.filename]["source_files"] = sum(n.endswith('.cs') for n in names)
                report[entry.filename]["sensitive_filename_count"] = sum(Path(n).name.lower().startswith('.env') or 'installid' in n.lower() for n in names)
        elif target.name.endswith('.tar.gz'):
            with tarfile.open(target) as inner:
                names = inner.getnames()
                report[entry.filename]["entries"] = len(names)
                report[entry.filename]["python_files"] = sum(n.endswith('.py') for n in names)
                report[entry.filename]["sensitive_filename_count"] = sum(Path(n).name.lower().startswith('.env') for n in names)
        else:
            report[entry.filename]["sha256"] = hashlib.sha256(target.read_bytes()).hexdigest()
print(json.dumps(report, indent=2))
