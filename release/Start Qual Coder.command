#!/bin/bash
# Double-click to start Qual Coder. Leave this window open while you work.
cd "$(dirname "$0")" || exit 1
for PY in /Library/Frameworks/Python.framework/Versions/Current/bin/python3 /opt/homebrew/bin/python3 /usr/local/bin/python3 python3; do
  if command -v "$PY" >/dev/null 2>&1 && "$PY" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)' >/dev/null 2>&1; then
    exec "$PY" server.py --open "$@"
  fi
done
echo
echo "Qual Coder needs Python 3.8 or newer, which isn't installed yet."
echo "Install it from https://www.python.org/downloads/macos/ and then double-click this file again."
echo
read -n 1 -s -r -p "Press any key to close this window."
