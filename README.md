# bStocker

bStocker는 BNB Chain bStock 집중 유동성 LP 관리와 Robinhood Chain SPCX/USDG 5틱 자동화 실험을 위한 로컬 웹 앱입니다. Windows 10/11과 macOS(Intel·Apple Silicon)를 지원하며 Rabby Wallet과 MetaMask 중 사용할 지갑을 직접 선택할 수 있습니다.

이 공개 배포본에는 Cloudflare Tunnel, 공개 도메인, 운영자의 개인 설정·Vault 주소·Keeper 키·거래 기록이 포함되지 않습니다. 각 사용자는 자기 컴퓨터에서 실행하고 자기 지갑으로 별도의 v2.9 Vault 컨트랙트를 배포합니다.

먼저 [사용법.md](./사용법.md)를 읽고 운영체제에 맞는 파일을 순서대로 실행하세요.

| 단계 | Windows | macOS |
|---|---|---|
| 최초 설정 | `1_FIRST_SETUP.bat` | `1_FIRST_SETUP.command` |
| 앱 실행 | `2_RUN_BSTOCKER.bat` | `2_RUN_BSTOCKER.command` |
| Keeper ETH 회수 | `3_RECLAIM_KEEPER_FUNDS.bat` | `3_RECLAIM_KEEPER_FUNDS.command` |

기본 로컬 주소는 `http://localhost:4174`, API는 `8787` 포트입니다.

## v2.9 오라클 가격 수정 — 기존 사용자는 교체 필요

v2.8 화면과 서버는 Robinhood REST API의 bid/ask 중간값을 SPCX 기준가격으로 사용했습니다. 호가 간격이 큰 때에는 이 값이 실제 DEX와 공식 온체인 가격보다 크게 낮아져 NAV를 과소평가하고, 원금 -5% 안전 종료 신호를 잘못 만들 수 있었습니다. v2.9는 이 문제를 다음과 같이 수정합니다.

- 화면 NAV와 컨트랙트의 -5% 종료 판정을 [Robinhood 공식 오라클 안내](https://docs.robinhood.com/chain/oracles-and-price-feeds/)에 따른 Chainlink `SPCX/USD` 및 `USDG/USD` 온체인 피드로 계산합니다. REST 중간값은 진단용일 뿐 손익과 안전 종료에는 쓰지 않습니다.
- 컨트랙트에 고정된 Robinhood Chain 피드는 `SPCX/USD` `0xB265810950ba6c5C0Ff821c9963014a56fD8Bffb`, `USDG/USD` `0x61B7e5650328764B076A108EFF5fa7282a1B9aD2`입니다.
- 두 피드의 양수 가격, round 완결, 25시간 신선도와 stock token의 `tokenPaused`/`oraclePaused`를 확인합니다.
- 예상 주말 휴장 구간에는 최대 72시간 동안 마지막 Chainlink, multiplier-adjusted Robinhood bid/ask 범위, DEX 30초·5분 TWAP이 모두 합의할 때만 기존 포지션의 재배치와 UP 수확을 허용합니다. REST 중간값은 여전히 사용하지 않습니다.
- 휴장 합의는 신규 시작·추가 입금이나 stale Chainlink 기반 USDG 종료를 허용하지 않습니다. 어느 조건이든 깨지면 즉시 fail-closed로 재배치를 중단합니다.
- Chainlink 기준으로 종료할 때 DEX 5분 TWAP가 Chainlink보다 1.5% 넘게 낮으면 불리한 매도를 보내지 않습니다.
- USDG 전환 사전검증이 가격 하한 때문에 막히면 먼저 LP를 두 원물로 회수해 자동 재배치를 멈추고, 다음 검증에서 USDG 전환을 다시 시도합니다.

이미 배포된 v2.8 이하 컨트랙트 코드는 자동으로 바뀌지 않습니다. 앱에서 기존 자산 회수와 `v2.9 교체 + 새로 시작` 절차를 지갑으로 직접 확인해야 새 온체인 종료 기준이 적용됩니다.

## v2.9 주요 안전 특성

- 온체인 입금액 상한 없음: 사용자가 입력한 수량만 정확히 승인합니다.
- 기존 v2.8 이하 Vault는 바뀌지 않으며, v2.9를 쓰려면 앱의 교체 절차로 새 Vault를 배포해야 합니다.
- BNB Chain LP 승인·민트·스왑, Pancake/Merkl 보상 쓰기, LayerZero Bridge 쓰기는 공개 배포본에서 기본 잠금입니다.
- Keeper 개인키는 Windows DPAPI 또는 macOS 로그인 Keychain에 보관되며 화면·파일·로그에 평문으로 출력하지 않습니다.
- Vault owner·guardian·보상 수령 주소는 최초 설정에 입력한 지갑으로 고정됩니다.
- 모든 Vault 스왑은 온체인 TWAP 최소수령량·1% 가격 한계·짧은 deadline을 강제합니다. Keeper 자동 거래는 Robinhood 공식 FCFS Sequencer에 직접 제출하며 공개 RPC로 재전송하지 않습니다.
- 5분 약 -3% 급락, DEX NAV -5% 또는 Chainlink NAV -5% hard stop이 온체인에서 확인되면 Keeper가 LP를 회수하고 SPCX를 USDG로 전환해 고정 owner 주소로 보냅니다. 부분 매도만 발생하면 전체 거래를 되돌립니다.
- 공식 거래정지·토큰/오라클 정지·검증 실패 때는 스왑하지 않고 두 토큰 상태로 회수합니다.

## 개발 명령

```text
npm ci
npm test
npm run build
npm run start:lan
```

이 코드는 감사를 받지 않은 실험용 DeFi 소프트웨어입니다. 금액 상한을 제거해 손실 규모도 제한되지 않습니다. TWAP·가격 한계·직접 Sequencer 제출은 MEV를 줄이는 장치이지 비공개 릴레이나 수익·체결 보장이 아닙니다. 비영구손실, 슬리피지, MEV, 스마트컨트랙트 오류, RPC 장애와 Keeper 가스 소진 위험을 이해한 금액만 사용하세요.
