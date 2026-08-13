#!/bin/bash
set -u
cd -- "$(dirname -- "$0")"

fail() {
  echo
  echo "[오류] $1"
  read -r -p "Enter를 누르면 닫힙니다..." _
  exit 1
}

[[ "$(uname -s)" == "Darwin" ]] || fail "이 파일은 macOS용입니다."
command -v node >/dev/null 2>&1 || fail "Node.js LTS가 설치되어 있지 않습니다."
command -v npm >/dev/null 2>&1 || fail "npm을 찾을 수 없습니다."
[[ -f ".env.local" ]] || fail "먼저 1_FIRST_SETUP.command를 실행하세요."

if [[ ! -f "node_modules/vite/bin/vite.js" ]]; then
  echo "필요한 파일을 처음 한 번 설치합니다..."
  npm ci || fail "패키지를 설치하지 못했습니다."
fi

echo "bStocker를 빌드합니다..."
npm run build || fail "앱을 빌드하지 못했습니다."
echo
echo "로컬 주소: http://localhost:4174"
echo "같은 공유기 기기: http://이-Mac의-IP:4174"
echo "종료하려면 이 창에서 Ctrl+C를 누르세요."
node scripts/run-local.mjs || fail "bStocker가 오류로 종료되었습니다."
