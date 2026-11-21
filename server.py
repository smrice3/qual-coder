#!/usr/bin/env python3
"""Qual Coder: a local workspace for qualitative coding.

Serves the browser app in ./app and keeps each project as one JSON file in the
projects folder (by default "Qual Coder Projects" in your home folder), with
rolling automatic backups and named snapshots. Standard library only; runs on
Python 3.8+ on macOS, Windows and Linux. It listens on 127.0.0.1 only, so
nothing is reachable from other machines.

AI suggestions are off in every project unless turned on in that project's
Settings. When on, they come from a model running on this computer through
Ollama (https://ollama.com). Text is sent only to that local model, never over
the network, and every request is logged in the project's ai-log.jsonl.
"""
from __future__ import annotations

import argparse
import base64
import datetime as dt
import hashlib
import io
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import urllib.error
import urllib.request
import webbrowser
import xml.etree.ElementTree as ET
import zipfile
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

VERSION = "1.3.0"
ROOT = Path(__file__).resolve().parent
APP_DIR = ROOT / "app"
DEFAULT_PORT = 4350
SCHEMA_VERSION = 1
AUTO_BACKUP_EVERY = dt.timedelta(minutes=10)
AUTO_BACKUP_KEEP = 60
MAX_BODY = 80 * 1024 * 1024
MAX_AI_CHARS = 150_000
AI_CHUNK_CHARS = 6000
LOCK = threading.RLock()


def default_data_dir() -> Path:
    env = os.environ.get("QUALCODER_DATA", "").strip()
    if env:
        return Path(env).expanduser()
    # The home folder itself, not Documents or Desktop: those are often synced
    # to iCloud or OneDrive, which may not be approved for research data.
    return Path.home() / "Qual Coder Projects"


def now() -> dt.datetime:
    return dt.datetime.now().astimezone()


def iso(t: dt.datetime | None = None) -> str:
    return (t or now()).isoformat(timespec="seconds")


def stamp() -> str:
    return now().strftime("%Y%m%d-%H%M%S")


def slug(s: str, n: int = 40) -> str:
    return re.sub(r"[^a-z0-9]+", "-", (s or "").lower()).strip("-")[:n]


class HttpError(Exception):
    def __init__(self, status: int, message: str, extra: dict | None = None):
        super().__init__(message)
        self.status = status
        self.message = message
        self.extra = extra or {}


# --------------------------------------------------------------------------
# Storage

def blank_project(pid: str, name: str) -> dict:
    t = iso()
    return {
        "schema": SCHEMA_VERSION,
        "id": pid,
        "name": name,
        "created": t,
        "updated": t,
        "rev": 1,
        "settings": {"ai_enabled": False, "ai_ack": None, "ai_model": "", "ai_instructions": ""},
        "attributes": [],
        "documents": [],
        "codes": [],
        "codings": [],
        "memos": [],
        "groups": [],
        "suggestions": [],
        "log": [{"t": t, "action": "Project created", "detail": name}],
    }


class Store:
    def __init__(self, data_dir: Path):
        self.dir = data_dir
        self.dir.mkdir(parents=True, exist_ok=True)

    def pdir(self, pid: str) -> Path:
        if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", pid or ""):
            raise HttpError(400, "Bad project id")
        d = self.dir / pid
        if not (d / "project.json").is_file():
            raise HttpError(404, "No such project")
        return d

    @staticmethod
    def _write(path: Path, obj: dict) -> None:
        tmp = path.with_name(f".{path.name}.{secrets.token_hex(4)}.tmp")
        tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=1), "utf-8")
        for attempt in range(5):
            try:
                os.replace(tmp, path)
                return
            except PermissionError:
                # Windows: antivirus or a sync client can hold the file briefly.
                if attempt == 4:
                    raise
                time.sleep(0.2)

    @staticmethod
    def _read(path: Path) -> dict:
        return json.loads(path.read_text("utf-8"))

    def list(self) -> list:
        out = []
        for d in self.dir.iterdir():
            f = d / "project.json"
            if not f.is_file():
                continue
            try:
                p = self._read(f)
            except Exception:
                continue
            out.append({
                "id": d.name,
                "name": p.get("name", d.name),
                "updated": p.get("updated"),
                "documents": len(p.get("documents", [])),
                "codes": len(p.get("codes", [])),
                "codings": len(p.get("codings", [])),
                "ai_enabled": bool(p.get("settings", {}).get("ai_enabled")),
            })
        out.sort(key=lambda x: x.get("updated") or "", reverse=True)
        return out

    def _new_id(self, name: str) -> str:
        base = slug(name) or "project"
        pid, n = base, 2
        while (self.dir / pid).exists():
            pid, n = f"{base}-{n}", n + 1
        return pid

    def create(self, name: str, imported: dict | None = None) -> dict:
        name = (name or "").strip() or "Untitled project"
        with LOCK:
            pid = self._new_id(name)
            d = self.dir / pid
            (d / "backups").mkdir(parents=True)
            if imported is None:
                project = blank_project(pid, name)
            else:
                project = dict(imported)
                project.update({"id": pid, "name": name, "rev": 1, "updated": iso()})
                project.setdefault("log", []).append(
                    {"t": iso(), "action": "Project imported from file", "detail": name})
            self._write(d / "project.json", project)
            return project

    def load(self, pid: str) -> dict:
        return self._read(self.pdir(pid) / "project.json")

    def save(self, pid: str, project: dict, base_rev) -> int:
        if not isinstance(project, dict):
            raise HttpError(400, "Missing project")
        with LOCK:
            d = self.pdir(pid)
            f = d / "project.json"
            current = self._read(f)
            if current.get("rev") != base_rev:
                raise HttpError(
                    409,
                    "This project was saved from somewhere else (another tab or window). "
                    "Reload the page to get the latest version before making more changes.",
                    {"rev": current.get("rev")},
                )
            self._auto_backup(d)
            project["id"] = pid
            project["rev"] = (base_rev or 0) + 1
            project["updated"] = iso()
            self._write(f, project)
            return project["rev"]

    def _auto_backup(self, d: Path) -> None:
        b = d / "backups"
        b.mkdir(exist_ok=True)
        autos = sorted(b.glob("auto-*.json"))
        if autos:
            last = dt.datetime.fromtimestamp(autos[-1].stat().st_mtime).astimezone()
            if now() - last < AUTO_BACKUP_EVERY:
                return
        shutil.copy2(d / "project.json", b / f"auto-{stamp()}.json")
        autos = sorted(b.glob("auto-*.json"))
        for old in autos[:-AUTO_BACKUP_KEEP]:
            try:
                old.unlink()
            except FileNotFoundError:
                pass

    def snapshots(self, pid: str) -> list:
        b = self.pdir(pid) / "backups"
        out = []
        for f in sorted(b.glob("*.json"), reverse=True):
            m = re.match(r"(auto|snap|prerestore)-(\d{8}-\d{6})(?:-(.*))?\.json$", f.name)
            if not m:
                continue
            kind, ts, label = m.groups()
            t = dt.datetime.strptime(ts, "%Y%m%d-%H%M%S").astimezone()
            out.append({"name": f.name, "kind": kind, "label": (label or "").replace("-", " "),
                        "time": iso(t), "size": f.stat().st_size})
        return out

    def snapshot(self, pid: str, label: str) -> dict:
        with LOCK:
            d = self.pdir(pid)
            safe = re.sub(r"[^A-Za-z0-9]+", "-", label or "").strip("-")[:60]
            name = f"snap-{stamp()}" + (f"-{safe}" if safe else "") + ".json"
            shutil.copy2(d / "project.json", d / "backups" / name)
        return {"name": name}

    def restore(self, pid: str, name: str) -> dict:
        if not re.fullmatch(r"[A-Za-z0-9._-]+\.json", name or ""):
            raise HttpError(400, "Bad snapshot name")
        with LOCK:
            d = self.pdir(pid)
            src = d / "backups" / name
            if not src.is_file():
                raise HttpError(404, "No such snapshot")
            current = self._read(d / "project.json")
            shutil.copy2(d / "project.json", d / "backups" / f"prerestore-{stamp()}.json")
            project = self._read(src)
            project["id"] = pid
            project["rev"] = (current.get("rev") or 0) + 1
            project["updated"] = iso()
            project.setdefault("log", []).append(
                {"t": iso(), "action": "Restored snapshot", "detail": name})
            self._write(d / "project.json", project)
            return project

    def trash(self, pid: str) -> dict:
        """Move a project folder (with its backups and AI log) into _trash. Nothing is erased."""
        with LOCK:
            d = self.pdir(pid)
            t = self.dir / "_trash"
            t.mkdir(exist_ok=True)
            dest = t / f"{pid}-{stamp()}"
            shutil.move(str(d), str(dest))
        return {"moved_to": str(dest)}

    def ai_log_append(self, pid: str, entry: dict) -> None:
        with LOCK:
            with open(self.pdir(pid) / "ai-log.jsonl", "a", encoding="utf-8") as fh:
                fh.write(json.dumps(entry, ensure_ascii=False) + "\n")

    def ai_log(self, pid: str) -> list:
        f = self.pdir(pid) / "ai-log.jsonl"
        if not f.is_file():
            return []
        out = []
        for line in f.read_text("utf-8").splitlines():
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                pass
        return out


# --------------------------------------------------------------------------
# Text extraction for imports

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
CUE_TIME = re.compile(r"^\s*((?:\d+:)?\d{1,2}:\d{2})(?:[.,]\d{1,3})?\s*-->")


def decode_text(data: bytes) -> str:
    if data.startswith(b"\xef\xbb\xbf"):
        return data[3:].decode("utf-8", "replace")
    if data.startswith((b"\xff\xfe", b"\xfe\xff")):
        return data.decode("utf-16", "replace")
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return data.decode("cp1252", "replace")


def docx_text(data: bytes) -> str:
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            root = ET.fromstring(z.read("word/document.xml"))
    except (zipfile.BadZipFile, KeyError, ET.ParseError) as e:
        raise HttpError(400, f"Couldn't read this .docx file ({e}).")
    body = root.find(W + "body")
    paras = []
    for p in body.iter(W + "p"):
        parts = []
        for el in p.iter():
            if el.tag == W + "t":
                parts.append(el.text or "")
            elif el.tag == W + "tab":
                parts.append("\t")
            elif el.tag in (W + "br", W + "cr"):
                parts.append("\n")
        paras.append("".join(parts))
    return "\n".join(paras)


def rtf_text(data: bytes) -> str:
    """Plain text from RTF, enough for transcripts. Used where textutil isn't available."""
    s = data.decode("latin-1")
    out, stack, ignore, i = [], [], False, 0
    skip_dest = re.compile(r"\\\*|\\(fonttbl|colortbl|stylesheet|info|pict|header|footer|listtable|listoverridetable|themedata|datastore|latentstyles)\b")
    while i < len(s):
        ch = s[i]
        if ch == "{":
            stack.append(ignore)
            if skip_dest.match(s, i + 1):
                ignore = True
            i += 1
        elif ch == "}":
            ignore = stack.pop() if stack else False
            i += 1
        elif ch == "\\":
            m = re.match(r"\\([a-zA-Z]+)(-?\d+)? ?|\\'([0-9a-fA-F]{2})|\\(.)", s[i:])
            if not m:
                i += 1
                continue
            word, arg, hexch, sym = m.groups()
            if not ignore:
                if word in ("par", "line"):
                    out.append("\n")
                elif word == "tab":
                    out.append("\t")
                elif word == "u" and arg:
                    out.append(chr(int(arg) % 65536))
                    i += m.end()
                    if i < len(s) and s[i] == "?":
                        i += 1
                    continue
                elif hexch:
                    out.append(bytes([int(hexch, 16)]).decode("cp1252", "replace"))
                elif sym in ("\\", "{", "}"):
                    out.append(sym)
            i += m.end()
        elif ch in "\r\n":
            i += 1
        else:
            if not ignore:
                out.append(ch)
            i += 1
    return "".join(out)


def textutil_text(data: bytes, ext: str) -> str:
    exe = shutil.which("textutil")
    if not exe:
        if ext == ".rtf":
            return rtf_text(data)
        raise HttpError(400, f"{ext} files can only be read on a Mac. Save the file as .docx or .txt instead.")
    with tempfile.TemporaryDirectory() as tmp:
        src = Path(tmp) / f"in{ext}"
        src.write_bytes(data)
        proc = subprocess.run([exe, "-convert", "txt", "-stdout", str(src)], capture_output=True, timeout=60)
    if proc.returncode != 0:
        raise HttpError(400, f"Couldn't convert this {ext} file.")
    return decode_text(proc.stdout)


def pdf_text(data: bytes) -> str:
    exe = shutil.which("pdftotext") or next(
        (p for p in ("/opt/homebrew/bin/pdftotext", "/usr/local/bin/pdftotext") if Path(p).exists()), None)
    if not exe:
        raise HttpError(400, "PDF import needs the free pdftotext tool (part of Poppler), which isn't installed. "
                             "Save the PDF as .docx or .txt instead, or copy its text and use Paste text.")
    with tempfile.TemporaryDirectory() as tmp:
        src = Path(tmp) / "in.pdf"
        src.write_bytes(data)
        proc = subprocess.run([exe, "-layout", "-enc", "UTF-8", str(src), "-"], capture_output=True, timeout=120)
    if proc.returncode != 0:
        raise HttpError(400, "Couldn't read text from this PDF.")
    return decode_text(proc.stdout)


def _hms(t: str) -> str:
    parts = t.split(":")
    while len(parts) < 3:
        parts.insert(0, "0")
    h, m, s = (int(x) for x in parts)
    return f"{h:02d}:{m:02d}:{s:02d}"


def caption_text(raw: str) -> str:
    """Turn a .vtt/.srt caption file into speaker turns: [hh:mm:ss] Name: text."""
    turns = []
    cue_time = None
    buf = []

    def flush() -> None:
        nonlocal buf
        if cue_time is None or not buf:
            buf = []
            return
        line = " ".join(buf).strip()
        buf = []
        speaker = None
        m = re.match(r"^<v(?:\.[^\s>]*)?\s+([^>]+)>(.*?)(?:</v>)?$", line)
        if m:
            speaker, line = m.group(1).strip(), m.group(2)
        else:
            m = re.match(r"^([^:]{1,40}):\s+(.*)$", line)
            if m:
                speaker, line = m.group(1).strip(), m.group(2)
        line = re.sub(r"<[^>]+>", "", line).strip()
        if not line:
            return
        if turns and turns[-1][1] == speaker:
            turns[-1][2] += " " + line
        else:
            turns.append([cue_time, speaker, line])

    for line in raw.splitlines():
        m = CUE_TIME.match(line)
        if m:
            flush()
            cue_time = _hms(m.group(1))
            continue
        s = line.strip()
        if not s:
            flush()
            cue_time = None
            continue
        if cue_time is not None:
            buf.append(s)
    flush()
    return "\n\n".join(f"[{t}] {spk}: {txt}" if spk else f"[{t}] {txt}" for t, spk, txt in turns)


DOC_EXTS = {".docx", ".doc", ".rtf", ".odt", ".html", ".htm", ".webarchive", ".pdf", ".vtt", ".srt",
            ".txt", ".text", ".md", ".markdown"}
ZIP_MAX_FILES = 1000
ZIP_MAX_FILE = 50 * 1024 * 1024
ZIP_MAX_TOTAL = 300 * 1024 * 1024


def extract_zip(data: bytes) -> dict:
    """Every document in a .zip, such as a Google Drive download (Docs arrive as .docx)."""
    try:
        z = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        raise HttpError(400, "That .zip file couldn't be opened.")
    docs, skipped, total = [], [], 0
    with z:
        infos = [i for i in z.infolist() if not i.is_dir()]
        if len(infos) > ZIP_MAX_FILES:
            raise HttpError(413, f"That .zip has more than {ZIP_MAX_FILES:,} files. Split it into smaller downloads.")
        for info in sorted(infos, key=lambda i: i.filename.lower()):
            parts = [p for p in info.filename.replace("\\", "/").split("/") if p]
            if not parts or parts[0] == "__MACOSX" or parts[-1].startswith((".", "~$")):
                continue
            base = parts[-1]
            if Path(base).suffix.lower() not in DOC_EXTS:
                skipped.append({"name": info.filename, "reason": "not a document type Qual Coder reads"})
                continue
            if info.file_size > ZIP_MAX_FILE:
                skipped.append({"name": info.filename, "reason": "larger than 50 MB"})
                continue
            total += info.file_size
            if total > ZIP_MAX_TOTAL:
                raise HttpError(413, "That .zip holds more than 300 MB of documents. Split it into smaller downloads.")
            try:
                r = extract(base, z.read(info))
            except HttpError as e:
                skipped.append({"name": info.filename, "reason": e.message})
                continue
            docs.append({"title": r["title"], "text": r["text"], "path": info.filename, "folder": "/".join(parts[:-1])})
    if not docs and not skipped:
        raise HttpError(400, "That .zip file is empty.")
    return {"documents": docs, "skipped": skipped}


def extract(filename: str, data: bytes) -> dict:
    ext = Path(filename).suffix.lower()
    if ext == ".docx":
        text = docx_text(data)
    elif ext in (".doc", ".rtf", ".odt", ".html", ".htm", ".webarchive"):
        text = textutil_text(data, ext)
    elif ext == ".pdf":
        text = pdf_text(data)
    elif ext in (".vtt", ".srt"):
        text = caption_text(decode_text(data))
    elif ext in (".txt", ".text", ".md", ".markdown", ".csv", ".tsv", ""):
        text = decode_text(data)
    else:
        raise HttpError(400, f"{ext} files aren't supported. Use .txt, .md, .docx, .rtf, .pdf, .vtt or .srt.")
    text = text.replace("\r\n", "\n").replace("\r", "\n").replace("\u00a0", " ").replace("\u200b", "")
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text).strip("\n")
    if not text.strip():
        raise HttpError(400, "No text was found in this file.")
    return {"title": Path(filename).stem, "text": text}


# --------------------------------------------------------------------------
# Optional AI suggestions from a local Ollama model

AI_SCHEMA = {
    "type": "object",
    "properties": {
        "suggestions": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "quote": {"type": "string"},
                    "code": {"type": "string"},
                    "is_new_code": {"type": "boolean"},
                    "definition": {"type": "string"},
                    "rationale": {"type": "string"},
                },
                "required": ["quote", "code", "is_new_code", "rationale"],
            },
        }
    },
    "required": ["suggestions"],
}

AI_SYSTEM = """You assist a qualitative researcher with first-cycle coding of text data. You only suggest codes; the researcher decides what to accept, edit or reject.

Rules:
- Prefer codes from the researcher's codebook. Use their names exactly as written and respect each code's definition, inclusion and exclusion notes.
- Propose a new code only when no existing code fits. Give it a short name in the style of the codebook and a one-sentence definition, and set is_new_code to true.
- Every suggestion must quote one contiguous span copied character for character from the passage: no ellipses, no paraphrase, no added punctuation. Choose a meaningful unit, usually a clause to a few sentences.
- Code what participants say. Skip interviewer questions and small talk unless they carry meaning on their own.
- The same span may get more than one code when each applies.
- Give a one-sentence rationale that ties the span to the code.
- Return at most {max_n} suggestions, the strongest first. Return an empty list if nothing fits.
- Answer only with JSON in this shape: {"suggestions": [{"quote": "...", "code": "...", "is_new_code": false, "definition": "", "rationale": "..."}]}"""

LOCAL_HOSTS = ("127.0.0.1", "localhost", "::1")
NO_PROXY = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def ollama_base() -> str:
    """The Ollama address, which must be on this computer."""
    raw = os.environ.get("OLLAMA_HOST", "").strip() or "127.0.0.1:11434"
    if "://" not in raw:
        raw = "http://" + raw
    u = urlparse(raw)
    host = u.hostname or "127.0.0.1"
    if host in ("0.0.0.0", "::"):
        host = "127.0.0.1"
    if host not in LOCAL_HOSTS:
        raise HttpError(400, f"OLLAMA_HOST points to {host}. Qual Coder only uses an Ollama model on this computer.")
    port = u.port or 11434
    return f"http://{'[::1]' if host == '::1' else host}:{port}"


def ollama_call(path: str, body: dict | None = None, timeout: float = 10) -> dict:
    req = urllib.request.Request(
        ollama_base() + path,
        data=None if body is None else json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="GET" if body is None else "POST",
    )
    with NO_PROXY.open(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def ai_status() -> dict:
    try:
        base = ollama_base()
    except HttpError as e:
        return {"available": False, "running": False, "reason": e.message}
    try:
        version = ollama_call("/api/version", timeout=3).get("version")
        tags = ollama_call("/api/tags", timeout=5)
    except Exception:
        return {"available": False, "running": False, "host": base}
    models = sorted(
        m.get("name") for m in tags.get("models", [])
        if m.get("name") and "embed" not in m.get("name", "").lower()
    )
    return {"available": bool(models), "running": True, "version": version, "models": models, "host": base}


def codebook_text(project: dict) -> str:
    codes = project.get("codes", [])
    by_id = {c["id"]: c for c in codes}

    def path(c: dict) -> str:
        names, seen = [c["name"]], {c["id"]}
        while c.get("parent") in by_id and c["parent"] not in seen:
            c = by_id[c["parent"]]
            seen.add(c["id"])
            names.insert(0, c["name"])
        return " > ".join(names)

    lines = []
    for c in sorted(codes, key=path):
        parts = [f"- {c['name']}"]
        if c.get("parent") in by_id:
            parts.append(f"  (under: {path(by_id[c['parent']])})")
        for key, label in (("definition", "Definition"), ("include", "Use when"), ("exclude", "Don't use when")):
            if (c.get(key) or "").strip():
                parts.append(f"  {label}: {c[key].strip()}")
        lines.append("\n".join(parts))
    return "\n".join(lines) if lines else "(The codebook is empty. Propose new codes.)"


TRANS = str.maketrans({"\u2018": "'", "\u2019": "'", "\u201c": '"', "\u201d": '"',
                       "\u2013": "-", "\u2014": "-", "\u00a0": " "})


def _norm_map(s: str):
    out, idx, prev_space = [], [], False
    for i, ch in enumerate(s.translate(TRANS)):
        if ch.isspace():
            if prev_space:
                continue
            ch, prev_space = " ", True
        else:
            prev_space = False
        out.append(ch.lower())
        idx.append(i)
    return "".join(out), idx


def locate(passage: str, quote: str, used: set):
    quote = (quote or "").strip().strip('"').strip()
    if not quote:
        return None
    i = passage.find(quote)
    while i != -1 and (i, i + len(quote)) in used:
        i = passage.find(quote, i + 1)
    if i != -1:
        return i, i + len(quote)
    np_, idx = _norm_map(passage)
    nq, _ = _norm_map(quote)
    nq = nq.strip().rstrip(".")
    j = np_.find(nq) if nq else -1
    if j != -1:
        return idx[j], idx[j + len(nq) - 1] + 1
    parts = [p for p in re.split(r"\s*(?:\.\.\.|\u2026)\s*", quote) if p.strip()]
    if len(parts) > 1:
        a = locate(passage, parts[0], set())
        b = locate(passage, parts[-1], set())
        if a and b and b[1] > a[0]:
            return a[0], b[1]
    return None


def run_model(system: str, prompt: str, model: str) -> dict:
    body = {
        "model": model,
        "stream": False,
        "format": AI_SCHEMA,
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": prompt}],
        "options": {"temperature": 0.2, "num_ctx": 16384},
        "keep_alive": "15m",
    }
    for attempt in range(2):
        try:
            out = ollama_call("/api/chat", body, timeout=900)
            break
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")
            if "not found" in detail.lower():
                raise HttpError(400, f"The model {model} isn't installed. In a terminal, run: ollama pull {model}")
            if attempt == 0 and "format" in detail.lower():
                body["format"] = "json"  # older Ollama without JSON-schema support
                continue
            raise HttpError(502, f"Ollama returned an error: {detail[:400]}")
        except (urllib.error.URLError, ConnectionError, OSError) as e:
            if "timed out" in str(e).lower():
                raise HttpError(504, "The local model took more than 15 minutes. Try a shorter passage or a smaller model.")
            raise HttpError(503, "Ollama isn't running. Open the Ollama app (or run: ollama serve) and try again.")
    content = (out.get("message") or {}).get("content") or ""
    try:
        data = json.loads(content)
    except json.JSONDecodeError:
        m = re.search(r"\{.*\}", content, re.S)
        try:
            data = json.loads(m.group(0)) if m else None
        except json.JSONDecodeError:
            data = None
    if not isinstance(data, dict):
        raise HttpError(502, "The model's answer wasn't in the expected format. Try again, or try another model.")
    return {"data": data, "model": out.get("model") or model}


def chunks(text: str, limit: int = AI_CHUNK_CHARS):
    """Split at paragraph breaks into pieces of at most `limit` characters."""
    pieces, start, pos = [], 0, 0
    for line in text.split("\n"):
        end = pos + len(line)
        if end - start > limit and pos > start:
            pieces.append((start, pos))
            start = pos
        while end - start > limit:
            cut = text.rfind(" ", start, start + limit)
            cut = cut if cut > start else start + limit
            pieces.append((start, cut))
            start = cut
        pos = end + 1
    if start < len(text):
        pieces.append((start, len(text)))
    return [(s, text[s:e]) for s, e in pieces if text[s:e].strip()]


def ai_suggest(store: Store, pid: str, body: dict) -> dict:
    project = store.load(pid)
    st = project.get("settings") or {}
    ack = st.get("ai_ack") or {}
    if not st.get("ai_enabled") or ack.get("backend") != "ollama":
        raise HttpError(403, "AI suggestions are turned off for this project. Turn them on in Settings.")
    model = (st.get("ai_model") or "").strip()
    if not model:
        raise HttpError(400, "Choose a model in Settings › AI suggestions first.")
    doc = next((d for d in project.get("documents", []) if d.get("id") == body.get("doc_id")), None)
    if not doc:
        raise HttpError(404, "Document not found. Wait a moment for the project to save, then try again.")
    text = doc.get("text", "")
    start = max(0, min(len(text), int(body.get("start") or 0)))
    end = body.get("end")
    end = len(text) if end is None else max(start, min(len(text), int(end)))
    passage = text[start:end]
    if not passage.strip():
        raise HttpError(400, "The passage is empty.")
    if len(passage) > MAX_AI_CHARS:
        raise HttpError(413, f"That passage is {len(passage):,} characters. Select less than {MAX_AI_CHARS:,}.")
    instructions = (st.get("ai_instructions") or "").strip()
    codebook = codebook_text(project)
    existing = {c["name"].strip().lower(): c for c in project.get("codes", [])}
    t0 = time.time()
    out, unplaced, model_used = [], 0, model
    parts = chunks(passage)
    for offset, piece in parts:
        max_n = max(3, min(25, len(piece) // 300 + 3))
        prompt = (
            f"Project: {project.get('name', '')}\n\n"
            f"Researcher's focus and coding instructions:\n{instructions or '(none given)'}\n\n"
            f"Codebook:\n{codebook}\n\n"
            f"Passage to code, from the document \"{doc.get('title', '')}\":\n"
            f"<passage>\n{piece}\n</passage>"
        )
        res = run_model(AI_SYSTEM.replace("{max_n}", str(max_n)), prompt, model)
        model_used = res["model"]
        used = set()
        for s in (res["data"].get("suggestions") or [])[: max_n * 2]:
            if not isinstance(s, dict):
                continue
            loc = locate(piece, s.get("quote", ""), used)
            name = (s.get("code") or "").strip()
            if not loc or not name:
                unplaced += 1
                continue
            used.add(loc)
            match = existing.get(name.lower())
            out.append({
                "start": start + offset + loc[0],
                "end": start + offset + loc[1],
                "code": match["name"] if match else name,
                "code_id": match["id"] if match else None,
                "is_new": match is None,
                "definition": (s.get("definition") or "").strip(),
                "rationale": (s.get("rationale") or "").strip(),
            })
    entry = {
        "id": f"ai_{stamp()}_{secrets.token_hex(3)}",
        "t": iso(),
        "doc_id": doc.get("id"),
        "doc_title": doc.get("title"),
        "start": start,
        "end": end,
        "chars_sent": len(passage),
        "chunks": len(parts),
        "codebook_codes": len(project.get("codes", [])),
        "backend": "ollama (this computer)",
        "model": model,
        "model_used": model_used,
        "suggestions": len(out),
        "unplaced": unplaced,
        "seconds": round(time.time() - t0, 1),
    }
    store.ai_log_append(pid, entry)
    return {"suggestions": out, "log": entry}


# --------------------------------------------------------------------------
# Google Drive settings (shared by all projects on this computer)
#
# Only public identifiers are kept here: the OAuth client ID, a Picker API key
# restricted to this app's address, and the Cloud project number. Sign-in
# happens in the browser with Google; the access token stays in the page's
# memory and is never sent to or stored by this server.

GOOGLE_FIELDS = ("client_id", "api_key", "project_number")


def _settings_path(store: Store) -> Path:
    return store.dir / "qualcoder-settings.json"


def google_config(store: Store) -> dict:
    shipped = {}
    f = ROOT / "google.json"
    if f.is_file():
        try:
            shipped = json.loads(f.read_text("utf-8"))
        except (OSError, json.JSONDecodeError):
            shipped = {}
    saved = {}
    p = _settings_path(store)
    if p.is_file():
        try:
            saved = json.loads(p.read_text("utf-8")).get("google") or {}
        except (OSError, json.JSONDecodeError):
            saved = {}
    out = {}
    for k in GOOGLE_FIELDS:
        out[k] = (saved.get(k) or shipped.get(k) or "").strip()
    out["source"] = "this computer" if any(saved.get(k) for k in GOOGLE_FIELDS) else ("included with Qual Coder" if any(shipped.get(k) for k in GOOGLE_FIELDS) else "")
    return out


def save_google_config(store: Store, g: dict) -> dict:
    vals = {k: str(g.get(k) or "").strip() for k in GOOGLE_FIELDS}
    if vals["client_id"] and not vals["client_id"].endswith(".apps.googleusercontent.com"):
        raise HttpError(400, "The client ID should end with .apps.googleusercontent.com.")
    if vals["api_key"] and not re.fullmatch(r"AIza[0-9A-Za-z_-]{35}", vals["api_key"]):
        raise HttpError(400, "That doesn't look like a Google API key (they start with AIza and are 39 characters).")
    if vals["project_number"] and not vals["project_number"].isdigit():
        raise HttpError(400, "The project number is digits only (find it on the Cloud console dashboard).")
    p = _settings_path(store)
    with LOCK:
        data = {}
        if p.is_file():
            try:
                data = json.loads(p.read_text("utf-8"))
            except (OSError, json.JSONDecodeError):
                data = {}
        data["google"] = vals
        Store._write(p, data)
    return google_config(store)


# --------------------------------------------------------------------------
# Updates
#
# New versions are published as releases of the public GitHub repository
# smrice3/qual-coder. Each release carries QualCoder-<version>-update.zip: the
# server, the app, google.json and the guides, without Python or the launchers.
# Qual Coder looks up the latest release (at most every 6 hours, or when
# asked); nothing about projects is sent. "Update now" downloads that zip,
# checks it against the SHA-256 GitHub records for it, keeps the current files
# in .previous-version/, swaps the new ones in, and restarts. Projects live in
# the projects folder, so an update never touches them.

UPDATE_URL = os.environ.get("QUALCODER_UPDATE_URL") or "https://api.github.com/repos/smrice3/qual-coder/releases/latest"
UPDATE_TESTING = bool(os.environ.get("QUALCODER_UPDATE_URL"))  # lets tests use a local http:// release
UPDATE_EVERY = 6 * 3600
UPDATE_MAX_BYTES = 20 * 1024 * 1024
UPDATE_LOCK = threading.Lock()
INSTALL_LOCK = threading.Lock()
_update = {"t": 0.0, "info": None, "asset": None}
RESTART_EXIT_CODE = 3  # the Windows launcher starts Qual Coder again when it exits with this
UPDATE_FILES = re.compile(r"(server\.py|google\.json|update\.json|guides/(mac|windows|plain)\.txt|app/[A-Za-z0-9_./ -]+)")


def parse_version(s: str):
    m = re.fullmatch(r"v?(\d+)\.(\d+)\.(\d+)", (s or "").strip())
    return tuple(int(x) for x in m.groups()) if m else None


def install_kind() -> str:
    """Which download this copy came from, so the right guide is installed."""
    if (ROOT / "python" / "python.exe").is_file():
        return "windows"
    if (ROOT / "python" / "mac-arm64").is_dir() or (ROOT / "python" / "mac-x86_64").is_dir():
        return "mac"
    return "plain"


def restart_mode() -> str:
    if os.environ.get("QUALCODER_RESTART") == "exit" or os.name != "nt":
        return "auto"
    return "manual"


def _fetch(url: str, limit: int, accept: str):
    if not (url.startswith("https://") or UPDATE_TESTING):
        raise HttpError(502, "The update address isn't secure (https), so Qual Coder didn't use it.")
    req = urllib.request.Request(url, headers={"Accept": accept, "User-Agent": f"QualCoder/{VERSION}"})
    with urllib.request.urlopen(req, timeout=30) as r:
        data = r.read(limit + 1)
    if len(data) > limit:
        raise HttpError(413, "The update is larger than expected, so it wasn't installed.")
    return data


def update_check(force: bool = False) -> dict:
    with UPDATE_LOCK:
        if _update["info"] and not force and time.time() - _update["t"] < UPDATE_EVERY:
            return _update["info"]
    info = {"current": VERSION, "available": False, "git": (ROOT / ".git").exists(), "restart": restart_mode()}
    asset = None
    try:
        rel = json.loads(_fetch(UPDATE_URL, 2 * 1024 * 1024, "application/vnd.github+json").decode("utf-8"))
        latest = str(rel.get("tag_name") or "").lstrip("v")
        newer = parse_version(latest) is not None and parse_version(latest) > (parse_version(VERSION) or (0, 0, 0))
        asset = next((a for a in rel.get("assets") or [] if a.get("name") == f"QualCoder-{latest}-update.zip"), None)
        info.update(latest=latest, notes=str(rel.get("body") or "")[:4000],
                    page=str(rel.get("html_url") or ""), published=str(rel.get("published_at") or ""))
        if newer:
            info["available"] = True
            info["full_download"] = asset is None  # a release without an update zip needs a fresh download
    except urllib.error.HTTPError as e:
        info["error"] = "No versions have been published yet." if e.code == 404 else f"GitHub answered with error {e.code}. Try again later."
    except HttpError as e:
        info["error"] = e.message
    except (urllib.error.URLError, OSError, ValueError):
        info["error"] = "Couldn't reach GitHub to check for updates. Check your internet connection."
    info["checked"] = iso()
    with UPDATE_LOCK:
        _update.update(t=time.time(), info=info, asset=asset)
    return info


def _replace(src: Path, dst: Path) -> None:
    # Windows refuses to rename a file another program has open for a moment.
    for attempt in range(10):
        try:
            os.replace(src, dst)
            return
        except PermissionError:
            if attempt == 9:
                raise
            time.sleep(0.3)


def update_install() -> dict:
    if not INSTALL_LOCK.acquire(blocking=False):
        raise HttpError(409, "An update is already being installed.")
    try:
        return _update_install()
    finally:
        INSTALL_LOCK.release()


def _update_install() -> dict:
    info = update_check(force=True)
    if info.get("error"):
        raise HttpError(502, info["error"])
    if not info.get("available"):
        raise HttpError(409, "You already have the latest version.")
    if info.get("git"):
        raise HttpError(409, "This copy of Qual Coder is a git checkout. Update it with git pull instead.")
    if info.get("full_download"):
        raise HttpError(409, "This version needs a fresh download. Get it from the release page.", {"page": info.get("page", "")})
    latest = info["latest"]
    asset = _update["asset"] or {}
    digest = str(asset.get("digest") or "")
    if not digest.startswith("sha256:"):
        raise HttpError(502, "GitHub didn't list a checksum for this update, so it wasn't installed.")
    try:
        data = _fetch(str(asset.get("browser_download_url") or ""), UPDATE_MAX_BYTES, "application/octet-stream")
    except (urllib.error.URLError, OSError):
        raise HttpError(502, "The download didn't finish. Check your internet connection and try again.")
    if hashlib.sha256(data).hexdigest() != digest.split(":", 1)[1].lower():
        raise HttpError(502, "The download didn't match its checksum, so it wasn't installed. Try again.")

    try:
        z = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        raise HttpError(502, "The update file is damaged, so it wasn't installed.")
    names = [n for n in z.namelist() if not n.endswith("/")]
    bad = [n for n in names if not UPDATE_FILES.fullmatch(n) or ".." in n.split("/")]
    if bad or "server.py" not in names or "app/index.html" not in names or "update.json" not in names:
        raise HttpError(502, "The update file isn't laid out as expected, so it wasn't installed.")
    try:
        manifest = json.loads(z.read("update.json").decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise HttpError(502, "The update file is damaged, so it wasn't installed.")
    if manifest.get("version") != latest:
        raise HttpError(502, "The update file is for a different version, so it wasn't installed.")
    if manifest.get("full_download_required"):
        raise HttpError(409, "This version needs a fresh download. Get it from the release page.", {"page": info.get("page", "")})
    new_server = z.read("server.py")
    if f'VERSION = "{latest}"'.encode() not in new_server:
        raise HttpError(502, "The update's version number doesn't match, so it wasn't installed.")
    try:
        compile(new_server, "server.py", "exec")  # refuse a file this Python can't run
    except SyntaxError:
        raise HttpError(502, "The update needs a newer Python than this copy has. Get a fresh download from the release page.", {"page": info.get("page", "")})

    staging = ROOT / ".update-staging"
    previous = ROOT / ".previous-version"
    shutil.rmtree(staging, ignore_errors=True)
    staging.mkdir()
    for n in names:
        out = staging.joinpath(*n.split("/"))
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(z.read(n))
    guide = staging / "guides" / f"{install_kind()}.txt"

    # Swap: current files go to .previous-version/, new ones come in. If any
    # step fails, put everything back.
    moves = [("server.py", "server.py"), ("app", "app")]
    if (staging / "google.json").is_file():
        moves.append(("google.json", "google.json"))
    shutil.rmtree(previous, ignore_errors=True)
    previous.mkdir()
    done = []
    try:
        for new_name, cur_name in moves:
            cur = ROOT / cur_name
            if cur.exists():
                _replace(cur, previous / cur_name)
                done.append(("back", cur_name))
            _replace(staging / new_name, cur)
            done.append(("new", cur_name))
        if guide.is_file():
            if (ROOT / "READ ME FIRST.txt").exists():
                shutil.copy2(ROOT / "READ ME FIRST.txt", previous / "READ ME FIRST.txt")
            text = guide.read_text("utf-8")
            if install_kind() != "mac":
                text = text.replace("\r\n", "\n").replace("\n", "\r\n")
            (ROOT / "READ ME FIRST.txt").write_text(text, "utf-8", newline="")
    except Exception:
        for step, name in reversed(done):
            try:
                if step == "new":
                    _replace(ROOT / name, staging / name)
                else:
                    _replace(previous / name, ROOT / name)
            except OSError:
                pass
        raise HttpError(500, "The update couldn't be installed, so Qual Coder kept the version you had.")
    finally:
        shutil.rmtree(staging, ignore_errors=True)
    print(f"Updated Qual Coder from {VERSION} to {latest}. The previous version is in {previous}.", flush=True)
    mode = restart_mode()
    if mode == "auto":
        threading.Thread(target=_restart, daemon=True).start()
    return {"version": latest, "restart": mode}


def _restart() -> None:
    """Start the new version: the Windows launcher reruns Qual Coder when it
    exits with RESTART_EXIT_CODE; elsewhere this process becomes the new one."""
    time.sleep(0.8)  # let the response reach the browser
    print("Restarting Qual Coder…", flush=True)
    if os.environ.get("QUALCODER_RESTART") == "exit":
        os._exit(RESTART_EXIT_CODE)
    os.environ["QUALCODER_RESTARTED"] = "1"
    args = [a for a in getattr(sys, "orig_argv", [sys.executable] + sys.argv) if a != "--open"]
    os.execv(sys.executable, args)


# --------------------------------------------------------------------------
# HTTP

class Handler(SimpleHTTPRequestHandler):
    store: Store
    server_version = "QualCoder/" + VERSION
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map,
                      ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".svg": "image/svg+xml"}

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(APP_DIR), **kwargs)

    def log_request(self, code="-", size="-"):
        if isinstance(code, int) and code >= 400:
            super().log_request(code, size)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    def _host_ok(self) -> bool:
        host = (self.headers.get("Host") or "").strip()
        host = host[1:].split("]")[0] if host.startswith("[") else host.split(":")[0]
        if host in LOCAL_HOSTS:
            return True
        self.send_error(403, "Forbidden host")
        return False

    def do_GET(self):
        if not self._host_ok():
            return
        path = urlparse(self.path).path
        if path.startswith("/api/"):
            return self._api("GET")
        if path == "/favicon.ico":
            self.send_response(204)
            self.end_headers()
            return None
        return super().do_GET()

    def do_POST(self):
        if self._host_ok():
            self._api("POST")

    def do_PUT(self):
        if self._host_ok():
            self._api("PUT")

    def _json(self, status: int, obj) -> None:
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _body(self) -> dict:
        n = int(self.headers.get("Content-Length") or 0)
        if n > MAX_BODY:
            raise HttpError(413, "Request too large")
        raw = self.rfile.read(n) if n else b""
        if not raw:
            return {}
        try:
            return json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise HttpError(400, "Bad JSON")

    def _api(self, method: str) -> None:
        try:
            # A custom header forces a CORS preflight, which this server never
            # approves, so other websites can't call the API from a browser.
            if self.headers.get("X-QC") != "1":
                raise HttpError(403, "Missing X-QC header")
            parts = [p for p in urlparse(self.path).path.split("/") if p][1:]
            body = self._body() if method in ("POST", "PUT") else {}
            self._json(200, self._route(method, parts, body))
        except HttpError as e:
            self._json(e.status, {"error": e.message, **e.extra})
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            self._json(500, {"error": f"Server error: {e}"})

    def _route(self, method: str, parts: list, body: dict):
        s = self.store
        n = len(parts)
        top = parts[0] if parts else ""
        if top == "projects":
            if n == 1 and method == "GET":
                return {"projects": s.list(), "data_dir": str(s.dir), "version": VERSION}
            if n == 1 and method == "POST":
                return {"project": s.create(body.get("name", ""))}
            if n == 2 and parts[1] == "import" and method == "POST":
                p = body.get("project")
                if not isinstance(p, dict) or not isinstance(p.get("documents"), list):
                    raise HttpError(400, "That file isn't a Qual Coder project.")
                return {"project": s.create(body.get("name") or p.get("name", ""), p)}
            if n >= 2:
                pid = parts[1]
                rest = parts[2:]
                if not rest and method == "GET":
                    return {"project": s.load(pid)}
                if not rest and method == "PUT":
                    return {"rev": s.save(pid, body.get("project"), body.get("base_rev"))}
                if rest == ["snapshots"] and method == "GET":
                    return {"snapshots": s.snapshots(pid)}
                if rest == ["snapshots"] and method == "POST":
                    return {"snapshot": s.snapshot(pid, body.get("label", ""))}
                if rest == ["restore"] and method == "POST":
                    return {"project": s.restore(pid, body.get("name", ""))}
                if rest == ["trash"] and method == "POST":
                    return s.trash(pid)
                if rest == ["ai-log"] and method == "GET":
                    return {"entries": s.ai_log(pid)}
                if rest == ["ai", "suggest"] and method == "POST":
                    return ai_suggest(s, pid, body)
        if parts == ["ai", "status"] and method == "GET":
            return ai_status()
        if parts == ["extract"] and method == "POST":
            try:
                data = base64.b64decode(body.get("data") or "", validate=True)
            except ValueError:
                raise HttpError(400, "Bad file data")
            filename = body.get("filename") or "file.txt"
            if Path(filename).suffix.lower() == ".zip":
                return extract_zip(data)
            return extract(filename, data)
        if parts == ["update"] and method == "GET":
            return update_check()
        if parts == ["update", "check"] and method == "POST":
            return update_check(force=True)
        if parts == ["update", "install"] and method == "POST":
            return update_install()
        if parts == ["config"] and method == "GET":
            return {"google": google_config(s)}
        if parts == ["config"] and method == "PUT":
            return {"google": save_google_config(s, body.get("google") or {})}
        raise HttpError(404, "Not found")


class Server(ThreadingHTTPServer):
    # On Windows, SO_REUSEADDR would let a second copy share the port silently.
    allow_reuse_address = os.name != "nt"
    daemon_threads = True


def already_running(port: int) -> bool:
    """True if a Qual Coder server already answers on this port."""
    req = urllib.request.Request(f"http://127.0.0.1:{port}/api/projects", headers={"X-QC": "1"})
    try:
        with NO_PROXY.open(req, timeout=1.5) as r:
            return "projects" in json.loads(r.read().decode("utf-8"))
    except Exception:
        return False


def main() -> None:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")
        except (AttributeError, ValueError):
            pass
    if sys.version_info < (3, 8):
        sys.exit("Qual Coder needs Python 3.8 or newer.")
    ap = argparse.ArgumentParser(description="Qual Coder local server")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    ap.add_argument("--data", default=None,
                    help="folder that holds projects (default: 'Qual Coder Projects' in your home folder, "
                         "or the QUALCODER_DATA environment variable)")
    ap.add_argument("--open", action="store_true", help="open the app in your browser")
    a = ap.parse_args()
    restarted = os.environ.pop("QUALCODER_RESTARTED", "") == "1"
    data_dir = Path(a.data).expanduser() if a.data else default_data_dir()
    Handler.store = Store(data_dir.resolve())

    httpd = None
    for port in range(a.port, a.port + 10):
        if already_running(port):
            url = f"http://localhost:{port}/"
            print(f"Qual Coder is already running at {url}")
            if a.open:
                webbrowser.open(url)
            return
        # Right after an update the old copy may hold the port for a moment.
        for attempt in range(25 if restarted and port == a.port else 1):
            try:
                httpd = Server(("127.0.0.1", port), Handler)
                break
            except OSError:
                time.sleep(0.2)
        if httpd is not None:
            break
    if httpd is None:
        sys.exit(f"Couldn't find a free port between {a.port} and {a.port + 9}.")
    url = f"http://localhost:{httpd.server_address[1]}/"
    print(f"Qual Coder {VERSION} is running at {url}")
    print(f"Projects folder: {Handler.store.dir}")
    print("Leave this window open while you work. Close it (or press Ctrl+C) to stop Qual Coder.", flush=True)
    if a.open or (restarted and httpd.server_address[1] != a.port):
        webbrowser.open(url)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
