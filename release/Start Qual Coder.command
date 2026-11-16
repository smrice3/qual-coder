#!/bin/bash
# Double-click to start Qual Coder. Leave this window open while you work.
cd "$(dirname "$0")" || exit 1
shopt -s execfail

# The Mac download includes its own Python: python/mac-arm64 for Apple chips,
# python/mac-x86_64 for Intel. macOS flags downloaded files and won't run a
# flagged program from an unregistered developer. You already allowed this
# launcher, so clear the flag from the included Python before starting it.
case "$(uname -m)" in
  arm64) BUNDLED="mac-arm64 mac-x86_64" ;;
  *)     BUNDLED="mac-x86_64" ;;
esac
for A in $BUNDLED; do
  if [ -x "python/$A/bin/python3" ]; then
    xattr -dr com.apple.quarantine "python/$A" 2>/dev/null
    exec "python/$A/bin/python3" -I server.py --open "$@"
  fi
done

# Otherwise use a Python that's already installed.
for PY in /Library/Frameworks/Python.framework/Versions/Current/bin/python3 /opt/homebrew/bin/python3 /usr/local/bin/python3 "$(command -v python3)"; do
  [ -n "$PY" ] && [ -x "$PY" ] || continue
  # Apple's /usr/bin/python3 is a placeholder until the Command Line Tools are
  # installed; running it then pops up an install prompt.
  if [ "$PY" = /usr/bin/python3 ] && ! xcode-select -p >/dev/null 2>&1; then continue; fi
  if "$PY" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)' >/dev/null 2>&1; then
    exec "$PY" server.py --open "$@"
  fi
done

echo
if [ -d python ]; then
  echo "Qual Coder's own copy of Python didn't start."
  echo "Take a screenshot of this window and send it to whoever gave you Qual Coder."
else
  echo "Qual Coder needs Python 3.8 or newer, which isn't installed yet."
  echo "Install it from https://www.python.org/downloads/macos/ and then double-click this file again."
fi
echo
read -n 1 -s -r -p "Press any key to close this window."
