import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const artifact = JSON.parse(readFileSync(new URL('../contracts/build/BStockerThreeTickVault.json', import.meta.url), 'utf8'))
const source = readFileSync(new URL('../contracts/BStockerThreeTickVault.sol', import.meta.url), 'utf8')
const automationSource = readFileSync(new URL('../server/robinhood-automation.mjs', import.meta.url), 'utf8')
const functions = artifact.abi.filter(item => item.type === 'function').map(item => item.name)

test('runtime bytecode remains below the EVM contract size limit', () => {
  assert.ok((artifact.deployedBytecode.length - 2) / 2 < 24_576)
})

test('vault exposes no generic arbitrary-call or recipient mutation function', () => {
  for (const forbidden of ['execute', 'call', 'delegateCall', 'setRecipient', 'withdrawTo', 'recoverERC20']) {
    assert.equal(functions.includes(forbidden), false, `${forbidden} must not be exposed`)
  }
})

test('all protocol and token routes are hardcoded to the verified SPCX/USDG deployment', () => {
  for (const address of [
    '0x9d590437ABaAe12cf9fE0627cAF4CFd633152599',
    '0x01a47258375735D36D15dE8A2bb8e0cE876d31f6',
    '0x07F44c47743A2f36414A82b9F558ECFCf0EEdCEf',
    '0xC062b870E813fcA720f1e002c234369Ab3aB9415',
    '0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa',
    '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
    '0x57C0E45cB534413D1C20A4240955d6bB250BB4F1',
  ]) assert.ok(source.includes(address))
})

test('keeper cannot perform the final USDG exit and recipient is immutable', () => {
  assert.match(source, /function exitToUsdgAuto\([\s\S]*?\) external onlyOwnerOrGuardian/)
  assert.match(source, /function exitToTokens\([\s\S]*?\) external onlySafetyOperator/)
  assert.match(source, /address public immutable recipient/)
})

test('five-tick, deadline, tick drift, rate and oracle limits are compiled into the vault', () => {
  assert.match(source, /RANGE_INTERVALS = 5/)
  assert.match(source, /RANGE_WIDTH = 50/)
  assert.match(source, /MAX_DEADLINE_DELAY = 30 seconds/)
  assert.match(source, /MAX_START_DEADLINE_DELAY = 5 minutes/)
  assert.match(source, /EXPECTED_TICK_TOLERANCE = 10/)
  assert.match(source, /SWAP_PRICE_LIMIT_TICKS = 100/)
  assert.match(source, /MAX_REBALANCES_10_MIN = 3/)
  assert.match(source, /MAX_REBALANCES_1_HOUR = 10/)
  assert.match(source, /MAX_BALANCE_PASSES = 8/)
  assert.match(source, /REQUIRED_ORACLE_CARDINALITY = 64/)
})

test('existing Slipstream pool mint never asks the position manager to create the pool again', () => {
  assert.match(source, /sqrtPriceX96:\s*0/)
  assert.doesNotMatch(source, /sqrtPriceX96:\s*sqrtPriceX96/)
})

test('USDG six-decimal 350 pilot limit and token-specific dust threshold are enforced', () => {
  assert.match(source, /USDG_UNIT = 1e6/)
  assert.match(source, /MAX_PILOT_USDG = 350 \* USDG_UNIT/)
  assert.match(source, /tokenIn == USDG && amountIn < 1/)
})

test('v2.6 bounds unused value and stops balance passes after convergence', () => {
  assert.match(source, /return "2\.6\.0"/)
  assert.match(source, /MAX_UNUSED_BPS = 200/)
  assert.match(source, /MAX_BALANCE_PASSES = 8/)
  assert.match(source, /BALANCE_STOP_BPS = 1/)
  assert.match(source, /amount0Min: 0/)
  assert.match(source, /unusedValueUsdg \* BPS > desiredValueUsdg \* MAX_UNUSED_BPS/)
  assert.match(source, /nextValueUsdg \* BPS <= totalValueUsdg \* BALANCE_STOP_BPS/)
  assert.match(source, /_validatedPostSwapTick\(currentTick\)/)
  assert.match(source, /_tickDistance\(tick, expectedTick\) > SWAP_PRICE_LIMIT_TICKS/)
})

test('vault exposes the fixed-route atomic automation functions', () => {
  for (const required of ['start', 'addCapital', 'rebalanceAuto', 'withdrawToIdle', 'exitToTokens', 'exitToUsdgAuto', 'harvestUp', 'previewBalance']) {
    assert.equal(functions.includes(required), true, `${required} must be exposed`)
  }
})

test('capital additions are owner-only, atomic and capped against cumulative principal', () => {
  assert.match(source, /function addCapital\([\s\S]*?\)\s*external\s*onlyOwner\s*nonReentrant/)
  assert.match(source, /principalUsdg \+ addedPrincipal > MAX_PILOT_USDG/)
  assert.match(source, /_withdrawPosition\(previousTokenId, deadline\)[\s\S]*?_balanceMintAndStake/)
  assert.match(source, /principalUsdg \+= addedPrincipal/)
})

test('server route verification accepts the current v2.6 runtime', () => {
  assert.match(automationSource, /supportedVersion = \[[^\]]*'2\.6\.0'/)
  assert.match(automationSource, /expectedRangeWidth = \['2\.5\.0', '2\.6\.0'\]/)
  assert.match(automationSource, /supportsCapitalAdd: \[[^\]]*'2\.6\.0'/)
})
