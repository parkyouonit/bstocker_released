import { createPublicClient, defineChain, formatUnits, getAddress, http, isAddress, parseAbi } from 'viem'
import { tickToPrice } from './robinhood-strategy.mjs'

export const ROBINHOOD_CONTRACTS = Object.freeze({
  chainId: 4663,
  pool: getAddress('0x9d590437ABaAe12cf9fE0627cAF4CFd633152599'),
  gauge: getAddress('0x01a47258375735D36D15dE8A2bb8e0cE876d31f6'),
  positionManager: getAddress('0x07F44c47743A2f36414A82b9F558ECFCf0EEdCEf'),
  swapRouter: getAddress('0xC062b870E813fcA720f1e002c234369Ab3aB9415'),
  spcx: getAddress('0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa'),
  usdg: getAddress('0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168'),
  up: getAddress('0x57C0E45cB534413D1C20A4240955d6bB250BB4F1'),
  spcxUsdFeed: getAddress('0xB265810950ba6c5C0Ff821c9963014a56fD8Bffb'),
  usdgUsdFeed: getAddress('0x61B7e5650328764B076A108EFF5fa7282a1B9aD2'),
  priceFeedHeartbeatSec: 86_400,
  priceFeedMaxAgeSec: 90_000,
  tickSpacing: 10,
  explorer: 'https://robinhoodchain.blockscout.com',
})

export const ROBINHOOD_CHAIN = defineChain({
  id: ROBINHOOD_CONTRACTS.chainId,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.mainnet.chain.robinhood.com'] } },
  blockExplorers: { default: { name: 'Robinhood Chain Blockscout', url: ROBINHOOD_CONTRACTS.explorer } },
  contracts: {
    multicall3: {
      address: getAddress('0xcA11bde05977b3631167028862bE2a173976CA11'),
      blockCreated: 1,
    },
  },
})

const clPoolAbi = parseAbi([
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function fee() view returns (uint24)',
  'function tickSpacing() view returns (int24)',
  'function gauge() view returns (address)',
  'function nft() view returns (address)',
  'function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,bool unlocked)',
  'function liquidity() view returns (uint128)',
  'function stakedLiquidity() view returns (uint128)',
  'function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives,uint160[] secondsPerLiquidityCumulativeX128s)',
])

const gaugeAbi = parseAbi([
  'function pool() view returns (address)',
  'function nft() view returns (address)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function tickSpacing() view returns (int24)',
  'function rewardToken() view returns (address)',
  'function rewardRate() view returns (uint256)',
  'function periodFinish() view returns (uint256)',
  'function left() view returns (uint256)',
  'function stakedValues(address depositor) view returns (uint256[] staked)',
  'function earned(address account,uint256 tokenId) view returns (uint256)',
])

const slipstreamPositionManagerAbi = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function tokenOfOwnerByIndex(address owner,uint256 index) view returns (uint256)',
  'function positions(uint256 tokenId) view returns (uint96 nonce,address operator,address token0,address token1,int24 tickSpacing,int24 tickLower,int24 tickUpper,uint128 liquidity,uint256 feeGrowthInside0LastX128,uint256 feeGrowthInside1LastX128,uint128 tokensOwed0,uint128 tokensOwed1)',
])

const tokenAbi = parseAbi([
  'function symbol() view returns (string)',
  'function name() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address account) view returns (uint256)',
])

const stockAbi = parseAbi([
  'function uiMultiplier() view returns (uint256)',
  'function tokenPaused() view returns (bool)',
  'function oraclePaused() view returns (bool)',
])

const priceFeedAbi = parseAbi([
  'function decimals() view returns (uint8)',
  'function description() view returns (string)',
  'function latestRoundData() view returns (uint80 roundId,int256 answer,uint256 startedAt,uint256 updatedAt,uint80 answeredInRound)',
])

function bigintFloorDivide(numerator, denominator) {
  let quotient = numerator / denominator
  if (numerator < 0n && numerator % denominator !== 0n) quotient -= 1n
  return quotient
}

function priceFromSqrtPriceX96(value, token0Decimals, token1Decimals) {
  const ratio = Number(value) / 2 ** 96
  const price = ratio * ratio * 10 ** (token0Decimals - token1Decimals)
  return Number.isFinite(price) ? price : 0
}

async function fetchJson(url, timeoutMs = 8_000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { headers: { accept: 'application/json' }, signal: controller.signal })
    if (!response.ok) throw new Error(`upstream HTTP ${response.status}`)
    return await response.json()
  } finally {
    clearTimeout(timer)
  }
}

async function optional(read, fallback = null) {
  try { return await read() } catch { return fallback }
}

function tokenAmount(raw, decimals) {
  const value = Number(formatUnits(raw, decimals))
  return Number.isFinite(value) ? value : 0
}

export function createRobinhoodService({
  rpcUrl = 'https://rpc.mainnet.chain.robinhood.com',
  stockApiUrl = 'https://api.robinhood.com/rhj',
} = {}) {
  const client = createPublicClient({
    chain: ROBINHOOD_CHAIN,
    transport: http(rpcUrl, { timeout: 12_000, retryCount: 2, retryDelay: 300 }),
    batch: { multicall: { wait: 12 } },
  })
  let officialCache = { expires: 0, value: null }
  let tokenCache = { expires: 0, value: null }
  let marketPriceCache = { expires: 0, value: null }

  async function loadMarketPrices() {
    if (marketPriceCache.value && marketPriceCache.expires > Date.now()) return marketPriceCache.value
    const relayPrice = async address => {
      const query = new URLSearchParams({ chainId: String(ROBINHOOD_CONTRACTS.chainId), address })
      const payload = await fetchJson(`https://api.relay.link/currencies/token/price?${query}`, 6_000)
      const price = Number(payload?.price)
      if (!Number.isFinite(price) || price <= 0) throw new Error('Relay price unavailable')
      return price
    }
    const [upResult, ethResult] = await Promise.allSettled([
      relayPrice(ROBINHOOD_CONTRACTS.up),
      relayPrice('0x0000000000000000000000000000000000000000'),
    ])
    const previous = marketPriceCache.value
    const upUsd = upResult.status === 'fulfilled' ? upResult.value : previous?.upUsd ?? null
    const ethUsd = ethResult.status === 'fulfilled' ? ethResult.value : previous?.ethUsd ?? null
    const stale = upResult.status === 'rejected' || ethResult.status === 'rejected'
    const value = {
      source: 'RELAY',
      upUsd,
      ethUsd,
      fetchedAt: stale && previous?.fetchedAt ? previous.fetchedAt : Date.now(),
      stale,
    }
    marketPriceCache = { expires: Date.now() + (stale ? 15_000 : 60_000), value }
    return value
  }

  async function loadTokenMetadata() {
    if (tokenCache.value && tokenCache.expires > Date.now()) return tokenCache.value
    const addresses = [ROBINHOOD_CONTRACTS.spcx, ROBINHOOD_CONTRACTS.usdg, ROBINHOOD_CONTRACTS.up]
    const values = await Promise.all(addresses.map(async address => {
      const [symbol, name, decimals] = await Promise.all([
        client.readContract({ address, abi: tokenAbi, functionName: 'symbol' }),
        client.readContract({ address, abi: tokenAbi, functionName: 'name' }),
        client.readContract({ address, abi: tokenAbi, functionName: 'decimals' }),
      ])
      return { address, symbol, name, decimals: Number(decimals) }
    }))
    const result = Object.fromEntries(values.map(value => [value.address.toLowerCase(), value]))
    tokenCache = { expires: Date.now() + 60 * 60_000, value: result }
    return result
  }

  async function loadOfficialSpcx() {
    if (officialCache.value && officialCache.expires > Date.now()) return officialCache.value
    const [pricesResult, assetsResult, spcxFeed, usdgFeed, spcxFeedDescription, usdgFeedDescription, spcxFeedDecimals, usdgFeedDecimals] = await Promise.all([
      optional(() => fetchJson(`${stockApiUrl}/prices/SPCX`), null),
      optional(() => fetchJson(`${stockApiUrl}/assets`), null),
      client.readContract({ address: ROBINHOOD_CONTRACTS.spcxUsdFeed, abi: priceFeedAbi, functionName: 'latestRoundData' }),
      client.readContract({ address: ROBINHOOD_CONTRACTS.usdgUsdFeed, abi: priceFeedAbi, functionName: 'latestRoundData' }),
      client.readContract({ address: ROBINHOOD_CONTRACTS.spcxUsdFeed, abi: priceFeedAbi, functionName: 'description' }),
      client.readContract({ address: ROBINHOOD_CONTRACTS.usdgUsdFeed, abi: priceFeedAbi, functionName: 'description' }),
      client.readContract({ address: ROBINHOOD_CONTRACTS.spcxUsdFeed, abi: priceFeedAbi, functionName: 'decimals' }),
      client.readContract({ address: ROBINHOOD_CONTRACTS.usdgUsdFeed, abi: priceFeedAbi, functionName: 'decimals' }),
    ])
    const prices = pricesResult
    const assets = assetsResult
    const quote = Array.isArray(prices?.quotes) ? prices.quotes.find(item => item?.tokenSymbol === 'SPCX') : undefined
    const asset = Array.isArray(assets?.assets) ? assets.assets.find(item => item?.tokenSymbol === 'SPCX') : undefined
    const deployment = Array.isArray(asset?.deployments) ? asset.deployments.find(item => Number(item.chainId) === ROBINHOOD_CONTRACTS.chainId) : undefined
    const bid = Number(quote?.bid)
    const ask = Number(quote?.ask)
    const multiplier = Number(asset?.currentMultiplier || 1)
    const midpoint = Number.isFinite(bid) && Number.isFinite(ask) ? (bid + ask) / 2 : null
    const [spcxRoundId, spcxAnswer, , spcxUpdatedAt, spcxAnsweredInRound] = spcxFeed
    const [usdgRoundId, usdgAnswer, , usdgUpdatedAt, usdgAnsweredInRound] = usdgFeed
    const feedShapeVerified = spcxFeedDescription === 'Robinhood SPCX / USD'
      && usdgFeedDescription === 'USDG / USD'
      && Number(spcxFeedDecimals) === 8
      && Number(usdgFeedDecimals) === 8
    const roundsValid = spcxAnswer > 0n && usdgAnswer > 0n
      && spcxUpdatedAt > 0n && usdgUpdatedAt > 0n
      && spcxAnsweredInRound >= spcxRoundId && usdgAnsweredInRound >= usdgRoundId
    if (!feedShapeVerified || !roundsValid) throw new Error('SPCX/USDG Chainlink 가격 피드 검증에 실패했습니다.')
    const tokenPrice = Number(spcxAnswer) / Number(usdgAnswer)
    const oldestFeedTimestamp = Number(spcxUpdatedAt < usdgUpdatedAt ? spcxUpdatedAt : usdgUpdatedAt)
    const value = {
      bid,
      ask,
      midpoint,
      tokenPrice: Number.isFinite(tokenPrice) && tokenPrice > 0 ? tokenPrice : null,
      multiplier,
      generatedAt: new Date(oldestFeedTimestamp * 1000).toISOString(),
      quoteGeneratedAt: quote?.generatedAt || null,
      isTradingHalt: Boolean(quote?.isTradingHalt),
      assetStatus: asset?.status || null,
      tradingCapabilities: asset?.tradingCapabilities || null,
      deploymentAddress: deployment?.contractAddress || null,
      deploymentVerified: deployment?.contractAddress
        ? getAddress(deployment.contractAddress) === ROBINHOOD_CONTRACTS.spcx
        : null,
      logoUrl: asset?.logoUrl,
      priceSource: 'CHAINLINK_ONCHAIN',
      priceFeedsVerified: true,
      priceFeedHeartbeatSec: ROBINHOOD_CONTRACTS.priceFeedHeartbeatSec,
      priceFeedMaxAgeSec: ROBINHOOD_CONTRACTS.priceFeedMaxAgeSec,
      spcxFeed: {
        address: ROBINHOOD_CONTRACTS.spcxUsdFeed,
        description: spcxFeedDescription,
        priceUsd: Number(spcxAnswer) / 10 ** Number(spcxFeedDecimals),
        updatedAt: new Date(Number(spcxUpdatedAt) * 1000).toISOString(),
        roundId: spcxRoundId.toString(),
      },
      usdgFeed: {
        address: ROBINHOOD_CONTRACTS.usdgUsdFeed,
        description: usdgFeedDescription,
        priceUsd: Number(usdgAnswer) / 10 ** Number(usdgFeedDecimals),
        updatedAt: new Date(Number(usdgUpdatedAt) * 1000).toISOString(),
        roundId: usdgRoundId.toString(),
      },
    }
    officialCache = { expires: Date.now() + 12_000, value }
    return value
  }

  async function readPosition(tokenId, owner, custody, metadata) {
    const position = await client.readContract({ address: ROBINHOOD_CONTRACTS.positionManager, abi: slipstreamPositionManagerAbi, functionName: 'positions', args: [tokenId] })
    const [, , token0, token1, tickSpacing, tickLower, tickUpper, liquidity, , , tokensOwed0, tokensOwed1] = position
    if (getAddress(token0) !== ROBINHOOD_CONTRACTS.spcx || getAddress(token1) !== ROBINHOOD_CONTRACTS.usdg || Number(tickSpacing) !== ROBINHOOD_CONTRACTS.tickSpacing) return null
    const earned = custody === 'gauge'
      ? await optional(() => client.readContract({ address: ROBINHOOD_CONTRACTS.gauge, abi: gaugeAbi, functionName: 'earned', args: [owner, tokenId] }), 0n)
      : 0n
    return {
      tokenId: tokenId.toString(),
      custody,
      tickLower: Number(tickLower),
      tickUpper: Number(tickUpper),
      priceLower: tickToPrice(Number(tickLower), metadata[token0.toLowerCase()].decimals, metadata[token1.toLowerCase()].decimals),
      priceUpper: tickToPrice(Number(tickUpper), metadata[token0.toLowerCase()].decimals, metadata[token1.toLowerCase()].decimals),
      liquidity: liquidity.toString(),
      tokensOwed0: tokenAmount(tokensOwed0, metadata[token0.toLowerCase()].decimals),
      tokensOwed1: tokenAmount(tokensOwed1, metadata[token1.toLowerCase()].decimals),
      earnedUp: tokenAmount(earned, metadata[ROBINHOOD_CONTRACTS.up.toLowerCase()].decimals),
    }
  }

  async function loadOwner(owner, metadata) {
    if (!owner || !isAddress(owner)) return null
    const address = getAddress(owner)
    const [nativeBalance, spcxBalance, usdgBalance, upBalance, stakedIds, walletCount] = await Promise.all([
      client.getBalance({ address }),
      client.readContract({ address: ROBINHOOD_CONTRACTS.spcx, abi: tokenAbi, functionName: 'balanceOf', args: [address] }),
      client.readContract({ address: ROBINHOOD_CONTRACTS.usdg, abi: tokenAbi, functionName: 'balanceOf', args: [address] }),
      client.readContract({ address: ROBINHOOD_CONTRACTS.up, abi: tokenAbi, functionName: 'balanceOf', args: [address] }),
      optional(() => client.readContract({ address: ROBINHOOD_CONTRACTS.gauge, abi: gaugeAbi, functionName: 'stakedValues', args: [address] }), []),
      optional(() => client.readContract({ address: ROBINHOOD_CONTRACTS.positionManager, abi: slipstreamPositionManagerAbi, functionName: 'balanceOf', args: [address] }), 0n),
    ])
    const count = Math.min(Number(walletCount), 50)
    const walletIds = await Promise.all(Array.from({ length: count }, (_, index) => client.readContract({
      address: ROBINHOOD_CONTRACTS.positionManager,
      abi: slipstreamPositionManagerAbi,
      functionName: 'tokenOfOwnerByIndex',
      args: [address, BigInt(index)],
    })))
    const positions = (await Promise.all([
      ...stakedIds.map(id => readPosition(id, address, 'gauge', metadata)),
      ...walletIds.map(id => readPosition(id, address, 'wallet', metadata)),
    ])).filter(Boolean)
    return {
      address,
      balances: {
        ETH: tokenAmount(nativeBalance, 18),
        SPCX: tokenAmount(spcxBalance, metadata[ROBINHOOD_CONTRACTS.spcx.toLowerCase()].decimals),
        USDG: tokenAmount(usdgBalance, metadata[ROBINHOOD_CONTRACTS.usdg.toLowerCase()].decimals),
        UP: tokenAmount(upBalance, metadata[ROBINHOOD_CONTRACTS.up.toLowerCase()].decimals),
      },
      positions,
    }
  }

  async function loadSnapshot(owner) {
    const metadataPromise = loadTokenMetadata()
    const officialPromise = optional(loadOfficialSpcx, null)
    const [
      block, token0, token1, tickSpacing, fee, gauge, nft, slot0, liquidity, stakedLiquidity,
      gaugePool, gaugeNft, gaugeToken0, gaugeToken1, gaugeSpacing, rewardToken, rewardRate, periodFinish, rewardsLeft,
      multiplier, tokenPaused, oraclePaused, observations, metadata, official,
    ] = await Promise.all([
      client.getBlock(),
      client.readContract({ address: ROBINHOOD_CONTRACTS.pool, abi: clPoolAbi, functionName: 'token0' }),
      client.readContract({ address: ROBINHOOD_CONTRACTS.pool, abi: clPoolAbi, functionName: 'token1' }),
      client.readContract({ address: ROBINHOOD_CONTRACTS.pool, abi: clPoolAbi, functionName: 'tickSpacing' }),
      client.readContract({ address: ROBINHOOD_CONTRACTS.pool, abi: clPoolAbi, functionName: 'fee' }),
      client.readContract({ address: ROBINHOOD_CONTRACTS.pool, abi: clPoolAbi, functionName: 'gauge' }),
      client.readContract({ address: ROBINHOOD_CONTRACTS.pool, abi: clPoolAbi, functionName: 'nft' }),
      client.readContract({ address: ROBINHOOD_CONTRACTS.pool, abi: clPoolAbi, functionName: 'slot0' }),
      client.readContract({ address: ROBINHOOD_CONTRACTS.pool, abi: clPoolAbi, functionName: 'liquidity' }),
      client.readContract({ address: ROBINHOOD_CONTRACTS.pool, abi: clPoolAbi, functionName: 'stakedLiquidity' }),
      client.readContract({ address: ROBINHOOD_CONTRACTS.gauge, abi: gaugeAbi, functionName: 'pool' }),
      client.readContract({ address: ROBINHOOD_CONTRACTS.gauge, abi: gaugeAbi, functionName: 'nft' }),
      client.readContract({ address: ROBINHOOD_CONTRACTS.gauge, abi: gaugeAbi, functionName: 'token0' }),
      client.readContract({ address: ROBINHOOD_CONTRACTS.gauge, abi: gaugeAbi, functionName: 'token1' }),
      client.readContract({ address: ROBINHOOD_CONTRACTS.gauge, abi: gaugeAbi, functionName: 'tickSpacing' }),
      client.readContract({ address: ROBINHOOD_CONTRACTS.gauge, abi: gaugeAbi, functionName: 'rewardToken' }),
      client.readContract({ address: ROBINHOOD_CONTRACTS.gauge, abi: gaugeAbi, functionName: 'rewardRate' }),
      client.readContract({ address: ROBINHOOD_CONTRACTS.gauge, abi: gaugeAbi, functionName: 'periodFinish' }),
      client.readContract({ address: ROBINHOOD_CONTRACTS.gauge, abi: gaugeAbi, functionName: 'left' }),
      optional(() => client.readContract({ address: ROBINHOOD_CONTRACTS.spcx, abi: stockAbi, functionName: 'uiMultiplier' }), 10n ** 18n),
      optional(() => client.readContract({ address: ROBINHOOD_CONTRACTS.spcx, abi: stockAbi, functionName: 'tokenPaused' }), false),
      optional(() => client.readContract({ address: ROBINHOOD_CONTRACTS.spcx, abi: stockAbi, functionName: 'oraclePaused' }), false),
      optional(() => client.readContract({ address: ROBINHOOD_CONTRACTS.pool, abi: clPoolAbi, functionName: 'observe', args: [[0, 30, 300]] }), null),
      metadataPromise,
      officialPromise,
    ])

    const contractsVerified = [
      getAddress(token0) === ROBINHOOD_CONTRACTS.spcx,
      getAddress(token1) === ROBINHOOD_CONTRACTS.usdg,
      Number(tickSpacing) === ROBINHOOD_CONTRACTS.tickSpacing,
      getAddress(gauge) === ROBINHOOD_CONTRACTS.gauge,
      getAddress(nft) === ROBINHOOD_CONTRACTS.positionManager,
      getAddress(gaugePool) === ROBINHOOD_CONTRACTS.pool,
      getAddress(gaugeNft) === ROBINHOOD_CONTRACTS.positionManager,
      getAddress(gaugeToken0) === ROBINHOOD_CONTRACTS.spcx,
      getAddress(gaugeToken1) === ROBINHOOD_CONTRACTS.usdg,
      Number(gaugeSpacing) === ROBINHOOD_CONTRACTS.tickSpacing,
      getAddress(rewardToken) === ROBINHOOD_CONTRACTS.up,
      official?.deploymentVerified !== false,
      official?.priceFeedsVerified !== false,
    ].every(Boolean)
    if (!contractsVerified) throw new Error('Robinhood SPCX/USDG Pool·Gauge 계약 교차검증에 실패했습니다.')

    const [sqrtPriceX96, tick, , observationCardinality, observationCardinalityNext, unlocked] = slot0
    const token0Meta = metadata[getAddress(token0).toLowerCase()]
    const token1Meta = metadata[getAddress(token1).toLowerCase()]
    const upMeta = metadata[ROBINHOOD_CONTRACTS.up.toLowerCase()]
    const spotPrice = priceFromSqrtPriceX96(sqrtPriceX96, token0Meta.decimals, token1Meta.decimals)
    let twap30Tick = null
    let twap300Tick = null
    if (observations) {
      const [cumulatives] = observations
      if (cumulatives?.length >= 3) {
        twap30Tick = Number(bigintFloorDivide(cumulatives[0] - cumulatives[1], 30n))
        twap300Tick = Number(bigintFloorDivide(cumulatives[0] - cumulatives[2], 300n))
      }
    }
    const multiplierDisplay = Number(formatUnits(multiplier, 18))
    const snapshot = {
      at: Number(block.timestamp) * 1000,
      fetchedAt: Date.now(),
      blockNumber: block.number.toString(),
      chainId: ROBINHOOD_CONTRACTS.chainId,
      contracts: ROBINHOOD_CONTRACTS,
      contractsVerified,
      tick: Number(tick),
      tickSpacing: Number(tickSpacing),
      fee: Number(fee),
      sqrtPriceX96: sqrtPriceX96.toString(),
      spotPrice,
      twap30Tick,
      twap300Tick,
      twap30Price: twap30Tick == null ? null : tickToPrice(twap30Tick, token0Meta.decimals, token1Meta.decimals),
      twap300Price: twap300Tick == null ? null : tickToPrice(twap300Tick, token0Meta.decimals, token1Meta.decimals),
      liquidity: liquidity.toString(),
      stakedLiquidity: stakedLiquidity.toString(),
      poolUnlocked: Boolean(unlocked),
      observationCardinality: Number(observationCardinality),
      observationCardinalityNext: Number(observationCardinalityNext),
      stock: {
        symbol: token0Meta.symbol,
        name: token0Meta.name,
        decimals: token0Meta.decimals,
        uiMultiplier: multiplierDisplay,
        paused: Boolean(tokenPaused),
        oraclePaused: Boolean(oraclePaused),
      },
      quote: { symbol: token1Meta.symbol, name: token1Meta.name, decimals: token1Meta.decimals },
      official,
      gauge: {
        rewardSymbol: upMeta.symbol,
        rewardRate: rewardRate.toString(),
        rewardPerDay: tokenAmount(rewardRate * 86_400n, upMeta.decimals),
        rewardsLeft: tokenAmount(rewardsLeft, upMeta.decimals),
        periodFinish: Number(periodFinish) * 1000,
        active: Number(periodFinish) * 1000 > Date.now() && rewardsLeft > 0n,
      },
    }
    snapshot.owner = await loadOwner(owner, metadata)
    return snapshot
  }

  return { client, loadSnapshot, loadOfficialSpcx, loadMarketPrices, contracts: ROBINHOOD_CONTRACTS }
}
