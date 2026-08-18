import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { AdaptiveShadowEngine, defensiveStrategyRange, evaluateOracleGuard, expectedUsMarketClosure, ROBINHOOD_ADAPTIVE_POLICY_VERSION, ROBINHOOD_GUARD_POLICY_VERSION, ShadowGuardEngine, floorTickToSpacing, rangeAnchor, strategyRange } from '../server/robinhood-strategy.mjs'

const automationPanelSource = readFileSync(new URL('../src/components/RobinhoodAutomationPanel.tsx', import.meta.url), 'utf8')

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
  officialGeneratedAt = at,
  officialMaxAgeSec = 90_000,
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
      generatedAt: new Date(officialGeneratedAt).toISOString(),
      priceFeedMaxAgeSec: officialMaxAgeSec,
      isTradingHalt: halt,
    },
  }
}

function closedMarketSnapshot(at, {
  officialGeneratedAt = Date.UTC(2026, 7, 14, 20, 28, 39),
  spotPrice = 140.2609,
  twap30Price = 140.2541,
  twap300Price = 140.2541,
} = {}) {
  const value = snapshot(at, { officialGeneratedAt, officialPrice: 140.4624, spotPrice, twap30Price, twap300Price })
  Object.assign(value.official, {
    bid: 120,
    ask: 140.58,
    multiplier: 1,
    quoteGeneratedAt: new Date(at).toISOString(),
    assetStatus: 'ASSET_STATUS_ACTIVE',
    usdgFeed: { priceUsd: 1 },
  })
  return value
}

test('negative ticks floor toward negative infinity', () => {
  assert.equal(floorTickToSpacing(-227_341, 10), -227_350)
  assert.equal(floorTickToSpacing(-227_350, 10), -227_350)
})

test('five interval range is centered around the current initialized interval', () => {
  assert.deepEqual(strategyRange(-227_341, 10), { lower: -227_370, upper: -227_320, anchor: -227_350, width: 50 })
  assert.equal(rangeAnchor(-227_370, -227_320, 10), -227_350)
})

test('defensive five interval range starts USDG-heavy near its upper edge', () => {
  assert.deepEqual(defensiveStrategyRange(-227_341, 10), { lower: -227_390, upper: -227_340, anchor: -227_350, width: 50 })
})

test('adaptive shadow confirms slow decline before entering a shifted five-tick defense', () => {
  const now = Date.now()
  const engine = new AdaptiveShadowEngine()
  for (let minute = 0; minute <= 60; minute += 1) engine.ingest(snapshot(now + minute * 60_000, { spotPrice: 140, tick: -227_350 }))
  let decision
  for (let minute = 61; minute <= 64; minute += 1) {
    decision = engine.ingest(snapshot(now + minute * 60_000, { spotPrice: 138, tick: -227_450 }))
  }
  assert.equal(decision.mode, 'DEFENSIVE')
  assert.equal(decision.action, 'SHADOW_ENTER_DEFENSIVE')
  assert.deepEqual(decision.range, { lower: -227_490, upper: -227_440, anchor: -227_450, width: 50 })
  assert.equal(engine.serialize().adaptivePolicyVersion, ROBINHOOD_ADAPTIVE_POLICY_VERSION)
})

test('adaptive shadow parks in USDG after twenty additional defense ticks', () => {
  const now = Date.now()
  const engine = new AdaptiveShadowEngine()
  for (let minute = 0; minute <= 60; minute += 1) engine.ingest(snapshot(now + minute * 60_000, { spotPrice: 140, tick: -227_350 }))
  for (let minute = 61; minute <= 64; minute += 1) engine.ingest(snapshot(now + minute * 60_000, { spotPrice: 138, tick: -227_450 }))
  const decision = engine.ingest(snapshot(now + 65 * 60_000, { spotPrice: 137.8, tick: -227_470 }))
  assert.equal(decision.mode, 'USDG_WAIT')
  assert.equal(decision.action, 'SHADOW_PARK_IN_USDG')
  assert.equal(decision.metrics.additionalDefenseDrop, true)
})

test('adaptive shadow fails closed across a long sampling gap', () => {
  const now = Date.now()
  const engine = new AdaptiveShadowEngine()
  engine.ingest(snapshot(now, { spotPrice: 140 }))
  const decision = engine.ingest(snapshot(now + 65 * 60_000, { spotPrice: 130 }))
  assert.equal(decision.mode, 'NORMAL')
  assert.equal(decision.metrics.historyReady, false)
  assert.ok(decision.reasons.some(reason => reason.includes('연속 이력')))
})

test('adaptive engine follows the last confirmed onchain mode after a failed transaction', () => {
  const now = Date.now()
  const engine = new AdaptiveShadowEngine()
  engine.syncConfirmedState({
    mode: 'DEFENSIVE',
    modeSince: now - 60_000,
    defenseAnchor: -227_450,
    range: { lower: -227_490, upper: -227_440, anchor: -227_450, width: 50 },
  }, now)
  assert.equal(engine.serialize().mode, 'DEFENSIVE')
  assert.equal(engine.serialize().defenseAnchor, -227_450)

  engine.syncConfirmedState({
    mode: 'NORMAL',
    modeSince: now,
    range: { lower: -227_470, upper: -227_420, anchor: -227_450, width: 50 },
  }, now)
  const state = engine.serialize()
  assert.equal(state.mode, 'NORMAL')
  assert.equal(state.defenseAnchor, null)
  assert.equal(state.slowSignalSince, null)
  assert.ok(state.events.some(event => event.type === 'ADAPTIVE_ONCHAIN_SYNC'))
})

test('empty legacy vault migration uses the entered USDG instead of requiring a recovery delta', () => {
  assert.match(automationPanelSource, /const vaultAlreadyEmpty = Boolean\(vault[\s\S]*?balances\.earnedUP === 0\)/)
  assert.match(automationPanelSource, /if \(!vaultAlreadyEmpty\) \{[\s\S]*?executeRobinhoodVaultOwnerAction\(walletAddress, configuredExecutor, 'exitToTokens'\)/)
  assert.match(automationPanelSource, /onClick=\{\(\) => upgradeAndMigrate\(amount\)\}/)
  assert.match(automationPanelSource, /if \(recoveredSpcx <= 0n && recoveredUsdg <= 0n && extraUsdg <= 0n\)/)
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

test('confirmed five minute crash automatically exits to USDG', () => {
  const now = Date.now()
  const engine = new ShadowGuardEngine()
  engine.ingest(snapshot(now, { spotPrice: 140, officialPrice: 140 }))
  const first = engine.ingest(snapshot(now + 300_000, { tick: -227_970, spotPrice: 131, officialPrice: 132, twap30Price: 131, twap300Price: 132 }))
  assert.equal(first.state, 'WITHDRAW_ONLY')
  const confirmed = engine.ingest(snapshot(now + 331_000, { tick: -227_980, spotPrice: 130.8, officialPrice: 131.8, twap30Price: 130.8, twap300Price: 131.8 }))
  assert.equal(confirmed.state, 'USDG_EXIT_PENDING')
  assert.equal(confirmed.action, 'USDG_EXIT_REQUIRED')
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

test('gradual NAV drawdown stays live and keeps ordinary five-tick rebalancing', () => {
  const now = Date.now()
  const engine = new ShadowGuardEngine({}, {}, { executionMode: 'LIVE' })
  engine.ingest(snapshot(now, { strategyNavUsd: 200, strategyPrincipalUsd: 200 }))
  const warmed = engine.ingest(snapshot(now + 300_000, { strategyNavUsd: 190, strategyPrincipalUsd: 200 }))
  assert.equal(warmed.state, 'LIVE')
  assert.equal(warmed.action, 'NO_ACTION')
  engine.ingest(snapshot(now + 305_000, { tick: -227_321, strategyNavUsd: 190, strategyPrincipalUsd: 200 }))
  const decision = engine.ingest(snapshot(now + 315_000, { tick: -227_319, strategyNavUsd: 190, strategyPrincipalUsd: 200 }))
  assert.equal(decision.state, 'LIVE')
  assert.equal(decision.action, 'REBALANCE_REQUIRED')
  assert.equal(decision.metrics.strategyNavChangePercent, -5.000000000000004)
})

test('legacy NAV-stop state is cleared when the guard policy upgrades', () => {
  const now = Date.now()
  const engine = new ShadowGuardEngine({}, {
    state: 'USDG_EXIT_PENDING',
    softPauseUntil: now + 60 * 60_000,
    hardStateSince: now - 60_000,
    samples: [snapshot(now - 300_000)],
    events: [],
  }, { executionMode: 'LIVE' })
  const decision = engine.ingest(snapshot(now, { strategyNavUsd: 190, strategyPrincipalUsd: 200 }))
  assert.equal(decision.state, 'LIVE')
  assert.equal(decision.action, 'NO_ACTION')
  assert.equal(engine.serialize().guardPolicyVersion, ROBINHOOD_GUARD_POLICY_VERSION)
  assert.ok(decision.events.some(event => event.type === 'POLICY_MIGRATED'))
})

test('official halt overrides NAV loss and withdraws without swapping', () => {
  const now = Date.now()
  const engine = new ShadowGuardEngine({}, {}, { executionMode: 'LIVE' })
  engine.ingest(snapshot(now, { strategyNavUsd: 200, strategyPrincipalUsd: 200 }))
  const decision = engine.ingest(snapshot(now + 300_000, {
    halt: true,
    strategyNavUsd: 180,
    strategyPrincipalUsd: 200,
  }))
  assert.equal(decision.state, 'WITHDRAW_ONLY')
  assert.equal(decision.action, 'WITHDRAW_TO_IDLE_REQUIRED')
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

test('Chainlink 24h heartbeat accepts an eight-hour round but rejects a round beyond the 25h limit', () => {
  const now = Date.now()
  const engine = new ShadowGuardEngine()
  engine.ingest(snapshot(now, { officialGeneratedAt: now - 8 * 60 * 60_000 }))
  const fresh = engine.ingest(snapshot(now + 300_000, { officialGeneratedAt: now - 8 * 60 * 60_000 }))
  assert.equal(fresh.metrics.officialFresh, true)
  const stale = engine.ingest(snapshot(now + 600_000, { officialGeneratedAt: now - 26 * 60 * 60_000 }))
  assert.equal(stale.metrics.officialFresh, false)
  assert.equal(stale.state, 'SOFT_PAUSE')
})

test('expected US market closure covers the weekend window but not normal Tuesday trading', () => {
  assert.equal(expectedUsMarketClosure(Date.UTC(2026, 7, 14, 21)), true)
  assert.equal(expectedUsMarketClosure(Date.UTC(2026, 7, 15, 12)), true)
  assert.equal(expectedUsMarketClosure(Date.UTC(2026, 7, 16, 12)), true)
  assert.equal(expectedUsMarketClosure(Date.UTC(2026, 7, 17, 14)), true)
  assert.equal(expectedUsMarketClosure(Date.UTC(2026, 7, 18, 16)), false)
})

test('weekend quorum accepts a stale Chainlink anchor only when REST range and DEX TWAP agree', () => {
  const now = Date.UTC(2026, 7, 16, 10, 55)
  const guard = evaluateOracleGuard(closedMarketSnapshot(now))
  assert.equal(guard.primaryFresh, false)
  assert.equal(guard.closedMarketConsensus, true)
  assert.equal(guard.mode, 'MARKET_CLOSED_QUORUM')
  assert.equal(guard.valuationPrice, 140.2541)
  const engine = new ShadowGuardEngine()
  engine.ingest(closedMarketSnapshot(now))
  const decision = engine.ingest(closedMarketSnapshot(now + 300_000))
  assert.equal(decision.state, 'LIVE')
  assert.equal(decision.metrics.oracleMode, 'MARKET_CLOSED_QUORUM')
})

test('weekend quorum fails closed when DEX leaves the last Chainlink anchor', () => {
  const now = Date.UTC(2026, 7, 16, 10, 55)
  const guard = evaluateOracleGuard(closedMarketSnapshot(now, {
    spotPrice: 130,
    twap30Price: 130,
    twap300Price: 130,
  }))
  assert.equal(guard.closedMarketConsensus, false)
  assert.equal(guard.mode, 'FAIL_CLOSED')
  assert.equal(guard.valuationPrice, null)
})

test('stale Chainlink never receives a closure exemption during normal market time', () => {
  const now = Date.UTC(2026, 7, 18, 16)
  const guard = evaluateOracleGuard(closedMarketSnapshot(now, {
    officialGeneratedAt: now - 30 * 60 * 60_000,
  }))
  assert.equal(guard.expectedMarketClosed, false)
  assert.equal(guard.closedMarketConsensus, false)
  assert.equal(guard.mode, 'FAIL_CLOSED')
})

test('weekend stale anchor can freeze and withdraw but never confirms the Chainlink crash exit', () => {
  const now = Date.UTC(2026, 7, 16, 10, 55)
  const engine = new ShadowGuardEngine({}, {}, { executionMode: 'LIVE' })
  engine.ingest(closedMarketSnapshot(now))
  const decision = engine.ingest(closedMarketSnapshot(now + 300_000, {
    spotPrice: 134,
    twap30Price: 134,
    twap300Price: 134,
  }))
  assert.equal(decision.state, 'WITHDRAW_ONLY')
  assert.equal(decision.action, 'WITHDRAW_TO_IDLE_REQUIRED')
  assert.notEqual(decision.action, 'USDG_EXIT_REQUIRED')
  assert.equal(decision.metrics.officialFresh, false)
})

test('new capital remains pinned to fresh Chainlink even when weekend rebalance quorum is live', () => {
  assert.match(automationPanelSource, /vault\?\.mode === 'PAUSED'[\s\S]*?decision\.state === 'LIVE'[\s\S]*?decision\.metrics\.officialFresh[\s\S]*?decision\.metrics\.onchainTwapReady/)
  assert.match(automationPanelSource, /vault\?\.mode === 'LIVE'[\s\S]*?decision\.state === 'LIVE'[\s\S]*?decision\.metrics\.officialFresh[\s\S]*?decision\.metrics\.onchainTwapReady/)
})
