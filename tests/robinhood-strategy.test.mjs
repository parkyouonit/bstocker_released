import assert from 'node:assert/strict'
import test from 'node:test'
import { ShadowGuardEngine, floorTickToSpacing, rangeAnchor, strategyRange } from '../server/robinhood-strategy.mjs'

function snapshot(at, {
  tick = -227_350,
  spotPrice = 134,
  officialPrice = spotPrice,
  twap30Price = spotPrice,
  twap300Price = spotPrice,
  halt = false,
  strategyNavUsd,
  strategyPrincipalUsd,
  managedRange,
} = {}) {
  return {
    at,
    tick,
    tickSpacing: 10,
    spotPrice,
    twap30Price,
    twap300Price,
    contractsVerified: true,
    observationCardinality: 64,
    stock: { paused: false, oraclePaused: false },
    strategyNavUsd,
    strategyPrincipalUsd,
    managedRange,
    official: {
      tokenPrice: officialPrice,
      generatedAt: new Date(at).toISOString(),
      isTradingHalt: halt,
    },
  }
}

test('negative ticks floor toward negative infinity', () => {
  assert.equal(floorTickToSpacing(-227_341, 10), -227_350)
  assert.equal(floorTickToSpacing(-227_350, 10), -227_350)
})

test('five interval range is centered around the current initialized interval', () => {
  assert.deepEqual(strategyRange(-227_341, 10), { lower: -227_370, upper: -227_320, anchor: -227_350, width: 50 })
  assert.equal(rangeAnchor(-227_370, -227_320, 10), -227_350)
})

test('engine warms for five minutes before normal shadow operation', () => {
  const now = Date.now()
  const engine = new ShadowGuardEngine()
  assert.equal(engine.ingest(snapshot(now)).state, 'WARMING')
  assert.equal(engine.ingest(snapshot(now + 300_000)).state, 'LIVE')
})

test('one minute crash enters soft pause', () => {
  const now = Date.now()
  const engine = new ShadowGuardEngine()
  engine.ingest(snapshot(now))
  engine.ingest(snapshot(now + 300_000))
  const decision = engine.ingest(snapshot(now + 360_000, { tick: -227_552, spotPrice: 131.5, officialPrice: 131.5, twap30Price: 131.5, twap300Price: 132 }))
  assert.equal(decision.state, 'SOFT_PAUSE')
  assert.ok(decision.metrics.oneMinuteChangePercent <= -1.5)
})

test('confirmed five minute crash requires withdraw then USDG quote', () => {
  const now = Date.now()
  const engine = new ShadowGuardEngine()
  engine.ingest(snapshot(now, { spotPrice: 140, officialPrice: 140 }))
  const first = engine.ingest(snapshot(now + 300_000, { tick: -227_970, spotPrice: 131, officialPrice: 132, twap30Price: 131, twap300Price: 132 }))
  assert.equal(first.state, 'WITHDRAW_ONLY')
  const confirmed = engine.ingest(snapshot(now + 331_000, { tick: -227_980, spotPrice: 130.8, officialPrice: 131.8, twap30Price: 130.8, twap300Price: 131.8 }))
  assert.equal(confirmed.state, 'USDG_EXIT_PENDING')
  assert.equal(confirmed.action, 'USDG_EXIT_QUOTE_REQUIRED')
})

test('official trading halt immediately latches withdraw-only', () => {
  const now = Date.now()
  const engine = new ShadowGuardEngine()
  const decision = engine.ingest(snapshot(now, { halt: true }))
  assert.equal(decision.state, 'WITHDRAW_ONLY')
  assert.equal(decision.action, 'WITHDRAW_TO_IDLE_REQUIRED')
})

test('ordinary five-tick exit requests an atomic live rebalance', () => {
  const now = Date.now()
  const engine = new ShadowGuardEngine({}, {}, { executionMode: 'LIVE' })
  engine.ingest(snapshot(now))
  engine.ingest(snapshot(now + 300_000))
  engine.ingest(snapshot(now + 305_000, { tick: -227_321 }))
  const decision = engine.ingest(snapshot(now + 315_000, { tick: -227_319 }))
  assert.equal(decision.state, 'LIVE')
  assert.equal(decision.action, 'REBALANCE_REQUIRED')
  assert.equal(decision.metrics.rapidBandExit, false)
})

test('thirty-tick jump within ten seconds freezes automatic rebalance', () => {
  const now = Date.now()
  const engine = new ShadowGuardEngine({}, {}, { executionMode: 'LIVE' })
  engine.ingest(snapshot(now))
  engine.ingest(snapshot(now + 300_000))
  const decision = engine.ingest(snapshot(now + 305_000, { tick: -227_320 }))
  assert.equal(decision.state, 'SOFT_PAUSE')
  assert.equal(decision.action, 'FREEZE_REBALANCE')
  assert.equal(decision.metrics.rapidBandExit, true)
})

test('five percent vault NAV loss withdraws LP to idle tokens', () => {
  const now = Date.now()
  const engine = new ShadowGuardEngine({}, {}, { executionMode: 'LIVE' })
  engine.ingest(snapshot(now, { strategyNavUsd: 200, strategyPrincipalUsd: 200 }))
  const decision = engine.ingest(snapshot(now + 300_000, { strategyNavUsd: 190, strategyPrincipalUsd: 200 }))
  assert.equal(decision.state, 'WITHDRAW_ONLY')
  assert.equal(decision.action, 'WITHDRAW_TO_IDLE_REQUIRED')
  assert.equal(decision.metrics.strategyNavChangePercent, -5.000000000000004)
})

test('missing onchain TWAP capacity never enters live mode', () => {
  const now = Date.now()
  const engine = new ShadowGuardEngine()
  const first = snapshot(now)
  first.observationCardinality = 1
  first.twap30Price = null
  first.twap300Price = null
  engine.ingest(first)
  const later = snapshot(now + 300_000)
  later.observationCardinality = 1
  later.twap30Price = null
  later.twap300Price = null
  const decision = engine.ingest(later)
  assert.equal(decision.state, 'SOFT_PAUSE')
  assert.equal(decision.metrics.onchainTwapReady, false)
})

test('expanded capacity without initialized TWAP history remains fail-closed', () => {
  const now = Date.now()
  const engine = new ShadowGuardEngine()
  const first = snapshot(now)
  first.twap30Price = null
  first.twap300Price = null
  engine.ingest(first)
  const later = snapshot(now + 300_000)
  later.twap30Price = null
  later.twap300Price = null
  const decision = engine.ingest(later)
  assert.equal(decision.state, 'SOFT_PAUSE')
  assert.equal(decision.metrics.onchainTwapReady, false)
  assert.ok(decision.reasons.some(reason => reason.includes('관찰 이력이 아직 부족')))
})

test('missing official price is never coerced to zero or treated as fresh', () => {
  const now = Date.now()
  const engine = new ShadowGuardEngine()
  engine.ingest(snapshot(now, { officialPrice: null }))
  const decision = engine.ingest(snapshot(now + 300_000, { officialPrice: null }))
  assert.equal(decision.state, 'SOFT_PAUSE')
  assert.equal(decision.metrics.officialFresh, false)
})
