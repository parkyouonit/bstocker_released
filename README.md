# bStocker

bStocker는 BNB Chain bStock 집중 유동성 LP 관리와 Robinhood Chain SPCX/USDG 5틱 자동화 실험을 위한 로컬 웹 앱입니다. Windows 10/11과 macOS(Intel·Apple Silicon)를 지원하며 Rabby Wallet과 MetaMask 중 사용할 지갑을 직접 선택할 수 있습니다.

이 공개 배포본에는 Cloudflare Tunnel, 공개 도메인, 운영자의 개인 설정·Vault 주소·Keeper 키·거래 기록이 포함되지 않습니다. 각 사용자는 자기 컴퓨터에서 실행하고 자기 지갑으로 별도의 v2.7 Vault 컨트랙트를 배포합니다.

먼저 [사용법.md](./사용법.md)를 읽고 운영체제에 맞는 파일을 순서대로 실행하세요.

| 단계 | Windows | macOS |
|---|---|---|
| 최초 설정 | `1_FIRST_SETUP.bat` | `1_FIRST_SETUP.command` |
| 앱 실행 | `2_RUN_BSTOCKER.bat` | `2_RUN_BSTOCKER.command` |
| Keeper ETH 회수 | `3_RECLAIM_KEEPER_FUNDS.bat` | `3_RECLAIM_KEEPER_FUNDS.command` |

기본 로컬 주소는 `http://localhost:4174`, API는 `8787` 포트입니다.

## v2.7 주요 안전 특성

- 온체인 입금액 상한 없음: 사용자가 입력한 수량만 정확히 승인합니다.
- 기존 v2.6 이하 Vault의 한도는 바뀌지 않으며, 무제한 v2.7을 쓰려면 앱의 교체 절차로 새 Vault를 배포해야 합니다.
- BNB Chain LP 승인·민트·스왑, Pancake/Merkl 보상 쓰기, LayerZero Bridge 쓰기는 공개 배포본에서 기본 잠금입니다.
- Keeper 개인키는 Windows DPAPI 또는 macOS 로그인 Keychain에 보관되며 화면·파일·로그에 평문으로 출력하지 않습니다.
- Vault owner·guardian·보상 수령 주소는 최초 설정에 입력한 지갑으로 고정됩니다.
- Keeper는 최종 USDG 전환이나 사용자 자산 수령을 할 수 없습니다.

## 개발 명령

```text
npm ci
npm test
npm run build
npm run start:lan
```

이 코드는 감사를 받지 않은 실험용 DeFi 소프트웨어입니다. 금액 상한을 제거해 손실 규모도 제한되지 않습니다. 비영구손실, 슬리피지, MEV, 스마트컨트랙트 오류, RPC 장애와 Keeper 가스 소진 위험을 이해한 금액만 사용하세요.
