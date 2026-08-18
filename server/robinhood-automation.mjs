import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { formatUnits, getAddress, isAddress, parseAbi } from 'viem'
import { ROBINHOOD_CONTRACTS } from './robinhood.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const workDirectory = join(root, 'work')
export const automationConfigFile = join(workDirectory, 'robinhood-automation-config.json')
const temporaryConfigFile = join(workDirectory, 'robinhood-automation-config.tmp.json')
export const vaultArtifactFile = join(root, 'contracts', 'build', 'BStockerThreeTickVault.json')

export const vaultAbi = parseAbi([
  'error CrashNotConfirmed()',
  'error PriceGuardFailed()',
  'function version() view returns (string)',
  'function owner() view returns (address)',
  'function recipient() view returns (address)',
  'function keeper() view returns (address)',
  'function guardian() view returns (address)',
  'function mode() view returns (uint8)',
  'function activeTokenId() view returns (uint256)',
  'function principalUsdg() view returns (uint256)',
  'function totalRebalances() view returns (uint256)',
  'function totalHarvestedUp() view returns (uint256)',
  'function totalCapitalAddedUsdg() view returns (uint256)',
  'function lastRebalanceAt() view returns (uint64)',
  'function modeChangedAt() view returns (uint64)',
  'function defensiveAnchor() view returns (int24)',
  'function POOL() view returns (address)',
  'function GAUGE() view returns (address)',
  'function POSITION_MANAGER() view returns (address)',
  'function SWAP_ROUTER() view returns (address)',
  'function SPCX() view returns (address)',
  'function USDG() view returns (address)',
  'function UP() view returns (address)',
  'function SPCX_USD_FEED() view returns (address)',
  'function USDG_USD_FEED() view returns (address)',
  'function TICK_SPACING() view returns (int24)',
  'function RANGE_WIDTH() view returns (int24)',
  'function MAX_PILOT_USDG() view returns (uint256)',
  'function MAX_UNUSED_BPS() view returns (uint256)',
  'function NAV_HARD_STOP_BPS() view returns (uint256)',
  'function FIVE_MINUTE_CRASH_TICKS() view returns (int24)',
  'function PRICE_FEED_MAX_AGE() view returns (uint256)',
  'function EXIT_ORACLE_FLOOR_BPS() view returns (uint256)',
  'function REQUIRED_ORACLE_CARDINALITY() view returns (uint16)',
  'function SLOW_DROP_15_TWAP_TICKS() view returns (int24)',
  'function SLOW_DROP_30_TWAP_TICKS() view returns (int24)',
  'function DEFENSE_EXIT_TICKS() view returns (int24)',
  'function RECOVERY_15_TWAP_TICKS() view returns (int24)',
  'function MIN_DEFENSIVE_DURATION() view returns (uint256)',
  'function MIN_USDG_WAIT_DURATION() view returns (uint256)',
  'function safetyOracle() view returns (bool ready,uint256 spcxPriceUsdg,uint256 spcxUpdatedAt,uint256 usdgUpdatedAt)',
  'function currentPosition() view returns (uint256 tokenId,int24 tickLower,int24 tickUpper,uint128 liquidity,bool inRange)',
  'function rebalanceCounts() view returns (uint256 inTenMinutes,uint256 inOneHour)',
  'function start(uint256 amountSpcx,uint256 amountUsdg,int24 expectedTick,uint256 deadline) returns (uint256 tokenId)',
  'function addCapital(uint256 amountSpcx,uint256 amountUsdg,int24 expectedTick,uint256 deadline) returns (uint256 nextTokenId)',
  'function rebalanceAuto(int24 expectedTick,uint256 deadline) returns (uint256 nextTokenId)',
  'function enterDefensiveAuto(int24 expectedTick,uint256 deadline) returns (uint256 nextTokenId)',
  'function parkInUsdgAuto(uint256 deadline) returns (uint256 amountOut)',
  'function resumeNormalAuto(int24 expectedTick,uint256 deadline) returns (uint256 nextTokenId)',
  'function withdrawToIdle(uint256 deadline)',
  'function exitToTokens(uint256 deadline)',
  'function exitToUsdgAuto(uint256 deadline) returns (uint256 amountOut)',
  'function harvestUp() returns (uint256 amount)',
  'function pause()',
  'function resume()',
  'function resetAfterExit()',
])

const erc20Abi = parseAbi(['function balanceOf(address account) view returns (uint256)'])
const gaugeAbi = parseAbi(['function earned(address account,uint256 tokenId) view returns (uint256)'])
const positionAbi = parseAbi([
  'function positions(uint256 tokenId) view returns (uint96 nonce,address operator,address token0,address token1,int24 tickSpacing,int24 tickLower,int24 tickUpper,uint128 liquidity,uint256 feeGrowthInside0LastX128,uint256 feeGrowthInside1LastX128,uint128 tokensOwed0,uint128 tokensOwed1)',
])

const modeNames = ['PAUSED', 'LIVE', 'SOFT_PAUSE', 'WITHDRAW_ONLY', 'DEFENSIVE', 'USDG_WAIT']

function optional(read, fallback = null) {
  return Promise.resolve().then(read).catch(() => fallback)
}

function sameAddress(a, b) {
  try { return getAddress(a) === getAddress(b) } catch { return false }
}

function amount(raw, decimals = 18) {
  const value = Number(formatUnits(raw, decimals))
  return Number.isFinite(value) ? value : 0
}

function positionAmounts(sqrtPriceX96, tickLower, tickUpper, liquidity) {
  const q96 = 2 ** 96
  const sqrtPrice = Number(sqrtPriceX96) / q96
  const sqrtLower = Math.pow(1.0001, Number(tickLower) / 2)
  const sqrtUpper = Math.pow(1.0001, Number(tickUpper) / 2)
  const liquid = Number(liquidity)
  if (![sqrtPrice, sqrtLower, sqrtUpper, liquid].every(Number.isFinite) || liquid <= 0) return { amount0: 0, amount1: 0 }
  if (sqrtPrice <= sqrtLower) return { amount0: liquid * (sqrtUpper - sqrtLower) / (sqrtLower * sqrtUpper), amount1: 0 }
  if (sqrtPrice >= sqrtUpper) return { amount0: 0, amount1: liquid * (sqrtUpper - sqrtLower) }
  return {
    amount0: liquid * (sqrtUpper - sqrtPrice) / (sqrtPrice * sqrtUpper),
    amount1: liquid * (sqrtPrice - sqrtLower),
  }
}

export function loadAutomationConfig() {
  if (!existsSync(automationConfigFile)) return null
  try {
    const value = JSON.parse(readFileSync(automationConfigFile, 'utf8'))
    if (value?.version !== 1 || !isAddress(value?.executorAddress) || !isAddress(value?.ownerAddress) || !isAddress(value?.keeperAddress)) return null
    return {
      ...value,
      executorAddress: getAddress(value.executorAddress),
      ownerAddress: getAddress(value.ownerAddress),
      keeperAddress: getAddress(value.keeperAddress),
      armed: Boolean(value.armed),
    }
  } catch {
    return null
  }
}

export function saveAutomationConfig(value) {
  const normalized = {
    version: 1,
    executorAddress: getAddress(value.executorAddress),
    ownerAddress: getAddress(value.ownerAddress),
    keeperAddress: getAddress(value.keeperAddress),
    armed: Boolean(value.armed),
    configuredAt: value.configuredAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  mkdirSync(workDirectory, { recursive: true })
  writeFileSync(temporaryConfigFile, JSON.stringify(normalized, null, 2), 'utf8')
  renameSync(temporaryConfigFile, automationConfigFile)
  return normalized
}

export function assertAutomationReconfigurationSafe(currentConfig, currentVault, nextExecutorAddress) {
  if (!currentConfig?.executorAddress || sameAddress(currentConfig.executorAddress, nextExecutorAddress)) return
  const safelyRetired = Boolean(currentVault
    && ['PAUSED', 'WITHDRAW_ONLY'].includes(currentVault.mode)
    && String(currentVault.activeTokenId) === '0'
    && Number(currentVault.balances?.SPCX || 0) === 0
    && Number(currentVault.balances?.USDG || 0) === 0
    && Number(currentVault.balances?.earnedUP || 0) === 0)
  if (!safelyRetired) {
    throw new Error('현재 활성 자동화 금고가 있어 브라우저에 저장된 다른 주소로 덮어쓸 수 없습니다. 기존 금고가 완전히 회수된 뒤에만 교체할 수 있습니다.')
  }
}

export function loadVaultArtifact() {
  if (!existsSync(vaultArtifactFile)) return null
  try {
    const artifact = JSON.parse(readFileSync(vaultArtifactFile, 'utf8'))
    if (artifact?.contractName !== 'BStockerThreeTickVault' || typeof artifact?.bytecode !== 'string' || !artifact.bytecode.startsWith('0x')) return null
    return { abi: artifact.abi, bytecode: artifact.bytecode, compiler: artifact.compiler }
  } catch {
    return null
  }
}

export async function readVaultStatus(client, executorAddress, expectedKeeperAddress, market = {}) {
  if (!executorAddress || !isAddress(executorAddress)) return null
  const address = getAddress(executorAddress)
  const code = await client.getBytecode({ address })
  if (!code || code === '0x') throw new Error('설정된 자동화 금고 주소에 배포 코드가 없습니다.')
  const [
    version, owner, recipient, keeper, guardian, modeRaw, activeTokenId, principalUsdg, totalRebalances,
    totalHarvestedUp, lastRebalanceAt, pool, gauge, positionManager, swapRouter, spcx, usdg, up,
    tickSpacing, rangeWidth, maxPilotUsdg, maxUnusedBps, navHardStopBps, crashTicks,
    spcxUsdFeed, usdgUsdFeed, priceFeedMaxAge, exitOracleFloorBps, safetyOracle,
    totalCapitalAddedUsdg, currentPosition, rebalanceCounts, idleSpcx, idleUsdg, keeperGasBalance,
    modeChangedAt, defensiveAnchor, requiredOracleCardinality, slowDrop15Ticks, slowDrop30Ticks,
    defenseExitTicks, recovery15Ticks, minDefensiveDuration, minUsdgWaitDuration,
  ] = await Promise.all([
    client.readContract({ address, abi: vaultAbi, functionName: 'version' }),
    client.readContract({ address, abi: vaultAbi, functionName: 'owner' }),
    client.readContract({ address, abi: vaultAbi, functionName: 'recipient' }),
    client.readContract({ address, abi: vaultAbi, functionName: 'keeper' }),
    client.readContract({ address, abi: vaultAbi, functionName: 'guardian' }),
    client.readContract({ address, abi: vaultAbi, functionName: 'mode' }),
    client.readContract({ address, abi: vaultAbi, functionName: 'activeTokenId' }),
    client.readContract({ address, abi: vaultAbi, functionName: 'principalUsdg' }),
    client.readContract({ address, abi: vaultAbi, functionName: 'totalRebalances' }),
    client.readContract({ address, abi: vaultAbi, functionName: 'totalHarvestedUp' }),
    client.readContract({ address, abi: vaultAbi, functionName: 'lastRebalanceAt' }),
    client.readContract({ address, abi: vaultAbi, functionName: 'POOL' }),
    client.readContract({ address, abi: vaultAbi, functionName: 'GAUGE' }),
    client.readContract({ address, abi: vaultAbi, functionName: 'POSITION_MANAGER' }),
    client.readContract({ address, abi: vaultAbi, functionName: 'SWAP_ROUTER' }),
    client.readContract({ address, abi: vaultAbi, functionName: 'SPCX' }),
    client.readContract({ address, abi: vaultAbi, functionName: 'USDG' }),
    client.readContract({ address, abi: vaultAbi, functionName: 'UP' }),
    client.readContract({ address, abi: vaultAbi, functionName: 'TICK_SPACING' }),
    client.readContract({ address, abi: vaultAbi, functionName: 'RANGE_WIDTH' }),
    client.readContract({ address, abi: vaultAbi, functionName: 'MAX_PILOT_USDG' }),
    optional(() => client.readContract({ address, abi: vaultAbi, functionName: 'MAX_UNUSED_BPS' }), null),
    optional(() => client.readContract({ address, abi: vaultAbi, functionName: 'NAV_HARD_STOP_BPS' }), null),
    optional(() => client.readContract({ address, abi: vaultAbi, functionName: 'FIVE_MINUTE_CRASH_TICKS' }), null),
    optional(() => client.readContract({ address, abi: vaultAbi, functionName: 'SPCX_USD_FEED' }), null),
    optional(() => client.readContract({ address, abi: vaultAbi, functionName: 'USDG_USD_FEED' }), null),
    optional(() => client.readContract({ address, abi: vaultAbi, functionName: 'PRICE_FEED_MAX_AGE' }), null),
    optional(() => client.readContract({ address, abi: vaultAbi, functionName: 'EXIT_ORACLE_FLOOR_BPS' }), null),
    optional(() => client.readContract({ address, abi: vaultAbi, functionName: 'safetyOracle' }), null),
    optional(() => client.readContract({ address, abi: vaultAbi, functionName: 'totalCapitalAddedUsdg' }), 0n),
    client.readContract({ address, abi: vaultAbi, functionName: 'currentPosition' }),
    client.readContract({ address, abi: vaultAbi, functionName: 'rebalanceCounts' }),
    client.readContract({ address: ROBINHOOD_CONTRACTS.spcx, abi: erc20Abi, functionName: 'balanceOf', args: [address] }),
    client.readContract({ address: ROBINHOOD_CONTRACTS.usdg, abi: erc20Abi, functionName: 'balanceOf', args: [address] }),
    expectedKeeperAddress && isAddress(expectedKeeperAddress) ? client.getBalance({ address: getAddress(expectedKeeperAddress) }) : 0n,
    optional(() => client.readContract({ address, abi: vaultAbi, functionName: 'modeChangedAt' }), 0n),
    optional(() => client.readContract({ address, abi: vaultAbi, functionName: 'defensiveAnchor' }), 0),
    optional(() => client.readContract({ address, abi: vaultAbi, functionName: 'REQUIRED_ORACLE_CARDINALITY' }), 64),
    optional(() => client.readContract({ address, abi: vaultAbi, functionName: 'SLOW_DROP_15_TWAP_TICKS' }), null),
    optional(() => client.readContract({ address, abi: vaultAbi, functionName: 'SLOW_DROP_30_TWAP_TICKS' }), null),
    optional(() => client.readContract({ address, abi: vaultAbi, functionName: 'DEFENSE_EXIT_TICKS' }), null),
    optional(() => client.readContract({ address, abi: vaultAbi, functionName: 'RECOVERY_15_TWAP_TICKS' }), null),
    optional(() => client.readContract({ address, abi: vaultAbi, functionName: 'MIN_DEFENSIVE_DURATION' }), null),
    optional(() => client.readContract({ address, abi: vaultAbi, functionName: 'MIN_USDG_WAIT_DURATION' }), null),
  ])

  const tokenId = currentPosition[0]
  const tickLower = Number(currentPosition[1])
  const tickUpper = Number(currentPosition[2])
  const liquidity = currentPosition[3]
  const position = tokenId > 0n
    ? await client.readContract({ address: ROBINHOOD_CONTRACTS.positionManager, abi: positionAbi, functionName: 'positions', args: [tokenId] })
    : null
  const earnedUp = tokenId > 0n
    ? await optional(() => client.readContract({ address: ROBINHOOD_CONTRACTS.gauge, abi: gaugeAbi, functionName: 'earned', args: [address, tokenId] }), 0n)
    : 0n
  const held = market.sqrtPriceX96 && tokenId > 0n ? positionAmounts(BigInt(market.sqrtPriceX96), tickLower, tickUpper, liquidity) : { amount0: 0, amount1: 0 }
  const owed0 = position ? Number(position[10]) : 0
  const owed1 = position ? Number(position[11]) : 0
  const totalSpcx = amount(idleSpcx, 18) + (held.amount0 + owed0) / 1e18
  const totalUsdg = amount(idleUsdg, 6) + (held.amount1 + owed1) / 1e6
  const officialPrice = Number(market.officialPrice)
  const spotPrice = Number(market.spotPrice)
  const protectedPriceProvided = Object.prototype.hasOwnProperty.call(market, 'valuationPrice')
  const protectedPrice = Number(market.valuationPrice)
  const valuationPrice = protectedPriceProvided
    ? Number.isFinite(protectedPrice) && protectedPrice > 0 ? protectedPrice : null
    : Number.isFinite(officialPrice) && officialPrice > 0
      ? officialPrice
      : Number.isFinite(spotPrice) && spotPrice > 0 ? spotPrice : null
  const navUsd = valuationPrice == null ? null : totalUsdg + totalSpcx * valuationPrice

  // Old verified vaults remain readable so the owner can migrate safely.
  // Older verified Vaults stay readable for a safe migration. v3 treats Chainlink
  // NAV as telemetry and pins its adaptive actions to Slipstream TWAP conditions.
  const supportedVersion = ['2.1.0', '2.3.0', '2.4.0', '2.5.0', '2.6.0', '2.7.0', '2.8.0', '2.9.0', '3.0.0'].includes(version)
  const unlimitedVersion = ['2.7.0', '2.8.0', '2.9.0', '3.0.0'].includes(version)
  const expectedPilotLimit = unlimitedVersion
    ? 2n ** 256n - 1n
    : ['2.3.0', '2.4.0', '2.5.0', '2.6.0'].includes(version) ? 350n * 10n ** 6n : 200n * 10n ** 6n
  const expectedRangeWidth = ['2.5.0', '2.6.0', '2.7.0', '2.8.0', '2.9.0', '3.0.0'].includes(version) ? 50 : 30
  const v28SafetyVerified = version !== '2.8.0'
    || (Number(maxUnusedBps) === 1_000 && Number(navHardStopBps) === 500 && Number(crashTicks) === 305)
  const v29SafetyVerified = version !== '2.9.0'
    || (Number(maxUnusedBps) === 1_000
      && Number(navHardStopBps) === 500
      && Number(crashTicks) === 305
      && sameAddress(spcxUsdFeed, ROBINHOOD_CONTRACTS.spcxUsdFeed)
      && sameAddress(usdgUsdFeed, ROBINHOOD_CONTRACTS.usdgUsdFeed)
      && Number(priceFeedMaxAge) === ROBINHOOD_CONTRACTS.priceFeedMaxAgeSec
      && Number(exitOracleFloorBps) === 150
      && safetyOracle !== null)
  const v30AdaptiveVerified = version !== '3.0.0'
    || (Number(maxUnusedBps) === 1_000
      && navHardStopBps === null
      && Number(crashTicks) === 305
      && Number(requiredOracleCardinality) === 256
      && Number(slowDrop15Ticks) === 25
      && Number(slowDrop30Ticks) === 38
      && Number(defenseExitTicks) === 20
      && Number(recovery15Ticks) === 25
      && Number(minDefensiveDuration) === 30 * 60
      && Number(minUsdgWaitDuration) === 60 * 60)
  const routeVerified = supportedVersion
    && sameAddress(pool, ROBINHOOD_CONTRACTS.pool)
    && sameAddress(gauge, ROBINHOOD_CONTRACTS.gauge)
    && sameAddress(positionManager, ROBINHOOD_CONTRACTS.positionManager)
    && sameAddress(swapRouter, ROBINHOOD_CONTRACTS.swapRouter)
    && sameAddress(spcx, ROBINHOOD_CONTRACTS.spcx)
    && sameAddress(usdg, ROBINHOOD_CONTRACTS.usdg)
    && sameAddress(up, ROBINHOOD_CONTRACTS.up)
    && Number(tickSpacing) === ROBINHOOD_CONTRACTS.tickSpacing
    && Number(rangeWidth) === expectedRangeWidth
    && maxPilotUsdg === expectedPilotLimit
    && v28SafetyVerified
    && v29SafetyVerified
    && v30AdaptiveVerified

  return {
    address,
    version,
    owner: getAddress(owner),
    recipient: getAddress(recipient),
    keeper: getAddress(keeper),
    guardian: getAddress(guardian),
    mode: modeNames[Number(modeRaw)] || `UNKNOWN_${modeRaw}`,
    activeTokenId: activeTokenId.toString(),
    principalUsdg: amount(principalUsdg, 6),
    totalRebalances: Number(totalRebalances),
    totalHarvestedUp: amount(totalHarvestedUp),
    totalCapitalAddedUsdg: amount(totalCapitalAddedUsdg, 6),
    maxPilotUsdg: unlimitedVersion ? null : amount(maxPilotUsdg, 6),
    capitalUnlimited: unlimitedVersion,
    autoUsdgSafetyExit: ['2.8.0', '2.9.0'].includes(version),
    chainlinkSafetyExit: version === '2.9.0',
    adaptiveAutomation: version === '3.0.0',
    safetyOracle: safetyOracle ? {
      ready: Boolean(safetyOracle[0]),
      spcxPriceUsdg: amount(safetyOracle[1], 6),
      spcxUpdatedAt: Number(safetyOracle[2]) * 1000,
      usdgUpdatedAt: Number(safetyOracle[3]) * 1000,
    } : null,
    mevProtection: ['2.8.0', '2.9.0', '3.0.0'].includes(version) ? 'TWAP_AND_PRICE_LIMIT' : 'LEGACY_PRICE_LIMIT',
    rangeWidth: Number(rangeWidth),
    supportsCapitalAdd: ['2.3.0', '2.4.0', '2.5.0', '2.6.0', '2.7.0', '2.8.0', '2.9.0'].includes(version),
    lastRebalanceAt: Number(lastRebalanceAt) * 1000,
    modeChangedAt: Number(modeChangedAt) * 1000,
    defensiveAnchor: Number(defensiveAnchor),
    oracleCardinalityRequired: Number(requiredOracleCardinality),
    adaptivePolicy: version === '3.0.0' ? {
      slowDrop15Ticks: Number(slowDrop15Ticks),
      slowDrop30Ticks: Number(slowDrop30Ticks),
      defenseExitTicks: Number(defenseExitTicks),
      recovery15Ticks: Number(recovery15Ticks),
      minDefensiveDurationSec: Number(minDefensiveDuration),
      minUsdgWaitDurationSec: Number(minUsdgWaitDuration),
    } : null,
    routeVerified,
    ownerLocked: sameAddress(owner, recipient) && sameAddress(owner, guardian),
    keeperVerified: expectedKeeperAddress ? sameAddress(keeper, expectedKeeperAddress) : false,
    keeperGasEth: amount(keeperGasBalance),
    balances: { SPCX: totalSpcx, USDG: totalUsdg, earnedUP: amount(earnedUp) },
    navUsd,
    position: tokenId > 0n ? {
      tokenId: tokenId.toString(),
      tickLower,
      tickUpper,
      liquidity: liquidity.toString(),
      inRange: Boolean(currentPosition[4]),
    } : null,
    rebalanceCounts: { tenMinutes: Number(rebalanceCounts[0]), oneHour: Number(rebalanceCounts[1]) },
  }
}

export async function verifyVaultForConfiguration(client, executorAddress, ownerAddress, keeperAddress) {
  const status = await readVaultStatus(client, executorAddress, keeperAddress)
  if (!status.routeVerified) throw new Error('자동화 금고의 버전 또는 고정 프로토콜 경로가 검증되지 않았습니다.')
  if (!sameAddress(status.owner, ownerAddress) || !sameAddress(status.recipient, ownerAddress) || !sameAddress(status.guardian, ownerAddress)) {
    throw new Error('owner·고정 수령 주소·guardian이 현재 연결 지갑 주소와 일치하지 않습니다.')
  }
  if (!status.keeperVerified) throw new Error('금고에 등록된 Keeper가 이 PC의 저권한 Keeper와 일치하지 않습니다.')
  return status
}
