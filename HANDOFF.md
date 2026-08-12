# bStocker 공개 배포본 핸드오프

## 2026-08-13 08:00 KST

### 사용자 요청

- 현재 운영 중인 bStocker는 변경하지 않고, 다른 사용자가 로컬에서 실행할 수 있는 독립 배포본 제작.
- Cloudflare Tunnel·공개 도메인 연결을 제외하고 한국어 사용법, ZIP, 공개 GitHub 저장소 준비.
- 각 사용자가 자기 Rabby 지갑으로 Robinhood Chain v2.6 5틱 Vault를 새로 배포하도록 개인 설정 제거.

### 실제 완료 결과

- 운영 폴더를 복사하지 않고 필요한 소스·계약·서버·Keeper·테스트만 별도 구성했다.
- 운영자의 `.env.local`, `.secrets`, `work`, 로그, 거래 기록, 기존 Vault 복구 주소와 개인 주소가 들어간 진단 스크립트를 제외했다.
- Cloudflare 실행 파일·설정·도메인 라우팅 없이 `localhost:4174`, API `8787`만 사용하는 실행본으로 만들었다.
- 최초 설정 배치가 사용자 owner 주소를 받아 `.env.local`을 만들며, 첫 실행 때 해당 Windows 사용자 전용 DPAPI Keeper를 새로 생성한다.
- 각 사용자는 자기 owner·guardian·수령 주소와 새 Keeper가 고정된 v2.6 5틱 Vault를 Rabby로 직접 배포한다.

### 주요 변경 파일

- `README.md`, `사용법.md`
- `1_FIRST_SETUP.bat`, `2_RUN_BSTOCKER.bat`
- `scripts/setup-release.mjs`, `scripts/run-local.mjs`
- `src/components/RobinhoodAutomationPanel.tsx`
- `.env.example`, `.gitignore`, `package.json`, `package-lock.json`

### 실행·검증 상태

- 깨끗한 폴더에서 `npm.cmd ci`: 성공, 알려진 취약점 0개.
- `npm.cmd test`: 전략 21/21, 계약 11/11 통과.
- `npm.cmd run build`: 성공. 단일 JS 청크 크기 경고만 있으며 기능 실패는 아니다.
- v2.6 계약 runtime 21,101 bytes로 EVM 계약 크기 제한 이내.
- ZIP에서 `.env.local`, `.secrets`, `node_modules`, `dist`, `work`, Cloudflare 파일이 없음을 확인했다.
- 테스트용 owner 설정은 검증 후 삭제했으며 실제 키·승인·자금·트랜잭션은 생성하지 않았다.

### 미완료 항목·위험

- GitHub 공개 저장소 생성과 push는 GitHub 사용자 인증이 완료되어야 한다.
- 이 앱과 Vault는 미감사 실험용이다. 5틱 재배치 가스, 슬리피지, MEV, 비영구손실, RPC 장애와 Keeper 가스 소진 위험이 남는다.
- 사용자는 Rabby에서 배포 주소·승인 대상·금액·각 거래를 직접 확인해야 한다.

### Git 상태

- 신규 독립 저장소로 초기화·커밋 예정. 기존 운영 폴더는 Git 및 실행 상태를 포함해 변경하지 않았다.

## 2026-08-13 08:12 KST — GitHub 공개 저장소 생성 확인

- 사용자가 공개 빈 저장소 `parkyouonit/bstocker_released`를 생성했다.
- GitHub API에서 visibility `public`, 사용자 admin/push 권한, 기본 브랜치 `main`을 확인했다.
- 로컬 검증본을 원격 `main`에 push하고 원격 파일·커밋을 검증하는 단계다.

## 2026-08-13 08:16 KST — 공개 배포 완료

- 공개 저장소 `https://github.com/parkyouonit/bstocker_released`의 `main` 브랜치에 배포본을 push했다.
- 초기 배포 commit `8ffd0dd`와 핸드오프 갱신 commit `dcdee07`이 원격에 반영됐다.
- 원격 저장소는 공개 상태이며 `README.md`, `사용법.md`, 최초 설정/실행 배치, v2.6 계약·서버·Keeper·테스트를 포함한다.
- `.env.local`, `.secrets`, `work`, 운영 로그·거래 기록·기존 owner/Keeper/Vault 주소·Cloudflare 설정은 공개하지 않았다.
- 최종 상태는 원격 파일과 기본 브랜치 SHA를 다시 확인한 뒤 종료한다.
