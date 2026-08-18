import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { assertAutomationReconfigurationSafe } from '../server/robinhood-automation.mjs'

const currentExecutor = '0x0000000000000000000000000000000000000101'
const otherExecutor = '0x0000000000000000000000000000000000000202'
const panelSource = readFileSync(new URL('../src/components/RobinhoodAutomationPanel.tsx', import.meta.url), 'utf8')

function vault(overrides = {}) {
  return {
    mode: 'LIVE',
    activeTokenId: '60471',
    balances: { SPCX: 0, USDG: 0, earnedUP: 1 },
    ...overrides,
  }
}

test('same configured executor can be armed or disarmed again', () => {
  assert.doesNotThrow(() => assertAutomationReconfigurationSafe(
    { executorAddress: currentExecutor },
    vault(),
    currentExecutor,
  ))
})

test('active configured vault cannot be replaced by a browser-stored executor', () => {
  assert.throws(() => assertAutomationReconfigurationSafe(
    { executorAddress: currentExecutor },
    vault(),
    otherExecutor,
  ), /현재 활성 자동화 금고/)
})

test('only a fully retired configured vault can be replaced', () => {
  for (const mode of ['PAUSED', 'WITHDRAW_ONLY']) {
    assert.doesNotThrow(() => assertAutomationReconfigurationSafe(
      { executorAddress: otherExecutor },
      vault({ mode, activeTokenId: '0', balances: { SPCX: 0, USDG: 0, earnedUP: 0 } }),
      currentExecutor,
    ))
  }
  assert.throws(() => assertAutomationReconfigurationSafe(
    { executorAddress: otherExecutor },
    vault({ mode: 'WITHDRAW_ONLY', activeTokenId: '0', balances: { SPCX: 0, USDG: 0.000001, earnedUP: 0 } }),
    currentExecutor,
  ), /완전히 회수/)
})

test('frontend removes the legacy executor key and only stages against a retired vault', () => {
  assert.match(panelSource, /bstocker\.robinhood\.pending-executor\.v4/)
  assert.match(panelSource, /bstocker\.robinhood\.executor\.v3/)
  assert.match(panelSource, /legacyExecutorKeys\.forEach\(key => window\.localStorage\.removeItem\(key\)\)/)
  assert.match(panelSource, /localExecutor\.toLowerCase\(\) !== configuredExecutor\.toLowerCase\(\) && configuredVaultCanBeReplaced/)
})
