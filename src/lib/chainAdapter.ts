import {
  getAddress,
  isAddress,
  maxUint128,
  type Address,
  type Hash,
} from 'viem'
import { APP_CONFIG, isLiveConfig } from '../config'
import { erc20Abi, pancakeV3FactoryAbi, pancakeV3QuoterV2Abi, pancakeV3SwapRouterAbi, poolAbi, positionManagerAbi, scaledUiAbi } from '../abi'
import { createDemoData, createDemoPositions, demoSummary } from './demo'
import { alignTick, calculatePositionAmounts, displayPriceFromPoolRaw, rawToUi, sqrtPriceX96ToRawPrice, tickToPrice } from './math'
import { connectWallet, getPublicClient, getWalletClient } from './viem'
import type { Candle, LiquidityBin, PoolSummary, Position, TerminalData, TokenMeta, ZapQuote } from '../types'
import type { PoolPreset } from '../pools'

type Tuple = readonly [bigint, number, number, number, number, number, boolean]

function asNumber(value: unknown): number {
  return typeof value === 'bigint' ? Number(value) : Number(value)
}

function asAddress(value: unknown): Address {
  return getAddress(String(value))
}

function feeLabel(fee: number): string {
  return `${(fee / 10000).toFixed(fee % 10000 === 0 ? 0 : 2)}%`
}

async function readScaledUi(address: Address, owner?: Address): Promise<{ isScaledUi: boolean; multiplier: bigint; balanceUi: bigint }> {
  const client = getPublicClient()
  try {
    const multiplier = await client.readContract({ address, abi: scaledUiAbi, functionName: 'uiMultiplier' }) as bigint
    const balanceUi = owner
      ? await client.readContract({ address, abi: scaledUiAbi, functionName: 'balanceOfUI', args: [owner] }) as bigint
      : 0n
    return { isScaledUi: true, multiplier, balanceUi }
  } catch {
    const balanceUi = owner
      ? await client.readContract({ address, abi: erc20Abi, functionName: 'balanceOf', args: [owner] }) as bigint
      : 0n
    return { isScaledUi: false, multiplier: 10n ** 18n, balanceUi }
  }
}

async function readToken(address: Address, fallbackSymbol: string, fallbackDecimals: number, owner?: Address): Promise<TokenMeta> {
  const client = getPublicClient()
  const [symbol, name, decimals, scaled] = await Promise.all([
    client.readContract({ address, abi: erc20Abi, functionName: 'symbol' }).catch(() => fallbackSymbol) as Promise<string>,
    client.readContract({ address, abi: erc20Abi, functionName: 'name' }).catch(() => fallbackSymbol) as Promise<string>,
    client.readContract({ address, abi: erc20Abi, functionName: 'decimals' }).catch(() => fallbackDecimals) as Promise<number>,
    readScaledUi(address, owner),
  ])
  const spender = APP_CONFIG.npmAddress || APP_CONFIG.smartRouterAddress || address
  const balanceRaw = owner
    ? await client.readContract({ address, abi: erc20Abi, functionName: 'balanceOf', args: [owner] }) as bigint
    : 0n
  const allowanceRaw = owner
    ? await client.readContract({ address, abi: erc20Abi, functionName: 'allowance', args: [owner, spender] }).catch(() => 0n) as bigint
    : 0n
  const displayBalance = scaled.isScaledUi ? scaled.balanceUi : balanceRaw
  return {
    address,
    symbol,
    name,
    decimals: Number(decimals),
    isScaledUi: scaled.isScaledUi,
    uiMultiplier: scaled.multiplier,
    uiMultiplierDisplay: Number(scaled.multiplier) / 1e18,
    balanceUi: rawToUi(displayBalance, Number(decimals)),
    balanceUiRaw: displayBalance,
    balanceRaw,
    allowanceRaw,
    verified: Boolean(import.meta.env.VITE_POOL_ADDRESS),
  }
}

function toUiPoolPrice(rawPrice: number, token0: TokenMeta, token1: TokenMeta): { display: number; token0IsQuote: boolean } {
  const token0IsQuote = /USDT|USDC|USD|BUSD|FDUSD/i.test(token0.symbol)
  const rawDisplay = displayPriceFromPoolRaw(
    rawPrice * 10 ** (token0.decimals - token1.decimals),
    token0IsQuote,
    token0.uiMultiplierDisplay,
    token1.uiMultiplierDisplay,
  )
  return { display: rawDisplay, token0IsQuote }
}

async function getLiveSummary(owner?: Address, preset?: PoolPreset): Promise<PoolSummary> {
  const client = getPublicClient()
  const pool = preset?.poolAddress || APP_CONFIG.poolAddress
  const [token0Address, token1Address, feeValue, spacingValue, slot0Value, liquidityValue, block] = await Promise.all([
    client.readContract({ address: pool, abi: poolAbi, functionName: 'token0' }),
    client.readContract({ address: pool, abi: poolAbi, functionName: 'token1' }),
    client.readContract({ address: pool, abi: poolAbi, functionName: 'fee' }),
    client.readContract({ address: pool, abi: poolAbi, functionName: 'tickSpacing' }),
    client.readContract({ address: pool, abi: poolAbi, functionName: 'slot0' }),
    client.readContract({ address: pool, abi: poolAbi, functionName: 'liquidity' }),
    client.getBlockNumber(),
  ])
  const token0 = await readToken(asAddress(token0Address), preset?.token0Symbol || APP_CONFIG.token0Symbol, preset?.token0Decimals || APP_CONFIG.token0Decimals, owner)
  const token1 = await readToken(asAddress(token1Address), preset?.token1Symbol || APP_CONFIG.token1Symbol, preset?.token1Decimals || APP_CONFIG.token1Decimals, owner)
  const slot0 = slot0Value as Tuple
  const rawPrice = sqrtPriceX96ToRawPrice(slot0[0])
  const { display, token0IsQuote } = toUiPoolPrice(rawPrice, token0, token1)
  let twapPrice = display
  try {
    const observations = await client.readContract({ address: pool, abi: poolAbi, functionName: 'observe', args: [[1800, 0]] }) as readonly [readonly bigint[], readonly bigint[]]
    const tickDelta = Number(observations[0][1] - observations[0][0]) / 1800
    const rawTwap = tickToPrice(tickDelta, token0.decimals, token1.decimals)
    twapPrice = token0IsQuote
      ? 1 / (rawTwap * token1.uiMultiplierDisplay / token0.uiMultiplierDisplay)
      : rawTwap * token1.uiMultiplierDisplay / token0.uiMultiplierDisplay
  } catch {
    twapPrice = display
  }
  const poolBalance0 = await client.readContract({ address: token0.address, abi: erc20Abi, functionName: 'balanceOf', args: [pool] }) as bigint
  const poolBalance1 = await client.readContract({ address: token1.address, abi: erc20Abi, functionName: 'balanceOf', args: [pool] }) as bigint
  const poolAmount0 = rawToUi(poolBalance0, token0.decimals, token0.uiMultiplier)
  const poolAmount1 = rawToUi(poolBalance1, token1.decimals, token1.uiMultiplier)
  const tvlUsd = token0IsQuote ? poolAmount0 + poolAmount1 * display : poolAmount1 + poolAmount0 * display
  return {
    address: pool,
    mode: 'live',
    token0,
    token1,
    displayBase: token0IsQuote ? token1 : token0,
    displayQuote: token0IsQuote ? token0 : token1,
    displayPrice: display,
    rawPrice,
    twapPrice,
    tick: Number(slot0[1]),
    tickSpacing: Number(spacingValue),
    feeTier: Number(feeValue),
    feeTierLabel: feeLabel(Number(feeValue)),
    tvlUsd,
    fees24hUsd: 0,
    volume24hUsd: 0,
    feeApr: 0,
    activeLiquidity: asNumber(liquidityValue),
    lastUpdated: Date.now(),
    sourceBlock: block,
    underlyingStatus: 'unavailable',
    writesEnabled: Boolean(APP_CONFIG.enableMainnetWrites && APP_CONFIG.npmAddress && owner && preset?.verified !== false),
  }
}

async function fetchApi<T>(path: string, signal?: AbortSignal): Promise<T | undefined> {
  try {
    const response = await fetch(`${APP_CONFIG.apiBaseUrl}${path}`, { signal })
    if (!response.ok) return undefined
    return await response.json() as T
  } catch (cause) {
    if (signal?.aborted) throw cause
    return undefined
  }
}

function revivePositions(positions: Position[]): Position[] {
  return positions.map(position => ({
    ...position,
    tokenId: BigInt(position.tokenId),
    liquidity: BigInt(position.liquidity),
    minPrice: Number(position.minPrice),
    maxPrice: Number(position.maxPrice),
    amount0: Number(position.amount0),
    amount1: Number(position.amount1),
    amount0Usd: Number(position.amount0Usd),
    amount1Usd: Number(position.amount1Usd),
    fees0: Number(position.fees0),
    fees1: Number(position.fees1),
    feesUsd: Number(position.feesUsd),
    feeApr: Number(position.feeApr),
    createdAt: Number(position.createdAt),
  }))
}

export async function loadTerminalData(owner?: Address, preset?: PoolPreset, timeframe = '1d', signal?: AbortSignal): Promise<TerminalData> {
  if (!isLiveConfig && !preset) return createDemoData()
  const onchainSummary = await getLiveSummary(owner, preset)
  if (signal?.aborted) throw new DOMException('요청이 취소되었습니다.', 'AbortError')
  const [market, candles, liquidity] = await Promise.all([
    fetchApi<Partial<PoolSummary>>(`/api/pools/${onchainSummary.address}/summary`, signal),
    fetchApi<Candle[]>(`/api/pools/${onchainSummary.address}/candles?interval=${encodeURIComponent(timeframe)}`, signal).then(value => value || []),
    fetchApi<LiquidityBin[]>(`/api/pools/${onchainSummary.address}/liquidity`, signal).then(value => value || []),
  ])
  const positions = owner
    ? await fetchApi<Position[]>(`/api/wallet/${owner}/positions`, signal).then(value => revivePositions(value || []))
    : []
  const finite = (value: unknown) => Number.isFinite(Number(value)) && Number(value) >= 0
  const summary: PoolSummary = {
    ...onchainSummary,
    tvlUsd: finite(market?.tvlUsd) ? Number(market?.tvlUsd) : onchainSummary.tvlUsd,
    fees24hUsd: finite(market?.fees24hUsd) ? Number(market?.fees24hUsd) : onchainSummary.fees24hUsd,
    volume24hUsd: finite(market?.volume24hUsd) ? Number(market?.volume24hUsd) : onchainSummary.volume24hUsd,
    feeApr: finite(market?.feeApr) ? Number(market?.feeApr) : onchainSummary.feeApr,
    marketStatus: market?.marketStatus || 'unavailable',
    marketUpdatedAt: finite(market?.marketUpdatedAt) ? Number(market?.marketUpdatedAt) : undefined,
  }
  return { summary, candles, liquidity, positions }
}

export async function connectAndLoad(): Promise<Address> {
  return connectWallet()
}

function uiAmountToAtoms(amount: number | string, decimals: number): bigint {
  if (typeof amount === 'number') {
    if (!Number.isFinite(amount) || amount <= 0) return 0n
    const precision = Math.min(decimals, 12)
    const truncated = BigInt(Math.floor(amount * 10 ** precision))
    return truncated * 10n ** BigInt(decimals - precision)
  }
  const normalized = amount.trim()
  if (!/^\d+(?:\.\d*)?$/.test(normalized)) return 0n
  const [whole, fraction = ''] = normalized.split('.')
  const fractionAtoms = fraction.slice(0, decimals).padEnd(decimals, '0')
  return BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(fractionAtoms || '0')
}

async function toRawAmount(token: TokenMeta, uiAmount: number | string): Promise<bigint> {
  const uiAtoms = uiAmountToAtoms(uiAmount, token.decimals)
  if (uiAtoms <= 0n) return 0n
  if (!token.isScaledUi) return uiAtoms
  const client = getPublicClient()
  try {
    return await client.readContract({ address: token.address, abi: scaledUiAbi, functionName: 'fromUIAmount', args: [uiAtoms] }) as bigint
  } catch {
    return uiAtoms
  }
}

function poolPriceFromDisplay(summary: PoolSummary, displayPrice: number): number {
  const token0IsQuote = summary.displayQuote.address.toLowerCase() === summary.token0.address.toLowerCase()
  const uiPoolPrice = token0IsQuote ? 1 / displayPrice : displayPrice
  return uiPoolPrice * summary.token0.uiMultiplierDisplay / summary.token1.uiMultiplierDisplay
}

function displayPriceToPoolTick(summary: PoolSummary, displayPrice: number): number {
  if (!Number.isFinite(displayPrice) || displayPrice <= 0) return 0
  const poolPrice = poolPriceFromDisplay(summary, displayPrice)
  const rawPrice = poolPrice / 10 ** (summary.token0.decimals - summary.token1.decimals)
  return Math.floor(Math.log(rawPrice) / Math.log(1.0001))
}

function poolRawPriceToDisplay(summary: PoolSummary, rawPrice: number): number {
  const token0IsQuote = summary.displayQuote.address.toLowerCase() === summary.token0.address.toLowerCase()
  return displayPriceFromPoolRaw(
    rawPrice * 10 ** (summary.token0.decimals - summary.token1.decimals),
    token0IsQuote,
    summary.token0.uiMultiplierDisplay,
    summary.token1.uiMultiplierDisplay,
  )
}

function positionTicks(summary: PoolSummary, minPrice: number, maxPrice: number): { tickLower: number; tickUpper: number } {
  const ticks = [displayPriceToPoolTick(summary, minPrice), displayPriceToPoolTick(summary, maxPrice)].sort((a, b) => a - b)
  const tickLower = alignTick(ticks[0], summary.tickSpacing, 'down')
  const tickUpper = alignTick(ticks[1], summary.tickSpacing, 'up')
  if (tickLower >= tickUpper) throw new Error('가격 범위가 올바르지 않습니다.')
  return { tickLower, tickUpper }
}

async function assertDeployedContract(address: Address, label: string): Promise<void> {
  const bytecode = await getPublicClient().getBytecode({ address })
  if (!bytecode || bytecode === '0x') throw new Error(`${label} 컨트랙트가 BNB Chain에서 확인되지 않습니다.`)
}

async function assertVerifiedPancakePool(summary: PoolSummary): Promise<void> {
  const publicClient = getPublicClient()
  const [bytecode, token0, token1, fee, factoryPool] = await Promise.all([
    publicClient.getBytecode({ address: summary.address }),
    publicClient.readContract({ address: summary.address, abi: poolAbi, functionName: 'token0' }),
    publicClient.readContract({ address: summary.address, abi: poolAbi, functionName: 'token1' }),
    publicClient.readContract({ address: summary.address, abi: poolAbi, functionName: 'fee' }),
    publicClient.readContract({
      address: APP_CONFIG.pancakeV3FactoryAddress,
      abi: pancakeV3FactoryAbi,
      functionName: 'getPool',
      args: [summary.token0.address, summary.token1.address, summary.feeTier],
    }),
  ])
  if (!bytecode || bytecode === '0x') throw new Error('선택한 풀 컨트랙트가 BNB Chain에서 확인되지 않습니다.')
  if (String(token0).toLowerCase() !== summary.token0.address.toLowerCase() || String(token1).toLowerCase() !== summary.token1.address.toLowerCase()) {
    throw new Error('선택한 풀의 토큰 구성이 화면과 일치하지 않습니다.')
  }
  if (Number(fee) !== summary.feeTier || String(factoryPool).toLowerCase() !== summary.address.toLowerCase()) {
    throw new Error('PancakeSwap V3 Factory에서 검증되지 않은 풀입니다.')
  }
}

async function writeWithSimulation<T extends string>(functionName: T, args: unknown[], account: Address): Promise<Hash> {
  if (!APP_CONFIG.enableMainnetWrites) throw new Error('메인넷 쓰기는 기본 비활성화되어 있습니다. 검증 후 VITE_ENABLE_MAINNET_WRITES=true로 켜세요.')
  const npm = APP_CONFIG.npmAddress
  if (!npm) throw new Error('NonfungiblePositionManager 주소가 설정되지 않았습니다.')
  const publicClient = getPublicClient()
  const walletClient = getWalletClient()
  const simulation = await publicClient.simulateContract({
    address: npm,
    abi: positionManagerAbi,
    functionName,
    args,
    account,
  } as never)
  return walletClient.writeContract(simulation.request as never)
}

export async function approveTokenFor(token: TokenMeta, amountRaw: bigint, spender: Address, account: Address): Promise<Hash | undefined> {
  if (!APP_CONFIG.enableMainnetWrites) throw new Error('메인넷 쓰기는 기본 비활성화되어 있습니다.')
  if (amountRaw <= 0n) return undefined
  const walletClient = getWalletClient()
  const publicClient = getPublicClient()
  const allowance = await publicClient.readContract({ address: token.address, abi: erc20Abi, functionName: 'allowance', args: [account, spender] }) as bigint
  if (allowance >= amountRaw) return undefined
  const simulation = await publicClient.simulateContract({
    address: token.address,
    abi: erc20Abi,
    functionName: 'approve',
    args: [spender, amountRaw],
    account,
  } as never)
  return walletClient.writeContract(simulation.request as never)
}

export async function approveToken(token: TokenMeta, amountRaw: bigint, account: Address): Promise<Hash | undefined> {
  return approveTokenFor(token, amountRaw, APP_CONFIG.npmAddress, account)
}

async function mintPositionRaw(params: {
  summary: PoolSummary
  account: Address
  minPrice: number
  maxPrice: number
  amount0: bigint
  amount1: bigint
  slippageBps: number
}): Promise<Hash> {
  const { summary, account, minPrice, maxPrice, amount0, amount1, slippageBps } = params
  const { tickLower, tickUpper } = positionTicks(summary, minPrice, maxPrice)
  if (amount0 <= 0n && amount1 <= 0n) throw new Error('예치할 토큰 수량이 없습니다.')
  const publicClient = getPublicClient()
  const [balance0, balance1] = await Promise.all([
    publicClient.readContract({ address: summary.token0.address, abi: erc20Abi, functionName: 'balanceOf', args: [account] }) as Promise<bigint>,
    publicClient.readContract({ address: summary.token1.address, abi: erc20Abi, functionName: 'balanceOf', args: [account] }) as Promise<bigint>,
  ])
  if (amount0 > balance0) throw new Error(`${summary.token0.symbol} 입력 수량이 현재 실제 잔고보다 많습니다. MAX를 다시 눌러 주세요.`)
  if (amount1 > balance1) throw new Error(`${summary.token1.symbol} 입력 수량이 현재 실제 잔고보다 많습니다. MAX를 다시 눌러 주세요.`)
  const factor = BigInt(Math.max(0, 10_000 - slippageBps))
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 900)
  const baseParams = {
    token0: summary.token0.address,
    token1: summary.token1.address,
    fee: summary.feeTier,
    tickLower,
    tickUpper,
    amount0Desired: amount0,
    amount1Desired: amount1,
    recipient: account,
    deadline,
  }
  const quote = await publicClient.simulateContract({
    address: APP_CONFIG.npmAddress,
    abi: positionManagerAbi,
    functionName: 'mint',
    args: [{ ...baseParams, amount0Min: 0n, amount1Min: 0n }],
    account,
  } as never)
  const [, liquidity, used0, used1] = quote.result as readonly [bigint, bigint, bigint, bigint]
  if (liquidity <= 0n || (used0 <= 0n && used1 <= 0n)) throw new Error('선택한 범위에서 생성 가능한 유동성이 없습니다.')
  const protectedParams = {
    ...baseParams,
    amount0Min: used0 * factor / 10_000n,
    amount1Min: used1 * factor / 10_000n,
  }
  const simulation = await publicClient.simulateContract({
    address: APP_CONFIG.npmAddress,
    abi: positionManagerAbi,
    functionName: 'mint',
    args: [protectedParams],
    account,
  } as never)
  return getWalletClient().writeContract(simulation.request as never)
}

export async function mintPosition(params: {
  summary: PoolSummary
  account: Address
  minPrice: number
  maxPrice: number
  amount0Ui: number | string
  amount1Ui: number | string
  slippageBps: number
}): Promise<Hash> {
  const { summary, account, minPrice, maxPrice, amount0Ui, amount1Ui, slippageBps } = params
  await assertVerifiedPancakePool(summary)
  const amount0 = await toRawAmount(summary.token0, amount0Ui)
  const amount1 = await toRawAmount(summary.token1, amount1Ui)
  const approval0 = await approveToken(summary.token0, amount0, account)
  if (approval0) await getPublicClient().waitForTransactionReceipt({ hash: approval0 })
  const approval1 = await approveToken(summary.token1, amount1, account)
  if (approval1) await getPublicClient().waitForTransactionReceipt({ hash: approval1 })
  return mintPositionRaw({ summary, account, minPrice, maxPrice, amount0, amount1, slippageBps })
}

export async function quoteZap(params: {
  summary: PoolSummary
  budgetQuoteUi: number
  minPrice: number
  maxPrice: number
  slippageBps: number
}): Promise<ZapQuote> {
  const { summary, budgetQuoteUi, minPrice, maxPrice, slippageBps } = params
  if (!Number.isFinite(budgetQuoteUi) || budgetQuoteUi <= 0) throw new Error('Zap에 사용할 수량을 입력하세요.')
  if (minPrice <= 0 || maxPrice <= minPrice) throw new Error('가격 범위를 먼저 설정하세요.')
  positionTicks(summary, minPrice, maxPrice)
  const unitAmounts = calculatePositionAmounts(1, summary.displayPrice, minPrice, maxPrice)
  const baseValue = unitAmounts.base * summary.displayPrice
  const quoteValue = unitAmounts.quote
  const totalValue = baseValue + quoteValue
  if (!Number.isFinite(totalValue) || totalValue <= 0) throw new Error('선택 범위의 Zap 비율을 계산하지 못했습니다.')
  const baseValueShare = Math.max(0, Math.min(1, baseValue / totalValue))
  const swapQuoteUi = budgetQuoteUi * baseValueShare
  const remainingQuoteUi = Math.max(0, budgetQuoteUi - swapQuoteUi)
  if (swapQuoteUi <= 0.00000001) {
    return {
      budgetQuoteUi,
      swapQuoteUi: 0,
      swapQuoteRaw: 0n,
      remainingQuoteUi: budgetQuoteUi,
      expectedBaseUi: 0,
      expectedBaseRaw: 0n,
      minimumBaseUi: 0,
      minimumBaseRaw: 0n,
      baseValueShare,
      priceImpactPercent: 0,
      initializedTicksCrossed: 0,
      gasEstimate: 0n,
      quotedAt: Date.now(),
    }
  }
  const amountIn = await toRawAmount(summary.displayQuote, swapQuoteUi)
  const simulation = await getPublicClient().simulateContract({
    address: APP_CONFIG.quoterV2Address,
    abi: pancakeV3QuoterV2Abi,
    functionName: 'quoteExactInputSingle',
    args: [{
      tokenIn: summary.displayQuote.address,
      tokenOut: summary.displayBase.address,
      amountIn,
      fee: summary.feeTier,
      sqrtPriceLimitX96: 0n,
    }],
  } as never)
  const [amountOutRaw, sqrtPriceX96After, initializedTicksCrossed, gasEstimate] = simulation.result as readonly [bigint, bigint, number, bigint]
  if (amountOutRaw <= 0n) throw new Error('PancakeSwap에서 Zap 스왑 견적을 받지 못했습니다.')
  const factor = BigInt(Math.max(0, 10_000 - slippageBps))
  const minimumOutRaw = amountOutRaw * factor / 10_000n
  const expectedBaseUi = rawToUi(amountOutRaw, summary.displayBase.decimals, summary.displayBase.uiMultiplier)
  const minimumBaseUi = rawToUi(minimumOutRaw, summary.displayBase.decimals, summary.displayBase.uiMultiplier)
  const priceAfter = poolRawPriceToDisplay(summary, sqrtPriceX96ToRawPrice(sqrtPriceX96After))
  const priceImpactPercent = Math.abs(priceAfter - summary.displayPrice) / summary.displayPrice * 100
  return {
    budgetQuoteUi,
    swapQuoteUi,
    swapQuoteRaw: amountIn,
    remainingQuoteUi,
    expectedBaseUi,
    expectedBaseRaw: amountOutRaw,
    minimumBaseUi,
    minimumBaseRaw: minimumOutRaw,
    baseValueShare,
    priceImpactPercent,
    initializedTicksCrossed: Number(initializedTicksCrossed),
    gasEstimate: BigInt(gasEstimate),
    quotedAt: Date.now(),
  }
}

export interface ZapProgress {
  phase: 'quoting' | 'approving-swap' | 'swapping' | 'approving-position' | 'minting'
  message: string
  hash?: Hash
}

export async function executeZapPosition(params: {
  summary: PoolSummary
  account: Address
  budgetQuoteUi: number
  minPrice: number
  maxPrice: number
  slippageBps: number
  onProgress?: (progress: ZapProgress) => void
}): Promise<{ mintHash: Hash; swapHash?: Hash; quote: ZapQuote }> {
  const { summary, account, budgetQuoteUi, minPrice, maxPrice, slippageBps, onProgress } = params
  if (!APP_CONFIG.enableMainnetWrites) throw new Error('메인넷 실행 설정이 비활성화되어 있습니다.')
  if (summary.mode !== 'live') throw new Error('실제 온체인 풀에서만 Zap을 실행할 수 있습니다.')
  await Promise.all([
    assertDeployedContract(APP_CONFIG.smartRouterAddress, 'PancakeSwap V3 SwapRouter'),
    assertDeployedContract(APP_CONFIG.npmAddress, 'PancakeSwap V3 Position Manager'),
    assertDeployedContract(APP_CONFIG.quoterV2Address, 'PancakeSwap V3 QuoterV2'),
    assertVerifiedPancakePool(summary),
  ])
  onProgress?.({ phase: 'quoting', message: 'PancakeSwap에서 최신 Zap 견적을 다시 확인하는 중…' })
  const quote = await quoteZap({ summary, budgetQuoteUi, minPrice, maxPrice, slippageBps })
  if (quote.priceImpactPercent > 5) throw new Error(`예상 가격 충격이 ${quote.priceImpactPercent.toFixed(2)}%로 너무 큽니다. 수량을 줄여 주세요.`)
  const publicClient = getPublicClient()
  const quoteToken = summary.displayQuote
  const baseToken = summary.displayBase
  const budgetRaw = await toRawAmount(quoteToken, budgetQuoteUi)
  const swapAmountRaw = quote.swapQuoteRaw
  const quoteBalance = await publicClient.readContract({ address: quoteToken.address, abi: erc20Abi, functionName: 'balanceOf', args: [account] }) as bigint
  if (quoteBalance < budgetRaw) throw new Error(`${quoteToken.symbol} 잔고가 Zap 예산보다 부족합니다.`)
  let actualBaseRaw = 0n
  let swapHash: Hash | undefined
  if (swapAmountRaw > 0n) {
    onProgress?.({ phase: 'approving-swap', message: `${quoteToken.symbol} 스왑 승인을 확인하는 중…` })
    const approvalHash = await approveTokenFor(quoteToken, swapAmountRaw, APP_CONFIG.smartRouterAddress, account)
    if (approvalHash) {
      onProgress?.({ phase: 'approving-swap', message: `${quoteToken.symbol} 스왑 승인 처리 중…`, hash: approvalHash })
      await publicClient.waitForTransactionReceipt({ hash: approvalHash })
    }
    const baseBefore = await publicClient.readContract({ address: baseToken.address, abi: erc20Abi, functionName: 'balanceOf', args: [account] }) as bigint
    const minimumOutRaw = quote.minimumBaseRaw
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600)
    const swapSimulation = await publicClient.simulateContract({
      address: APP_CONFIG.smartRouterAddress,
      abi: pancakeV3SwapRouterAbi,
      functionName: 'exactInputSingle',
      args: [{
        tokenIn: quoteToken.address,
        tokenOut: baseToken.address,
        fee: summary.feeTier,
        recipient: account,
        deadline,
        amountIn: swapAmountRaw,
        amountOutMinimum: minimumOutRaw,
        sqrtPriceLimitX96: 0n,
      }],
      account,
    } as never)
    onProgress?.({ phase: 'swapping', message: `${quoteToken.symbol} → ${baseToken.symbol} 실제 스왑을 지갑에서 확인하세요.` })
    swapHash = await getWalletClient().writeContract(swapSimulation.request as never)
    onProgress?.({ phase: 'swapping', message: '스왑 트랜잭션 확인 중…', hash: swapHash })
    await publicClient.waitForTransactionReceipt({ hash: swapHash })
    const baseAfter = await publicClient.readContract({ address: baseToken.address, abi: erc20Abi, functionName: 'balanceOf', args: [account] }) as bigint
    actualBaseRaw = baseAfter > baseBefore ? baseAfter - baseBefore : 0n
    if (actualBaseRaw <= 0n) throw new Error('스왑은 처리됐지만 받은 토큰 수량을 확인하지 못했습니다. 지갑 잔고를 확인하세요.')
  }
  try {
    await assertVerifiedPancakePool(summary)
    const remainingQuoteRaw = budgetRaw > swapAmountRaw ? budgetRaw - swapAmountRaw : 0n
    const actualBaseUi = rawToUi(actualBaseRaw, baseToken.decimals, baseToken.uiMultiplier)
    const remainingQuoteUi = rawToUi(remainingQuoteRaw, quoteToken.decimals, quoteToken.uiMultiplier)
    const unitAmounts = calculatePositionAmounts(1, summary.displayPrice, minPrice, maxPrice)
    let desiredBaseUi = 0
    let desiredQuoteUi = 0
    if (unitAmounts.base <= 0) desiredQuoteUi = remainingQuoteUi * 0.999
    else if (unitAmounts.quote <= 0) desiredBaseUi = actualBaseUi * 0.999
    else {
      const scale = Math.min(actualBaseUi / unitAmounts.base, remainingQuoteUi / unitAmounts.quote)
      desiredBaseUi = unitAmounts.base * scale * 0.999
      desiredQuoteUi = unitAmounts.quote * scale * 0.999
    }
    const desiredBaseRaw = actualBaseRaw > 0n ? [await toRawAmount(baseToken, desiredBaseUi), actualBaseRaw].reduce((a, b) => a < b ? a : b) : 0n
    const desiredQuoteRaw = remainingQuoteRaw > 0n ? [await toRawAmount(quoteToken, desiredQuoteUi), remainingQuoteRaw].reduce((a, b) => a < b ? a : b) : 0n
    const baseIsToken0 = baseToken.address.toLowerCase() === summary.token0.address.toLowerCase()
    const amount0 = baseIsToken0 ? desiredBaseRaw : desiredQuoteRaw
    const amount1 = baseIsToken0 ? desiredQuoteRaw : desiredBaseRaw
    onProgress?.({ phase: 'approving-position', message: 'V3 포지션 생성을 위한 토큰 승인을 확인하는 중…', hash: swapHash })
    const approval0 = await approveTokenFor(summary.token0, amount0, APP_CONFIG.npmAddress, account)
    if (approval0) {
      onProgress?.({ phase: 'approving-position', message: `${summary.token0.symbol} LP 승인 처리 중…`, hash: approval0 })
      await publicClient.waitForTransactionReceipt({ hash: approval0 })
    }
    const approval1 = await approveTokenFor(summary.token1, amount1, APP_CONFIG.npmAddress, account)
    if (approval1) {
      onProgress?.({ phase: 'approving-position', message: `${summary.token1.symbol} LP 승인 처리 중…`, hash: approval1 })
      await publicClient.waitForTransactionReceipt({ hash: approval1 })
    }
    onProgress?.({ phase: 'minting', message: 'Pancake V3 LP 포지션 생성을 지갑에서 확인하세요.', hash: swapHash })
    const mintHash = await mintPositionRaw({ summary, account, minPrice, maxPrice, amount0, amount1, slippageBps })
    onProgress?.({ phase: 'minting', message: 'LP 포지션 생성 트랜잭션 확인 중…', hash: mintHash })
    await publicClient.waitForTransactionReceipt({ hash: mintHash })
    return { mintHash, swapHash, quote }
  } catch (cause) {
    if (swapHash) {
      const message = cause instanceof Error ? cause.message : '알 수 없는 오류'
      throw new Error(`스왑은 완료됐지만 LP 생성이 중단되었습니다. 지갑에는 두 토큰이 남아 있습니다. 원인: ${message}`)
    }
    throw cause
  }
}

export async function collectPosition(tokenId: bigint, account: Address): Promise<Hash> {
  return writeWithSimulation('collect', [{ tokenId, recipient: account, amount0Max: maxUint128, amount1Max: maxUint128 }], account)
}

export async function decreasePosition(tokenId: bigint, liquidity: bigint, account: Address): Promise<Hash> {
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 900)
  return writeWithSimulation('decreaseLiquidity', [{ tokenId, liquidity, amount0Min: 0n, amount1Min: 0n, deadline }], account)
}

export function isAddressConfigured(): boolean {
  return isLiveConfig && isAddress(APP_CONFIG.poolAddress) && isAddress(APP_CONFIG.token0Address) && isAddress(APP_CONFIG.token1Address)
}
