import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeAbiParameters } from 'viem'
import { floorTickToSpacing, percentChange, tickToPrice } from '../server/robinhood-strategy.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const outputFile = join(root, 'work', 'robinhood-replay-24h.json')
const pool = '0x9d590437ABaAe12cf9fE0627cAF4CFd633152599'
const swapTopic = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67'
const rpcUrl = process.env.ROBINHOOD_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com'
const replayWindowMs = 24 * 60 * 60_000

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
const toHex = value => `0x${BigInt(value).toString(16)}`

async function requestRpc(body, attempt = 0) {
  let response
  try {
    response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    })
  } catch (error) {
    if (attempt < 6) {
      await wait(Math.min(15_000, 2_000 * (attempt + 1)))
      return requestRpc(body, attempt + 1)
    }
    throw error
  }
  if (!response.ok) {
    if ((response.status === 429 || response.status >= 500) && attempt < 6) {
      await wait(Math.min(15_000, 2_000 * (attempt + 1)))
      return requestRpc(body, attempt + 1)
    }
    throw new Error(`Robinhood RPC HTTP ${response.status}`)
  }
  return response.json()
}

async function rpc(method, params) {
  const payload = await requestRpc({ jsonrpc: '2.0', id: 1, method, params })
  if (payload?.error) throw new Error(`Robinhood RPC ${method}: ${JSON.stringify(payload.error)}`)
  return payload?.result
}

async function rpcBatch(calls) {
  const payload = await requestRpc(calls.map((call, index) => ({
    jsonrpc: '2.0',
    id: index + 1,
    method: call.method,
    params: call.params,
  })))
  if (!Array.isArray(payload)) throw new Error('Robinhood RPC did not return a batch response.')
  const responses = new Map(payload.map(item => [Number(item.id), item]))
  return calls.map((call, index) => {
    const item = responses.get(index + 1)
    if (!item || item.error) throw new Error(`Robinhood RPC ${call.method}: ${JSON.stringify(item?.error || 'missing response')}`)
    return item.result
  })
}

async function estimateReplayStartBlock(latestBlock, latestTimestampSeconds) {
  const sampleDistance = latestBlock > 100_000n ? 100_000n : latestBlock
  if (sampleDistance === 0n) return { startBlock: 0n, secondsPerBlock: 1 }
  const sampleBlock = latestBlock - sampleDistance
  const sampleHeader = await rpc('eth_getBlockByNumber', [toHex(sampleBlock), false])
  const elapsedSeconds = Math.max(1, Number(latestTimestampSeconds - BigInt(sampleHeader.timestamp)))
  const secondsPerBlock = elapsedSeconds / Number(sampleDistance)
  const requiredBlocks = BigInt(Math.ceil((replayWindowMs / 1000) / secondsPerBlock * 1.2)) + 2_000n
  return {
    startBlock: latestBlock > requiredBlocks ? latestBlock - requiredBlocks : 0n,
    secondsPerBlock,
  }
}

async function buildBlockTimeIndex(logs) {
  if (!logs.length) throw new Error('Cannot build a block time index without swap logs.')
  const logBlocks = logs.map(log => BigInt(log.blockNumber))
  const minimumBlock = logBlocks.reduce((minimum, value) => value < minimum ? value : minimum)
  const maximumBlock = logBlocks.reduce((maximum, value) => value > maximum ? value : maximum)
  const anchorSpacing = 5_000n
  const anchorBlocks = []
  for (let block = minimumBlock; block <= maximumBlock; block += anchorSpacing) anchorBlocks.push(block)
  if (anchorBlocks.at(-1) !== maximumBlock) anchorBlocks.push(maximumBlock)

  const headers = []
  const batchSize = 100
  for (let index = 0; index < anchorBlocks.length; index += batchSize) {
    const batch = anchorBlocks.slice(index, index + batchSize)
    const values = await rpcBatch(batch.map(blockNumber => ({
      method: 'eth_getBlockByNumber',
      params: [toHex(blockNumber), false],
    })))
    headers.push(...values)
    if (index + batchSize < anchorBlocks.length) await wait(1_000)
  }

  const anchors = headers.map((header, index) => {
    if (!header) throw new Error(`Missing block ${anchorBlocks[index]} while replaying swaps.`)
    return { block: anchorBlocks[index], at: Number(BigInt(header.timestamp)) * 1000 }
  })

  function timestampFor(blockNumberHex) {
    const block = BigInt(blockNumberHex)
    let left = 0
    let right = anchors.length - 1
    while (left + 1 < right) {
      const middle = Math.floor((left + right) / 2)
      if (anchors[middle].block <= block) left = middle
      else right = middle
    }
    const before = anchors[left]
    const after = anchors[Math.min(right, anchors.length - 1)]
    if (before.block === block || before.block === after.block) return before.at
    if (after.block === block) return after.at
    const ratio = Number(block - before.block) / Number(after.block - before.block)
    return Math.round(before.at + (after.at - before.at) * ratio)
  }

  return { timestampFor, anchorCount: anchors.length, anchorSpacing: Number(anchorSpacing) }
}

function decodeSwap(log, timestampForBlock) {
  const [, , sqrtPriceX96, liquidity, tick] = decodeAbiParameters([
    { type: 'int256' },
    { type: 'int256' },
    { type: 'uint160' },
    { type: 'uint128' },
    { type: 'int24' },
  ], log.data)
  const at = timestampForBlock(log.blockNumber)
  if (!Number.isFinite(at)) throw new Error(`Missing timestamp for swap block ${log.blockNumber}.`)
  return {
    at,
    blockNumber: Number.parseInt(log.blockNumber, 16),
    transactionHash: log.transactionHash,
    tick: Number(tick),
    sqrtPriceX96: sqrtPriceX96.toString(),
    liquidity: liquidity.toString(),
    price: tickToPrice(Number(tick), 18, 6),
  }
}

function sampleAtOrBefore(events, cutoffAt) {
  let left = 0
  let right = events.length - 1
  let result
  while (left <= right) {
    const middle = Math.floor((left + right) / 2)
    if (events[middle].at <= cutoffAt) {
      result = events[middle]
      left = middle + 1
    } else right = middle - 1
  }
  return result
}

function centeredRange(tick, intervals) {
  const spacing = 10
  const anchor = floorTickToSpacing(tick, spacing)
  const below = Math.floor((intervals - 1) / 2)
  return { lower: anchor - below * spacing, upper: anchor + (intervals - below) * spacing }
}

function replayRange(events, intervals) {
  let range = centeredRange(events[0].tick, intervals)
  let lastAt = events[0].at
  let lastInRange = true
  let inRangeMs = 0
  let totalMs = 0
  let rebalances = 0
  let rateLimited = 0
  const timestamps = []
  for (const event of events.slice(1)) {
    const elapsed = Math.max(0, event.at - lastAt)
    totalMs += elapsed
    if (lastInRange) inRangeMs += elapsed
    const inRange = event.tick >= range.lower && event.tick < range.upper
    if (!inRange) {
      const recent10m = timestamps.filter(value => value >= event.at - 600_000).length
      const recent1h = timestamps.filter(value => value >= event.at - 3_600_000).length
      const last = timestamps[timestamps.length - 1]
      if ((last && event.at - last < 30_000) || recent10m >= 3 || recent1h >= 10) {
        rateLimited += 1
      } else {
        range = centeredRange(event.tick, intervals)
        timestamps.push(event.at)
        rebalances += 1
      }
    }
    lastInRange = event.tick >= range.lower && event.tick < range.upper
    lastAt = event.at
  }
  return {
    intervals,
    rawTickWidth: intervals * 10,
    approximatePriceWidthPercent: (Math.pow(1.0001, intervals * 10) - 1) * 100,
    rebalances,
    rateLimitedEvents: rateLimited,
    inRangePercent: totalMs ? inRangeMs / totalMs * 100 : 0,
    averageMinutesBetweenRebalances: rebalances > 1 ? (timestamps.at(-1) - timestamps[0]) / (rebalances - 1) / 60_000 : null,
    maxRebalancesInHour: timestamps.reduce((maximum, at) => Math.max(maximum, timestamps.filter(value => value >= at - 3_600_000 && value <= at).length), 0),
  }
}

function replayCrashGuards(events) {
  let minimum1m = 0
  let minimum5m = 0
  let softEpisodes = 0
  let withdrawEpisodes = 0
  let exitEpisodes = 0
  let softActive = false
  let withdrawActive = false
  let exitActive = false
  for (const event of events) {
    const oneMinute = sampleAtOrBefore(events, event.at - 60_000)
    const fiveMinute = sampleAtOrBefore(events, event.at - 300_000)
    const change1m = percentChange(event.price, oneMinute?.price)
    const change5m = percentChange(event.price, fiveMinute?.price)
    if (change1m != null) minimum1m = Math.min(minimum1m, change1m)
    if (change5m != null) minimum5m = Math.min(minimum5m, change5m)
    const nextSoft = change1m != null && change1m <= -1.5
    const nextWithdraw = change5m != null && change5m <= -3
    const nextExit = change5m != null && change5m <= -5
    if (nextSoft && !softActive) softEpisodes += 1
    if (nextWithdraw && !withdrawActive) withdrawEpisodes += 1
    if (nextExit && !exitActive) exitEpisodes += 1
    softActive = nextSoft
    withdrawActive = nextWithdraw
    exitActive = nextExit
  }
  return { minimum1mPercent: minimum1m, minimum5mPercent: minimum5m, softPauseEpisodes: softEpisodes, withdrawEpisodes, exitEpisodes }
}

const latestHeader = await rpc('eth_getBlockByNumber', ['latest', false])
if (!latestHeader) throw new Error('Robinhood RPC did not return the latest block.')
const latestBlock = BigInt(latestHeader.number)
const latestBlockAt = Number(BigInt(latestHeader.timestamp)) * 1000
const cutoff = latestBlockAt - replayWindowMs
const { startBlock, secondsPerBlock } = await estimateReplayStartBlock(latestBlock, BigInt(latestHeader.timestamp))
const raw = await rpc('eth_getLogs', [{
  address: pool,
  fromBlock: toHex(startBlock),
  toBlock: latestHeader.number,
  topics: [swapTopic],
}])
if (!Array.isArray(raw)) throw new Error('Robinhood RPC did not return swap logs.')
const blockTimeIndex = await buildBlockTimeIndex(raw)
const unique = new Map(raw.map(log => [`${log.transactionHash}:${log.logIndex}`, log]))
const events = [...unique.values()]
  .map(log => decodeSwap(log, blockTimeIndex.timestampFor))
  .filter(event => event.at >= cutoff && event.at <= latestBlockAt)
  .sort((a, b) => a.at - b.at || a.blockNumber - b.blockNumber)
if (events.length < 2) throw new Error('24시간 재생에 필요한 Swap 이벤트가 부족합니다.')

const report = {
  generatedAt: Date.now(),
  source: `${rpcUrl} eth_getLogs + eth_getBlockByNumber`,
  pool,
  latestBlock: latestBlock.toString(),
  requestedFromBlock: startBlock.toString(),
  estimatedSecondsPerBlock: secondsPerBlock,
  timestampMethod: `official block headers every ${blockTimeIndex.anchorSpacing} blocks with linear interpolation`,
  timestampAnchorCount: blockTimeIndex.anchorCount,
  windowFrom: cutoff,
  windowTo: latestBlockAt,
  windowHours: replayWindowMs / 3_600_000,
  from: events[0].at,
  to: events.at(-1).at,
  hoursCovered: (events.at(-1).at - events[0].at) / 3_600_000,
  firstEventDelayMinutes: (events[0].at - cutoff) / 60_000,
  lastEventAgeMinutes: (latestBlockAt - events.at(-1).at) / 60_000,
  swapEvents: events.length,
  price: {
    first: events[0].price,
    last: events.at(-1).price,
    high: Math.max(...events.map(event => event.price)),
    low: Math.min(...events.map(event => event.price)),
    changePercent: percentChange(events.at(-1).price, events[0].price),
  },
  rangeComparison: [1, 3, 5].map(intervals => replayRange(events, intervals)),
  crashGuards: replayCrashGuards(events),
  limitations: [
    'Swap 이벤트 tick만 사용한 실행 전 재생이며 LP 원금, swap fee, gas, UP reward, MEV는 포함하지 않습니다.',
    'Robinhood 공식 /prices는 과거 시계열을 제공하지 않아 과거 독립 가격원 확인은 포함하지 않습니다.',
    '현재 풀 observation cardinality가 작아 과거 onchain TWAP 재생은 포함하지 않습니다.',
    '공개 RPC 호출 제한 때문에 이벤트 시각은 5,000블록마다 읽은 공식 블록 시각 사이를 선형 보간합니다.',
  ],
}

mkdirSync(dirname(outputFile), { recursive: true })
writeFileSync(outputFile, JSON.stringify(report, null, 2), 'utf8')
console.log(JSON.stringify(report, null, 2))
