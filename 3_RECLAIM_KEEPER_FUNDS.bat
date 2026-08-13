@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title bStocker - Reclaim Keeper ETH

where node.exe >nul 2>&1
if errorlevel 1 (
  echo [오류] Node.js LTS가 설치되어 있지 않습니다.
  pause
  exit /b 1
)

if not exist ".env.local" (
  echo [오류] 최초 설정 파일 .env.local이 없습니다.
  pause
  exit /b 1
)

echo.
echo 먼저 bStocker 자동화를 끄고 실행 창에서 Ctrl+C로 앱을 종료해야 합니다.
echo 회수액은 최초 설정의 owner 지갑으로만 전송됩니다.
node scripts\reclaim-robinhood-keeper-funds.mjs --send
if errorlevel 1 (
  echo.
  echo [오류] 회수하지 못했습니다. 위 메시지를 확인하세요.
  pause
  exit /b 1
)
echo.
pause
