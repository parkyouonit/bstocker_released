import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const artifact = JSON.parse(readFileSync(new URL('../contracts/build/BStockerThreeTickVault.json', import.meta.url), 'utf8'))
const source = readFileSync(new URL('../contracts/BStockerThreeTickVault.sol', import.meta.url), 'utf8')
const automationSource = readFileSync(new URL('../server/robinhood-automation.mjs', import.meta.url), 'utf8')
const keeperSource = readFileSync(new URL('../services/robinhood-keeper/index.mjs', import.meta.url), 'utf8')
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

test('keeper can only perform a condition-checked USDG safety exit to the immutable recipient', () => {
  assert.match(source, /function exitToUsdgAuto\([\s\S]*?\) external onlySafetyOperator/)
  assert.match(source, /if \(!crashConfirmed && !navHardStop\) revert CrashNotConfirmed\(\)/)
  assert.match(source, /navValueUsdg \* BPS <= principalUsdg \* \(BPS - NAV_HARD_STOP_BPS\)/)
  assert.match(source, /if \(remainingSpcx >= 1e9\) revert EmergencySwapIncomplete\(remainingSpcx\)/)
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
  assert.match(source, /MAX_BALANCE_PASSES = 10/)
  assert.match(source, /REQUIRED_ORACLE_CARDINALITY = 64/)
})

test('existing Slipstream pool mint never asks the position manager to create the pool again', () => {
  assert.match(source, /sqrtPriceX96:\s*0/)
  assert.doesNotMatch(source, /sqrtPriceX96:\s*sqrtPriceX96/)
})

test('v2.8 remains uncapped while keeping token-specific dust thresholds', () => {
  assert.match(source, /USDG_UNIT = 1e6/)
  assert.match(source, /MAX_PILOT_USDG = type\(uint256\)\.max/)
  assert.doesNotMatch(source, /principal > MAX_PILOT_USDG/)
  assert.match(source, /tokenIn == USDG && amountIn < 1/)
})

test('v2.8 dampens direction flips and keeps excess capital safely idle', () => {
  assert.match(source, /return "2\.8\.0"/)
  assert.match(source, /MAX_UNUSED_BPS = 1_000/)
  assert.match(source, /MAX_BALANCE_PASSES = 10/)
  assert.match(source, /BALANCE_STOP_BPS = 1/)
  assert.match(source, /amount0Min: 0/)
  assert.match(source, /previousTokenIn != address\(0\) && previousTokenIn != nextTokenIn/)
  assert.match(source, /IdleBalanceTooHigh\(unusedValueUsdg, desiredValueUsdg\)/)
  assert.match(source, /nextValueUsdg \* BPS <= totalValueUsdg \* BALANCE_STOP_BPS/)
  assert.match(source, /_validatedPostSwapTick\(currentTick\)/)
  assert.match(source, /_tickDistance\(tick, expectedTick\) > SWAP_PRICE_LIMIT_TICKS/)
})

test('vault exposes the fixed-route atomic automation functions', () => {
  for (const required of ['start', 'addCapital', 'rebalanceAuto', 'withdrawToIdle', 'exitToTokens', 'exitToUsdgAuto', 'harvestUp', 'previewBalance']) {
    assert.equal(functions.includes(required), true, `${required} must be exposed`)
  }
})

test('capital additions are owner-only and atomic without an amount cap', () => {
  assert.match(source, /function addCapital\([\s\S]*?\)\s*external\s*onlyOwner\s*nonReentrant/)
  assert.doesNotMatch(source, /principalUsdg \+ addedPrincipal > MAX_PILOT_USDG/)
  assert.match(source, /if \(addedPrincipal == 0\) revert InvalidPosition\(\)/)
  assert.match(source, /_withdrawPosition\(previousTokenId, deadline\)[\s\S]*?_balanceMintAndStake/)
  assert.match(source, /principalUsdg \+= addedPrincipal/)
})

test('server route verification accepts only the v2.8 safety constants for the current runtime', () => {
  assert.match(automationSource, /supportedVersion = \[[^\]]*'2\.8\.0'/)
  assert.match(automationSource, /unlimitedVersion = \['2\.7\.0', '2\.8\.0'\]/)
  assert.match(automationSource, /Number\(maxUnusedBps\) === 1_000/)
  assert.match(automationSource, /Number\(navHardStopBps\) === 500/)
  assert.match(automationSource, /Number\(crashTicks\) === 305/)
})

test('every swap is TWAP bounded and Keeper prefers the direct FCFS sequencer', () => {
  assert.match(source, /referenceSqrtPriceX96 = _twapSqrtPriceX96\(30\)/)
  assert.match(source, /twapSqrtPriceX96 = _twapSqrtPriceX96\(300\)/)
  assert.match(source, /amountOutMinimum = spotQuote \* \(BPS - slippageBps\) \/ BPS/)
  assert.match(source, /sqrtPriceLimitX96 = _priceLimit/)
  assert.match(keeperSource, /sequencer\.mainnet\.chain\.robinhood\.com/)
  assert.match(keeperSource, /transactionSubmission: 'DIRECT_FCFS_SEQUENCER'/)
  assert.match(keeperSource, /'exitToUsdgAuto'.*'AUTO_EXIT_TO_USDG'/)
  assert.match(keeperSource, /sequencer\.sendRawTransaction\(\{ serializedTransaction \}\)/)
  assert.match(keeperSource, /sequencerSubmissionUnavailable\(error\)[\s\S]*?wallet\.sendRawTransaction\(\{ serializedTransaction \}\)/)
  assert.match(keeperSource, /CONFIGURED_RPC_TO_FCFS_SEQUENCER/)
})

test('Keeper signs an encoded Vault call and verifies onchain postconditions', () => {
  assert.match(keeperSource, /encodeFunctionData\(\{ abi: vaultAbi, functionName, args \}\)/)
  assert.match(keeperSource, /to: vaultAddress,[\s\S]*?data,/)
  assert.doesNotMatch(keeperSource, /prepareTransactionRequest\(\{\s*\.\.\.simulation\.request/)
  assert.match(keeperSource, /receipt\.to[\s\S]*?Vault와 일치하지 않습니다/)
  assert.match(keeperSource, /receipt\.logs\.some\(log => getAddress\(log\.address\) === vaultAddress\)/)
  assert.match(keeperSource, /after\.totalRebalances !== before\.totalRebalances \+ 1/)
  assert.match(keeperSource, /after\.activeTokenId === before\.activeTokenId/)
  assert.match(keeperSource, /assertVaultPostcondition\('AUTO_REBALANCE', vault, refreshed\)/)
})
