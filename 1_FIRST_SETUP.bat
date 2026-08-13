@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title bStocker - First Setup

where node.exe >nul 2>&1
if errorlevel 1 (
  echo [오류] Node.js LTS가 설치되어 있지 않습니다.
  echo https://nodejs.org 에서 Node.js 20.19 이상을 설치하세요.
  pause
  exit /b 1
)

echo.
echo 이 설정은 Robinhood Chain 메인넷 5틱 자동화 거래를 활성화합니다.
echo v2.8 Vault에는 금액 상한이 없으며 TWAP MEV 가드와 자동 USDG 안전 종료를 사용합니다.
set /p OWNER=본인이 사용할 Rabby/MetaMask EVM 지갑 주소를 입력하세요:
set /p ACK=위험을 이해했다면 LIVE 를 입력하세요:
if /I not "%ACK%"=="LIVE" (
  echo 설정을 취소했습니다.
  pause
  exit /b 1
)

node scripts\setup-release.mjs "%OWNER%"
if errorlevel 1 (
  pause
  exit /b 1
)

echo.
echo 최초 설정이 끝났습니다. 이제 2_RUN_BSTOCKER.bat을 실행하세요.
pause
