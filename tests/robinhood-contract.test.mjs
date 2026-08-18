import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const artifact = JSON.parse(readFileSync(new URL('../contracts/build/BStockerThreeTickVault.json', import.meta.url), 'utf8'))
const source = readFileSync(new URL('../contracts/BStockerThreeTickVault.sol', import.meta.url), 'utf8')
const automationSource = readFileSync(new URL('../server/robinhood-automation.mjs', import.meta.url), 'utf8')
const keeperSource = readFileSync(new URL('../services/robinhood-keeper/index.mjs', import.meta.url), 'utf8')
const marketSource = readFileSync(new URL('../server/robinhood.mjs', import.meta.url), 'utf8')
const functions = artifact.abi.filter(item => item.type === 'function').map(item => item.name)

test('v3 runtime bytecode remains below the EVM contract size limit', () => {
  assert.ok((artifact.deployedBytecode.length - 2) / 2 < 24_576)
})

test('vault exposes no arbitrary call, recipient mutation or ownership mutation', () => {
  for (const forbidden of ['execute', 'call', 'delegateCall', 'setRecipient', 'withdrawTo', 'recoverERC20', 'transferOwnership']) {
    assert.equal(functions.includes(forbidden), false, `${forbidden} must not be exposed`)
  }
  assert.match(source, /address public immutable owner/)
  assert.match(source, /address public immutable recipient/)
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

test('v3 exposes only fixed-route adaptive automation and owner recovery operations', () => {
  for (const required of [
    'start', 'rebalanceAuto', 'enterDefensiveAuto', 'parkInUsdgAuto', 'resumeNormalAuto',
    'withdrawToIdle', 'exitToTokens', 'harvestUp', 'strategyRange', 'defensiveRange',
  ]) assert.equal(functions.includes(required), true, `${required} must be exposed`)
  for (const removed of ['addCapital', 'exitToUsdgAuto', 'resetAfterExit', 'previewBalance', 'sweepDust']) {
    assert.equal(functions.includes(removed), false, `${removed} must not be exposed by v3`)
  }
  assert.match(source, /return "3\.0\.0"/)
})

test('five-tick, deadline, tick drift, rate and expanded oracle limits are compiled in', () => {
  assert.match(source, /RANGE_INTERVALS = 5/)
  assert.match(source, /RANGE_WIDTH = 50/)
  assert.match(source, /MAX_DEADLINE_DELAY = 30 seconds/)
  assert.match(source, /MAX_START_DEADLINE_DELAY = 5 minutes/)
  assert.match(source, /EXPECTED_TICK_TOLERANCE = 10/)
  assert.match(source, /SWAP_PRICE_LIMIT_TICKS = 100/)
  assert.match(source, /MAX_REBALANCES_10_MIN = 3/)
  assert.match(source, /MAX_REBALANCES_1_HOUR = 10/)
  assert.match(source, /REQUIRED_ORACLE_CARDINALITY = 256/)
})

test('normal and defensive ranges retain the same width with a two-interval downward shift', () => {
  assert.match(source, /function strategyRange[\s\S]*?tickLower = anchor - \(TICK_SPACING \* 2\)[\s\S]*?tickUpper = anchor \+ \(TICK_SPACING \* 3\)/)
  assert.match(source, /function defensiveRange[\s\S]*?tickLower = anchor - \(TICK_SPACING \* 4\)[\s\S]*?tickUpper = anchor \+ TICK_SPACING/)
  assert.match(source, /defensiveAnchor = tickLower \+ \(TICK_SPACING \* 4\)/)
})

test('adaptive entry, parking and recovery all require onchain price conditions', () => {
  assert.match(source, /SLOW_DROP_15_TWAP_TICKS = 25/)
  assert.match(source, /SLOW_DROP_30_TWAP_TICKS = 38/)
  assert.match(source, /DEFENSE_EXIT_TICKS = 20/)
  assert.match(source, /RECOVERY_15_TWAP_TICKS = 25/)
  assert.match(source, /MIN_DEFENSIVE_DURATION = 30 minutes/)
  assert.match(source, /MIN_USDG_WAIT_DURATION = 60 minutes/)
  assert.match(source, /function _slowDowntrendConfirmed[\s\S]*?secondsAgos\[1\] = 900[\s\S]*?secondsAgos\[2\] = 1800/)
  assert.match(source, /function _recoveryConfirmed[\s\S]*?secondsAgos\[3\] = 3600/)
  assert.match(source, /block\.timestamp < uint256\(modeChangedAt\) \+ minimumWait/)
})

test('rapid or continued defensive decline parks assets as USDG inside the vault', () => {
  const parkBody = source.match(/function parkInUsdgAuto[\s\S]*?\n    }\n\n    \/\/\/ @notice 방어 또는 USDG 대기/)?.[0] || ''
  assert.match(parkBody, /mode == Mode\.DEFENSIVE && tick <= defensiveAnchor - DEFENSE_EXIT_TICKS/)
  assert.match(parkBody, /_fiveMinuteCrashConfirmed\(\)/)
  assert.match(parkBody, /_swapVaultSpcxToUsdg\(tick, deadline\)/)
  assert.match(parkBody, /_setMode\(Mode\.USDG_WAIT\)/)
  assert.doesNotMatch(parkBody, /_sendAll\(USDG, recipient\)/)
  assert.match(source, /function exitToTokens[\s\S]*?_sendAll\(USDG, recipient\)/)
  assert.match(source, /return tick <= twap300 - FIVE_MINUTE_CRASH_TICKS \/ 2/)
})

test('ordinary NAV loss is absent from v3 execution conditions', () => {
  assert.doesNotMatch(source, /NAV_HARD_STOP_BPS/)
  assert.doesNotMatch(source, /principalUsdg \* \(BPS -/)
  assert.match(source, /MAX_PILOT_USDG = type\(uint256\)\.max/)
})

test('existing Slipstream pool mint never asks the position manager to create the pool again', () => {
  assert.match(source, /sqrtPriceX96:\s*0/)
  assert.doesNotMatch(source, /sqrtPriceX96:\s*sqrtPriceX96/)
})

test('every swap is TWAP bounded and Keeper prefers the direct FCFS sequencer', () => {
  assert.match(source, /referenceSqrtPriceX96 = _twapSqrtPriceX96\(30\)/)
  assert.match(source, /_swapExactIn\(SPCX, amountIn, _twapSqrtPriceX96\(300\), tick, true, deadline\)/)
  assert.match(source, /amountOutMinimum = spotQuote \* \(BPS - slippageBps\) \/ BPS/)
  assert.match(source, /sqrtPriceLimitX96 = _priceLimit/)
  assert.match(keeperSource, /sequencer\.mainnet\.chain\.robinhood\.com/)
  assert.match(keeperSource, /sequencer\.sendRawTransaction\(\{ serializedTransaction \}\)/)
  assert.match(keeperSource, /CONFIGURED_RPC_TO_FCFS_SEQUENCER/)
})

test('server verification pins the full v3 adaptive policy', () => {
  assert.match(automationSource, /supportedVersion = \[[^\]]*'3\.0\.0'/)
  assert.match(automationSource, /Number\(requiredOracleCardinality\) === 256/)
  assert.match(automationSource, /Number\(slowDrop15Ticks\) === 25/)
  assert.match(automationSource, /Number\(slowDrop30Ticks\) === 38/)
  assert.match(automationSource, /Number\(defenseExitTicks\) === 20/)
  assert.match(automationSource, /Number\(minDefensiveDuration\) === 30 \* 60/)
  assert.match(automationSource, /Number\(minUsdgWaitDuration\) === 60 \* 60/)
  assert.match(automationSource, /adaptiveAutomation: version === '3\.0\.0'/)
})

test('display NAV still uses verified onchain Chainlink feeds as telemetry', () => {
  assert.match(marketSource, /priceSource: 'CHAINLINK_ONCHAIN'/)
  assert.match(marketSource, /const tokenPrice = Number\(spcxAnswer\) \/ Number\(usdgAnswer\)/)
})

test('Keeper syncs to confirmed mode and verifies every adaptive postcondition', () => {
  assert.match(keeperSource, /adaptiveEngine\.syncConfirmedState/)
  assert.match(keeperSource, /'enterDefensiveAuto'.*'AUTO_ENTER_DEFENSIVE'/)
  assert.match(keeperSource, /'parkInUsdgAuto'.*'AUTO_PARK_IN_USDG'/)
  assert.match(keeperSource, /'resumeNormalAuto'.*'AUTO_RESUME_NORMAL'/)
  assert.match(keeperSource, /after\.mode !== 'DEFENSIVE'/)
  assert.match(keeperSource, /after\.mode !== 'USDG_WAIT'/)
  assert.match(keeperSource, /after\.mode !== 'LIVE'/)
  assert.match(keeperSource, /after\.totalRebalances !== before\.totalRebalances \+ 1/)
  assert.match(keeperSource, /receipt\.logs\.some\(log => getAddress\(log\.address\) === vaultAddress\)/)
})
