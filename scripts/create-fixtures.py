"""Create inert synthetic game trees. These text files are not executable binaries."""
from pathlib import Path
import argparse

parser = argparse.ArgumentParser()
parser.add_argument("--destination", default="work/fixtures")
args = parser.parse_args()
root = Path(args.destination).resolve()
workspace = Path(__file__).resolve().parents[1]
if not root.is_relative_to(workspace / "work"):
    raise SystemExit("Fixture output must stay inside workspace/work")
for scenario in ("healthy-layout", "missing-loader", "unknown-plugin", "duplicates"):
    game = root / scenario / "Gorilla Tag"
    for directory in ("Gorilla Tag_Data", "BepInEx/plugins", "BepInEx/config", "BepInEx/patchers", "iisStupidMenu"):
        (game / directory).mkdir(parents=True, exist_ok=True)
    for name in ("Gorilla Tag.exe", "UnityPlayer.dll"):
        (game / name).write_text("INERT SYNTHETIC TEST FIXTURE\n")
    if scenario != "missing-loader":
        (game / "BepInEx/core").mkdir(exist_ok=True)
        (game / "BepInEx/core/BepInEx.dll").write_text("INERT baseline layout fixture; never trusted for install")
    if scenario == "unknown-plugin":
        (game / "BepInEx/plugins/unknown.dll").write_text("INERT UNKNOWN PLUGIN")
    if scenario == "duplicates":
        for alias in ("ii.s.Stupid.Menu.dll", "iis_Stupid_Menu.dll"):
            (game / "BepInEx/plugins" / alias).write_text("INERT alias fixture; not managed metadata")
print(f"Created four inert scenarios under {root}")
