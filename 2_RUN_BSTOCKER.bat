@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title bStocker - Local 4174

where node.exe >nul 2>&1
if errorlevel 1 (
  echo [오류] Node.js LTS가 설치되어 있지 않습니다.
  pause
  exit /b 1
)

where npm.cmd >nul 2>&1
if errorlevel 1 (
  echo [오류] npm을 찾을 수 없습니다.
  pause
  exit /b 1
)

if not exist ".env.local" (
  echo [오류] 먼저 1_FIRST_SETUP.bat을 실행하세요.
  pause
  exit /b 1
)

if not exist "node_modules\vite\bin\vite.js" (
  echo 필요한 파일을 처음 한 번 설치합니다...
  call npm.cmd ci
  if errorlevel 1 goto :failed
)

echo bStocker를 빌드합니다...
call npm.cmd run build
if errorlevel 1 goto :failed

echo.
echo 로컬 주소: http://localhost:4174
echo 같은 공유기 기기: http://이-PC의-IP:4174
echo 종료하려면 이 창에서 Ctrl+C를 누르세요.
node scripts\run-local.mjs
if errorlevel 1 goto :failed
exit /b 0

:failed
echo.
echo [오류] 실행하지 못했습니다. 위 메시지를 확인하세요.
pause
exit /b 1
