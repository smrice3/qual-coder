# Qual Coder

A local workspace for qualitative coding. You run a small server on your own
computer (Mac, Windows or Linux, Python 3.8+), and the app opens in your
browser. Projects stay on that computer.

## Start it

- Mac (this folder): `./qual-coder`, or the launch config "qual-coder" in the
  Claude browser pane
- Classmates: unzip the release and double-click `Start Qual Coder.command`
  (Mac) or `Start Qual Coder.bat` (Windows). See `release/READ ME FIRST.txt`.

It opens http://127.0.0.1:4350 (or the next free port). Launching it again
while it's running just reopens the browser. Options: `--port`, `--data`
(or the `QUALCODER_DATA` environment variable).

## Where projects live

`~/Qual Coder Projects` (`C:\Users\<name>\Qual Coder Projects` on Windows).
That folder is outside Documents and Desktop on purpose, because those are
often synced to iCloud or OneDrive. Each project is `<id>/project.json`,
with `backups/` (an automatic copy every 10 minutes, the last 60 kept, plus
named snapshots) and `ai-log.jsonl`. Deleted projects move to `_trash/`.

## Features

- **Documents:** import .docx, .txt, .md, .rtf, .vtt and .srt captions
  (merged into speaker turns), CSV rows (one document per row), .pdf (needs
  `pdftotext`), .doc (Mac only), or pasted text. Documents have sets and
  attributes.
- **Code:** select text, type a code, and press Enter (Shift+Enter keeps the
  picker open). In vivo codes, overlapping codes, turn labels like `T12`.
- **Codebook:** child codes, definition, when to use, when not to use, example,
  merge, delete, and import from an indented list or CSV.
- **Memos:** dated and typed, linked to codes, documents, excerpts and themes.
- **Search** (`/`): exact phrase, any word or all words; whole-word matching
  and `*` endings; only text not yet coded; frequent words. Code results in
  bulk as the match, the sentence, or the paragraph (without the speaker
  label). These codings are marked "from text search" in exports.
- **Analyze:** retrieve excerpts with attribute filters and context, a
  code × document or × attribute matrix, and co-occurrence.
- **Themes:** drag codes into categories and categories into themes.
- **Export:** CSVs, copy for Google Docs, HTML reports, a coded transcript,
  the codebook, memos, the audit trail, and the full project JSON.
- **Safety:** undo, autosave, backups, snapshots and restore, a warning when
  another tab has saved, and delete-to-trash.

## AI suggestions: local Ollama only, off by default

To turn them on, open a project's Settings and confirm two statements: no
rule prohibits AI-assisted coding of this data, and you'll review every
suggestion. Requests go only to Ollama on the same computer. The server
refuses any `OLLAMA_HOST` that isn't local and bypasses proxies. Long
passages are split into chunks of about 6,000 characters. Suggestions must
quote the text exactly, and nothing is coded until you accept it. Accepted
codings are labeled AI everywhere, and each request is logged.

Setup: install Ollama (https://ollama.com/download), then
`ollama pull llama3.1:8b`. Choose the model in Settings.

**Don't turn AI on for TEL 713 / EdD course data.** The course doesn't allow
AI coding or analysis, even with a local model.

## Releasing to classmates

```bash
python3 make_release.py
```

This writes `dist/QualCoder-<version>.zip` with the server, the app, both
launchers, and `READ ME FIRST.txt`. It never includes any projects. Bump
`VERSION` in `server.py` first.

## Files

- `server.py`: local server, standard library only
- `app/`: browser app (plain JavaScript modules, no build step)
- `release/`: the launchers and the classmate guide that go in the zip
- `make_release.py`: builds the zip
