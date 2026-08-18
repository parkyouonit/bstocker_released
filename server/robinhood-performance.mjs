import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs'
import { decodeEventLog, formatUnits, getAddress, parseAbi } from 'viem'
import { ROBINHOOD_CONTRACTS } from './robinhood.mjs'
import { strategyRange, tickToPrice } from './robinhood-strategy.mjs'

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const receiptCache = new Map()
const blockTimestampCache = new Map()
const lifecycleCache = new Map()
const ndjsonCache = new Map()
const lifecycleCacheMs = 60_000
const transferEvent = parseAbi(['event Transfer(address indexed from,address indexed to,uint256 value)'])[0]
const approvalEvent = parseAbi(['event Approval(address indexed owner,address indexed spender,uint256 value)'])[0]
const poolAbi = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,bool unlocked)',
])
const lifecycleAbi = parseAbi([
  'event PositionStarted(uint256 indexed tokenId,int24 tickLower,int24 tickUpper,uint256 principalUsdg,address swapTokenIn,uint256 swapAmountIn,uint256 swapAmountOut)',
  'event CapitalAdded(uint256 indexed previousTokenId,uint256 indexed nextTokenId,uint256 addedPrincipalUsdg,uint256 totalPrincipalUsdg,int24 tickLower,int24 tickUpper,address swapTokenIn,uint256 swapAmountIn,uint256 swapAmountOut)',
  'event PositionExited(uint256 indexed tokenId,bool swappedToUsdg,uint256 spcxReturned,uint256 usdgReturned)',
])

function finiteNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function percentage(value, principal) {
  return principal > 0 && Number.isFinite(value) ? value / principal * 100 : null
}

function normalizedAddress(value) {
  try { return getAddress(value).toLowerCase() } catch { return null }
}

function topicAddress(topic) {
  return typeof topic === 'string' && topic.length >= 42 ? `0x${topic.slice(-40)}`.toLowerCase() : null
}

function parseNdjson(text, dropLeadingPartial = false) {
  let lines = text.split(/\r?\n/)
  if (dropLeadingPartial) lines = lines.slice(1)
  const remainder = /\r?\n$/.test(text) ? '' : (lines.pop() || '')
  const rows = lines.filter(Boolean).map(line => {
    try { return JSON.parse(line) } catch { return null }
  }).filter(Boolean)
  return { rows, remainder }
}

function readFileSlice(file, start, length) {
  let descriptor
  try {
    const buffer = Buffer.alloc(length)
    descriptor = openSync(file, 'r')
    const bytesRead = readSync(descriptor, buffer, 0, length, start)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    if (descriptor != null) closeSync(descriptor)
  }
}

function readNdjson(file, maximumBytes = 5 * 1024 * 1024) {
  if (!existsSync(file)) return []
  try {
    const stats = statSync(file)
    const size = stats.size
    const cacheKey = `${file}:${maximumBytes}`
    const identity = `${stats.dev}:${stats.ino}:${stats.birthtimeMs}`
    const cached = ndjsonCache.get(cacheKey)
    if (size <= 0) {
      ndjsonCache.set(cacheKey, { identity, size: 0, rows: [], remainder: '' })
      return []
    }
    if (cached && cached.identity === identity && size === cached.size) return cached.rows
    if (cached && cached.identity === identity && size > cached.size && size - cached.size <= maximumBytes) {
      const appended = readFileSlice(file, cached.size, size - cached.size)
      const parsed = parseNdjson(`${cached.remainder}${appended}`)
      cached.rows.push(...parsed.rows)
      cached.size = size
      cached.remainder = parsed.remainder
      return cached.rows
    }
    const bytesToRead = Math.min(size, maximumBytes)
    const start = Math.max(0, size - bytesToRead)
    const parsed = parseNdjson(readFileSlice(file, start, bytesToRead), start > 0)
    ndjsonCache.set(cacheKey, { identity, size, rows: parsed.rows, remainder: parsed.remainder })
    return parsed.rows
  } catch {
    return []
  }
}

function transactionHash(row) {
  const hash = row?.hash || row?.executed?.hash
  return typeof hash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(hash) ? hash.toLowerCase() : null
}

function gasEth(row) {
  try {
    const gasUsed = BigInt(row?.gasUsed || 0)
    const gasPrice = BigInt(row?.effectiveGasPrice || 0)
    return Number(formatUnits(gasUsed * gasPrice, 18))
  } catch {
    return 0
  }
}

function receiptGasEth(receipt) {
  try {
    return Number(formatUnits(BigInt(receipt?.gasUsed || 0) * BigInt(receipt?.effectiveGasPrice || 0), 18))
  } catch {
    return 0
  }
}

function bigintDistance(a, b) {
  return a >= b ? a - b : b - a
}

function eventAmount(value, decimals) {
  try { return Number(formatUnits(BigInt(value || 0), decimals)) } catch { return 0 }
}

function upTransfersFromReceipt(receipt, vaultAddress, recipientAddress) {
  const vault = normalizedAddress(vaultAddress)
  const recipient = normalizedAddress(recipientAddress)
  if (!vault || !recipient || !Array.isArray(receipt?.logs)) return 0
  return receipt.logs.reduce((total, log) => {
    if (normalizedAddress(log?.address) !== ROBINHOOD_CONTRACTS.up.toLowerCase()) return total
    const topics = Array.isArray(log?.topics) ? log.topics : []
    if (String(topics[0]).toLowerCase() !== TRANSFER_TOPIC || topicAddress(topics[1]) !== vault || topicAddress(topics[2]) !== recipient) return total
    try { return total + Number(formatUnits(BigInt(log.data || 0), 18)) } catch { return total }
  }, 0)
}

function rebalanceUpEmitted(row) {
  return row?.action === 'AUTO_REBALANCE' ? Math.max(0, finiteNumber(row?.paidUp) || 0) : 0
}

async function loadReceipt(client, hash) {
  if (receiptCache.has(hash)) return receiptCache.get(hash)
  try {
    const receipt = await client.getTransactionReceipt({ hash })
    receiptCache.set(hash, receipt)
    if (receiptCache.size > 256) receiptCache.delete(receiptCache.keys().next().value)
    return receipt
  } catch {
    return null
  }
}

async function loadBlockTimestamp(client, blockNumber) {
  const key = blockNumber.toString()
  if (blockTimestampCache.has(key)) return blockTimestampCache.get(key)
  const block = await client.getBlock({ blockNumber })
  const timestamp = Number(block.timestamp) * 1000
  blockTimestampCache.set(key, timestamp)
  if (blockTimestampCache.size > 256) blockTimestampCache.delete(blockTimestampCache.keys().next().value)
  return timestamp
}

function computeRolloverAccounting(inputSessions, currentNavUsd = 0) {
  const sessions = inputSessions.map(session => ({ ...session }))
  let capitalContributedUsd = 0
  let capitalWithdrawnUsd = 0
  for (let index = 0; index < sessions.length; index += 1) {
    const session = sessions[index]
    const previousRecoveryUsd = index > 0 ? Math.max(0, finiteNumber(sessions[index - 1].recoveredUsd) || 0) : 0
    session.rolledCapitalUsd = index === 0 ? 0 : Math.min(previousRecoveryUsd, session.startPrincipalUsd)
    session.freshCapitalUsd = index === 0
      ? session.startPrincipalUsd
      : Math.max(0, session.startPrincipalUsd - previousRecoveryUsd)
    session.capitalWithdrawnUsd = index === 0 ? 0 : Math.max(0, previousRecoveryUsd - session.startPrincipalUsd)
    session.lpProfitUsd = session.endedAt == null
      ? Math.max(0, finiteNumber(currentNavUsd) || 0) - session.principalUsd
      : Math.max(0, finiteNumber(session.recoveredUsd) || 0) - session.principalUsd
    capitalContributedUsd += session.freshCapitalUsd + session.capitalAddedUsd
    capitalWithdrawnUsd += session.capitalWithdrawnUsd
  }
  const activeSession = sessions.findLast(session => session.endedAt == null) || null
  if (!activeSession && sessions.length) capitalWithdrawnUsd += Math.max(0, finiteNumber(sessions.at(-1).recoveredUsd) || 0)
  const activeNavUsd = activeSession ? Math.max(0, finiteNumber(currentNavUsd) || 0) : 0
  const lpProfitUsd = activeNavUsd + capitalWithdrawnUsd - capitalContributedUsd
  return {
    sessions,
    activeSessionIndex: activeSession?.index ?? null,
    capitalContributedUsd,
    capitalWithdrawnUsd,
    activeNavUsd,
    lpProfitUsd,
  }
}

function snapshotLifecycleAccounting(lifecycle, blockNumber, navUsd) {
  if (!lifecycle?.sessions?.length || blockNumber == null) return null
  let snapshotBlock
  try { snapshotBlock = BigInt(blockNumber) } catch { return null }
  const session = lifecycle.sessions.findLast(item => {
    const start = BigInt(item.startBlock)
    const end = item.endBlock == null ? null : BigInt(item.endBlock)
    return start <= snapshotBlock && (end == null || snapshotBlock <= end)
  })
  if (!session) return null
  const sessions = lifecycle.sessions
    .filter(item => BigInt(item.startBlock) <= snapshotBlock)
    .map(item => item.index === session.index ? { ...item, endedAt: null, recoveredUsd: null } : item)
  const accounting = computeRolloverAccounting(sessions, navUsd)
  const paidUp = (lifecycle.timeline?.rewards || []).reduce((total, entry) => (
    BigInt(entry.blockNumber) <= snapshotBlock ? total + entry.amountUp : total
  ), 0)
  const gasSpentEth = (lifecycle.timeline?.gas || []).reduce((total, entry) => (
    BigInt(entry.blockNumber) <= snapshotBlock ? total + entry.gasEth : total
  ), 0)
  return { sessionIndex: session.index, accounting, paidUp, gasSpentEth }
}

async function resolveExitedRecovery(client, { owner, session, nextStartBlock }) {
  const spcxReturnedRaw = BigInt(session.spcxReturnedRaw || 0)
  const usdgReturnedUsd = eventAmount(session.usdgReturnedRaw, 6)
  if (spcxReturnedRaw === 0n) return { recoveredUsd: usdgReturnedUsd, recoverySource: 'EXIT_USDG', rolloverSwapHash: null, rolloverSwapBlock: null }
  const fromBlock = session.endBlock + 1n
  const toBlock = nextStartBlock == null ? 'latest' : nextStartBlock
  const [spcxOut, usdgIn] = await Promise.all([
    client.getLogs({ address: ROBINHOOD_CONTRACTS.spcx, event: transferEvent, args: { from: owner }, fromBlock, toBlock }),
    client.getLogs({ address: ROBINHOOD_CONTRACTS.usdg, event: transferEvent, args: { to: owner }, fromBlock, toBlock }),
  ])
  const tolerance = spcxReturnedRaw / 1_000n > 1_000_000n ? spcxReturnedRaw / 1_000n : 1_000_000n
  const matched = spcxOut
    .filter(log => bigintDistance(BigInt(log.args?.value || 0), spcxReturnedRaw) <= tolerance)
    .sort((a, b) => Number(a.blockNumber - b.blockNumber))[0]
  if (matched) {
    const hash = matched.transactionHash.toLowerCase()
    const receivedRaw = usdgIn
      .filter(log => log.transactionHash.toLowerCase() === hash)
      .reduce((total, log) => total + BigInt(log.args?.value || 0), 0n)
    if (receivedRaw > 0n) return {
      recoveredUsd: usdgReturnedUsd + eventAmount(receivedRaw, 6),
      recoverySource: 'MATCHED_WALLET_SWAP',
      rolloverSwapHash: hash,
      rolloverSwapBlock: matched.blockNumber,
    }
  }
  const slot0 = await client.readContract({
    address: ROBINHOOD_CONTRACTS.pool,
    abi: poolAbi,
    functionName: 'slot0',
    blockNumber: session.endBlock,
  })
  const fallbackPrice = tickToPrice(Number(slot0[1]), 18, 6)
  return {
    recoveredUsd: usdgReturnedUsd + eventAmount(spcxReturnedRaw, 18) * fallbackPrice,
    recoverySource: 'EXIT_BLOCK_SPOT_FALLBACK',
    rolloverSwapHash: null,
    rolloverSwapBlock: null,
  }
}

async function loadLifecycleAccounting(client, vault) {
  const cacheKey = `${normalizedAddress(vault.address)}:${normalizedAddress(vault.recipient)}`
  const cached = lifecycleCache.get(cacheKey)
  if (cached && cached.expires > Date.now()) {
    const refreshed = computeRolloverAccounting(cached.value.sessions, vault.navUsd)
    const { sessions: ignoredSessions, ...accounting } = refreshed
    return { ...cached.value, sessions: refreshed.sessions, accounting }
  }
  const owner = getAddress(vault.recipient)
  const vaultAddress = getAddress(vault.address)
  const rawLogs = await client.getLogs({ address: vaultAddress, fromBlock: 0n, toBlock: 'latest' })
  const lifecycleEvents = rawLogs.map(log => {
    try { return { ...log, ...decodeEventLog({ abi: lifecycleAbi, data: log.data, topics: log.topics }) } } catch { return null }
  }).filter(Boolean).sort((a, b) => Number(a.blockNumber - b.blockNumber) || Number(a.logIndex - b.logIndex))
  const sessions = []
  for (const event of lifecycleEvents) {
    if (event.eventName === 'PositionStarted') {
      sessions.push({
        index: sessions.length + 1,
        tokenId: event.args.tokenId.toString(),
        startBlock: event.blockNumber,
        startHash: event.transactionHash.toLowerCase(),
        startPrincipalUsd: eventAmount(event.args.principalUsdg, 6),
        principalUsd: eventAmount(event.args.principalUsdg, 6),
        capitalAddedUsd: 0,
        endBlock: null,
        endHash: null,
        endedAt: null,
        spcxReturnedRaw: 0n,
        usdgReturnedRaw: 0n,
        recoveredUsd: null,
        recoverySource: null,
        rolloverSwapHash: null,
        rolloverSwapBlock: null,
        paidUp: 0,
        gasSpentEth: 0,
      })
    } else if (event.eventName === 'CapitalAdded' && sessions.length) {
      const session = sessions.at(-1)
      session.tokenId = event.args.nextTokenId.toString()
      session.capitalAddedUsd += eventAmount(event.args.addedPrincipalUsdg, 6)
      session.principalUsd = eventAmount(event.args.totalPrincipalUsdg, 6)
    } else if (event.eventName === 'PositionExited' && sessions.length) {
      const session = sessions.findLast(item => item.endBlock == null)
      if (!session) continue
      session.endBlock = event.blockNumber
      session.endHash = event.transactionHash.toLowerCase()
      session.spcxReturnedRaw = BigInt(event.args.spcxReturned || 0)
      session.usdgReturnedRaw = BigInt(event.args.usdgReturned || 0)
      session.swappedToUsdg = Boolean(event.args.swappedToUsdg)
    }
  }
  if (!sessions.length) {
    const empty = { sessions: [], accounting: computeRolloverAccounting([], vault.navUsd), paidUp: 0, gasSpentEth: 0, timeline: { rewards: [], gas: [] } }
    lifecycleCache.set(cacheKey, { expires: Date.now() + lifecycleCacheMs, value: empty })
    return empty
  }

  await Promise.all(sessions.map(async (session, index) => {
    const [startedAt, endedAt] = await Promise.all([
      loadBlockTimestamp(client, session.startBlock),
      session.endBlock == null ? null : loadBlockTimestamp(client, session.endBlock),
    ])
    session.startedAt = startedAt
    session.endedAt = endedAt
    if (session.endBlock == null) return
    const recovery = await resolveExitedRecovery(client, {
      owner,
      session,
      nextStartBlock: sessions[index + 1]?.startBlock ?? null,
    })
    Object.assign(session, recovery)
  }))

  const firstStartBlock = sessions[0].startBlock
  const [upTransfers, spcxApprovals, usdgApprovals] = await Promise.all([
    client.getLogs({ address: ROBINHOOD_CONTRACTS.up, event: transferEvent, args: { from: vaultAddress, to: owner }, fromBlock: firstStartBlock, toBlock: 'latest' }),
    client.getLogs({ address: ROBINHOOD_CONTRACTS.spcx, event: approvalEvent, args: { owner, spender: vaultAddress }, fromBlock: firstStartBlock, toBlock: 'latest' }),
    client.getLogs({ address: ROBINHOOD_CONTRACTS.usdg, event: approvalEvent, args: { owner, spender: vaultAddress }, fromBlock: firstStartBlock, toBlock: 'latest' }),
  ])
  const paidUp = upTransfers.reduce((total, log) => total + eventAmount(log.args?.value, 18), 0)
  const transactionBlocks = new Map()
  rawLogs.filter(log => log.blockNumber >= firstStartBlock).forEach(log => transactionBlocks.set(log.transactionHash.toLowerCase(), log.blockNumber))
  for (const log of [...spcxApprovals, ...usdgApprovals]) transactionBlocks.set(log.transactionHash.toLowerCase(), log.blockNumber)
  for (const session of sessions) {
    if (session.rolloverSwapHash) transactionBlocks.set(session.rolloverSwapHash, session.rolloverSwapBlock)
  }
  const transactionEntries = [...transactionBlocks.entries()]
  const receipts = await Promise.all(transactionEntries.map(([hash]) => loadReceipt(client, hash)))
  let gasSpentEth = 0
  const gasTimeline = []
  transactionEntries.forEach(([hash, blockNumber], index) => {
    const gas = receiptGasEth(receipts[index])
    gasSpentEth += gas
    gasTimeline.push({ blockNumber: blockNumber.toString(), gasEth: gas })
    const session = sessions.findLast(item => blockNumber >= item.startBlock) || sessions[0]
    session.gasSpentEth += gas
  })
  const rewardTimeline = upTransfers.map(log => ({ blockNumber: log.blockNumber.toString(), amountUp: eventAmount(log.args?.value, 18) }))
  for (const log of upTransfers) {
    const session = sessions.findLast(item => log.blockNumber >= item.startBlock) || sessions[0]
    session.paidUp += eventAmount(log.args?.value, 18)
  }
  const accounting = computeRolloverAccounting(sessions, vault.navUsd)
  const publicSessions = accounting.sessions.map(session => {
    const { spcxReturnedRaw, usdgReturnedRaw, ...publicSession } = session
    return {
      ...publicSession,
      startBlock: session.startBlock.toString(),
      endBlock: session.endBlock == null ? null : session.endBlock.toString(),
      rolloverSwapBlock: session.rolloverSwapBlock == null ? null : session.rolloverSwapBlock.toString(),
      spcxReturned: eventAmount(spcxReturnedRaw, 18),
      usdgReturned: eventAmount(usdgReturnedRaw, 6),
    }
  })
  const { sessions: ignoredSessions, ...accountingSummary } = accounting
  const value = { sessions: publicSessions, accounting: accountingSummary, paidUp, gasSpentEth, timeline: { rewards: rewardTimeline, gas: gasTimeline } }
  lifecycleCache.set(cacheKey, { expires: Date.now() + lifecycleCacheMs, value })
  return value
}

function selectCurrentVaultTransactions(rows, totalRebalances) {
  const transactions = rows
    .map(row => ({ ...row, normalizedHash: transactionHash(row), atNumber: finiteNumber(row?.at) }))
    .filter(row => row.normalizedHash && row.atNumber != null)
    .sort((a, b) => a.atNumber - b.atNumber)
  const rebalanceRows = transactions.filter(row => row.action === 'AUTO_REBALANCE')
  const count = Math.max(0, Math.floor(finiteNumber(totalRebalances) || 0))
  if (!count || !rebalanceRows.length) return []
  const first = rebalanceRows.at(-Math.min(count, rebalanceRows.length))
  return transactions.filter(row => row.atNumber >= first.atNumber)
}

function valueSnapshot({ principalUsd, navUsd, paidUp, earnedUp = 0, gasSpentEth, upPriceUsd, ethPriceUsd, lpProfitUsdOverride }) {
  const lpProfitUsd = lpProfitUsdOverride === undefined ? (navUsd == null ? null : navUsd - principalUsd) : finiteNumber(lpProfitUsdOverride)
  const totalRewardUp = Math.max(0, paidUp + earnedUp)
  const upValueUsd = upPriceUsd == null ? null : totalRewardUp * upPriceUsd
  const gasSpentUsd = ethPriceUsd == null ? null : gasSpentEth * ethPriceUsd
  const netProfitUsd = lpProfitUsd == null || upValueUsd == null || gasSpentUsd == null
    ? null
    : lpProfitUsd + upValueUsd - gasSpentUsd
  return {
    principalUsd,
    navUsd,
    lpProfitUsd,
    lpReturnPercent: lpProfitUsd == null ? null : percentage(lpProfitUsd, principalUsd),
    paidUp,
    earnedUp,
    totalRewardUp,
    upValueUsd,
    gasSpentEth,
    gasSpentUsd,
    netProfitUsd,
    netReturnPercent: netProfitUsd == null ? null : percentage(netProfitUsd, principalUsd),
  }
}

export async function loadRobinhoodPerformance({
  client,
  transactionFile,
  historyFile,
  vault,
  marketPrices,
  limit = 12,
}) {
  if (!vault || !vault.routeVerified) return null
  const principalUsd = Math.max(0, finiteNumber(vault.principalUsdg) || 0)
  let lifecycle = null
  let lifecycleError = null
  try {
    lifecycle = await loadLifecycleAccounting(client, vault)
  } catch (error) {
    lifecycleError = error instanceof Error ? error.message : String(error)
  }
  const transactionRows = selectCurrentVaultTransactions(readNdjson(transactionFile), vault.totalRebalances)
  const historyByHash = new Map(readNdjson(historyFile, 10 * 1024 * 1024).map(row => [transactionHash(row), row]).filter(([hash]) => hash))
  const receipts = await Promise.all(transactionRows.map(row => loadReceipt(client, row.normalizedHash)))
  const rows = transactionRows.map((row, index) => {
    const receipt = receipts[index]
    const receiptVault = normalizedAddress(receipt?.to)
    const belongsToVault = !receiptVault || receiptVault === normalizedAddress(vault.address)
    return {
      ...row,
      belongsToVault,
      blockNumber: receipt?.blockNumber?.toString() || row?.blockNumber || row?.executed?.blockNumber || null,
      gasEth: gasEth(row),
      paidUp: belongsToVault
        ? receipt ? upTransfersFromReceipt(receipt, vault.address, vault.recipient) : Math.max(0, finiteNumber(row?.rewardUp) || 0)
        : 0,
      history: historyByHash.get(row.normalizedHash) || null,
    }
  }).filter(row => row.belongsToVault)

  let cumulativeGasEth = 0
  let cumulativeRebalanceUp = 0
  let cumulativeHarvestUp = 0
  const snapshots = []
  for (const row of rows) {
    cumulativeGasEth += row.gasEth
    if (row.action === 'AUTO_HARVEST_UP') cumulativeHarvestUp += row.paidUp
    else cumulativeRebalanceUp += row.paidUp
    if (row.action !== 'AUTO_REBALANCE') continue
    const navUsd = finiteNumber(row?.navUsdAfter) ?? finiteNumber(row?.history?.strategyNavUsd)
    const paidUp = cumulativeRebalanceUp + Math.max(cumulativeHarvestUp, finiteNumber(row?.totalHarvestedUpAfter) || 0)
    const tick = finiteNumber(row?.expectedTick) ?? finiteNumber(row?.history?.tick)
    const connected = snapshotLifecycleAccounting(lifecycle, row.blockNumber, navUsd)
    snapshots.push({
      at: row.atNumber,
      hash: row.normalizedHash,
      rebalanceUpEmitted: rebalanceUpEmitted(row),
      sessionIndex: connected?.sessionIndex ?? null,
      tick,
      range: row?.rangeAfter || (tick == null ? row?.history?.range || null : strategyRange(tick, ROBINHOOD_CONTRACTS.tickSpacing)),
      ...valueSnapshot({
        principalUsd: connected?.accounting.capitalContributedUsd ?? finiteNumber(row?.principalUsdAfter) ?? principalUsd,
        navUsd,
        lpProfitUsdOverride: connected?.accounting.lpProfitUsd,
        paidUp: connected?.paidUp ?? paidUp,
        gasSpentEth: connected?.gasSpentEth ?? cumulativeGasEth,
        upPriceUsd: marketPrices?.upUsd ?? null,
        ethPriceUsd: marketPrices?.ethUsd ?? null,
      }),
    })
  }

  const explicitHarvestUp = Math.max(cumulativeHarvestUp, finiteNumber(vault.totalHarvestedUp) || 0)
  const paidUp = cumulativeRebalanceUp + explicitHarvestUp
  const fallbackCurrent = valueSnapshot({
    principalUsd,
    navUsd: finiteNumber(vault.navUsd),
    paidUp,
    earnedUp: Math.max(0, finiteNumber(vault?.balances?.earnedUP) || 0),
    gasSpentEth: cumulativeGasEth,
    upPriceUsd: marketPrices?.upUsd ?? null,
    ethPriceUsd: marketPrices?.ethUsd ?? null,
  })
  const activeSession = lifecycle?.sessions.find(session => session.endedAt == null) || null
  const current = activeSession ? valueSnapshot({
    principalUsd: activeSession.principalUsd,
    navUsd: finiteNumber(vault.navUsd),
    paidUp: activeSession.paidUp,
    earnedUp: Math.max(0, finiteNumber(vault?.balances?.earnedUP) || 0),
    gasSpentEth: activeSession.gasSpentEth,
    upPriceUsd: marketPrices?.upUsd ?? null,
    ethPriceUsd: marketPrices?.ethUsd ?? null,
  }) : fallbackCurrent
  const lifetime = lifecycle?.sessions.length ? valueSnapshot({
    principalUsd: lifecycle.accounting.capitalContributedUsd,
    navUsd: lifecycle.accounting.activeNavUsd,
    lpProfitUsdOverride: lifecycle.accounting.lpProfitUsd,
    paidUp: lifecycle.paidUp,
    earnedUp: activeSession ? Math.max(0, finiteNumber(vault?.balances?.earnedUP) || 0) : 0,
    gasSpentEth: lifecycle.gasSpentEth,
    upPriceUsd: marketPrices?.upUsd ?? null,
    ethPriceUsd: marketPrices?.ethUsd ?? null,
  }) : fallbackCurrent
  const warnings = [
    '연결 누적 LP 손익은 각 회차 원금, 종료 후 지갑의 실제 SPCX→USDG 교환 수령액, 다음 회차 추가 투입액과 현재 NAV를 이어 계산합니다.',
    'UP 보상은 Vault에서 수령 지갑으로 전송된 전체 온체인 수량과 현재 미수확 수량을 합산해 Relay 현재가로 환산합니다.',
    '리밸런싱별 UP 배출은 해당 AUTO_REBALANCE 영수증에서 Vault가 고정 수령 주소로 실제 전송한 UP Transfer만 집계합니다.',
    '총 운용 가스는 첫 진입 이후 Vault 호출, 토큰 승인, 회차 연결용 교환에 실제 사용된 ETH를 합산해 현재 ETH 가격으로 환산합니다.',
  ]
  if (marketPrices?.stale) warnings.push('Relay 가격이 일시적으로 갱신되지 않아 마지막 정상 가격을 사용했습니다.')
  if (marketPrices?.upUsd == null || marketPrices?.ethUsd == null) warnings.push('Relay 가격 일부를 받지 못해 순손익은 아직 계산하지 않았습니다.')
  if (snapshots.length < Number(vault.totalRebalances || 0)) warnings.push('이 Vault의 초기 리밸런싱 기록 일부가 로컬 로그에 없어 표시 가능한 시점만 나열합니다.')
  if (lifecycleError) warnings.push(`회차 연결 원장을 불러오지 못해 현재 회차 기준으로 표시합니다: ${lifecycleError}`)
  if (lifecycle?.sessions.some(session => session.recoverySource === 'EXIT_BLOCK_SPOT_FALLBACK')) warnings.push('실제 교환 트랜잭션을 찾지 못한 종료 회차는 종료 블록의 풀 가격으로 회수액을 추정했습니다.')

  return {
    asOf: Date.now(),
    priceSource: marketPrices?.source || 'RELAY',
    prices: {
      upUsd: marketPrices?.upUsd ?? null,
      ethUsd: marketPrices?.ethUsd ?? null,
      fetchedAt: marketPrices?.fetchedAt ?? null,
      stale: Boolean(marketPrices?.stale),
    },
    current,
    activeSession: current,
    lifetime,
    sessions: lifecycle?.sessions || [],
    accounting: lifecycle?.accounting || null,
    rebalances: snapshots.slice(-Math.max(1, Math.min(50, limit))).reverse(),
    warnings,
  }
}

export const robinhoodPerformanceInternals = {
  gasEth,
  readNdjson,
  selectCurrentVaultTransactions,
  snapshotLifecycleAccounting,
  upTransfersFromReceipt,
  rebalanceUpEmitted,
  computeRolloverAccounting,
  valueSnapshot,
}
