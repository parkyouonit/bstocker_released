import assert from 'node:assert/strict'
import test from 'node:test'
import {
  activeExecutionBackoff,
  classifyExecutionFailure,
  executionBackoffReason,
  scheduleExecutionBackoff,
} from '../server/robinhood-execution-gate.mjs'

test('Slipstream minimum-output failures enter a long liquidity backoff', () => {
  const classified = classifyExecutionFailure(new Error('execution reverted: Too little received'))
  assert.equal(classified.code, 'LIQUIDITY_SLIPPAGE')
  assert.equal(classified.baseDelayMs, 15 * 60_000)
})

test('repeated identical failures back off exponentially and remain scoped to the vault action', () => {
  const context = { now: 1_000, executorAddress: '0xabc', action: 'REBALANCE_REQUIRED' }
  const first = scheduleExecutionBackoff(null, new Error('PSC'), context)
  const second = scheduleExecutionBackoff(first, new Error('PSC'), { ...context, now: first.nextRetryAt })
  assert.equal(first.attempts, 1)
  assert.equal(second.attempts, 2)
  assert.equal(second.delayMs, first.delayMs * 2)
  assert.equal(activeExecutionBackoff(second, { ...context, now: second.blockedAt + 1 }), second)
  assert.equal(activeExecutionBackoff(second, { ...context, action: 'WITHDRAW_TO_IDLE_REQUIRED', now: second.blockedAt + 1 }), null)
})

test('backoff reason exposes a compact retry estimate without the raw RPC error', () => {
  const backoff = scheduleExecutionBackoff(null, new Error('Too little received'), {
    now: 1_000,
    executorAddress: '0xabc',
    action: 'REBALANCE_REQUIRED',
  })
  const reason = executionBackoffReason(backoff, 1_000)
  assert.match(reason, /15분/)
  assert.doesNotMatch(reason, /Too little received/)
})

test('safety oracle and DEX floor failures have explicit bounded backoff', () => {
  const oracle = classifyExecutionFailure(new Error('CrashNotConfirmed()'))
  assert.equal(oracle.code, 'SAFETY_EXIT_NOT_CONFIRMED')
  const floor = classifyExecutionFailure(new Error('PriceGuardFailed()'))
  assert.equal(floor.code, 'SAFETY_EXIT_PRICE_GUARD')
})
