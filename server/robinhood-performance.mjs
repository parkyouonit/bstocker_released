import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs'
import { formatUnits, getAddress } from 'viem'
import { ROBINHOOD_CONTRACTS } from './robinhood.mjs'
import { strategyRange } from './robinhood-strategy.mjs'

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const receiptCache = new Map()

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

function readNdjson(file, maximumBytes = 5 * 1024 * 1024) {
  if (!existsSync(file)) return []
  let descriptor
  try {
    const size = statSync(file).size
    if (size <= 0) return []
    const bytesToRead = Math.min(size, maximumBytes)
    const start = Math.max(0, size - bytesToRead)
    const buffer = Buffer.alloc(bytesToRead)
    descriptor = openSync(file, 'r')
    const bytesRead = readSync(descriptor, buffer, 0, bytesToRead, start)
    let lines = buffer.subarray(0, bytesRead).toString('utf8').split(/\r?\n/)
    if (start > 0) lines = lines.slice(1)
    return lines.filter(Boolean).map(line => {
      try { return JSON.parse(line) } catch { return null }
    }).filter(Boolean)
  } catch {
    return []
  } finally {
    if (descriptor != null) closeSync(descriptor)
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

function valueSnapshot({ principalUsd, navUsd, paidUp, earnedUp = 0, gasSpentEth, upPriceUsd, ethPriceUsd }) {
  const lpProfitUsd = navUsd == null ? null : navUsd - principalUsd
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
    snapshots.push({
      at: row.atNumber,
      hash: row.normalizedHash,
      tick,
      range: row?.rangeAfter || (tick == null ? row?.history?.range || null : strategyRange(tick, ROBINHOOD_CONTRACTS.tickSpacing)),
      ...valueSnapshot({
        principalUsd: finiteNumber(row?.principalUsdAfter) ?? principalUsd,
        navUsd,
        paidUp,
        gasSpentEth: cumulativeGasEth,
        upPriceUsd: marketPrices?.upUsd ?? null,
        ethPriceUsd: marketPrices?.ethUsd ?? null,
      }),
    })
  }

  const explicitHarvestUp = Math.max(cumulativeHarvestUp, finiteNumber(vault.totalHarvestedUp) || 0)
  const paidUp = cumulativeRebalanceUp + explicitHarvestUp
  const current = valueSnapshot({
    principalUsd,
    navUsd: finiteNumber(vault.navUsd),
    paidUp,
    earnedUp: Math.max(0, finiteNumber(vault?.balances?.earnedUP) || 0),
    gasSpentEth: cumulativeGasEth,
    upPriceUsd: marketPrices?.upUsd ?? null,
    ethPriceUsd: marketPrices?.ethUsd ?? null,
  })
  const warnings = [
    'LP 손익은 현재 NAV와 원금의 차이로, 누적 LP 수수료와 SPCX 가격 변동·비영구손실이 함께 포함됩니다.',
    'UP 보상은 획득 수량을 Relay 현재 가격으로 환산한 값이며 실제 매도 체결가는 달라질 수 있습니다.',
    '가스 USD는 실제 사용 ETH를 Relay 현재 ETH 가격으로 환산한 값입니다.',
  ]
  if (marketPrices?.stale) warnings.push('Relay 가격이 일시적으로 갱신되지 않아 마지막 정상 가격을 사용했습니다.')
  if (marketPrices?.upUsd == null || marketPrices?.ethUsd == null) warnings.push('Relay 가격 일부를 받지 못해 순손익은 아직 계산하지 않았습니다.')
  if (snapshots.length < Number(vault.totalRebalances || 0)) warnings.push('이 Vault의 초기 리밸런싱 기록 일부가 로컬 로그에 없어 표시 가능한 시점만 나열합니다.')

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
    rebalances: snapshots.slice(-Math.max(1, Math.min(50, limit))).reverse(),
    warnings,
  }
}

export const robinhoodPerformanceInternals = {
  gasEth,
  readNdjson,
  selectCurrentVaultTransactions,
  upTransfersFromReceipt,
  valueSnapshot,
}
