# bStocker

공개 저장소에는 운영자의 개인 설정, 지갑·Vault·Keeper 주소, 키, 거래 기록, Cloudflare 도메인·터널 자격 증명을 포함하지 않습니다. 로컬 값은 `.env.local`, `.secrets/`, `work/`에만 두고 커밋 전 `npm run release:check`로 검사합니다.

다른 Windows PC로 같은 Keeper를 옮길 때는 원문 키를 새 PC의 클립보드에 복사하고 `IMPORT_KEEPER_FROM_CLIPBOARD.bat`을 실행합니다. 기존 Keeper 주소와 같은 키만 허용되며 새 Windows 사용자 DPAPI로 재암호화한 뒤 클립보드를 지웁니다. 개인키를 채팅이나 Git 파일에 붙이지 마세요.

## LP rewards

- PancakeSwap V3 Farm 상태는 공식 MasterChef V3와 선택 풀의 `pid`, 토큰, fee, LM Pool, 배출 기간을 온체인에서 교차 검증합니다.
- 지갑 소유 LP NFT와 MasterChef에 맡긴 LP NFT를 함께 조회하며 `Stake`, `CAKE Harvest`, `Unstake`를 지원합니다.
- 스테이킹 포지션의 수수료는 MasterChef 경유로 수령합니다. 유동성 회수는 먼저 Unstake해야 하므로 기존 Position Manager 회수 경로와 섞이지 않습니다.
- Merkl 캠페인 상태와 개인 보상은 서버 프록시를 통해 조회하며, 청구 직전에 최신 proof와 Distributor의 온체인 claimed 값을 다시 확인하고 simulation을 통과한 요청만 지갑으로 보냅니다.
- `VITE_ENABLE_MAINNET_WRITES=true`와 `VITE_ENABLE_REWARD_WRITES=true`가 모두 설정되어야 보상 쓰기 기능이 열립니다.

BNB Chain bStock concentrated-liquidity terminal. The LP terminal and cross-chain bridge are separate apps: bStocker runs on 4174 and the dedicated Bridge app runs on 4175. Mainnet LP writes remain disabled unless `VITE_ENABLE_MAINNET_WRITES=true` is explicitly set. LP Zap uses the official PancakeSwap V3 QuoterV2, SwapRouter, and NonfungiblePositionManager in a wallet-visible approve → swap → mint sequence.

## Pool directory

- 좌측 디렉터리는 GeckoTerminal의 bStock 시장 후보와 기본 풀을 합친 뒤 PancakeSwap V3 Factory의 `getPool`, pool `token0/token1/fee`를 대조한다.
- 검증된 BNB Chain PancakeSwap V3 bStock/USDT 풀만 표시하고 ticker·이름·주소 검색, 최소 TVL, fee, TVL·volume·APR 정렬을 지원한다.
- TVL·24시간 거래량·수수료·gross APR은 5분 디렉터리 캐시와 60초 선택 풀 시장 캐시를 사용한다. 비정상 또는 누락 값은 0으로 꾸미지 않고 `—`와 partial 상태로 표시한다.
- 현재 검증 기본 목록은 17개이며, GeckoTerminal 검색이 일시 제한되더라도 Factory에서 다시 검증한 기본 목록은 유지된다. 검색에서 새 후보가 발견되면 같은 온체인 검증을 거쳐 추가된다.
- 풀 선택은 URL의 `?pool=`에 저장되고, 빠른 전환 시 이전 브라우저 요청을 취소한다.
- 실제 approve·swap·mint 직전에는 브라우저가 Factory 등록 풀과 token0/token1/fee를 다시 검증한다.

## Wallet positions

- 연결한 지갑의 PancakeSwap V3 Position Manager NFT를 최대 200개까지 직접 열거하고, 공식 Factory에 등록된 bStock/USDT 포지션만 표시한다.
- 현재 tick과 포지션 liquidity로 양쪽 토큰 보유량·USD 가치를 계산하며, 선택 풀/전체·범위 상태·가치·수수료 정렬을 지원한다.
- 미수령 수수료는 저장된 `tokensOwed`만 쓰지 않고, 실제 `collect`를 읽기 전용으로 시뮬레이션해 현재 수령 가능량을 표시한다. 이 조회는 서명이나 트랜잭션을 만들지 않는다.

## Robinhood 5-tick automation

- 상단 `RH 5-TICK` 화면은 Robinhood Chain(4663)의 검증된 SPCX/USDG up. Slipstream Pool·Gauge·Position Manager·Swap Router를 BNB LP 코드와 분리해 사용합니다. 이 배포는 Uniswap V3의 `fee` ABI가 아니라 Slipstream의 `tickSpacing` ABI입니다.
- `BStockerThreeTickVault` v2.9는 SPCX/USDG 고정 경로만 사용하며 raw width 50(5개 tick-spacing, 약 0.50%) 범위에 맞춰 비율 스왑·NFT 민트·Gauge 예치를 원자적으로 실행합니다.
- USDG는 메인넷에서 6 decimals입니다. v2.9의 온체인 입금 상한은 없고 UI가 입력한 정확한 금액만 승인합니다.
- 범위를 평범하게 벗어나면 저권한 PC Keeper가 `Gauge 철회 → 전액 회수 → 비율 스왑 → 새 5틱 민트 → Gauge 재예치`를 하나의 원자적 트랜잭션으로 실행합니다. 실패하면 전체 트랜잭션이 되돌아가며 기존 LP도 유지됩니다. 유동성·민트 사전검증 실패는 지수 백오프로 재시도 폭주를 막습니다.
- 진입·재배치·종료는 30초·5분 DEX TWAP, 최대 1% 수령 손실, 100틱 가격 한도를 적용합니다. 완성된 트랜잭션은 Robinhood FCFS Sequencer로 제출하며 공개 mempool 경매 라우팅은 사용하지 않습니다.
- 화면 NAV는 Robinhood 공식 Chainlink `SPCX/USD`와 `USDG/USD` 온체인 피드로 계산하는 성과 지표입니다. 코인 가격을 따라 NAV가 내려가는 것만으로 Keeper를 정지하거나 자동 종료하지 않으며 정상적인 5틱 이탈 재배치를 계속합니다. REST bid/ask 중간값은 사용하지 않습니다. 피드는 라운드 유효성·25시간 신선도·stock token의 `tokenPaused`/`oraclePaused`를 확인합니다. 예상 주말 휴장 구간에는 최대 72시간 동안 마지막 Chainlink, multiplier-adjusted Robinhood bid/ask 범위, DEX 30초·5분 TWAP이 모두 합의할 때만 기존 포지션의 재배치·UP 수확을 허용합니다. 조건 하나라도 어긋나면 fail-closed로 재배치를 중단합니다.
- 자동 USDG 종료는 DEX와 신선한 공식 가격이 모두 5분 약 -3% 급락을 확인하고 30초 동안 지속될 때만 Keeper가 요청합니다. 계약은 온체인 5분 TWAP 급락과 가격 한도를 다시 검증한 뒤 SPCX를 USDG로 전환해 owner에게 전송합니다. 배포된 v2.9 함수의 NAV -5% 조건은 수동 안전 종료 호환용으로 남아 있지만 Keeper는 NAV 하락만으로 호출하지 않습니다. DEX가 Chainlink보다 1.5% 넘게 낮으면 매도를 보류합니다.
- Keeper 개인키는 `.secrets/robinhood-keeper.dpapi.json`에 Windows 현재 사용자 DPAPI로 암호화됩니다. 자산 수령 주소를 바꿀 수 없고 고정 라우트 재배치·안전 종료·UP 수확만 할 수 있습니다. UP은 수확 즉시 owner의 고정 수령 주소로 전송됩니다.
- 공개 사이트의 Keeper 가스 악용을 막기 위해 `ROBINHOOD_AUTOMATION_OWNER` 한 주소만 금고를 등록할 수 있습니다. 실제 쓰기는 `ROBINHOOD_KEEPER_MODE=auto`, `ROBINHOOD_LIVE_AUTOMATION_ALLOWED=true`, owner 서명 `ARM` 세 조건이 모두 맞아야 열립니다.
- Pool 오라클 버퍼는 64/64이며 30초·5분 TWAP 이력이 준비돼 있습니다. 최근 24시간 실제 Pool Swap 재생 결과는 `work/robinhood-replay-24h.json`에 저장되지만 수수료·가스·UP·MEV·원금 손익은 포함하지 않습니다.
- 컨트랙트는 컴파일·고정 경로 constructor `eth_call`·현재 메인넷 비율 preview까지 통과했지만 독립적인 보안 감사를 받지 않았습니다. v2.8 이하에서 v2.9로 교체할 때 기존 Vault 회수·신규 배포·재시작은 반드시 `RH 5-TICK` 화면에서 Rabby 또는 MetaMask로 직접 확인합니다.

자동화 시작 순서:

1. `RH 5-TICK`에서 고정 owner 주소의 Rabby를 연결하고 위험 확인을 체크합니다.
2. v2.9 Vault를 배포한 뒤 자금 이동이 없는 `ARM` 메시지에 서명합니다.
   오래 열어둔 탭에서 이전 Keeper 주소로 배포된 경우 `연결`이 현재 PC Keeper와의 차이를 감지하고, Rabby `setKeeper` 확인 후 ARM 서명을 이어서 요청합니다. 새 배포는 서명 직전에 bootstrap을 다시 읽어 같은 문제를 방지합니다.
3. 저권한 Keeper에 가스용 `0.002 ETH`를 보냅니다.
4. 운용할 USDG 금액을 입력하고 `승인 + 시작`을 확인합니다. 온체인 상한은 없지만 처음에는 소액 검증을 권장합니다.
5. 화면이 `LIVE AUTOMATION`으로 바뀌었는지, Vault 범위와 최근 Keeper 트랜잭션을 확인합니다.

검증 명령:

```powershell
npm.cmd run keeper:once
npm.cmd run strategy:replay
npm.cmd run test:strategy
npm.cmd run contract:test
npm.cmd run contract:simulate-deploy
npm.cmd run contract:preview-mainnet
```

## Run

```powershell
npm install
npm.cmd run dev -- --port 4174 --strictPort
```

Open `http://localhost:4174`. This project deliberately uses 4174 so it does not interfere with another app on 4173.

전용 Bridge 앱:

```powershell
npm.cmd run bridge:dev
```

Open `http://localhost:4175`.

### Rabby 모바일 연결

휴대폰의 일반 Chrome/Safari에는 지갑 provider가 주입되지 않습니다. Rabby 모바일 앱을 열고 내장 DApp 브라우저에서 운영자가 설정한 bStocker HTTPS 주소를 열어야 연결 버튼이 Rabby를 호출할 수 있습니다. 앱은 EIP-6963 provider 탐색을 사용해 Rabby provider를 우선 선택하고, provider가 없는 모바일 브라우저에서는 이 사용법을 화면에 안내합니다.

일반 모바일 브라우저 자체에서 WalletConnect로 연결하려면 WalletConnect Cloud의 프로젝트 ID와 RabbyKit/WalletConnect 연동을 별도로 설정해야 합니다. 현재는 키 없이 바로 사용할 수 있는 Rabby 내장 DApp 브라우저 경로를 기본으로 사용합니다.

## Live configuration

The included `.env.local` contains the verified SPCXB/USDT read-only settings. To configure another environment, copy `.env.example` to `.env.local`, confirm the addresses from official deployment data, and restart Vite. The UI reads the pool directly through viem. Set `VITE_API_BASE_URL` to enable server/indexer-backed candles and position discovery.

## Cloudflare Tunnel

Create a private `cloudflared/config.yml` that routes your bStocker hostname to port 4174 and your Bridge hostname to port 4175. The config, named-tunnel credentials, and real hostnames stay outside Git. If the background connector is restarted, run:

```powershell
cloudflared --config .\cloudflared\config.yml tunnel run bstocker
```

## API/indexer helpers

```powershell
npm run api
npm run indexer
```

The API is intentionally small and read-only by default. The indexer writes a local JSON snapshot for development; replace the repository adapter with PostgreSQL/Redis before production.

## LayerZero OFT Bridge

Bridge는 bStocker 메뉴에서 분리되어 전용 4175 앱으로 실행됩니다. 현재 구현은 다음 기능을 포함합니다.

- 초기 토큰 목록은 표시하지 않고 심볼·이름·컨트랙트 주소를 검색한 뒤 선택
- metadata에 없는 주소는 지원 체인의 RPC를 순회해 ERC-20/OFT/Adapter를 자동 감지
- 상·하단 토큰 영역을 누르면 데스크톱 모달/모바일 바텀시트에서 검색 또는 목적지 체인 선택
- Arbitrum, Avalanche, Polygon, Base, Optimism은 일반 자산 검색과 읽기 전용 경로 탐색 지원
- bStock 토큰 검색 또는 ERC-20/OFT 주소 직접 입력
- 원본 Stargate `oft-snapshot.json`/`adapter-activity-index.json` metadata 자동 로드 및 검색
- 토큰 주소 입력 시 metadata 매칭 후 지원 체인 RPC fallback을 순회해 ERC-20/OFT/Adapter·decimals·잔액 자동 감지
- self-OFT는 토큰 주소를 OFT 주소로 자동 연결하고, Adapter는 `token()` 내부 토큰을 자동 선택
- OFT `quoteSend` 파라미터와 네이티브 수수료 견적
- LZ_RECEIVE 가스 옵션, 목적지 네이티브 가스 드롭, 슬리피지, 수신 주소
- EndpointV2, 출발/목적지 peer, reverse peer, shared decimals, RPC chain ID 검증
- 필요 시 ERC-20 승인 후 OFT `send`, LayerZero Scan 상태 조회

브릿지 실행 모드는 두 가지입니다.

- `Direct OFT`가 기본입니다. RPC에서 OFT/Adapter를 확인한 뒤 `quoteSend`를 직접 호출하고, 전송 시 Rabby가 `approve`와 `send`를 순서대로 서명합니다.
- `Stargate Route`는 OFT가 없는 공식 Stargate 지원 자산을 위한 보조 모드입니다. 서버가 지원 토큰·체인과 route를 조회하고, 반환된 transaction steps를 브라우저 지갑에서 실행합니다. 서버가 자산을 보관하거나 대신 서명하지 않습니다.

Stargate의 구 `/api/v1` quote API는 폐기 예정이므로 route quote 운영에는 최신 LayerZero Value Transfer API 키를 서버 환경에 설정해야 합니다. Direct OFT 모드는 API 키 없이도 컨트랙트 검증과 quote를 수행합니다.

```env
LZ_VALUE_TRANSFER_API_URL=https://transfer.layerzero-api.com/v1
LZ_VALUE_TRANSFER_API_KEY=your_server_side_key
BRIDGE_API_MODE=auto
```

고정 토큰 허용 목록은 없습니다. 전송할 때마다 Endpoint V2, 출발 peer, 목적지 reverse peer, shared decimals, 연결 토큰과 잔액을 다시 검증합니다.

```env
VITE_ENABLE_MAINNET_BRIDGE=true
```

검색 결과에 나타나는 것만으로 안전하거나 공식 토큰임을 뜻하지 않습니다. 사용자가 컨트랙트와 목적지 peer를 직접 확인해야 하며, 일반 ERC-20이나 PancakeSwap 풀 주소는 OFT 주소로 사용할 수 없습니다.
