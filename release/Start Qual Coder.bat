@echo off
rem Double-click to start Qual Coder. Leave this window open while you work.
setlocal
cd /d "%~dp0"
title Qual Coder

rem Opening the zip without extracting it runs this file alone from a
rem temporary folder, without the rest of Qual Coder.
if not exist "server.py" (
  echo.
  echo Qual Coder has to be unzipped before it can start:
  echo.
  echo   1. Close this window.
  echo   2. Right-click the Qual Coder zip file, choose "Extract All", then click Extract.
  echo   3. In the folder that opens, double-click "Start Qual Coder".
  echo.
  pause
  exit /b 1
)

rem The Windows download includes its own Python; otherwise use an installed one.
set "PY="
if exist "python\python.exe" set "PY=python\python.exe"
if not defined PY py -3 -c "import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)" >nul 2>nul && set "PY=py -3"
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
echo Qual Coder has stopped. If it stopped by itself, take a screenshot of this
echo window and send it to whoever gave you Qual Coder.
pause
