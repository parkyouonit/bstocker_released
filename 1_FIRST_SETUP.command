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
command -v node >/dev/null 2>&1 || fail "Node.js LTS 20.19 이상을 먼저 설치하세요: https://nodejs.org"

echo
echo "이 설정은 Robinhood Chain 메인넷 5틱 자동화 거래를 활성화합니다."
echo "v2.8 Vault에는 금액 상한이 없으며 TWAP MEV 가드와 자동 USDG 안전 종료를 사용합니다."
read -r -p "본인이 사용할 Rabby/MetaMask EVM 지갑 주소를 입력하세요: " OWNER
read -r -p "위험을 이해했다면 LIVE 를 입력하세요: " ACK
ACK_UPPER="$(printf '%s' "$ACK" | tr '[:lower:]' '[:upper:]')"
[[ "$ACK_UPPER" == "LIVE" ]] || fail "설정을 취소했습니다."

node scripts/setup-release.mjs "$OWNER" || fail "최초 설정을 완료하지 못했습니다."
echo
echo "최초 설정이 끝났습니다. 이제 2_RUN_BSTOCKER.command를 실행하세요."
read -r -p "Enter를 누르면 닫힙니다..." _
