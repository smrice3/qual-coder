@echo off
rem Double-click to start Qual Coder. Leave this window open while you work.
setlocal
cd /d "%~dp0"
title Qual Coder
set "PY="
py -3 -c "import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)" >nul 2>nul && set "PY=py -3"
if not defined PY python -c "import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)" >nul 2>nul && set "PY=python"
if not defined PY (
  echo.
  echo Qual Coder needs Python 3.8 or newer, which isn't installed yet.
  echo Install it from https://www.python.org/downloads/windows/
  echo On the first installer screen, tick "Add python.exe to PATH".
  echo Then double-click this file again.
  echo.
  pause
  exit /b 1
)
%PY% server.py --open %*
echo.
pause
