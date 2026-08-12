# bStocker

bStocker는 BNB Chain bStock 집중 유동성 LP 관리와 Robinhood Chain SPCX/USDG 5틱 자동화 실험을 위한 로컬 웹 앱입니다.

이 공개 배포본은 Cloudflare Tunnel, 공개 도메인, 운영자의 개인 설정·Vault 주소·Keeper 키·거래 기록을 포함하지 않습니다. 각 사용자는 자기 PC에서 실행하고 자기 Rabby 지갑으로 별도의 v2.6 Vault 컨트랙트를 배포합니다.

Windows 사용자는 [사용법.md](./사용법.md)를 먼저 읽고 아래 두 파일을 순서대로 실행하세요.

1. `1_FIRST_SETUP.bat`
2. `2_RUN_BSTOCKER.bat`

기본 로컬 주소는 `http://localhost:4174`이며 API는 `8787` 포트를 사용합니다.

## 안전 기본값

- BNB Chain LP 승인·민트·스왑: 기본 잠금
- Pancake/Merkl 보상 쓰기: 기본 잠금
- LayerZero Bridge 쓰기: 기본 잠금
- Robinhood 5틱 자동화: 최초 설정에서 `LIVE`를 직접 입력한 사용자만 활성화
- Keeper 개인키: Windows DPAPI로 해당 Windows 사용자 계정에만 복호화 가능하게 저장
- Vault owner·guardian·보상 수령 주소: 최초 설정에 입력한 사용자의 지갑으로 고정

## 개발 명령

```powershell
npm.cmd ci
npm.cmd test
npm.cmd run build
npm.cmd run start:lan
```

이 코드는 감사를 받지 않은 실험용 DeFi 소프트웨어입니다. 실제 자산 손실, 비영구손실, 슬리피지, MEV, RPC 장애, 자동화 가스 소진 위험이 있습니다.
