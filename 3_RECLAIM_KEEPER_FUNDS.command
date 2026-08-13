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
[[ -f ".env.local" ]] || fail "최초 설정 파일 .env.local이 없습니다."

echo
echo "먼저 앱에서 자동화를 끄고 2_RUN_BSTOCKER 창에서 Ctrl+C로 완전히 종료하세요."
echo "회수액은 최초 설정의 owner 지갑으로만 전송됩니다."
node scripts/reclaim-robinhood-keeper-funds.mjs --send || fail "Keeper ETH를 회수하지 못했습니다."
echo
read -r -p "Enter를 누르면 닫힙니다..." _
