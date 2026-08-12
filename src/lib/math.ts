import type { PoolSummary, Simulation } from '../types'

const Q96 = 2 ** 96

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

export function rawToUi(raw: bigint, decimals: number, multiplier = 10n ** 18n): number {
  const rawNumber = Number(raw) / 10 ** decimals
  return rawNumber * Number(multiplier) / 1e18
}

export function uiToRaw(amount: number, decimals: number): bigint {
  if (!Number.isFinite(amount) || amount <= 0) return 0n
  return BigInt(Math.max(0, Math.floor(amount * 10 ** decimals)))
}

export function sqrtPriceX96ToRawPrice(sqrtPriceX96: bigint): number {
  const sqrt = Number(sqrtPriceX96) / Q96
  return sqrt * sqrt
}

export function tickToRawPrice(tick: number): number {
  return Math.pow(1.0001, tick)
}

export function tickToPrice(tick: number, decimals0: number, decimals1: number): number {
  return tickToRawPrice(tick) * 10 ** (decimals0 - decimals1)
}

export function priceToTick(price: number, decimals0: number, decimals1: number): number {
  if (!Number.isFinite(price) || price <= 0) return 0
  const rawPrice = price / 10 ** (decimals0 - decimals1)
  return Math.floor(Math.log(rawPrice) / Math.log(1.0001))
}

export function alignTick(tick: number, tickSpacing: number, direction: 'down' | 'up'): number {
  const spacing = Math.max(1, Math.abs(tickSpacing))
  const quotient = tick / spacing
  return (direction === 'down' ? Math.floor(quotient) : Math.ceil(quotient)) * spacing
}

export function displayPriceFromPoolRaw(rawPrice: number, token0IsQuote: boolean, token0Multiplier = 1, token1Multiplier = 1): number {
  const uiRawPrice = rawPrice * token1Multiplier / token0Multiplier
  return token0IsQuote ? 1 / uiRawPrice : uiRawPrice
}

export function priceRangeForPreset(current: number, preset: string): [number, number] {
  if (!Number.isFinite(current) || current <= 0) return [0, 0]
  if (preset === 'x2') return [current / 2, current * 2]
  const width = Number(preset.replace('%', '')) / 100
  if (!Number.isFinite(width)) return [current * 0.8, current * 1.2]
  return [current * (1 - width), current * (1 + width)]
}

export function calculatePositionAmounts(
  liquidity: number,
  currentPrice: number,
  minPrice: number,
  maxPrice: number,
): { base: number; quote: number } {
  if (!Number.isFinite(liquidity) || liquidity <= 0 || minPrice <= 0 || maxPrice <= minPrice) {
    return { base: 0, quote: 0 }
  }
  const lower = Math.sqrt(minPrice)
  const upper = Math.sqrt(maxPrice)
  const current = Math.sqrt(clamp(currentPrice, minPrice, maxPrice))

  if (currentPrice <= minPrice) {
    return { base: liquidity * (upper - lower) / (lower * upper), quote: 0 }
  }
  if (currentPrice >= maxPrice) {
    return { base: 0, quote: liquidity * (upper - lower) }
  }
  return {
    base: liquidity * (upper - current) / (current * upper),
    quote: liquidity * (current - lower),
  }
}

export function calculateSimulation(
  summary: PoolSummary,
  minPrice: number,
  maxPrice: number,
  depositUsd: number,
): Simulation {
  const warnings: string[] = []
  const current = summary.displayPrice
  const inRange = current >= minPrice && current <= maxPrice
  const width = current > 0 ? (maxPrice - minPrice) / current : 0
  const historicalRangeShare = clamp(0.35 + width * 1.4, 0.08, 0.98)
  const activeShare = summary.tvlUsd > 0 && depositUsd > 0
    ? clamp(depositUsd / (summary.tvlUsd + depositUsd), 0.00001, 0.4)
    : null
  const feeApr = inRange && activeShare
    ? summary.feeApr * historicalRangeShare * clamp(1 + activeShare * 3, 1, 2.2)
    : inRange
      ? summary.feeApr * historicalRangeShare
      : 0
  const rangeStayDays = clamp(historicalRangeShare * 30, 1, 30)
  const expectedFeeUsd30d = depositUsd > 0 ? depositUsd * feeApr / 100 * 30 / 365 : null
  const expectedFee30d = expectedFeeUsd30d && summary.displayPrice > 0
    ? expectedFeeUsd30d / summary.displayPrice
    : null
  const twapDivergence = summary.twapPrice > 0
    ? Math.abs(summary.displayPrice - summary.twapPrice) / summary.twapPrice * 100
    : null

  if (!inRange) warnings.push('현재 가격이 선택한 범위 밖입니다. 이 상태에서는 수수료가 발생하지 않습니다.')
  if (width < 0.08) warnings.push('범위가 좁아 가격 이탈과 재조정 위험이 큽니다.')
  if (twapDivergence !== null && twapDivergence > 1) warnings.push('현재 가격과 TWAP의 괴리가 큽니다. 거래 전 가격을 확인하세요.')
  if (summary.volume24hUsd < summary.tvlUsd * 0.01) warnings.push('최근 거래량이 낮아 APR 추정 오차가 클 수 있습니다.')

  return {
    feeApr: Number.isFinite(feeApr) ? feeApr : null,
    inRangeShare: historicalRangeShare * 100,
    rangeStayDays,
    expectedFee30d,
    expectedFeeUsd30d,
    liquidityShare: activeShare === null ? null : activeShare * 100,
    twapDivergence,
    priceImpact: depositUsd > 0 ? clamp(depositUsd / Math.max(summary.tvlUsd, 1) * 100, 0.01, 4.5) : null,
    warnings,
  }
}

export function formatTickRange(minPrice: number, maxPrice: number): string {
  return `${minPrice.toFixed(4)} — ${maxPrice.toFixed(4)}`
}
