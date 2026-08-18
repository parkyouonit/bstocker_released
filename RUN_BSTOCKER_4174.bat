@echo off
setlocal
cd /d "%~dp0"
title bStocker - LAN 4174

where node.exe >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js is not installed or is not in PATH.
  echo Install Node.js LTS, then run this file again.
  pause
  exit /b 1
)

where npm.cmd >nul 2>&1
if errorlevel 1 (
  echo [ERROR] npm is not available.
  pause
  exit /b 1
)

if not exist "node_modules\vite\bin\vite.js" (
  echo Installing dependencies for the first run...
  call npm.cmd ci
  if errorlevel 1 goto :failed
)

echo Building bStocker...
call npm.cmd run build
if errorlevel 1 goto :failed

echo Starting bStocker on fixed port 4174 and API on 8787...
node scripts\run-local.mjs
if errorlevel 1 goto :failed
exit /b 0

:failed
echo.
echo [ERROR] bStocker could not start. Read the message above.
pause
exit /b 1
