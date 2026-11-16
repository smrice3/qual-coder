#!/usr/bin/env python3
"""Build the downloads to share, in dist/:

  QualCoder-<version>-Mac.zip           Python included (Apple chip and Intel)
  QualCoder-<version>-Windows.zip       Python included (64-bit Windows)
  QualCoder-<version>-needs-Python.zip  any system with Python 3.8+ installed

Each holds the server, the app, the launcher for that system, a plain-text
guide written for that download (from release/READ ME FIRST.txt), and
google.json when it exists. None of them includes any projects.

The first run downloads the Python builds (about 60 MB) into .release-cache/
and refuses any file whose SHA-256 doesn't match the checksums below, which
come from python.org and the python-build-standalone release.

Run: python3 make_release.py            (all three)
     python3 make_release.py mac        (just one: mac, windows or plain)
"""
import hashlib
import posixpath
import re
import sys
import tarfile
import urllib.request
import zipfile
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parent
VERSION = re.search(r'^VERSION = "([^"]+)"', (ROOT / "server.py").read_text("utf-8"), re.M).group(1)
TOP = f"Qual Coder {VERSION}"
CACHE = ROOT / ".release-cache"
STAMP = (2026, 1, 1, 0, 0, 0)

# Python 3.14 (3.13 now gets source-only security releases, with no Windows build).
PBS = "https://github.com/astral-sh/python-build-standalone/releases/download/20261110/"
PYTHONS = {
    "windows": (
        "https://www.python.org/ftp/python/3.14.10/python-3.14.10-embed-amd64.zip",
        "90905e64a840557d8c1bc4f5b74db3d7ee85e3ffb217611cac1c7813acea4159",
    ),
    "mac-arm64": (
        PBS + "cpython-3.14.10%2B20261110-aarch64-apple-darwin-install_only_stripped.tar.gz",
        "f15ec3d15460dd66c2eb88639b152cd9040e7d1ece11e38bf89e8f53f0171e02",
    ),
    "mac-x86_64": (
        PBS + "cpython-3.14.10%2B20261110-x86_64-apple-darwin-install_only_stripped.tar.gz",
        "85f8e54798e8e6aa58d2253f013d815c5616343cc0d15cbea882fca78bdfeae2",
    ),
}

# Parts of the Mac Python that Qual Coder never uses (tests, IDLE, Tk, pip,
# headers, docs, and the shared library: bin/python3.x is linked statically).
# Leaving them out more than halves the download.
TRIM = re.compile(
    r"^(include|share)/"
    r"|^lib/(pkgconfig|tcl|tk|itcl|thread)"
    r"|^lib/lib(tcl|tk|python)"
    r"|^lib/python3\.\d+/(test|idlelib|tkinter|turtledemo|ensurepip|site-packages/pip[^/]*|config-[^/]*)/"
    r"|^lib/python3\.\d+/lib-dynload/(_tkinter|_test|_ctypes_test|xxlimited|_xxtestfuzz)"
    r"|/__pycache__/"
    r"|^bin/(idle|pydoc|pip|2to3|python3\.\d+-config|python3-config|python-config)"
)


class Release:
    def __init__(self, path: Path):
        self.zip = zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9)
        self.names = set()

    def add(self, arc: str, data: bytes, executable: bool = False, symlink: bool = False) -> None:
        name = f"{TOP}/{arc}"
        if name in self.names:
            raise SystemExit(f"Duplicate file in the zip: {arc}")
        self.names.add(name)
        info = zipfile.ZipInfo(name, date_time=STAMP)
        info.create_system = 3  # Unix, so a Mac keeps execute permissions and links
        mode = 0o120755 if symlink else (0o100755 if executable else 0o100644)
        info.external_attr = mode << 16
        info.compress_type = zipfile.ZIP_STORED if symlink else zipfile.ZIP_DEFLATED
        self.zip.writestr(info, data)

    def close(self) -> None:
        self.zip.close()


def fetch(key: str) -> Path:
    """Download a Python build once, and check it against its pinned checksum."""
    url, sha = PYTHONS[key]
    dest = CACHE / url.rsplit("/", 1)[1].replace("%2B", "+")
    if not dest.is_file():
        CACHE.mkdir(exist_ok=True)
        print(f"Downloading {dest.name} …")
        part = dest.with_suffix(dest.suffix + ".part")
        with urllib.request.urlopen(url, timeout=120) as r, open(part, "wb") as f:
            while True:
                block = r.read(1 << 20)
                if not block:
                    break
                f.write(block)
        part.rename(dest)
    digest = hashlib.sha256(dest.read_bytes()).hexdigest()
    if digest != sha:
        dest.unlink()
        raise SystemExit(f"{dest.name} doesn't match its published checksum, so it was deleted. Try again.")
    return dest


def add_windows_python(rel: Release) -> None:
    with zipfile.ZipFile(fetch("windows")) as src:
        for info in src.infolist():
            path = PurePosixPath(info.filename)
            if info.is_dir() or path.is_absolute() or ".." in path.parts:
                continue
            rel.add(f"python/{path}", src.read(info))


def add_mac_python(rel: Release, key: str) -> int:
    kept = 0
    with tarfile.open(fetch(key), "r:gz") as src:
        for m in src.getmembers():
            path = PurePosixPath(m.name)
            if not path.parts or path.parts[0] != "python" or ".." in path.parts or path.is_absolute():
                continue
            inner = "/".join(path.parts[1:])
            if not inner or m.isdir() or TRIM.search(inner) or TRIM.search("/" + inner):
                continue
            arc = f"python/{key}/{inner}"
            if m.issym():
                norm = posixpath.normpath(posixpath.join(posixpath.dirname(m.name), m.linkname))
                if m.linkname.startswith("/") or not norm.startswith("python/"):
                    raise SystemExit(f"Unexpected link in {key}: {m.name} -> {m.linkname}")
                if TRIM.search(norm[len("python/"):]):
                    continue  # it points at something left out
                rel.add(arc, m.linkname.encode(), symlink=True)
            elif m.isfile() or m.islnk():
                rel.add(arc, src.extractfile(m).read(), executable=bool(m.mode & 0o111))
            else:
                continue
            kept += 1
    return kept


def guide(variant: str) -> str:
    """The guide for one download: [[mac]], [[windows,plain]] … [[end]] mark
    lines that belong only to some downloads."""
    out, keep = [], True
    for line in (ROOT / "release" / "READ ME FIRST.txt").read_text("utf-8").splitlines():
        m = re.fullmatch(r"\[\[([a-z, ]+)\]\]", line.strip())
        if m:
            tags = {t.strip() for t in m.group(1).split(",")}
            keep = "end" in tags or variant in tags
            continue
        if keep:
            out.append(line)
    text = "\n".join(out).replace("{VERSION}", VERSION) + "\n"
    return text.replace("\n", "\r\n") if variant != "mac" else text


def build(variant: str) -> Path:
    suffix = {"mac": "Mac", "windows": "Windows", "plain": "needs-Python"}[variant]
    out = ROOT / "dist" / f"QualCoder-{VERSION}-{suffix}.zip"
    out.parent.mkdir(exist_ok=True)
    rel = Release(out)
    rel.add("server.py", (ROOT / "server.py").read_bytes())
    for f in sorted((ROOT / "app").rglob("*")):
        if f.is_file() and not f.name.startswith("."):
            rel.add(f.relative_to(ROOT).as_posix(), f.read_bytes())
    if variant in ("mac", "plain"):
        rel.add("Start Qual Coder.command", (ROOT / "release" / "Start Qual Coder.command").read_bytes(), executable=True)
    if variant in ("windows", "plain"):
        rel.add("Start Qual Coder.bat", (ROOT / "release" / "Start Qual Coder.bat").read_bytes())
    rel.add("READ ME FIRST.txt", guide(variant).encode("utf-8"))
    shared_google = ROOT / "google.json"
    if shared_google.is_file():
        # Public Google identifiers (client ID, restricted API key, project
        # number), so people can sign in without their own Cloud setup.
        rel.add("google.json", shared_google.read_bytes())
    if variant == "windows":
        add_windows_python(rel)
    if variant == "mac":
        add_mac_python(rel, "mac-arm64")
        add_mac_python(rel, "mac-x86_64")
    rel.close()
    print(f"Built {out.relative_to(ROOT)} ({out.stat().st_size / 1048576:.1f} MB)"
          + ("; includes google.json" if shared_google.is_file() else ""))
    return out


def main() -> None:
    variants = sys.argv[1:] or ["mac", "windows", "plain"]
    for v in variants:
        if v not in ("mac", "windows", "plain"):
            raise SystemExit(f"Unknown download '{v}'. Use mac, windows or plain.")
    for v in variants:
        build(v)


if __name__ == "__main__":
    main()
