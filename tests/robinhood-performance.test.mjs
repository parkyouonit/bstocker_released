import assert from 'node:assert/strict'
import test from 'node:test'
import { robinhoodPerformanceInternals } from '../server/robinhood-performance.mjs'

const { gasEth, selectCurrentVaultTransactions, upTransfersFromReceipt, valueSnapshot } = robinhoodPerformanceInternals

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
