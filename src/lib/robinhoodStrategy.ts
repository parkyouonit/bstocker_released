import { createPublicClient, createWalletClient, custom, defineChain, getAddress, http, parseAbi, type Address, type Hash } from 'viem'
import { ensureRobinhoodNetwork } from './viem'
import { getWalletProvider } from './wallet'

const EXPECTED_ROBINHOOD_POOL = getAddress('0x9d590437ABaAe12cf9fE0627cAF4CFd633152599')
const EXPECTED_SPCX = getAddress('0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa')
const EXPECTED_USDG = getAddress('0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168')
const EXPECTED_GAUGE = getAddress('0x01a47258375735D36D15dE8A2bb8e0cE876d31f6')
const EXPECTED_NFT = getAddress('0x07F44c47743A2f36414A82b9F558ECFCf0EEdCEf')
const TARGET_OBSERVATION_CARDINALITY = 64

export const ROBINHOOD_CHAIN = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [import.meta.env.VITE_ROBINHOOD_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com'] } },
  blockExplorers: { default: { name: 'Robinhood Chain Blockscout', url: 'https://robinhoodchain.blockscout.com' } },
  contracts: {
    multicall3: {
      address: getAddress('0xcA11bde05977b3631167028862bE2a173976CA11'),
      blockCreated: 1,
    },
  },
})

const oraclePreparationAbi = parseAbi([
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function tickSpacing() view returns (int24)',
  'function gauge() view returns (address)',
  'function nft() view returns (address)',
  'function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,bool unlocked)',
  'function increaseObservationCardinalityNext(uint16 observationCardinalityNext)',
])

export type RobinhoodGuardState = 'WARMING' | 'LIVE' | 'SOFT_PAUSE' | 'WITHDRAW_ONLY' | 'USDG_EXIT_PENDING'

export interface RobinhoodRange {
  lower: number
  upper: number
  anchor: number
  width: number
}

export interface RobinhoodPerformanceValue {
  principalUsd: number
  navUsd: number | null
  lpProfitUsd: number | null
  lpReturnPercent: number | null
  paidUp: number
  earnedUp: number
  totalRewardUp: number
  upValueUsd: number | null
  gasSpentEth: number
  gasSpentUsd: number | null
  netProfitUsd: number | null
  netReturnPercent: number | null
}

export interface RobinhoodPerformanceSession {
  index: number
  tokenId: string
  startBlock: string
  startHash: Hash
  startedAt: number
  startPrincipalUsd: number
  principalUsd: number
  capitalAddedUsd: number
  endBlock: string | null
  endHash: Hash | null
  endedAt: number | null
  spcxReturned: number
  usdgReturned: number
  recoveredUsd: number | null
  recoverySource: 'EXIT_USDG' | 'MATCHED_WALLET_SWAP' | 'EXIT_BLOCK_SPOT_FALLBACK' | null
  rolloverSwapHash: Hash | null
  rolloverSwapBlock: string | null
  paidUp: number
  gasSpentEth: number
  rolledCapitalUsd: number
  freshCapitalUsd: number
  capitalWithdrawnUsd: number
  lpProfitUsd: number
}

export interface RobinhoodPerformance {
  asOf: number
  priceSource: string
  prices: { upUsd: number | null; ethUsd: number | null; fetchedAt: number | null; stale: boolean }
  current: RobinhoodPerformanceValue
  activeSession?: RobinhoodPerformanceValue
  lifetime?: RobinhoodPerformanceValue
  sessions?: RobinhoodPerformanceSession[]
  accounting?: null | {
    activeSessionIndex: number | null
    capitalContributedUsd: number
    capitalWithdrawnUsd: number
    activeNavUsd: number
    lpProfitUsd: number
  }
  rebalances: Array<RobinhoodPerformanceValue & {
    at: number
    hash: Hash
    sessionIndex?: number | null
    tick: number | null
    range: null | { lower: number | null; upper: number | null }
  }>
  warnings: string[]
}

export interface RobinhoodStrategyStatus {
  mode: 'SHADOW' | 'LIVE'
  writesEnabled: boolean
  executorAddress: Address | null
  snapshot: {
    at: number
    fetchedAt: number
    blockNumber: string
    chainId: number
    contractsVerified: boolean
    tick: number
    tickSpacing: number
    fee: number
    sqrtPriceX96: string
    spotPrice: number
    twap30Tick: number | null
    twap300Tick: number | null
    twap30Price: number | null
    twap300Price: number | null
    liquidity: string
    stakedLiquidity: string
    poolUnlocked: boolean
    observationCardinality: number
    observationCardinalityNext: number
    strategyNavUsd?: number | null
    strategyPrincipalUsd?: number | null
    managedRange?: RobinhoodRange
    stock: { symbol: string; name: string; decimals: number; uiMultiplier: number; paused: boolean; oraclePaused: boolean }
    quote: { symbol: string; name: string; decimals: number }
    official: null | {
      bid: number
      ask: number
      midpoint: number | null
      tokenPrice: number | null
      multiplier: number
      generatedAt: string
      quoteGeneratedAt: string | null
      isTradingHalt: boolean
      assetStatus: string | null
      tradingCapabilities?: {
        fractionalTradability?: string | null
        allDayTradability?: string | null
        extendedHoursFractionalTradability?: boolean | null
      } | null
      deploymentVerified: boolean | null
      priceSource: 'CHAINLINK_ONCHAIN'
      priceFeedsVerified: boolean
      priceFeedHeartbeatSec: number
      priceFeedMaxAgeSec: number
      spcxFeed: { address: Address; description: string; priceUsd: number; updatedAt: string; roundId: string }
      usdgFeed: { address: Address; description: string; priceUsd: number; updatedAt: string; roundId: string }
      logoUrl?: string
    }
    oracleGuard?: {
      mode: 'CHAINLINK_FRESH' | 'MARKET_CLOSED_QUORUM' | 'FAIL_CLOSED'
      operational: boolean
      primaryFresh: boolean
      closedMarketConsensus: boolean
      expectedMarketClosed: boolean
      valuationPrice: number | null
      officialAgeSec: number | null
      officialMaxAgeSec: number
      closedMarketMaxAgeSec: number
      quoteAgeSec: number | null
      quoteFresh: boolean
      quoteBidUsdg: number | null
      quoteAskUsdg: number | null
      dexInsideOfficialQuote: boolean
      poolStable: boolean
    }
    gauge: { rewardSymbol: string; rewardRate: string; rewardPerDay: number; rewardsLeft: number; periodFinish: number; active: boolean }
    owner: null | {
      address: Address
      balances: Record<'ETH' | 'SPCX' | 'USDG' | 'UP', number>
      positions: Array<{
        tokenId: string
        custody: 'wallet' | 'gauge'
        tickLower: number
        tickUpper: number
        priceLower: number
        priceUpper: number
        liquidity: string
        tokensOwed0: number
        tokensOwed1: number
        earnedUp: number
      }>
    }
  }
  decision: {
    at: number
    mode: 'SHADOW' | 'LIVE'
    state: RobinhoodGuardState
    reasons: string[]
    action: string
    metrics: {
      oneMinuteChangePercent?: number | null
      fiveMinuteChangePercent?: number | null
      officialFiveMinuteChangePercent?: number | null
      spotTwap30DeviationPercent?: number | null
      twapDivergencePercent?: number | null
      dexOfficialDeviationPercent?: number | null
      officialAgeSec?: number | null
      officialMaxAgeSec?: number | null
      officialFresh?: boolean
      oracleMode?: 'CHAINLINK_FRESH' | 'MARKET_CLOSED_QUORUM' | 'FAIL_CLOSED'
      closedMarketConsensus?: boolean
      expectedMarketClosed?: boolean
      closedMarketMaxAgeSec?: number
      quoteAgeSec?: number | null
      quoteFresh?: boolean
      quoteBidUsdg?: number | null
      quoteAskUsdg?: number | null
      dexInsideOfficialQuote?: boolean
      valuationPrice?: number | null
      strategyNavChangePercent?: number | null
      warmed?: boolean
      onchainTwapReady?: boolean
      rapidBandExit?: boolean
      inRange?: boolean
      rebalances10m?: number
      rebalances1h?: number
    }
    range: RobinhoodRange | null
    config: Record<string, number>
    events: Array<{ at: number; type: string; message: string }>
    liveWritesEnabled: boolean
  }
  keeper: {
    healthy: boolean
    updatedAt: number | null
    startedAt: number | null
    pollMs: number | null
    rpcKind: string
    error: string | null
    executionGate: null | {
      code: string
      action: string | null
      attempts: number
      blockedAt: number
      nextRetryAt: number
      publicMessage: string
    }
    signerLoaded: boolean
    lastTransaction: null | { at: number; action: string; hash: Hash; blockNumber: string; gasUsed: string; effectiveGasPrice: string; expectedTick: number }
    logs: Array<{
      id: string
      at: number
      blockNumber: string | null
      mode: string
      state: string
      action: string
      tick: number | null
      spotPrice: number | null
      officialPrice: number | null
      navUsd: number | null
      range: null | { lower: number | null; upper: number | null }
      reasons: string[]
      executionError: string | null
      transaction: null | { hash: Hash; action: string }
    }>
  }
  contracts: { chainId: number; pool: Address; gauge: Address; positionManager: Address; swapRouter: Address; spcx: Address; usdg: Address; up: Address; spcxUsdFeed: Address; usdgUsdFeed: Address; priceFeedHeartbeatSec: number; priceFeedMaxAgeSec: number; tickSpacing: number; explorer: string }
  guardConfig: Record<string, number>
  performance: RobinhoodPerformance | null
  replay: null | {
    generatedAt: number
    windowHours: number
    hoursCovered: number
    swapEvents: number
    timestampMethod: string
    price: { first: number; last: number; high: number; low: number; changePercent: number | null }
    rangeComparison: Array<{
      intervals: number
      rawTickWidth: number
      approximatePriceWidthPercent: number
      rebalances: number
      rateLimitedEvents: number
      inRangePercent: number
      averageMinutesBetweenRebalances: number | null
      maxRebalancesInHour: number
    }>
    crashGuards: {
      minimum1mPercent: number
      minimum5mPercent: number
      softPauseEpisodes: number
      withdrawEpisodes: number
      exitEpisodes: number
    }
    limitations: string[]
  }
  automation: {
    allowed: boolean
    armed: boolean
    configured: boolean
    keeperAddress: Address | null
    keeperKeyReady: boolean
    keeperKeyError: string | null
    expectedOwnerAddress: Address | null
    error: string | null
    vault: null | {
      address: Address
      version: string
      owner: Address
      recipient: Address
      keeper: Address
      guardian: Address
      mode: 'PAUSED' | 'LIVE' | 'SOFT_PAUSE' | 'WITHDRAW_ONLY' | string
      activeTokenId: string
      principalUsdg: number
      totalRebalances: number
      totalHarvestedUp: number
      totalCapitalAddedUsdg: number
      maxPilotUsdg: number | null
      capitalUnlimited: boolean
      autoUsdgSafetyExit: boolean
      chainlinkSafetyExit: boolean
      safetyOracle: null | { ready: boolean; spcxPriceUsdg: number; spcxUpdatedAt: number; usdgUpdatedAt: number }
      mevProtection: 'TWAP_AND_PRICE_LIMIT' | 'LEGACY_PRICE_LIMIT' | string
      rangeWidth: number
      supportsCapitalAdd: boolean
      lastRebalanceAt: number
      routeVerified: boolean
      ownerLocked: boolean
      keeperVerified: boolean
      keeperGasEth: number
      balances: { SPCX: number; USDG: number; earnedUP: number }
      navUsd: number | null
      position: null | { tokenId: string; tickLower: number; tickUpper: number; liquidity: string; inRange: boolean }
      rebalanceCounts: { tenMinutes: number; oneHour: number }
    }
  }
  deployment: { contractCompiled: boolean; contractDeployed: boolean; walletSignatureRequired: boolean; note: string }
}

export async function fetchRobinhoodStrategy(wallet?: Address, signal?: AbortSignal): Promise<RobinhoodStrategyStatus> {
  const query = wallet ? `?wallet=${wallet}` : ''
  const response = await fetch(`/api/robinhood/strategy${query}`, { signal, headers: { accept: 'application/json' } })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload?.error || `Robinhood 전략 API HTTP ${response.status}`)
  return payload as RobinhoodStrategyStatus
}

export async function prepareRobinhoodOracle(account: Address, pool: Address): Promise<Hash> {
  if (import.meta.env.VITE_ENABLE_ROBINHOOD_ORACLE_PREP !== 'true') throw new Error('Robinhood 오라클 준비 쓰기 기능이 비활성화되어 있습니다.')
  if (getAddress(pool) !== EXPECTED_ROBINHOOD_POOL) throw new Error('고정 검증된 SPCX/USDG 풀 주소가 아닙니다.')
  const provider = await getWalletProvider()
  await ensureRobinhoodNetwork(provider)
  const publicClient = createPublicClient({ chain: ROBINHOOD_CHAIN, transport: http(ROBINHOOD_CHAIN.rpcUrls.default.http[0], { timeout: 12_000 }) })
  const [code, token0, token1, spacing, gauge, nft, slot0] = await Promise.all([
    publicClient.getBytecode({ address: pool }),
    publicClient.readContract({ address: pool, abi: oraclePreparationAbi, functionName: 'token0' }),
    publicClient.readContract({ address: pool, abi: oraclePreparationAbi, functionName: 'token1' }),
    publicClient.readContract({ address: pool, abi: oraclePreparationAbi, functionName: 'tickSpacing' }),
    publicClient.readContract({ address: pool, abi: oraclePreparationAbi, functionName: 'gauge' }),
    publicClient.readContract({ address: pool, abi: oraclePreparationAbi, functionName: 'nft' }),
    publicClient.readContract({ address: pool, abi: oraclePreparationAbi, functionName: 'slot0' }),
  ])
  if (!code || code === '0x') throw new Error('Robinhood Chain에서 풀 바이트코드를 확인하지 못했습니다.')
  if (getAddress(token0) !== EXPECTED_SPCX || getAddress(token1) !== EXPECTED_USDG || Number(spacing) !== 10 || getAddress(gauge) !== EXPECTED_GAUGE || getAddress(nft) !== EXPECTED_NFT) {
    throw new Error('Pool·토큰·Gauge·Position Manager 교차검증에 실패했습니다.')
  }
  if (Number(slot0[4]) >= TARGET_OBSERVATION_CARDINALITY) throw new Error('오라클 저장 용량은 이미 64개 이상으로 준비되어 있습니다.')
  const simulation = await publicClient.simulateContract({
    account,
    address: pool,
    abi: oraclePreparationAbi,
    functionName: 'increaseObservationCardinalityNext',
    args: [TARGET_OBSERVATION_CARDINALITY],
  })
  const walletClient = createWalletClient({ chain: ROBINHOOD_CHAIN, transport: custom(provider as never) })
  const hash = await walletClient.writeContract(simulation.request)
  await publicClient.waitForTransactionReceipt({ hash })
  return hash
}
