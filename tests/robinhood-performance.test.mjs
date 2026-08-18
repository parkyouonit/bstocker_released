import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { encodeAbiParameters, encodeEventTopics, parseAbi } from 'viem'
import { robinhoodPerformanceInternals } from '../server/robinhood-performance.mjs'

const { combineLifecycleAccounting, compactLifecycleError, computeRolloverAccounting, decodeLifecycleEvent, gasEth, lifecycleTickAtOrBefore, lifecycleTickTimeline, lifecycleVaultAddresses, readNdjson, selectCurrentVaultTransactions, snapshotLifecycleAccounting, upTransfersFromReceipt, valueSnapshot, walletUpReceivedSince } = robinhoodPerformanceInternals

test('strategy polling waits for each response instead of invalidating slow requests', () => {
  const source = readFileSync(new URL('../src/hooks/useRobinhoodStrategy.ts', import.meta.url), 'utf8')
  assert.match(source, /setTimeout\(\(\) => void poll\(false\), 15_000\)/)
  assert.doesNotMatch(source, /setInterval/)
  assert.match(source, /if \(inFlight\.current\) return inFlight\.current/)
  assert.match(source, /controller\.current\?\.abort\(\)/)
})

test('NDJSON reader keeps parsed rows and consumes only appended complete records', () => {
  const directory = mkdtempSync(join(tmpdir(), 'bstocker-ndjson-'))
  const file = join(directory, 'history.ndjson')
  try {
    writeFileSync(file, '{"id":1}\n{"id":')
    assert.deepEqual(readNdjson(file), [{ id: 1 }])
    appendFileSync(file, '2}\n')
    assert.deepEqual(readNdjson(file), [{ id: 1 }, { id: 2 }])
    writeFileSync(file, '{"id":3}\n')
    assert.deepEqual(readNdjson(file), [{ id: 3 }])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('performance value combines LP NAV, UP reward and keeper gas', () => {
  const value = valueSnapshot({
    principalUsd: 350,
    navUsd: 355,
    paidUp: 10,
    earnedUp: 2,
    gasSpentEth: 0.001,
    upPriceUsd: 0.25,
    ethPriceUsd: 2_000,
  })
  assert.equal(value.lpProfitUsd, 5)
  assert.equal(value.upValueUsd, 3)
  assert.equal(value.gasSpentUsd, 2)
  assert.equal(value.netProfitUsd, 6)
  assert.ok(Math.abs(value.netReturnPercent - 6 / 350 * 100) < 1e-12)
})

test('current vault selection keeps the final onchain rebalance series', () => {
  const hash = digit => `0x${digit.repeat(64)}`
  const rows = [
    { at: 1, action: 'AUTO_REBALANCE', hash: hash('1') },
    { at: 2, action: 'AUTO_HARVEST_UP', hash: hash('2') },
    { at: 3, action: 'AUTO_REBALANCE', hash: hash('3') },
    { at: 4, action: 'AUTO_HARVEST_UP', hash: hash('4') },
    { at: 5, action: 'AUTO_REBALANCE', hash: hash('5') },
  ]
  assert.deepEqual(selectCurrentVaultTransactions(rows, 2).map(row => row.at), [3, 4, 5])
})

test('receipt parsing counts only UP transfers from vault to recipient', () => {
  const vault = '0x1111111111111111111111111111111111111111'
  const recipient = '0x2222222222222222222222222222222222222222'
  const topic = address => `0x${'0'.repeat(24)}${address.slice(2)}`
  const receipt = { logs: [{
    address: '0x57C0E45cB534413D1C20A4240955d6bB250BB4F1',
    topics: [
      '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
      topic(vault),
      topic(recipient),
    ],
    data: `0x${(3n * 10n ** 18n).toString(16)}`,
  }] }
  assert.equal(upTransfersFromReceipt(receipt, vault, recipient), 3)
})

test('rebalance row exposes every UP payment received by the wallet since the prior rebalance', () => {
  assert.ok(Math.abs(walletUpReceivedSince(168.74966003955404, 170.15137170572044) - 1.4017116661664) < 1e-12)
  assert.equal(walletUpReceivedSince(10, 10), 0)
  assert.equal(walletUpReceivedSince(10, 9), 0)
})

test('gas cost uses actual gas and effective gas price', () => {
  assert.equal(gasEth({ gasUsed: '21000', effectiveGasPrice: '1000000000' }), 0.000021)
})

test('rollover accounting preserves the first loss and counts only fresh capital on restart', () => {
  const accounting = computeRolloverAccounting([{
    index: 1,
    startPrincipalUsd: 345.410549,
    principalUsd: 345.410549,
    capitalAddedUsd: 0,
    endedAt: 1,
    recoveredUsd: 337.98115,
  }, {
    index: 2,
    startPrincipalUsd: 350,
    principalUsd: 350,
    capitalAddedUsd: 0,
    endedAt: null,
    recoveredUsd: null,
  }], 349.993148)
  assert.ok(Math.abs(accounting.sessions[0].lpProfitUsd - (-7.429399)) < 1e-9)
  assert.ok(Math.abs(accounting.sessions[1].freshCapitalUsd - 12.01885) < 1e-9)
  assert.ok(Math.abs(accounting.capitalContributedUsd - 357.429399) < 1e-9)
  assert.ok(Math.abs(accounting.lpProfitUsd - (-7.436251)) < 1e-9)
})

test('v3 compact PositionStarted event is decoded as a lifecycle start', () => {
  const event = parseAbi(['event PositionStarted(uint256 indexed tokenId,int24 tickLower,int24 tickUpper,uint256 principalUsdg)'])[0]
  const decoded = decodeLifecycleEvent({
    topics: encodeEventTopics({ abi: [event], eventName: 'PositionStarted', args: { tokenId: 63804n } }),
    data: encodeAbiParameters(
      [{ type: 'int24' }, { type: 'int24' }, { type: 'uint256' }],
      [-226660, -226610, 375765522n],
    ),
  })
  assert.equal(decoded.eventName, 'PositionStarted')
  assert.equal(decoded.args.tokenId, 63804n)
  assert.equal(decoded.args.principalUsdg, 375765522n)
})

test('vault discovery keeps historical executors in order and appends the current vault', () => {
  const first = '0x1111111111111111111111111111111111111111'
  const second = '0x2222222222222222222222222222222222222222'
  const current = '0x3333333333333333333333333333333333333333'
  assert.deepEqual(lifecycleVaultAddresses([
    { at: 20, action: 'AUTO_REBALANCE', executorAddress: second },
    { at: 10, action: 'AUTO_HARVEST_UP', executorAddress: first },
    { at: 5, action: 'NO_ACTION', executorAddress: '0x4444444444444444444444444444444444444444' },
    { at: 30, action: 'AUTO_REBALANCE', executorAddress: second },
  ], current), [first, second, current])
})

test('historical recovery selects the final fixed keeper tick at or before each exit block', () => {
  const vault = '0x1111111111111111111111111111111111111111'
  const timeline = lifecycleTickTimeline([
    { executorAddress: vault, blockNumber: '100', expectedTick: -226700 },
    { executorAddress: vault, blockNumber: '120', expectedTick: -226650 },
    { executorAddress: vault, blockNumber: '140', expectedTick: -226600 },
    { executorAddress: '0x2222222222222222222222222222222222222222', blockNumber: '130', expectedTick: -1 },
  ], vault)
  assert.equal(lifecycleTickAtOrBefore(timeline, '130'), -226650)
  assert.equal(lifecycleTickAtOrBefore(timeline, '99'), null)
})

test('cross-vault accounting preserves prior loss and counts migration wallet USDG as fresh capital', () => {
  const combined = combineLifecycleAccounting([{
    address: '0x1111111111111111111111111111111111111111',
    lifecycle: {
      sessions: [{ index: 1, startBlock: '100', startPrincipalUsd: 384, principalUsd: 384, capitalAddedUsd: 0, endedAt: 200, recoveredUsd: 361.53361 }],
      paidUp: 128,
      gasSpentEth: 0.001,
      timeline: { rewards: [{ blockNumber: '150', amountUp: 128 }], gas: [{ blockNumber: '100', gasEth: 0.001 }] },
    },
  }, {
    address: '0x2222222222222222222222222222222222222222',
    lifecycle: {
      sessions: [{ index: 1, startBlock: '220', startPrincipalUsd: 375.765522, principalUsd: 375.765522, capitalAddedUsd: 0, endedAt: null, recoveredUsd: null }],
      paidUp: 0.15,
      gasSpentEth: 0.0001,
      timeline: { rewards: [{ blockNumber: '230', amountUp: 0.15 }], gas: [{ blockNumber: '220', gasEth: 0.0001 }] },
    },
  }], 376.276266)
  assert.equal(combined.sessions.length, 2)
  assert.ok(Math.abs(combined.sessions[1].freshCapitalUsd - 14.231912) < 1e-9)
  assert.ok(Math.abs(combined.accounting.capitalContributedUsd - 398.231912) < 1e-9)
  assert.ok(Math.abs(combined.accounting.lpProfitUsd - (-21.955646)) < 1e-9)
  assert.equal(combined.paidUp, 128.15)
  assert.equal(combined.gasSpentEth, 0.0011)
})

test('public lifecycle warning removes raw RPC request details', () => {
  const error = Object.assign(new Error('Missing or invalid parameters.\nURL: https://rpc.example\nRequest body: secret'), {
    shortMessage: 'Missing or invalid parameters.\nDouble check the call.',
  })
  assert.equal(compactLifecycleError(error), 'Missing or invalid parameters.')
})

test('lifetime snapshot accepts connected LP profit instead of resetting at current principal', () => {
  const value = valueSnapshot({
    principalUsd: 357.429399,
    navUsd: 349.993148,
    lpProfitUsdOverride: -7.436251,
    paidUp: 84,
    gasSpentEth: 0,
    upPriceUsd: 0.25,
    ethPriceUsd: 2_000,
  })
  assert.equal(value.lpProfitUsd, -7.436251)
  assert.ok(Math.abs(value.netProfitUsd - 13.563749) < 1e-9)
})

test('rebalance snapshots include prior realized loss, fresh rollover capital, exit rewards and lifecycle gas', () => {
  const lifecycle = {
    sessions: [{
      index: 1,
      startBlock: '100',
      endBlock: '120',
      startPrincipalUsd: 345.410549,
      principalUsd: 345.410549,
      capitalAddedUsd: 0,
      endedAt: 1,
      recoveredUsd: 337.98115,
    }, {
      index: 2,
      startBlock: '140',
      endBlock: null,
      startPrincipalUsd: 350,
      principalUsd: 350,
      capitalAddedUsd: 0,
      endedAt: null,
      recoveredUsd: null,
    }],
    timeline: {
      rewards: [{ blockNumber: '115', amountUp: 70 }, { blockNumber: '120', amountUp: 14.5 }, { blockNumber: '150', amountUp: 2 }],
      gas: [{ blockNumber: '100', gasEth: 0.001 }, { blockNumber: '130', gasEth: 0.0005 }, { blockNumber: '150', gasEth: 0.0001 }],
    },
  }
  const snapshot = snapshotLifecycleAccounting(lifecycle, '150', 349.35)
  assert.equal(snapshot.sessionIndex, 2)
  assert.ok(Math.abs(snapshot.accounting.capitalContributedUsd - 357.429399) < 1e-9)
  assert.ok(Math.abs(snapshot.accounting.lpProfitUsd - (-8.079399)) < 1e-9)
  assert.equal(snapshot.paidUp, 86.5)
  assert.equal(snapshot.gasSpentEth, 0.0016)
})
