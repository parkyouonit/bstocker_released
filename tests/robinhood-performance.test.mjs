import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { robinhoodPerformanceInternals } from '../server/robinhood-performance.mjs'

const { computeRolloverAccounting, gasEth, readNdjson, selectCurrentVaultTransactions, snapshotLifecycleAccounting, upTransfersFromReceipt, valueSnapshot } = robinhoodPerformanceInternals

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
