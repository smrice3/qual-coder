#!/usr/bin/env python3
"""Build the zip to share: dist/QualCoder-<version>.zip.

It holds the server, the app, double-click launchers for Mac and Windows and a
plain-text guide. It never includes any projects. Run: python3 make_release.py
"""
import re
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
VERSION = re.search(r'^VERSION = "([^"]+)"', (ROOT / "server.py").read_text("utf-8"), re.M).group(1)
TOP = f"Qual Coder {VERSION}"


def add(z: zipfile.ZipFile, src: Path, arc: str, executable: bool = False, data: bytes = None) -> None:
    info = zipfile.ZipInfo(f"{TOP}/{arc}", date_time=(2026, 1, 1, 0, 0, 0))
    info.create_system = 3  # Unix, so the Mac keeps the launcher's execute permission
    info.external_attr = (0o100755 if executable else 0o100644) << 16
    info.compress_type = zipfile.ZIP_DEFLATED
    z.writestr(info, data if data is not None else src.read_bytes())


def main() -> None:
    out = ROOT / "dist" / f"QualCoder-{VERSION}.zip"
    out.parent.mkdir(exist_ok=True)
    guide = (ROOT / "release" / "READ ME FIRST.txt").read_text("utf-8").replace("{VERSION}", VERSION)
    with zipfile.ZipFile(out, "w") as z:
        add(z, ROOT / "server.py", "server.py")
        for f in sorted((ROOT / "app").rglob("*")):
            if f.is_file() and not f.name.startswith("."):
                add(z, f, f.relative_to(ROOT).as_posix())
        add(z, ROOT / "release" / "Start Qual Coder.command", "Start Qual Coder.command", executable=True)
        add(z, ROOT / "release" / "Start Qual Coder.bat", "Start Qual Coder.bat")
        add(z, None, "READ ME FIRST.txt", data=guide.replace("\n", "\r\n").encode("utf-8"))
    print(f"Built {out} ({out.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
