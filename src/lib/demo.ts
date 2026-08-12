import type { Address } from 'viem'
import { APP_CONFIG, DEMO_POOL_ADDRESS } from '../config'
import type { Candle, LiquidityBin, PoolSummary, Position, TerminalData, TokenMeta } from '../types'

const demoOwner = '0x0A5b36C2718a2E9bB9C8dA7E1b1dA0cB8C9d0114' as Address

function token(address: Address, symbol: string, name: string, decimals: number, balanceUi: number): TokenMeta {
  return {
    address,
    symbol,
    name,
    decimals,
    isScaledUi: symbol === 'SPCXB',
    uiMultiplier: 10n ** 18n,
    uiMultiplierDisplay: 1,
    balanceUi,
    balanceUiRaw: BigInt(Math.floor(balanceUi * 10 ** decimals)),
    balanceRaw: BigInt(Math.round(balanceUi * 10 ** decimals)),
    allowanceRaw: 0n,
    verified: false,
  }
}

const usdt = token(APP_CONFIG.token0Address, 'USDT', 'Tether USD', 18, 1.880384)
const spcxb = token(APP_CONFIG.token1Address, 'SPCXB', 'SpaceX bStock', 18, 0)

export const demoSummary: PoolSummary = {
  address: DEMO_POOL_ADDRESS,
  mode: 'demo',
  token0: usdt,
  token1: spcxb,
  displayBase: spcxb,
  displayQuote: usdt,
  displayPrice: 132.4762,
  rawPrice: 1 / 132.4762,
  twapPrice: 132.8945,
  tick: -48800,
  tickSpacing: 50,
  feeTier: 2500,
  feeTierLabel: '0.25%',
  tvlUsd: 4_010_000,
  fees24hUsd: 42_322,
  volume24hUsd: 16_928_800,
  feeApr: 385.08,
  activeLiquidity: 1_226_900,
  lastUpdated: Date.now() - 2_000,
  underlyingPrice: 132.48,
  underlyingUpdatedAt: Date.now() - 15_000,
  underlyingStatus: 'fresh',
  writesEnabled: false,
}

export function createDemoCandles(): Candle[] {
  const result: Candle[] = []
  const start = Date.now() - 48 * 60 * 60 * 1000
  let close = 120.4
  for (let i = 0; i < 96; i += 1) {
    const wave = Math.sin(i / 7) * 2.8 + Math.sin(i / 19) * 5.3
    const drift = i > 70 ? (i - 70) * 0.28 : 0
    const open = close
    close = Math.max(93, 123 + wave + drift + (i % 9) * 0.42)
    const high = Math.max(open, close) + 1.6 + (i % 4) * 0.55
    const low = Math.min(open, close) - 1.2 - (i % 3) * 0.42
    result.push({ time: start + i * 30 * 60 * 1000, open, high, low, close, volume: 50_000 + (i % 11) * 17_000 })
  }
  return result
}

export function createDemoLiquidity(): LiquidityBin[] {
  const bins: LiquidityBin[] = []
  const step = 1.7
  for (let i = 0; i < 54; i += 1) {
    const low = 92 + i * step
    const high = low + step
    const midpoint = (low + high) / 2
    const active = midpoint >= 104.8764 && midpoint <= 150.0591
    const value = active ? 45 + Math.sin(i / 5) * 16 + (i > 23 && i < 37 ? 25 : 0) : 7 + (i % 4) * 4
    bins.push({ low, high, value, side: midpoint < demoSummary.displayPrice ? 'below' : midpoint > demoSummary.displayPrice ? 'above' : 'active' })
  }
  return bins
}

export function createDemoPositions(): Position[] {
  return [
    {
      tokenId: 711338n,
      poolAddress: demoSummary.address,
      owner: demoOwner,
      pair: 'SPCXB/USDT',
      minPrice: 106.6728,
      maxPrice: 146.9988,
      tickLower: -50150,
      tickUpper: -46500,
      status: 'IN RANGE',
      liquidity: 2_209_750n,
      amount0: 59.701685,
      amount1: 0.220975,
      amount0Usd: 59.7,
      amount1Usd: 29.26,
      fees0: 0.001869,
      fees1: 0.24351,
      feesUsd: 0.49,
      feeApr: 0.55,
      createdAt: Date.now() - 1000 * 60 * 60 * 24 * 7,
    },
    {
      tokenId: 711060n,
      poolAddress: demoSummary.address,
      owner: demoOwner,
      pair: 'SNDKB/USDT',
      minPrice: 1001.9,
      maxPrice: 1603,
      tickLower: -32000,
      tickUpper: -28000,
      status: 'IN RANGE',
      liquidity: 1_009_900n,
      amount0: 651.196263,
      amount1: 0.592873,
      amount0Usd: 651.2,
      amount1Usd: 78.5,
      fees0: 0.000015,
      fees1: 0,
      feesUsd: 0,
      feeApr: 0,
      createdAt: Date.now() - 1000 * 60 * 60 * 24 * 4,
    },
    {
      tokenId: 711109n,
      poolAddress: demoSummary.address,
      owner: demoOwner,
      pair: 'SPCXB/USDT',
      minPrice: 104.5607,
      maxPrice: 150.6184,
      tickLower: -50150,
      tickUpper: -46500,
      status: 'IN RANGE',
      liquidity: 3_797_159n,
      amount0: 903.424635,
      amount1: 3.797159,
      amount0Usd: 903.42,
      amount1Usd: 503.0,
      fees0: 0.000001,
      fees1: 0.000155,
      feesUsd: 0,
      feeApr: 0,
      createdAt: Date.now() - 1000 * 60 * 60 * 24 * 2,
    },
  ]
}

export function createDemoData(): TerminalData {
  return {
    summary: demoSummary,
    candles: createDemoCandles(),
    liquidity: createDemoLiquidity(),
    positions: createDemoPositions(),
  }
}
