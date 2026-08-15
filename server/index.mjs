import { createPublicClient, getAddress, http, isAddress, parseAbi, verifyMessage } from 'viem'
import { bsc } from 'viem/chains'
import { randomBytes } from 'node:crypto'
import { createReadStream, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRobinhoodService, ROBINHOOD_CONTRACTS } from './robinhood.mjs'
import { DEFAULT_ROBINHOOD_GUARD_CONFIG, ShadowGuardEngine } from './robinhood-strategy.mjs'
import { loadAutomationConfig, loadVaultArtifact, readVaultStatus, saveAutomationConfig, verifyVaultForConfiguration } from './robinhood-automation.mjs'
import { ensureKeeperIdentity } from './robinhood-keeper-key.mjs'
import { loadRecentKeeperLogs } from './robinhood-log.mjs'
import { loadRobinhoodPerformance } from './robinhood-performance.mjs'

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const indexerSnapshot = join(root, 'services', 'indexer', 'data', 'snapshot.json')
const directoryMarketSnapshot = join(root, 'work', 'pool-directory-market-cache.json')

function loadEnvFile(file) {
  if (!existsSync(file)) return {}
  return Object.fromEntries(readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).filter(line => !line.trim().startsWith('#')).map(line => {
    const index = line.indexOf('=')
    return index < 0 ? [line.trim(), ''] : [line.slice(0, index).trim(), line.slice(index + 1).trim().replace(/^['"]|['"]$/g, '')]
  }))
}

const fileEnv = { ...loadEnvFile(join(root, '.env')), ...loadEnvFile(join(root, '.env.local')) }
const env = key => process.env[key] || fileEnv[key]
const rpcUrl = env('VITE_BSC_RPC_URL') || env('BSC_RPC_URL') || 'https://bsc-dataseed.bnbchain.org'
const configuredPool = env('VITE_POOL_ADDRESS') || env('POOL_ADDRESS')
const poolAddress = configuredPool && isAddress(configuredPool) ? getAddress(configuredPool) : undefined
const client = createPublicClient({ chain: bsc, transport: http(rpcUrl, { timeout: 12_000 }) })
const bridgeMetadataUrl = env('VITE_BRIDGE_METADATA_URL') || 'https://stargate-bridge-params.vercel.app/oft-checker/data/oft-snapshot.json'
const bridgeActivityUrl = env('VITE_BRIDGE_ACTIVITY_URL') || 'https://stargate-bridge-params.vercel.app/oft-checker/data/adapter-activity-index.json'
const stargateApiUrl = (env('STARGATE_API_URL') || 'https://stargate.finance/api/v1').replace(/\/$/, '')
const valueTransferApiUrl = (env('LZ_VALUE_TRANSFER_API_URL') || 'https://transfer.layerzero-api.com/v1').replace(/\/$/, '')
const valueTransferApiKey = env('LZ_VALUE_TRANSFER_API_KEY') || env('STARGATE_API_KEY') || ''
const robinhoodRpcUrl = env('ROBINHOOD_RPC_URL') || env('VITE_ROBINHOOD_RPC_URL') || 'https://rpc.mainnet.chain.robinhood.com'
const robinhoodService = createRobinhoodService({ rpcUrl: robinhoodRpcUrl })
const robinhoodFallbackEngine = new ShadowGuardEngine(DEFAULT_ROBINHOOD_GUARD_CONFIG)
const robinhoodKeeperStateFile = join(root, 'work', 'robinhood-strategy-state.json')
const robinhoodKeeperHistoryFile = join(root, 'work', 'robinhood-strategy-history.ndjson')
const robinhoodTransactionHistoryFile = join(root, 'work', 'robinhood-automation-transactions.ndjson')
const robinhoodReplayFile = join(root, 'work', 'robinhood-replay-24h.json')
const robinhoodContractArtifactFile = join(root, 'contracts', 'build', 'BStockerThreeTickVault.json')
const robinhoodLiveAutomationRequested = env('ROBINHOOD_LIVE_AUTOMATION_ALLOWED') === 'true'
const robinhoodAutomationOwnerCandidate = env('ROBINHOOD_AUTOMATION_OWNER') || ''
const robinhoodAutomationOwner = isAddress(robinhoodAutomationOwnerCandidate) ? getAddress(robinhoodAutomationOwnerCandidate) : null
const robinhoodLiveAutomationAllowed = robinhoodLiveAutomationRequested && Boolean(robinhoodAutomationOwner)
let robinhoodKeeperIdentity = null
let robinhoodKeeperIdentityError = null
try { robinhoodKeeperIdentity = ensureKeeperIdentity() } catch (error) { robinhoodKeeperIdentityError = error instanceof Error ? error.message : String(error) }
const robinhoodAutomationChallenges = new Map()
const bridgeApiMode = (env('BRIDGE_API_MODE') || 'auto').toLowerCase()
const layerZeroMetadataUrl = env('LZ_METADATA_URL') || 'https://metadata.layerzero-api.com/v1/metadata'
const layerZeroScanApiUrl = (env('LZ_SCAN_API_URL') || 'https://scan.layerzero-api.com/v1').replace(/\/$/, '')
const geckoTerminalApiUrl = (env('GECKOTERMINAL_API_URL') || 'https://api.geckoterminal.com/api/v2').replace(/\/$/, '')
const pancakeV3Factory = getAddress(env('PANCAKE_V3_FACTORY_ADDRESS') || '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865')
const pancakeV3PositionManager = getAddress(env('VITE_POSITION_MANAGER_ADDRESS') || env('POSITION_MANAGER_ADDRESS') || '0x46A15B0b27311cedF172AB29E4f4766fbE7F4364')
const pancakeV3MasterChef = getAddress(env('VITE_PANCAKE_V3_MASTER_CHEF_ADDRESS') || '0x556B9306565093C855AEA9AE92A594704c2Cd59e')
const merklApiUrl = (env('MERKL_API_URL') || 'https://api.merkl.xyz').replace(/\/$/, '')
const bscUsdt = getAddress('0x55d398326f99059fF775485246999027B3197955')
const directorySearchPages = Math.max(1, Math.min(5, Number(env('POOL_DIRECTORY_SEARCH_PAGES') || 3)))
const directorySeedPools = [
  ['SPCXB/USDT', 'SpaceX bStock', '0x977DaFFC095b33872E2741c19568925015C35b4d'],
  ['SKHYB/USDT', 'SK Hynix bStock', '0xD7d30F434b12F7Ed9b0Ae11fF1C754745a10aD52'],
  ['MUB/USDT', 'Micron bStock', '0x9E75Ced0a01590890917C5180c3e3ed6a86A071e'],
  ['SPYB/USDT', 'SPY bStock', '0x7aA6d92Fc369A8C1EDc631A3aAc44eFB0808ddbF'],
  ['SPYB/USDT', 'SPY bStock', '0x066B9C1e47303EA27C1e965FC7E3D65546675351'],
  ['QQQB/USDT', 'Nasdaq-100 bStock', '0xe531fcb1F5a195de7608B9F4f9518544C2cdB693'],
  ['QQQB/USDT', 'Nasdaq-100 bStock', '0x7C84F9943Ec82cf2233c97A7Ee417f18bD2eC295'],
  ['TSMB/USDT', 'TSMC bStock', '0x03f59988f5c366046321cccd2bf0e3878e2ed69c'],
  ['SOXLB/USDT', 'Semiconductor ETF bStock', '0x37111af783cb43c469127ca8ca8c20635bb35d3e'],
  ['MSFTB/USDT', 'Microsoft bStock', '0x5018b018ceb7645c927c5cf246786f89ebcbe7ea'],
  ['MSFTB/USDT', 'Microsoft bStock', '0x58e44c2e5b17ef40915b4b3ae8451b6b87285b44'],
  ['GOOGLB/USDT', 'Alphabet bStock', '0x89001d846f7ca36ee089f73eefc25657e1798144'],
  ['METAB/USDT', 'Meta bStock', '0xc2151a561e928d16576d75ea88544543ac63d80b'],
  ['NOKB/USDT', 'Nokia bStock', '0xd76cb6e9f642cdc7c33c9d4fc6bdd858116dcc84'],
  ['GOOGLB/USDT', 'Alphabet bStock', '0xf5a91043817ec002b8892688a25afb281ab06f4b'],
  ['BABAB/USDT', 'Alibaba bStock', '0xfd95cb1391999006eb91797a7c62acfe88b20292'],
  ['HOODB/USDT', 'Robinhood bStock', '0xfeef70ff6f58f0a900e28a77e5a8945afb343923'],
].map(([label, description, address]) => ({ label, description, address: getAddress(address) }))
const referenceChainKeys = new Set([
  'abstract', 'ape', 'apexfusionnexus', 'arbitrum', 'ault', 'aurora', 'avalanche', 'base', 'bera',
  'botanix', 'bsc', 'camp', 'coredao', 'cronosevm', 'degen', 'doma', 'edu', 'ethereum', 'flare',
  'flow', 'fuse', 'gatelayer', 'gensyn', 'glue', 'gnosis', 'goat', 'gravity', 'hedera', 'hemi',
  'horizen', 'injectiveevm', 'ink', 'iota', 'islander', 'kava', 'klaytn', 'lightlink', 'manta',
  'mantle', 'metis', 'moca', 'nibiru', 'og', 'optimism', 'orderly', 'peaq', 'plasma',
  'plumephoenix', 'polygon', 'rarible', 'redbelly', 'rootstock', 'scroll', 'sei', 'somnia',
  'soneium', 'sonic', 'sophon', 'stable', 'story', 'subtensorevm', 'superposition', 'swell',
  'taiko', 'telos', 'tempo', 'unichain', 'xdc',
])
const referenceChainNames = {
  abstract: 'Abstract', ape: 'ApeChain', apexfusionnexus: 'Apex Fusion', arbitrum: 'Arbitrum', ault: 'AULT',
  aurora: 'Aurora', avalanche: 'Avalanche', base: 'Base', bera: 'Berachain', botanix: 'Botanix', bsc: 'BSC',
  camp: 'Camp', coredao: 'CoreDAO', cronosevm: 'Cronos EVM', degen: 'Degen', doma: 'Doma', edu: 'EDU',
  ethereum: 'Ethereum', flare: 'Flare', flow: 'Flow', fuse: 'Fuse', gatelayer: 'GateLayer', gensyn: 'Gensyn',
  glue: 'Glue', gnosis: 'Gnosis', goat: 'Goat', gravity: 'Gravity', hedera: 'Hedera', hemi: 'Hemi',
  horizen: 'Horizen', injectiveevm: 'Injective EVM', ink: 'Ink', iota: 'IOTA EVM', islander: 'Islander',
  kava: 'Kava', klaytn: 'Klaytn', lightlink: 'Lightlink', manta: 'Manta', mantle: 'Mantle', metis: 'Metis',
  moca: 'Moca', nibiru: 'Nibiru', og: '0G', optimism: 'Optimism', orderly: 'Orderly', peaq: 'Peaq',
  plasma: 'Plasma', plumephoenix: 'Plume', polygon: 'Polygon', rarible: 'Rarible', redbelly: 'Redbelly',
  rootstock: 'Rootstock', scroll: 'Scroll', sei: 'Sei', somnia: 'Somnia', soneium: 'Soneium', sonic: 'Sonic',
  sophon: 'Sophon', stable: 'Stable', story: 'Story', subtensorevm: 'Bittensor EVM',
  superposition: 'Superposition', swell: 'Swell', taiko: 'Taiko', telos: 'Telos', tempo: 'Tempo',
  unichain: 'Unichain', xdc: 'XDC',
}
const referenceChainShortNames = { bsc: 'BSC', ethereum: 'ETH', arbitrum: 'ARB', avalanche: 'AVAX', base: 'BASE', polygon: 'POL', optimism: 'OP' }

const poolAbi = parseAbi([
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function fee() view returns (uint24)',
  'function tickSpacing() view returns (int24)',
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
  'function liquidity() view returns (uint128)',
  'function tickBitmap(int16 wordPosition) view returns (uint256)',
  'function ticks(int24 tick) view returns (uint128 liquidityGross, int128 liquidityNet, uint256 feeGrowthOutside0X128, uint256 feeGrowthOutside1X128, int56 tickCumulativeOutside, uint160 secondsPerLiquidityOutsideX128, uint32 secondsOutside, bool initialized)',
])
const pancakeV3FactoryAbi = parseAbi([
  'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)',
])
const positionManagerAbi = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
  'function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
  'function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max) params) payable returns (uint256 amount0, uint256 amount1)',
])
const pancakeV3MasterChefAbi = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
  'function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max) params) returns (uint256 amount0, uint256 amount1)',
])
const erc20Abi = parseAbi([
  'function symbol() view returns (string)',
  'function name() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
  'function uiMultiplier() view returns (uint256)',
])

const cache = new Map()
const TTL = 12_000
const bridgeMetadataCache = { expires: 0, value: null }
const bridgeChainCache = { expires: 0, value: null }
const poolDirectoryCache = { expires: 0, value: null, pending: null, lastForcedAt: 0 }
const walletPositionCache = new Map()

function json(response, status, value) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  })
  response.end(JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item))
}

function demoSummary(pool) {
  return {
    address: pool || '0x0000000000000000000000000000000000000001',
    mode: 'demo',
    lastUpdated: Date.now(),
    sourceBlock: null,
    notice: 'Pool address is not configured; browser remains in demo mode.',
  }
}

async function liveSummary(pool) {
  if (!pool) return demoSummary(pool)
  const key = `summary:${pool}`
  const cached = cache.get(key)
  if (cached && cached.expires > Date.now()) return cached.value
  const [token0Address, token1Address, fee, tickSpacing, slot0, liquidity, block] = await Promise.all([
    client.readContract({ address: pool, abi: poolAbi, functionName: 'token0' }),
    client.readContract({ address: pool, abi: poolAbi, functionName: 'token1' }),
    client.readContract({ address: pool, abi: poolAbi, functionName: 'fee' }),
    client.readContract({ address: pool, abi: poolAbi, functionName: 'tickSpacing' }),
    client.readContract({ address: pool, abi: poolAbi, functionName: 'slot0' }),
    client.readContract({ address: pool, abi: poolAbi, functionName: 'liquidity' }),
    client.getBlockNumber(),
  ])
  const [meta0, meta1, balance0, balance1, market] = await Promise.all([
    readToken(token0Address, pool),
    readToken(token1Address, pool),
    client.readContract({ address: token0Address, abi: erc20Abi, functionName: 'balanceOf', args: [pool] }),
    client.readContract({ address: token1Address, abi: erc20Abi, functionName: 'balanceOf', args: [pool] }),
    marketForSummary(pool).catch(() => undefined),
  ])
  const slot = slot0
  const sqrt = Number(slot[0]) / 2 ** 96
  const rawPrice = sqrt * sqrt
  const token0IsQuote = /USDT|USDC|USD|BUSD|FDUSD/i.test(meta0.symbol)
  const token1PerToken0 = rawPrice * 10 ** (meta0.decimals - meta1.decimals)
  const displayPrice = token0IsQuote ? 1 / token1PerToken0 : token1PerToken0
  const amount0 = tokenUiAmount(balance0, meta0)
  const amount1 = tokenUiAmount(balance1, meta1)
  const onchainTvlUsd = token0IsQuote ? amount0 + amount1 * displayPrice : amount1 + amount0 * displayPrice
  const marketTvlUsd = finiteMetric(market?.tvlUsd, 10_000_000_000)
  const volume24hUsd = finiteMetric(market?.volume24hUsd, 100_000_000_000)
  const tvlUsd = marketTvlUsd ?? onchainTvlUsd
  const fees24hUsd = volume24hUsd == null ? 0 : volume24hUsd * Number(fee) / 1_000_000
  const feeApr = tvlUsd > 0 && volume24hUsd != null ? fees24hUsd * 365 / tvlUsd * 100 : 0
  const value = {
    address: pool,
    mode: 'live',
    token0: meta0,
    token1: meta1,
    displayPrice,
    rawPrice,
    tick: Number(slot[1]),
    tickSpacing: Number(tickSpacing),
    feeTier: Number(fee),
    feeTierLabel: `${(Number(fee) / 10000).toFixed(2)}%`,
    tvlUsd,
    fees24hUsd,
    volume24hUsd: volume24hUsd ?? 0,
    feeApr: finiteMetric(feeApr, 100_000) ?? 0,
    activeLiquidity: Number(liquidity),
    lastUpdated: Date.now(),
    sourceBlock: block,
    underlyingStatus: 'unavailable',
    marketStatus: marketTvlUsd == null || volume24hUsd == null ? 'stale' : 'fresh',
    marketUpdatedAt: market ? Date.now() : null,
  }
  cache.set(key, { expires: Date.now() + TTL, value })
  return value
}

async function readToken(address, pool) {
  const [symbol, name, decimals, uiMultiplier] = await Promise.all([
    client.readContract({ address, abi: erc20Abi, functionName: 'symbol' }).catch(() => 'TOKEN'),
    client.readContract({ address, abi: erc20Abi, functionName: 'name' }).catch(() => 'Token'),
    client.readContract({ address, abi: erc20Abi, functionName: 'decimals' }).catch(() => 18),
    client.readContract({ address, abi: erc20Abi, functionName: 'uiMultiplier' }).catch(() => 10n ** 18n),
  ])
  return { address, symbol, name, decimals: Number(decimals), uiMultiplier, poolAddress: pool }
}

function tokenUiAmount(raw, token) {
  return Number(raw) / 10 ** token.decimals * Number(token.uiMultiplier) / 1e18
}

function finiteMetric(value, maximum = Number.POSITIVE_INFINITY) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 && number <= maximum ? number : null
}

function addressFromResourceId(id) {
  const value = String(id || '').split('_').at(-1)
  return value && isAddress(value) ? getAddress(value) : undefined
}

function geckoIncludedTokens(payload) {
  return new Map((Array.isArray(payload?.included) ? payload.included : [])
    .filter(item => item?.type === 'token')
    .map(item => [item.id, item.attributes || {}]))
}

function normalizeGeckoPool(item, tokens) {
  const address = item?.attributes?.address
  const baseId = item?.relationships?.base_token?.data?.id
  const quoteId = item?.relationships?.quote_token?.data?.id
  const baseAddress = addressFromResourceId(baseId)
  const quoteAddress = addressFromResourceId(quoteId)
  if (!isAddress(address) || !baseAddress || !quoteAddress) return undefined
  const base = tokens.get(baseId) || {}
  const quote = tokens.get(quoteId) || {}
  const attributes = item.attributes || {}
  const parsedFee = finiteMetric(attributes.pool_fee_percentage, 100)
  const namedFee = String(attributes.name || '').match(/([0-9]+(?:\.[0-9]+)?)%\s*$/)
  return {
    address: getAddress(address),
    dexId: String(item?.relationships?.dex?.data?.id || ''),
    baseAddress,
    quoteAddress,
    baseSymbol: String(base.symbol || '').toUpperCase(),
    baseName: String(base.name || ''),
    baseLogoUrl: typeof base.image_url === 'string' ? base.image_url : undefined,
    quoteSymbol: String(quote.symbol || '').toUpperCase(),
    quoteName: String(quote.name || ''),
    quoteLogoUrl: typeof quote.image_url === 'string' ? quote.image_url : undefined,
    feePercent: parsedFee ?? finiteMetric(namedFee?.[1], 100),
    tvlUsd: finiteMetric(attributes.reserve_in_usd, 10_000_000_000),
    volume24hUsd: finiteMetric(attributes.volume_usd?.h24, 100_000_000_000),
    basePriceUsd: finiteMetric(attributes.base_token_price_usd, 1_000_000_000),
    quotePriceUsd: finiteMetric(attributes.quote_token_price_usd, 1_000_000_000),
    priceChange24h: finiteMetric(Math.abs(Number(attributes.price_change_percentage?.h24)), 10_000) == null
      ? null
      : Number(attributes.price_change_percentage.h24),
    poolCreatedAt: attributes.pool_created_at ? Date.parse(attributes.pool_created_at) : null,
    marketName: String(attributes.name || ''),
  }
}

async function fetchGeckoPools(addresses) {
  if (!addresses.length) return []
  const lowered = addresses.map(address => address.toLowerCase()).join(',')
  const payload = await upstreamJson(`${geckoTerminalApiUrl}/networks/bsc/pools/multi/${lowered}?include=base_token,quote_token,dex`)
  const tokens = geckoIncludedTokens(payload)
  return (Array.isArray(payload?.data) ? payload.data : []).map(item => normalizeGeckoPool(item, tokens)).filter(Boolean)
}

async function fetchPoolMarket(pool) {
  const key = `market:${pool.toLowerCase()}`
  const cached = cache.get(key)
  if (cached && cached.expires > Date.now()) return cached.value
  const value = (await fetchGeckoPools([pool]))[0]
  cache.set(key, { expires: Date.now() + 60_000, value })
  return value
}

async function marketForSummary(pool) {
  if (!poolDirectoryCache.value && poolDirectoryCache.pending) await poolDirectoryCache.pending.catch(() => undefined)
  const directoryEntry = poolDirectoryCache.value?.items?.find(item => item.address.toLowerCase() === pool.toLowerCase())
  if (directoryEntry) {
    return {
      tvlUsd: directoryEntry.tvlUsd,
      volume24hUsd: directoryEntry.volume24hUsd,
      priceChange24h: directoryEntry.priceChange24h,
    }
  }
  return fetchPoolMarket(pool)
}

async function fetchGeckoBStockSearch() {
  const values = []
  const warnings = []
  for (let page = 1; page <= directorySearchPages; page += 1) {
    try {
      const payload = await upstreamJson(`${geckoTerminalApiUrl}/search/pools?query=bStock&network=bsc&page=${page}&include=base_token,quote_token,dex`)
      const tokens = geckoIncludedTokens(payload)
      values.push(...(Array.isArray(payload?.data) ? payload.data : []).map(item => normalizeGeckoPool(item, tokens)).filter(Boolean))
      if (!payload?.data?.length) break
      if (page < directorySearchPages) await new Promise(resolve => setTimeout(resolve, 280))
    } catch (error) {
      warnings.push(`시장 검색 ${page}페이지: ${error instanceof Error ? error.message : '조회 실패'}`)
      break
    }
  }
  return { values, warnings }
}

async function mapWithConcurrency(values, concurrency, mapper) {
  const results = new Array(values.length)
  let cursor = 0
  async function worker() {
    while (cursor < values.length) {
      const index = cursor
      cursor += 1
      try { results[index] = await mapper(values[index], index) } catch { results[index] = undefined }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()))
  return results
}

async function verifyDirectoryPool(candidate) {
  const pool = candidate.address
  const [token0Address, token1Address, fee, tickSpacing, slot0, activeLiquidity] = await Promise.all([
    client.readContract({ address: pool, abi: poolAbi, functionName: 'token0' }),
    client.readContract({ address: pool, abi: poolAbi, functionName: 'token1' }),
    client.readContract({ address: pool, abi: poolAbi, functionName: 'fee' }),
    client.readContract({ address: pool, abi: poolAbi, functionName: 'tickSpacing' }),
    client.readContract({ address: pool, abi: poolAbi, functionName: 'slot0' }),
    client.readContract({ address: pool, abi: poolAbi, functionName: 'liquidity' }),
  ])
  const token0 = getAddress(token0Address)
  const token1 = getAddress(token1Address)
  const feeTier = Number(fee)
  const quoteIs0 = token0.toLowerCase() === bscUsdt.toLowerCase()
  const quoteIs1 = token1.toLowerCase() === bscUsdt.toLowerCase()
  if (quoteIs0 === quoteIs1) return undefined
  const factoryPool = await client.readContract({
    address: pancakeV3Factory,
    abi: pancakeV3FactoryAbi,
    functionName: 'getPool',
    args: [token0, token1, feeTier],
  })
  if (String(factoryPool).toLowerCase() !== pool.toLowerCase()) return undefined
  const [meta0, meta1, balance0, balance1] = await Promise.all([
    readToken(token0, pool),
    readToken(token1, pool),
    client.readContract({ address: token0, abi: erc20Abi, functionName: 'balanceOf', args: [pool] }),
    client.readContract({ address: token1, abi: erc20Abi, functionName: 'balanceOf', args: [pool] }),
  ])
  const stock = quoteIs0 ? meta1 : meta0
  const quote = quoteIs0 ? meta0 : meta1
  if (!/B$/i.test(stock.symbol)) return undefined
  const seeded = candidate.source === 'seed'
  const volume24hUsd = finiteMetric(candidate.volume24hUsd, 100_000_000_000)
  const currentPrice = displayPriceAtTick(Number(slot0[1]), meta0, meta1, quoteIs0)
  const amount0 = tokenUiAmount(balance0, meta0)
  const amount1 = tokenUiAmount(balance1, meta1)
  const onchainTvlUsd = quoteIs0 ? amount0 + amount1 * currentPrice : amount1 + amount0 * currentPrice
  const marketTvlUsd = finiteMetric(candidate.tvlUsd, 10_000_000_000)
  const tvlUsd = marketTvlUsd ?? finiteMetric(onchainTvlUsd, 10_000_000_000)
  const fees24hUsd = volume24hUsd == null ? null : volume24hUsd * feeTier / 1_000_000
  const feeApr = fees24hUsd == null || tvlUsd == null || tvlUsd <= 0 ? null : fees24hUsd * 365 / tvlUsd * 100
  const stockIsBase = candidate.baseAddress?.toLowerCase() === stock.address.toLowerCase()
  const priceUsd = candidate.priceUsd ?? (stockIsBase ? candidate.basePriceUsd : candidate.quotePriceUsd) ?? currentPrice
  const logoUrl = candidate.logoUrl ?? (stockIsBase ? candidate.baseLogoUrl : candidate.quoteLogoUrl)
  return {
    id: `${pool.toLowerCase()}-${feeTier}`,
    address: pool,
    dexId: 'pancakeswap-v3-bsc',
    dexLabel: 'Pancake V3',
    label: `${stock.symbol}/USDT`,
    description: seeded ? candidate.description : `${stock.name.replace(/\s*\(bStocks? Tokenized Stock\)\s*/i, '').trim()} bStock`,
    token0Address: token0,
    token1Address: token1,
    token0Symbol: meta0.symbol,
    token1Symbol: meta1.symbol,
    token0Decimals: meta0.decimals,
    token1Decimals: meta1.decimals,
    stockAddress: stock.address,
    stockSymbol: stock.symbol,
    stockName: stock.name,
    quoteAddress: quote.address,
    quoteSymbol: quote.symbol,
    logoUrl,
    feeTier,
    feeTierLabel: `${(feeTier / 10000).toFixed(feeTier % 10000 === 0 ? 0 : 2)}%`,
    tickSpacing: Number(tickSpacing),
    tvlUsd,
    volume24hUsd,
    fees24hUsd,
    feeApr: finiteMetric(feeApr, 100_000),
    priceUsd: finiteMetric(priceUsd, 1_000_000_000),
    priceChange24h: candidate.priceChange24h ?? null,
    activeLiquidity: String(activeLiquidity),
    currentTick: Number(slot0[1]),
    poolCreatedAt: candidate.poolCreatedAt || null,
    verified: true,
    marketStatus: candidate.marketStale ? 'stale' : marketTvlUsd != null && volume24hUsd != null ? 'fresh' : 'stale',
    warnings: feeApr != null && feeApr > 500 ? ['HIGH_TURNOVER_APR'] : [],
    source: candidate.marketName ? 'geckoterminal+onchain' : 'onchain',
    lastUpdated: Date.now(),
  }
}

function loadDirectoryMarketSnapshot() {
  if (!existsSync(directoryMarketSnapshot)) return new Map()
  try {
    const snapshot = JSON.parse(readFileSync(directoryMarketSnapshot, 'utf8'))
    return new Map((Array.isArray(snapshot?.items) ? snapshot.items : []).map(item => [String(item.address).toLowerCase(), item]))
  } catch {
    return new Map()
  }
}

function saveDirectoryMarketSnapshot(directory) {
  try {
    const previous = loadDirectoryMarketSnapshot()
    const items = directory.items.map(item => ({
      address: item.address,
      tvlUsd: item.tvlUsd ?? previous.get(item.address.toLowerCase())?.tvlUsd ?? null,
      volume24hUsd: item.volume24hUsd ?? previous.get(item.address.toLowerCase())?.volume24hUsd ?? null,
      priceChange24h: item.priceChange24h ?? previous.get(item.address.toLowerCase())?.priceChange24h ?? null,
      priceUsd: item.priceUsd ?? previous.get(item.address.toLowerCase())?.priceUsd ?? null,
      logoUrl: item.logoUrl ?? previous.get(item.address.toLowerCase())?.logoUrl ?? null,
      savedAt: Date.now(),
    }))
    writeFileSync(directoryMarketSnapshot, JSON.stringify({ savedAt: Date.now(), items }, null, 2), 'utf8')
  } catch {
    // Runtime cache persistence is optional; onchain TVL remains available.
  }
}

async function buildPoolDirectory() {
  const warnings = []
  const previousMarket = loadDirectoryMarketSnapshot()
  let seedMarkets = []
  try { seedMarkets = await fetchGeckoPools(directorySeedPools.map(pool => pool.address)) } catch (error) {
    warnings.push(`기본 풀 시장 통계: ${error instanceof Error ? error.message : '조회 실패'}`)
  }
  const marketByAddress = new Map(seedMarkets.map(item => [item.address.toLowerCase(), item]))
  const candidates = directorySeedPools.map(seed => {
    const previous = previousMarket.get(seed.address.toLowerCase())
    const current = marketByAddress.get(seed.address.toLowerCase())
    return {
      ...(previous ? {
        tvlUsd: previous.tvlUsd,
        volume24hUsd: previous.volume24hUsd,
        priceChange24h: previous.priceChange24h,
        priceUsd: previous.priceUsd,
        logoUrl: previous.logoUrl,
        marketStale: true,
      } : {}),
      ...current,
      ...seed,
      marketStale: !current && Boolean(previous),
      source: 'seed',
    }
  })
  const search = await fetchGeckoBStockSearch()
  warnings.push(...search.warnings)
  for (const market of search.values) {
    const isPancakeV3 = market.dexId === 'pancakeswap-v3-bsc'
    const hasUsdt = market.baseAddress.toLowerCase() === bscUsdt.toLowerCase() || market.quoteAddress.toLowerCase() === bscUsdt.toLowerCase()
    const stockName = market.baseAddress.toLowerCase() === bscUsdt.toLowerCase() ? market.quoteName : market.baseName
    if (!isPancakeV3 || !hasUsdt || !/\bbstocks?\s+tokenized\s+stock\b/i.test(stockName)) continue
    const index = candidates.findIndex(item => item.address.toLowerCase() === market.address.toLowerCase())
    if (index >= 0) candidates[index] = { ...candidates[index], ...market, source: candidates[index].source }
    else candidates.push({ ...market, source: 'search' })
  }
  const verified = (await mapWithConcurrency(candidates, 4, verifyDirectoryPool)).filter(Boolean)
  verified.sort((a, b) => (b.tvlUsd ?? -1) - (a.tvlUsd ?? -1) || a.label.localeCompare(b.label))
  const directory = {
    items: verified,
    total: verified.length,
    discovered: candidates.length,
    rejected: candidates.length - verified.length,
    source: 'PancakeSwap V3 Factory + GeckoTerminal',
    partial: warnings.length > 0,
    warnings,
    fetchedAt: Date.now(),
    cacheTtlMs: 5 * 60_000,
  }
  saveDirectoryMarketSnapshot(directory)
  return directory
}

async function fetchPoolDirectory(force = false) {
  if (force && Date.now() - poolDirectoryCache.lastForcedAt < 30_000) force = false
  if (force) poolDirectoryCache.lastForcedAt = Date.now()
  if (!force && poolDirectoryCache.value && poolDirectoryCache.expires > Date.now()) return poolDirectoryCache.value
  if (poolDirectoryCache.pending) return poolDirectoryCache.pending
  poolDirectoryCache.pending = buildPoolDirectory().then(value => {
    poolDirectoryCache.value = value
    poolDirectoryCache.expires = Date.now() + 5 * 60_000
    return value
  }).catch(error => {
    if (poolDirectoryCache.value) return {
      ...poolDirectoryCache.value,
      partial: true,
      warnings: [...poolDirectoryCache.value.warnings, `갱신 실패: ${error instanceof Error ? error.message : '알 수 없는 오류'}`],
    }
    throw error
  }).finally(() => { poolDirectoryCache.pending = null })
  return poolDirectoryCache.pending
}

const candleIntervals = {
  '5m': { timeframe: 'minute', aggregate: 5 },
  '15m': { timeframe: 'minute', aggregate: 15 },
  '1h': { timeframe: 'hour', aggregate: 1 },
  '4h': { timeframe: 'hour', aggregate: 4 },
  '1d': { timeframe: 'day', aggregate: 1 },
  '1w': { timeframe: 'day', aggregate: 1, rollupDays: 7 },
}

function floorDiv(value, divisor) {
  return Math.floor(value / divisor)
}

function displayPriceAtTick(tick, token0, token1, token0IsQuote) {
  const poolPrice = Math.pow(1.0001, tick) * 10 ** (token0.decimals - token1.decimals)
  const uiPrice = poolPrice * Number(token1.uiMultiplier) / Number(token0.uiMultiplier)
  return token0IsQuote ? 1 / uiPrice : uiPrice
}

function displayPriceToTick(price, token0, token1, token0IsQuote) {
  if (!Number.isFinite(price) || price <= 0) return 0
  const uiPrice = token0IsQuote ? 1 / price : price
  const poolPrice = uiPrice * Number(token0.uiMultiplier) / Number(token1.uiMultiplier)
  const rawPrice = poolPrice / 10 ** (token0.decimals - token1.decimals)
  return Math.floor(Math.log(rawPrice) / Math.log(1.0001))
}

async function fetchPoolCandles(pool, interval = '1d') {
  const selected = candleIntervals[interval] || candleIntervals['1d']
  const key = `candles:${pool}:${interval}`
  const cached = cache.get(key)
  if (cached && cached.expires > Date.now()) return cached.value
  const params = new URLSearchParams({
    aggregate: String(selected.aggregate),
    limit: '96',
    currency: 'usd',
  })
  let response
  try {
    response = await upstreamJson(`${geckoTerminalApiUrl}/networks/bsc/pools/${pool}/ohlcv/${selected.timeframe}?${params}`)
  } catch (error) {
    if (cached?.value?.length) return cached.value
    throw error
  }
  const rows = response?.data?.attributes?.ohlcv_list
  if (!Array.isArray(rows)) throw new Error('실제 풀 OHLCV 응답 형식이 올바르지 않습니다.')
  const ordered = rows
    .flatMap(row => {
      if (!Array.isArray(row) || row.length < 6) return []
      const [time, open, high, low, close, volume] = row.map(Number)
      if (![time, open, high, low, close, volume].every(Number.isFinite)) return []
      return [{ time: time * 1000, open, high, low, close, volume }]
    })
    .sort((a, b) => a.time - b.time)
  const value = selected.rollupDays
    ? Array.from(ordered.reduce((groups, candle) => {
      const bucket = Math.floor(candle.time / (selected.rollupDays * 86_400_000))
      const existing = groups.get(bucket)
      if (!existing) groups.set(bucket, { ...candle })
      else {
        existing.high = Math.max(existing.high, candle.high)
        existing.low = Math.min(existing.low, candle.low)
        existing.close = candle.close
        existing.volume += candle.volume
      }
      return groups
    }, new Map()).values())
    : ordered
  cache.set(key, { expires: Date.now() + 60_000, value })
  return value
}

async function fetchPoolLiquidity(pool) {
  const key = `liquidity:${pool}`
  const cached = cache.get(key)
  if (cached && cached.expires > Date.now()) return cached.value
  const [token0Address, token1Address, spacingRaw, slot0, activeLiquidity] = await Promise.all([
    client.readContract({ address: pool, abi: poolAbi, functionName: 'token0' }),
    client.readContract({ address: pool, abi: poolAbi, functionName: 'token1' }),
    client.readContract({ address: pool, abi: poolAbi, functionName: 'tickSpacing' }),
    client.readContract({ address: pool, abi: poolAbi, functionName: 'slot0' }),
    client.readContract({ address: pool, abi: poolAbi, functionName: 'liquidity' }),
  ])
  const [token0, token1] = await Promise.all([readToken(token0Address, pool), readToken(token1Address, pool)])
  const currentTick = Number(slot0[1])
  const spacing = Math.max(1, Math.abs(Number(spacingRaw)))
  const token0IsQuote = /USDT|USDC|USD|BUSD|FDUSD/i.test(token0.symbol)
  const currentPrice = displayPriceAtTick(currentTick, token0, token1, token0IsQuote)
  const priceFactor = 2.05
  const minPrice = currentPrice / priceFactor
  const maxPrice = currentPrice * priceFactor
  const edgeTicks = [
    displayPriceToTick(minPrice, token0, token1, token0IsQuote),
    displayPriceToTick(maxPrice, token0, token1, token0IsQuote),
  ]
  const minTick = Math.min(...edgeTicks)
  const maxTick = Math.max(...edgeTicks)
  const minWord = floorDiv(floorDiv(minTick, spacing), 256)
  const maxWord = floorDiv(floorDiv(maxTick, spacing), 256)
  if (maxWord - minWord > 96) throw new Error('요청한 tick 범위가 너무 넓습니다.')
  const wordPositions = Array.from({ length: maxWord - minWord + 1 }, (_, index) => minWord + index)
  const bitmaps = await client.multicall({
    allowFailure: true,
    contracts: wordPositions.map(wordPosition => ({
      address: pool,
      abi: poolAbi,
      functionName: 'tickBitmap',
      args: [wordPosition],
    })),
  })
  const initializedTicks = []
  bitmaps.forEach((result, wordIndex) => {
    if (result.status !== 'success') return
    const bitmap = BigInt(result.result)
    if (bitmap === 0n) return
    for (let bit = 0; bit < 256; bit += 1) {
      if (((bitmap >> BigInt(bit)) & 1n) === 0n) continue
      const tick = (wordPositions[wordIndex] * 256 + bit) * spacing
      if (tick >= minTick && tick <= maxTick) initializedTicks.push(tick)
    }
  })
  const tickStates = initializedTicks.length
    ? await client.multicall({
      allowFailure: true,
      contracts: initializedTicks.map(tick => ({ address: pool, abi: poolAbi, functionName: 'ticks', args: [tick] })),
    })
    : []
  const liquidityNet = initializedTicks.flatMap((tick, index) => {
    const result = tickStates[index]
    return result?.status === 'success' ? [{ tick, net: BigInt(result.result[1]) }] : []
  }).sort((a, b) => a.tick - b.tick)
  const liquidityAtTick = targetTick => {
    let value = BigInt(activeLiquidity)
    if (targetTick > currentTick) {
      for (const state of liquidityNet) if (state.tick > currentTick && state.tick <= targetTick) value += state.net
    } else if (targetTick < currentTick) {
      for (const state of liquidityNet) if (state.tick <= currentTick && state.tick > targetTick) value -= state.net
    }
    return value > 0n ? value : 0n
  }
  const binCount = 72
  const logMin = Math.log(minPrice)
  const logMax = Math.log(maxPrice)
  const value = Array.from({ length: binCount }, (_, index) => {
    const low = Math.exp(logMin + (logMax - logMin) * index / binCount)
    const high = Math.exp(logMin + (logMax - logMin) * (index + 1) / binCount)
    const midpoint = Math.sqrt(low * high)
    const tick = displayPriceToTick(midpoint, token0, token1, token0IsQuote)
    return {
      low,
      high,
      value: Number(liquidityAtTick(tick)),
      side: midpoint < currentPrice ? 'below' : midpoint > currentPrice ? 'above' : 'active',
    }
  })
  cache.set(key, { expires: Date.now() + 30_000, value })
  return value
}

function rawToDisplayAmount(raw, token) {
  return Number(raw) / 10 ** token.decimals * Number(token.uiMultiplier) / 1e18
}

function positionRawAmounts(liquidity, currentTick, tickLower, tickUpper) {
  const amount = Number(liquidity)
  if (!Number.isFinite(amount) || amount <= 0) return { amount0: 0, amount1: 0 }
  const lower = Math.pow(1.0001, tickLower / 2)
  const upper = Math.pow(1.0001, tickUpper / 2)
  const current = Math.pow(1.0001, currentTick / 2)
  if (![lower, upper, current].every(Number.isFinite) || lower <= 0 || upper <= lower) return { amount0: 0, amount1: 0 }
  if (currentTick <= tickLower) return { amount0: amount * (upper - lower) / (lower * upper), amount1: 0 }
  if (currentTick >= tickUpper) return { amount0: 0, amount1: amount * (upper - lower) }
  return {
    amount0: amount * (upper - current) / (current * upper),
    amount1: amount * (current - lower),
  }
}

async function mapWalletPosition(owner, tokenId, position, custody = 'wallet') {
  const token0Address = getAddress(position[2])
  const token1Address = getAddress(position[3])
  const fee = Number(position[4])
  const tickLower = Number(position[5])
  const tickUpper = Number(position[6])
  const liquidity = BigInt(position[7])
  const hasUsdt = token0Address.toLowerCase() === bscUsdt.toLowerCase() || token1Address.toLowerCase() === bscUsdt.toLowerCase()
  if (!hasUsdt) return undefined
  const pool = getAddress(await client.readContract({
    address: pancakeV3Factory,
    abi: pancakeV3FactoryAbi,
    functionName: 'getPool',
    args: [token0Address, token1Address, fee],
  }))
  if (/^0x0{40}$/i.test(pool)) return undefined
  const [token0, token1, summary] = await Promise.all([
    readToken(token0Address, pool),
    readToken(token1Address, pool),
    liveSummary(pool),
  ])
  const stock = token0Address.toLowerCase() === bscUsdt.toLowerCase() ? token1 : token0
  if (!/B$/i.test(stock.symbol)) return undefined
  const currentTick = Number(summary.tick)
  const token0IsQuote = token0Address.toLowerCase() === bscUsdt.toLowerCase()
  const bounds = [
    displayPriceAtTick(tickLower, token0, token1, token0IsQuote),
    displayPriceAtTick(tickUpper, token0, token1, token0IsQuote),
  ].sort((a, b) => a - b)
  const rawAmounts = positionRawAmounts(liquidity, currentTick, tickLower, tickUpper)
  const amount0 = rawToDisplayAmount(rawAmounts.amount0, token0)
  const amount1 = rawToDisplayAmount(rawAmounts.amount1, token1)
  const collectable = await client.simulateContract({
    account: owner,
    address: custody === 'pancake-farm' ? pancakeV3MasterChef : pancakeV3PositionManager,
    abi: custody === 'pancake-farm' ? pancakeV3MasterChefAbi : positionManagerAbi,
    functionName: 'collect',
    args: [{ tokenId, recipient: owner, amount0Max: 2n ** 128n - 1n, amount1Max: 2n ** 128n - 1n }],
  }).then(result => result.result).catch(() => [BigInt(position[10]), BigInt(position[11])])
  const fees0 = rawToDisplayAmount(BigInt(collectable[0]), token0)
  const fees1 = rawToDisplayAmount(BigInt(collectable[1]), token1)
  const amount0Usd = token0IsQuote ? amount0 : amount0 * summary.displayPrice
  const amount1Usd = token0IsQuote ? amount1 * summary.displayPrice : amount1
  const feesUsd = token0IsQuote ? fees0 + fees1 * summary.displayPrice : fees0 * summary.displayPrice + fees1
  const status = summary.displayPrice < bounds[0]
    ? 'BELOW RANGE'
    : summary.displayPrice > bounds[1]
      ? 'ABOVE RANGE'
      : 'IN RANGE'
  return {
    tokenId,
    poolAddress: pool,
    owner,
    pair: `${stock.symbol}/USDT`,
    token0Symbol: token0.symbol,
    token1Symbol: token1.symbol,
    minPrice: bounds[0],
    maxPrice: bounds[1],
    tickLower,
    tickUpper,
    status,
    liquidity,
    amount0,
    amount1,
    amount0Usd,
    amount1Usd,
    fees0,
    fees1,
    feesUsd,
    feeApr: Number(summary.feeApr || 0),
    createdAt: 0,
    custody,
    farmStaked: custody === 'pancake-farm',
  }
}

async function ownedTokenIds(contract, abi, owner) {
  const balance = Number(await client.readContract({ address: contract, abi, functionName: 'balanceOf', args: [owner] }))
  if (!Number.isFinite(balance) || balance <= 0) return []
  const count = Math.min(balance, 200)
  const results = await client.multicall({
    allowFailure: true,
    contracts: Array.from({ length: count }, (_, index) => ({
      address: contract,
      abi,
      functionName: 'tokenOfOwnerByIndex',
      args: [owner, BigInt(index)],
    })),
  })
  return results.flatMap(result => result.status === 'success' ? [BigInt(result.result)] : [])
}

async function fetchWalletPositions(owner) {
  const key = owner.toLowerCase()
  const cached = walletPositionCache.get(key)
  if (cached && cached.expires > Date.now()) return cached.value
  const [walletTokenIds, farmTokenIds] = await Promise.all([
    ownedTokenIds(pancakeV3PositionManager, positionManagerAbi, owner),
    ownedTokenIds(pancakeV3MasterChef, pancakeV3MasterChefAbi, owner).catch(() => []),
  ])
  const records = [
    ...walletTokenIds.map(tokenId => ({ tokenId, custody: 'wallet' })),
    ...farmTokenIds.map(tokenId => ({ tokenId, custody: 'pancake-farm' })),
  ].filter((record, index, values) => values.findIndex(value => value.tokenId === record.tokenId) === index)
  if (!records.length) return []
  const positionResults = await client.multicall({
    allowFailure: true,
    contracts: records.map(record => ({
      address: pancakeV3PositionManager,
      abi: positionManagerAbi,
      functionName: 'positions',
      args: [record.tokenId],
    })),
  })
  const mapped = await mapWithConcurrency(positionResults, 4, async (result, index) => {
    if (result.status !== 'success') return undefined
    return mapWalletPosition(owner, records[index].tokenId, result.result, records[index].custody)
  })
  const value = mapped.filter(Boolean)
  walletPositionCache.set(key, { expires: Date.now() + 15_000, value })
  return value
}

async function fetchMerklOpportunity(pool) {
  const key = `merkl:opportunity:${pool.toLowerCase()}`
  const cached = cache.get(key)
  if (cached && cached.expires > Date.now()) return cached.value
  const items = await upstreamJson(`${merklApiUrl}/v4/opportunities?chainId=56&identifier=${encodeURIComponent(pool)}`)
  const value = (Array.isArray(items) ? items : []).find(item => String(item?.identifier || '').toLowerCase() === pool.toLowerCase()) || null
  cache.set(key, { expires: Date.now() + 60_000, value })
  return value
}

async function fetchMerklUserRewards(owner, refresh = false) {
  const params = new URLSearchParams({ chainId: '56' })
  if (refresh) params.set('reloadChainId', '56')
  return upstreamJson(`${merklApiUrl}/v4/users/${owner}/rewards?${params.toString()}`)
}

async function bridgeMetadata() {
  if (bridgeMetadataCache.value && bridgeMetadataCache.expires > Date.now()) return bridgeMetadataCache.value
  const [metadataResponse, activityResponse] = await Promise.all([
    fetch(bridgeMetadataUrl, { signal: AbortSignal.timeout(12_000) }),
    fetch(bridgeActivityUrl, { signal: AbortSignal.timeout(12_000) }).catch(() => null),
  ])
  if (!metadataResponse.ok) throw new Error(`bridge metadata HTTP ${metadataResponse.status}`)
  const value = {
    metadata: await metadataResponse.json(),
    activity: activityResponse?.ok ? await activityResponse.json() : { adapters: [] },
    sources: { metadata: bridgeMetadataUrl, activity: bridgeActivityUrl },
    fetchedAt: Date.now(),
  }
  bridgeMetadataCache.value = value
  bridgeMetadataCache.expires = Date.now() + 5 * 60_000
  return value
}

async function readRequestBody(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  if (!chunks.length) return {}
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new Error('JSON 요청 본문을 읽지 못했습니다.') }
}

async function upstreamJson(url, init = {}) {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(18_000),
    headers: {
      accept: 'application/json',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    const message = body?.message || body?.error || `upstream HTTP ${response.status}`
    const error = new Error(message)
    error.status = response.status
    throw error
  }
  return body
}

function bridgeApiInfo() {
  const valueTransferAllowed = bridgeApiMode !== 'legacy' && Boolean(valueTransferApiKey)
  return {
    quoteBackend: valueTransferAllowed ? 'layerzero-value-transfer' : 'stargate-v1',
    discoveryBackend: bridgeApiMode === 'legacy' ? 'stargate-v1' : 'layerzero-value-transfer',
    valueTransferApiConfigured: Boolean(valueTransferApiKey),
    legacyApiAvailable: false,
  }
}

function isAddressLike(value) {
  return typeof value === 'string' && (isAddress(value) || /^0x[eE]{40}$/.test(value))
}

function requireBridgePayload(payload) {
  const fields = ['srcChainKey', 'dstChainKey', 'srcToken', 'dstToken', 'srcAddress', 'dstAddress', 'srcAmount', 'dstAmountMin']
  for (const field of fields) if (!payload?.[field]) throw new Error(`${field} 값이 필요합니다.`)
  if (!isAddressLike(payload.srcToken) || !isAddressLike(payload.dstToken)) throw new Error('토큰 주소 형식이 올바르지 않습니다.')
  if (!isAddress(payload.srcAddress) || !isAddress(payload.dstAddress)) throw new Error('지갑 주소 형식이 올바르지 않습니다.')
  if (!/^\d+$/.test(String(payload.srcAmount)) || !/^\d+$/.test(String(payload.dstAmountMin))) throw new Error('브릿지 수량은 최소 단위 정수여야 합니다.')
}

function transactionFromStep(step, fallbackChainKey) {
  const encoded = step?.transaction?.encoded || step?.transaction || step?.params || step
  if (!encoded || typeof encoded !== 'object') return undefined
  const to = encoded.to || encoded.toAddress
  const data = encoded.data || encoded.input || '0x'
  if (!isAddress(to) || typeof data !== 'string' || !data.startsWith('0x')) return undefined
  return {
    type: 'TRANSACTION',
    description: String(step.description || step.action || step.type || 'transaction'),
    chainKey: String(step.chainKey || fallbackChainKey),
    chainId: encoded.chainId == null ? undefined : Number(encoded.chainId),
    signerAddress: isAddress(step.signerAddress || encoded.from) ? (step.signerAddress || encoded.from) : undefined,
    transaction: {
      to: getAddress(to),
      data,
      value: String(encoded.value ?? 0),
      from: isAddress(encoded.from) ? getAddress(encoded.from) : undefined,
      chainId: encoded.chainId == null ? undefined : Number(encoded.chainId),
      gasLimit: encoded.gasLimit == null ? undefined : String(encoded.gasLimit),
    },
  }
}

function normalizeLegacyQuote(payload, response) {
  const candidates = Array.isArray(response?.quotes) ? response.quotes : []
  const route = candidates.find(item => !item?.error) || candidates[0]
  if (!route) throw new Error('Stargate에서 사용할 수 있는 브릿지 경로를 찾지 못했습니다.')
  if (route.error) throw new Error(String(route.error))
  const steps = (Array.isArray(route.steps) ? route.steps : [])
    .map(step => transactionFromStep(step, payload.srcChainKey))
    .filter(Boolean)
  return {
    backend: 'stargate-v1',
    id: route.id || route.quoteId,
    route: String(route.route || route.bridge || 'stargate'),
    srcChainKey: String(route.srcChainKey || payload.srcChainKey),
    dstChainKey: String(route.dstChainKey || payload.dstChainKey),
    srcToken: String(route.srcToken || payload.srcToken),
    dstToken: String(route.dstToken || payload.dstToken),
    srcAmount: String(route.srcAmount || payload.srcAmount),
    dstAmount: String(route.dstAmount || route.dstAmountMin || payload.dstAmountMin),
    dstAmountMin: String(route.dstAmountMin || payload.dstAmountMin),
    feeUsd: route.fees?.find?.(fee => fee?.token && fee?.amountUsd != null)?.amountUsd == null ? undefined : String(route.fees.find(fee => fee?.amountUsd != null).amountUsd),
    feePercent: route.feePercent == null ? undefined : String(route.feePercent),
    durationSeconds: route.duration?.estimated == null ? undefined : Number(route.duration.estimated),
    allowance: route.allowance == null ? undefined : String(route.allowance),
    dstNativeAmount: route.dstNativeAmount == null ? undefined : String(route.dstNativeAmount),
    fees: Array.isArray(route.fees) ? route.fees : [],
    steps,
    rejected: candidates.filter(item => item?.error).map(item => String(item.error)),
  }
}

function normalizeValueTransferQuote(payload, response) {
  const candidates = Array.isArray(response?.quotes) ? response.quotes : []
  const quote = candidates[0]
  if (!quote) throw new Error('LayerZero Value Transfer API에서 사용할 수 있는 경로를 찾지 못했습니다.')
  const steps = (Array.isArray(quote.userSteps) ? quote.userSteps : [])
    .map(step => step?.type === 'TRANSACTION' ? transactionFromStep(step, payload.srcChainKey) : {
      type: 'SIGNATURE',
      description: String(step.description || 'signature'),
      chainKey: String(step.chainKey || payload.srcChainKey),
    })
  return {
    backend: 'layerzero-value-transfer',
    id: quote.id,
    route: Array.isArray(quote.routeSteps) && quote.routeSteps[0] ? String(quote.routeSteps[0].type || 'layerzero') : 'layerzero',
    srcChainKey: payload.srcChainKey,
    dstChainKey: payload.dstChainKey,
    srcToken: payload.srcToken,
    dstToken: payload.dstToken,
    srcAmount: String(quote.srcAmount || payload.srcAmount),
    dstAmount: String(quote.dstAmount || payload.dstAmountMin),
    dstAmountMin: String(quote.dstAmountMin || payload.dstAmountMin),
    feeUsd: quote.feeUsd == null ? undefined : String(quote.feeUsd),
    feePercent: quote.feePercent == null ? undefined : String(quote.feePercent),
    durationSeconds: quote.duration?.estimated == null ? undefined : Number(quote.duration.estimated) / 1000,
    allowance: undefined,
    dstNativeAmount: quote.options?.dstNativeDropAmount == null ? undefined : String(quote.options.dstNativeDropAmount),
    fees: Array.isArray(quote.fees) ? quote.fees : [],
    steps,
    rejected: Array.isArray(response.rejectedQuotes) ? response.rejectedQuotes.map(item => String(item?.error || item)) : [],
  }
}

async function fetchBridgeTokens(requestUrl) {
  const useValueTransfer = bridgeApiMode !== 'legacy'
  if (useValueTransfer) {
    try {
      const params = new URLSearchParams()
      const srcChainKey = requestUrl.searchParams.get('srcChainKey')
      const srcToken = requestUrl.searchParams.get('srcToken')
      if (srcChainKey) params.set('transferrableFromChainKey', srcChainKey)
      if (srcToken) params.set('transferrableFromTokenAddress', srcToken)
      const response = await upstreamJson(`${valueTransferApiUrl}/tokens?${params.toString()}`)
      return { backend: 'layerzero-value-transfer', tokens: Array.isArray(response.tokens) ? response.tokens : [] }
    } catch (error) {
      if (error?.status === 422 || /unsupported token/i.test(error?.message || '')) {
        return { backend: 'layerzero-value-transfer', tokens: [], message: error.message }
      }
      if (bridgeApiMode === 'value-transfer') throw error
    }
  }
  const response = await upstreamJson(`${stargateApiUrl}/tokens?${requestUrl.searchParams.toString()}`)
  return { backend: 'stargate-v1', tokens: Array.isArray(response.tokens) ? response.tokens : [] }
}

async function fetchBridgeChains() {
  if (bridgeChainCache.value && bridgeChainCache.expires > Date.now()) return bridgeChainCache.value
  const metadata = await upstreamJson(layerZeroMetadataUrl)
  const chains = Object.entries(metadata).flatMap(([key, raw]) => {
    if (!referenceChainKeys.has(key) || !raw || typeof raw !== 'object') return []
    const details = raw.chainDetails || {}
    if (details.chainType !== 'evm') return []
    const chainId = Number(details.nativeChainId)
    const deployment = Array.isArray(raw.deployments)
      ? raw.deployments.find(item => Number(item?.version) === 2 && item?.stage === 'mainnet' && Number(item?.eid) >= 30100)
      : undefined
    const eid = Number(deployment?.eid)
    if (!Number.isInteger(chainId) || !Number.isInteger(eid)) return []
    const rpcUrls = (Array.isArray(raw.rpcs) ? raw.rpcs : [])
      .filter(item => typeof item?.url === 'string' && /^https:\/\//i.test(item.url) && !/\$\{|YOUR_|API_KEY/i.test(item.url))
      .sort((a, b) => Number(a.rank ?? 99) - Number(b.rank ?? 99))
      .map(item => item.url)
      .filter((url, index, values) => values.indexOf(url) === index)
      .slice(0, 8)
    const explorerUrl = (Array.isArray(raw.blockExplorers) ? raw.blockExplorers : [])
      .map(item => item?.url)
      .find(url => typeof url === 'string' && /^https:\/\//i.test(url))
    const native = details.nativeCurrency || {}
    return [{
      key,
      name: referenceChainNames[key] || String(details.name || raw.chainName || key),
      shortName: referenceChainShortNames[key] || key.toUpperCase().slice(0, 5),
      eid,
      chainId,
      nativeSymbol: String(native.symbol || 'ETH'),
      nativeDecimals: Number(native.decimals ?? 18),
      rpcUrl: rpcUrls[0] || '',
      rpcUrls,
      explorerUrl,
    }]
  }).sort((a, b) => a.name.localeCompare(b.name))
  const value = {
    source: layerZeroMetadataUrl,
    chains,
    rpcReady: chains.filter(chain => chain.rpcUrls.length > 0).length,
    fetchedAt: Date.now(),
  }
  bridgeChainCache.value = value
  bridgeChainCache.expires = Date.now() + 10 * 60_000
  return value
}

async function fetchBridgeQuote(payload) {
  requireBridgePayload(payload)
  const useValueTransfer = bridgeApiMode !== 'legacy' && Boolean(valueTransferApiKey)
  if (useValueTransfer) {
    try {
      const response = await upstreamJson(`${valueTransferApiUrl}/quotes`, {
        method: 'POST',
        headers: { 'x-api-key': valueTransferApiKey },
        body: JSON.stringify({
          srcChainKey: payload.srcChainKey,
          dstChainKey: payload.dstChainKey,
          srcTokenAddress: payload.srcToken,
          dstTokenAddress: payload.dstToken,
          srcWalletAddress: payload.srcAddress,
          dstWalletAddress: payload.dstAddress,
          amount: String(payload.srcAmount),
          options: {
            amountType: 'EXACT_SRC_AMOUNT',
            feeTolerance: { type: 'PERCENT', amount: Math.max(0.1, Number(payload.slippagePercent || 0.5)) },
          },
        }),
      })
      return normalizeValueTransferQuote(payload, response)
    } catch (error) {
      if (bridgeApiMode === 'value-transfer') throw error
    }
  }
  const params = new URLSearchParams({
    srcToken: payload.srcToken,
    dstToken: payload.dstToken,
    srcAddress: payload.srcAddress,
    dstAddress: payload.dstAddress,
    srcChainKey: payload.srcChainKey,
    dstChainKey: payload.dstChainKey,
    srcAmount: String(payload.srcAmount),
    dstAmountMin: String(payload.dstAmountMin),
  })
  try {
    const response = await upstreamJson(`${stargateApiUrl}/quotes?${params.toString()}`)
    return normalizeLegacyQuote(payload, response)
  } catch (error) {
    if (/deprecated/i.test(error?.message || '')) {
      throw new Error('Stargate legacy quote API가 폐기되었습니다. Direct OFT 모드를 사용하거나 서버에 LZ_VALUE_TRANSFER_API_KEY를 설정하세요.')
    }
    throw error
  }
}

async function fetchBridgeStatus(quoteId, requestUrl) {
  if (!valueTransferApiKey) return { status: 'UNAVAILABLE', message: '상태 API 키가 설정되지 않아 LayerZero Scan 링크만 제공합니다.' }
  const query = requestUrl.searchParams.toString()
  const response = await upstreamJson(`${valueTransferApiUrl}/status/${encodeURIComponent(quoteId)}${query ? `?${query}` : ''}`, {
    headers: { 'x-api-key': valueTransferApiKey },
  })
  return response
}

async function fetchLayerZeroTransaction(txHash) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new Error('올바른 트랜잭션 해시가 아닙니다.')
  let response
  try {
    response = await upstreamJson(`${layerZeroScanApiUrl}/messages/tx/${txHash}`)
  } catch (error) {
    if (error?.status === 404) {
      return { txHash, status: 'INDEXING', indexed: false, updatedAt: new Date().toISOString() }
    }
    throw error
  }
  const messages = Array.isArray(response?.data) ? response.data : Array.isArray(response) ? response : [response]
  const message = messages.find(Boolean)
  if (!message) return { txHash, status: 'INDEXING', indexed: false, updatedAt: new Date().toISOString() }
  const destinationHash = message.destination?.tx?.txHash
  return {
    txHash,
    status: String(message.status?.name || message.status || 'UNKNOWN').toUpperCase(),
    indexed: true,
    srcEid: message.pathway?.srcEid ?? message.srcEid,
    dstEid: message.pathway?.dstEid ?? message.dstEid,
    srcTxHash: message.source?.tx?.txHash || txHash,
    dstTxHash: typeof destinationHash === 'string' && /^0x(?!0{64}$)[0-9a-fA-F]{64}$/.test(destinationHash) ? destinationHash : undefined,
    createdAt: message.created || message.source?.tx?.blockTimestamp,
    updatedAt: message.updated || message.destination?.tx?.blockTimestamp || new Date().toISOString(),
  }
}

function loadSnapshot() {
  if (!existsSync(indexerSnapshot)) return {}
  try { return JSON.parse(readFileSync(indexerSnapshot, 'utf8')) } catch { return {} }
}

function loadRobinhoodKeeperState() {
  if (!existsSync(robinhoodKeeperStateFile)) return null
  try { return JSON.parse(readFileSync(robinhoodKeeperStateFile, 'utf8')) } catch { return null }
}

function loadRobinhoodReplay() {
  if (!existsSync(robinhoodReplayFile)) return null
  try { return JSON.parse(readFileSync(robinhoodReplayFile, 'utf8')) } catch { return null }
}

function robinhoodContractCompiled() {
  if (!existsSync(robinhoodContractArtifactFile)) return false
  try {
    const artifact = JSON.parse(readFileSync(robinhoodContractArtifactFile, 'utf8'))
    return artifact?.contractName === 'BStockerThreeTickVault' && typeof artifact?.bytecode === 'string' && artifact.bytecode.length > 2
  } catch {
    return false
  }
}

async function robinhoodStrategyStatus(requestUrl) {
  const walletCandidate = requestUrl.searchParams.get('wallet')
  const wallet = walletCandidate && isAddress(walletCandidate) ? getAddress(walletCandidate) : undefined
  const persisted = loadRobinhoodKeeperState()
  const persistedFresh = Boolean(persisted?.updatedAt && Date.now() - Number(persisted.updatedAt) <= 30_000)
  let snapshot
  let snapshotSource = 'LIVE_RPC'
  try {
    snapshot = await robinhoodService.loadSnapshot(wallet)
  } catch (error) {
    if (!persistedFresh || !persisted?.snapshot) throw error
    snapshot = structuredClone(persisted.snapshot)
    snapshotSource = 'KEEPER_CACHE'
  }
  const automationConfig = loadAutomationConfig()
  let vault = persistedFresh ? persisted?.vault || null : null
  let vaultError = null
  if (automationConfig) {
    try {
      vault = await readVaultStatus(robinhoodService.client, automationConfig.executorAddress, robinhoodKeeperIdentity?.address, {
        sqrtPriceX96: snapshot.sqrtPriceX96,
        spotPrice: snapshot.spotPrice,
        officialPrice: snapshot.official?.tokenPrice,
      })
      snapshot.strategyNavUsd = vault.navUsd
      snapshot.strategyPrincipalUsd = vault.principalUsdg
      if (vault.position) {
        snapshot.managedRange = {
          lower: vault.position.tickLower,
          upper: vault.position.tickUpper,
          anchor: vault.position.tickLower + snapshot.tickSpacing,
          width: vault.position.tickUpper - vault.position.tickLower,
        }
      }
    } catch (error) {
      vaultError = error instanceof Error ? error.message : String(error)
    }
  }
  const decision = persistedFresh && persisted?.decision
    ? persisted.decision
    : robinhoodFallbackEngine.ingest(snapshot)
  const ownerVerified = Boolean(robinhoodAutomationOwner && automationConfig?.ownerAddress
    && getAddress(automationConfig.ownerAddress) === robinhoodAutomationOwner)
  const writesEnabled = Boolean(robinhoodLiveAutomationAllowed && ownerVerified && automationConfig?.armed && vault?.routeVerified && vault?.keeperVerified)
  const recentLogs = loadRecentKeeperLogs(robinhoodKeeperHistoryFile)
  let performance = null
  if (vault?.routeVerified) {
    const marketPrices = await robinhoodService.loadMarketPrices()
    performance = await loadRobinhoodPerformance({
      client: robinhoodService.client,
      transactionFile: robinhoodTransactionHistoryFile,
      historyFile: robinhoodKeeperHistoryFile,
      vault,
      marketPrices,
    })
  }
  return {
    mode: writesEnabled ? 'LIVE' : 'SHADOW',
    writesEnabled,
    executorAddress: automationConfig?.executorAddress || null,
    snapshot,
    snapshotSource,
    decision,
    keeper: persistedFresh ? {
      healthy: Boolean(persisted.healthy),
      updatedAt: persisted.updatedAt,
      startedAt: persisted.startedAt,
      pollMs: persisted.pollMs,
      rpcKind: persisted.rpcKind,
      error: persisted.error || persisted.executionError || null,
      executionGate: persisted.executionBackoff || null,
      signerLoaded: Boolean(persisted.signerLoaded),
      lastTransaction: persisted.lastTransaction || null,
      logs: recentLogs,
    } : {
      healthy: false,
      updatedAt: persisted?.updatedAt || null,
      startedAt: persisted?.startedAt || null,
      pollMs: persisted?.pollMs || null,
      rpcKind: persisted?.rpcKind || 'API_FALLBACK',
      error: persisted ? 'Shadow keeper 상태가 30초 이상 갱신되지 않았습니다.' : 'Shadow keeper가 아직 상태 파일을 만들지 않았습니다.',
      executionGate: persisted?.executionBackoff || null,
      signerLoaded: false,
      lastTransaction: persisted?.lastTransaction || null,
      logs: recentLogs,
    },
    contracts: ROBINHOOD_CONTRACTS,
    guardConfig: DEFAULT_ROBINHOOD_GUARD_CONFIG,
    performance,
    replay: loadRobinhoodReplay(),
    automation: {
      allowed: robinhoodLiveAutomationAllowed,
      armed: Boolean(automationConfig?.armed),
      configured: Boolean(automationConfig),
      keeperAddress: robinhoodKeeperIdentity?.address || null,
      keeperKeyReady: Boolean(robinhoodKeeperIdentity),
      keeperKeyError: robinhoodKeeperIdentityError,
      expectedOwnerAddress: robinhoodAutomationOwner,
      vault,
      error: vaultError || (robinhoodLiveAutomationRequested && !robinhoodAutomationOwner
        ? 'ROBINHOOD_AUTOMATION_OWNER가 없거나 올바른 주소가 아니어서 쓰기가 잠겼습니다.'
        : null),
    },
    deployment: {
      contractCompiled: robinhoodContractCompiled(),
      contractDeployed: Boolean(vault?.routeVerified),
      walletSignatureRequired: true,
      note: writesEnabled
        ? vault?.chainlinkSafetyExit
          ? '저권한 Keeper 자동화가 활성화되어 있습니다. v2.9는 검증된 Chainlink NAV와 DEX TWAP을 함께 확인해 USDG 종료를 실행합니다.'
          : `저권한 Keeper는 활성화되어 있지만 현재 Vault v${vault?.version || '—'}에는 화면과 동일한 Chainlink 손절 기준이 적용되지 않았습니다. 먼저 v2.9로 교체하세요.`
        : automationConfig?.armed
          ? '자동화 설정은 저장됐지만 Keeper 키·금고 경로·서버 허용값 중 하나가 검증되지 않았습니다.'
          : '연결 지갑으로 금고를 배포하고 서명 설정한 뒤 원하는 USDG 금액으로 시작할 수 있습니다.',
    },
  }
}

function pruneRobinhoodChallenges() {
  const now = Date.now()
  for (const [nonce, challenge] of robinhoodAutomationChallenges) {
    if (challenge.expiresAt <= now) robinhoodAutomationChallenges.delete(nonce)
  }
  while (robinhoodAutomationChallenges.size > 100) {
    const first = robinhoodAutomationChallenges.keys().next().value
    if (!first) break
    robinhoodAutomationChallenges.delete(first)
  }
}

async function createRobinhoodAutomationChallenge(requestUrl) {
  if (!robinhoodKeeperIdentity) throw new Error(robinhoodKeeperIdentityError || '이 PC의 Keeper 키를 준비하지 못했습니다.')
  const action = String(requestUrl.searchParams.get('action') || 'ARM').toUpperCase()
  if (!['ARM', 'DISARM'].includes(action)) throw new Error('지원하지 않는 자동화 설정 작업입니다.')
  const configured = loadAutomationConfig()
  const ownerCandidate = requestUrl.searchParams.get('owner') || configured?.ownerAddress
  const executorCandidate = requestUrl.searchParams.get('executor') || configured?.executorAddress
  if (!ownerCandidate || !isAddress(ownerCandidate) || !executorCandidate || !isAddress(executorCandidate)) {
    throw new Error('owner와 자동화 금고 주소가 필요합니다.')
  }
  const owner = getAddress(ownerCandidate)
  const executor = getAddress(executorCandidate)
  if (!robinhoodAutomationOwner || owner !== robinhoodAutomationOwner) {
    throw new Error('이 서버에 고정 등록된 Robinhood 자동화 owner 주소와 일치하지 않습니다.')
  }
  await verifyVaultForConfiguration(robinhoodService.client, executor, owner, robinhoodKeeperIdentity.address)
  pruneRobinhoodChallenges()
  const nonce = randomBytes(16).toString('hex')
  const expiresAt = Date.now() + 5 * 60_000
  const message = [
    'bStocker Robinhood automation authorization',
    `action: ${action}`,
    `chainId: ${ROBINHOOD_CONTRACTS.chainId}`,
    `owner: ${owner}`,
    `executor: ${executor}`,
    `keeper: ${robinhoodKeeperIdentity.address}`,
    `site: ${requestUrl.host}`,
    `nonce: ${nonce}`,
    `expiresAt: ${new Date(expiresAt).toISOString()}`,
    '',
    'This signature does not transfer tokens or approve spending.',
  ].join('\n')
  robinhoodAutomationChallenges.set(nonce, { action, owner, executor, keeper: robinhoodKeeperIdentity.address, message, expiresAt })
  return { action, owner, executor, keeperAddress: robinhoodKeeperIdentity.address, nonce, expiresAt, message }
}

async function configureRobinhoodAutomation(body) {
  pruneRobinhoodChallenges()
  const challenge = robinhoodAutomationChallenges.get(String(body?.nonce || ''))
  if (!challenge) throw new Error('설정 서명 요청이 없거나 만료되었습니다. 다시 시도하세요.')
  robinhoodAutomationChallenges.delete(String(body.nonce))
  if (challenge.expiresAt <= Date.now()) throw new Error('설정 서명 요청이 만료되었습니다.')
  if (String(body?.action || '').toUpperCase() !== challenge.action) throw new Error('설정 작업이 서명 요청과 다릅니다.')
  const valid = await verifyMessage({ address: challenge.owner, message: challenge.message, signature: body?.signature })
  if (!valid) throw new Error('owner 지갑 서명을 검증하지 못했습니다.')
  await verifyVaultForConfiguration(robinhoodService.client, challenge.executor, challenge.owner, challenge.keeper)
  const config = saveAutomationConfig({
    executorAddress: challenge.executor,
    ownerAddress: challenge.owner,
    keeperAddress: challenge.keeper,
    armed: challenge.action === 'ARM',
    configuredAt: loadAutomationConfig()?.configuredAt,
  })
  return { ok: true, config, liveAutomationAllowed: robinhoodLiveAutomationAllowed }
}

async function handler(request, response) {
  const requestUrl = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`)
  if (request.method === 'OPTIONS') {
    response.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type,x-api-key' })
    return response.end()
  }
  if (requestUrl.pathname === '/health') return json(response, 200, { ok: true, service: 'bstocker-api', mode: poolAddress ? 'live' : 'demo', now: Date.now() })
  try {
    if (requestUrl.pathname === '/api/robinhood/strategy') return json(response, 200, await robinhoodStrategyStatus(requestUrl))
    if (requestUrl.pathname === '/api/robinhood/contracts') return json(response, 200, { contracts: ROBINHOOD_CONTRACTS, guardConfig: DEFAULT_ROBINHOOD_GUARD_CONFIG, writesEnabled: robinhoodLiveAutomationAllowed })
    if (requestUrl.pathname === '/api/robinhood/automation/bootstrap') {
      const artifact = loadVaultArtifact()
      if (!artifact) throw new Error('자동화 금고 빌드 파일이 없습니다.')
      return json(response, 200, {
        chainId: ROBINHOOD_CONTRACTS.chainId,
        keeperAddress: robinhoodKeeperIdentity?.address || null,
        keeperKeyReady: Boolean(robinhoodKeeperIdentity),
        keeperKeyError: robinhoodKeeperIdentityError,
        expectedOwnerAddress: robinhoodAutomationOwner,
        liveAutomationAllowed: robinhoodLiveAutomationAllowed,
        artifact,
      })
    }
    if (requestUrl.pathname === '/api/robinhood/automation/challenge' && request.method === 'GET') {
      return json(response, 200, await createRobinhoodAutomationChallenge(requestUrl))
    }
    if (requestUrl.pathname === '/api/robinhood/automation/configure' && request.method === 'POST') {
      return json(response, 200, await configureRobinhoodAutomation(await readRequestBody(request)))
    }
    if (requestUrl.pathname === '/api/bridge/backend') return json(response, 200, bridgeApiInfo())
    if (requestUrl.pathname === '/api/bridge/chains') return json(response, 200, await fetchBridgeChains())
    if (requestUrl.pathname === '/api/bridge/tokens') return json(response, 200, await fetchBridgeTokens(requestUrl))
    if (requestUrl.pathname === '/api/bridge/quote' && request.method === 'POST') return json(response, 200, await fetchBridgeQuote(await readRequestBody(request)))
    const bridgeStatusMatch = requestUrl.pathname.match(/^\/api\/bridge\/status\/([^/]+)$/)
    if (bridgeStatusMatch) return json(response, 200, await fetchBridgeStatus(bridgeStatusMatch[1], requestUrl))
    const bridgeTxMatch = requestUrl.pathname.match(/^\/api\/bridge\/tx\/(0x[0-9a-fA-F]{64})$/)
    if (bridgeTxMatch) return json(response, 200, await fetchLayerZeroTransaction(bridgeTxMatch[1]))
    if (requestUrl.pathname === '/api/bridge/metadata') return json(response, 200, await bridgeMetadata())
    if (requestUrl.pathname === '/api/pools/directory') return json(response, 200, await fetchPoolDirectory(requestUrl.searchParams.get('refresh') === '1'))
    if (requestUrl.pathname === '/api/rewards/merkl/opportunity') {
      const candidate = requestUrl.searchParams.get('pool')
      if (!candidate || !isAddress(candidate)) return json(response, 400, { error: 'invalid_pool_address' })
      return json(response, 200, await fetchMerklOpportunity(getAddress(candidate)))
    }
    const merklUserMatch = requestUrl.pathname.match(/^\/api\/rewards\/merkl\/user\/(0x[0-9a-fA-F]{40})$/)
    if (merklUserMatch) {
      const owner = isAddress(merklUserMatch[1]) ? getAddress(merklUserMatch[1]) : undefined
      if (!owner) return json(response, 400, { error: 'invalid_wallet_address' })
      return json(response, 200, await fetchMerklUserRewards(owner, requestUrl.searchParams.get('refresh') === '1'))
    }
    const match = requestUrl.pathname.match(/^\/api\/pools\/([^/]+)\/(summary|candles|liquidity)$/)
    if (match) {
      const candidate = isAddress(match[1]) ? getAddress(match[1]) : poolAddress
      if (match[2] === 'summary') return json(response, 200, await liveSummary(candidate))
      if (!candidate) return json(response, 400, { error: 'pool_address_required' })
      if (match[2] === 'candles') return json(response, 200, await fetchPoolCandles(candidate, requestUrl.searchParams.get('interval') || '1d'))
      if (match[2] === 'liquidity') return json(response, 200, await fetchPoolLiquidity(candidate))
    }
    const walletMatch = requestUrl.pathname.match(/^\/api\/wallet\/([^/]+)\/positions$/)
    if (walletMatch) {
      const owner = isAddress(walletMatch[1]) ? getAddress(walletMatch[1]) : undefined
      if (!owner) return json(response, 400, { error: 'invalid_wallet_address' })
      const requestedPool = requestUrl.searchParams.get('pool')
      const selectedPool = requestedPool && isAddress(requestedPool) ? getAddress(requestedPool).toLowerCase() : undefined
      let positions
      try {
        positions = await fetchWalletPositions(owner)
      } catch {
        positions = (loadSnapshot().positions || []).filter(position => String(position.owner || '').toLowerCase() === owner.toLowerCase())
      }
      if (selectedPool) positions = positions.filter(position => String(position.poolAddress || '').toLowerCase() === selectedPool)
      return json(response, 200, positions)
    }
    return json(response, 404, { error: 'not_found' })
  } catch (error) {
    return json(response, 502, { error: error instanceof Error ? error.message : 'upstream_rpc_error' })
  }
}

const port = Number(env('PORT') || 8787)
createServer(handler).listen(port, '0.0.0.0', () => {
  console.log(`bStocker API listening on http://localhost:${port} (${poolAddress ? 'live' : 'demo'} mode)`)
})
