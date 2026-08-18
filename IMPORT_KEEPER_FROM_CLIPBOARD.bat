@echo off
setlocal
cd /d "%~dp0"
node "scripts\import-robinhood-keeper-key.mjs"
if errorlevel 1 (
  echo.
  echo Keeper import failed. The existing key file was preserved.
  pause
  exit /b 1
)
endlocal
