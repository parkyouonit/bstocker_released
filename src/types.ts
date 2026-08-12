import type { Address, Hash } from 'viem'

export type DataMode = 'demo' | 'live'
export type RangeStatus = 'IN RANGE' | 'BELOW RANGE' | 'ABOVE RANGE' | 'PENDING'

export interface TokenMeta {
  address: Address
  symbol: string
  name: string
  decimals: number
  isScaledUi: boolean
  uiMultiplier: bigint
  uiMultiplierDisplay: number
  balanceUi: number
  balanceUiRaw: bigint
  balanceRaw: bigint
  allowanceRaw: bigint
  verified: boolean
}

export interface PoolSummary {
  address: Address
  mode: DataMode
  token0: TokenMeta
  token1: TokenMeta
  displayBase: TokenMeta
  displayQuote: TokenMeta
  displayPrice: number
  rawPrice: number
  twapPrice: number
  tick: number
  tickSpacing: number
  feeTier: number
  feeTierLabel: string
  tvlUsd: number
  fees24hUsd: number
  volume24hUsd: number
  feeApr: number
  activeLiquidity: number
  lastUpdated: number
  sourceBlock?: bigint
  underlyingPrice?: number
  underlyingUpdatedAt?: number
  underlyingStatus: 'fresh' | 'stale' | 'unavailable'
  marketStatus?: 'fresh' | 'stale' | 'unavailable'
  marketUpdatedAt?: number
  writesEnabled: boolean
}

export interface PoolDirectoryEntry {
  id: string
  address: Address
  dexId: string
  dexLabel: string
  label: string
  description: string
  token0Address: Address
  token1Address: Address
  token0Symbol: string
  token1Symbol: string
  token0Decimals: number
  token1Decimals: number
  stockAddress: Address
  stockSymbol: string
  stockName: string
  quoteAddress: Address
  quoteSymbol: string
  logoUrl?: string
  feeTier: number
  feeTierLabel: string
  tickSpacing: number
  tvlUsd: number | null
  volume24hUsd: number | null
  fees24hUsd: number | null
  feeApr: number | null
  priceUsd: number | null
  priceChange24h: number | null
  activeLiquidity: string
  currentTick: number
  poolCreatedAt: number | null
  verified: boolean
  marketStatus: 'fresh' | 'stale' | 'unavailable'
  warnings: string[]
  source: string
  lastUpdated: number
}

export interface PoolDirectoryResponse {
  items: PoolDirectoryEntry[]
  total: number
  discovered: number
  rejected: number
  source: string
  partial: boolean
  warnings: string[]
  fetchedAt: number
  cacheTtlMs: number
}

export interface Candle {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export interface LiquidityBin {
  low: number
  high: number
  value: number
  side: 'below' | 'active' | 'above'
}

export interface Position {
  tokenId: bigint
  poolAddress: Address
  owner: Address
  pair: string
  token0Symbol?: string
  token1Symbol?: string
  minPrice: number
  maxPrice: number
  tickLower: number
  tickUpper: number
  status: RangeStatus
  liquidity: bigint
  amount0: number
  amount1: number
  amount0Usd: number
  amount1Usd: number
  fees0: number
  fees1: number
  feesUsd: number
  feeApr: number
  createdAt: number
  txHash?: Hash
  custody?: 'wallet' | 'pancake-farm'
  farmStaked?: boolean
}

export type RewardProgramStatus = 'ACTIVE' | 'ENDED' | 'INACTIVE' | 'UNAVAILABLE'

export interface PancakeFarmProgram {
  provider: 'pancake-v3'
  status: RewardProgramStatus
  verified: boolean
  contract: Address
  pid?: bigint
  rewardToken: Address
  rewardSymbol: string
  rewardRatePerSecond: number | null
  endsAt?: number
  totalLiquidity?: bigint
  reason?: string
}

export interface MerklOpportunity {
  provider: 'merkl'
  status: RewardProgramStatus
  apr: number | null
  liveCampaigns: number
  name?: string
  reason?: string
}

export interface PositionRewardState {
  tokenId: bigint
  staked: boolean
  pendingCake: number
  pendingCakeRaw: bigint
  farmPid?: bigint
}

export interface MerklClaimItem {
  token: Address
  symbol: string
  decimals: number
  amount: bigint
  claimed: bigint
  claimable: bigint
  pending: bigint
  proofs: `0x${string}`[]
}

export interface RewardsData {
  farm: PancakeFarmProgram
  merkl: MerklOpportunity
  positions: Record<string, PositionRewardState>
  merklClaims: MerklClaimItem[]
  warnings: string[]
  updatedAt: number
}

export interface Simulation {
  feeApr: number | null
  inRangeShare: number | null
  rangeStayDays: number | null
  expectedFee30d: number | null
  expectedFeeUsd30d: number | null
  liquidityShare: number | null
  twapDivergence: number | null
  priceImpact: number | null
  warnings: string[]
}

export interface ZapQuote {
  budgetQuoteUi: number
  swapQuoteUi: number
  swapQuoteRaw: bigint
  remainingQuoteUi: number
  expectedBaseUi: number
  expectedBaseRaw: bigint
  minimumBaseUi: number
  minimumBaseRaw: bigint
  baseValueShare: number
  priceImpactPercent: number
  initializedTicksCrossed: number
  gasEstimate: bigint
  quotedAt: number
}

export interface TerminalData {
  summary: PoolSummary
  candles: Candle[]
  liquidity: LiquidityBin[]
  positions: Position[]
}

export interface TransactionState {
  status: 'idle' | 'connecting' | 'approving' | 'simulating' | 'pending' | 'success' | 'error'
  message?: string
  hash?: Hash
}
