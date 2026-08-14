import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createWalletClient, encodeFunctionData, formatEther, formatUnits, getAddress, http, isAddress } from 'viem'
import { createRobinhoodService, ROBINHOOD_CHAIN, ROBINHOOD_CONTRACTS } from '../../server/robinhood.mjs'
import { loadAutomationConfig, readVaultStatus, vaultAbi } from '../../server/robinhood-automation.mjs'
import { loadKeeperAccount, readKeeperIdentity } from '../../server/robinhood-keeper-key.mjs'
import {
  activeExecutionBackoff,
  executionBackoffReason,
  scheduleExecutionBackoff,
} from '../../server/robinhood-execution-gate.mjs'
import { DEFAULT_ROBINHOOD_GUARD_CONFIG, rangeAnchor, ShadowGuardEngine } from '../../server/robinhood-strategy.mjs'

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const workDirectory = join(root, 'work')
const stateFile = join(workDirectory, 'robinhood-strategy-state.json')
const temporaryStateFile = join(workDirectory, 'robinhood-strategy-state.tmp.json')
const historyFile = join(workDirectory, 'robinhood-strategy-history.ndjson')
const transactionHistoryFile = join(workDirectory, 'robinhood-automation-transactions.ndjson')
const transferTopic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

function loadEnvFile(file) {
  if (!existsSync(file)) return {}
  return Object.fromEntries(readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).filter(line => !line.trim().startsWith('#')).map(line => {
    const index = line.indexOf('=')
    return index < 0 ? [line.trim(), ''] : [line.slice(0, index).trim(), line.slice(index + 1).trim().replace(/^['"]|['"]$/g, '')]
  }))
}

const fileEnv = { ...loadEnvFile(join(root, '.env')), ...loadEnvFile(join(root, '.env.local')) }
const env = key => process.env[key] || fileEnv[key]
const requestedMode = String(env('ROBINHOOD_KEEPER_MODE') || 'shadow').toLowerCase()
if (!['shadow', 'auto'].includes(requestedMode)) throw new Error('ROBINHOOD_KEEPER_MODE는 shadow 또는 auto만 사용할 수 있습니다.')
const liveAutomationAllowed = env('ROBINHOOD_LIVE_AUTOMATION_ALLOWED') === 'true'
const automationOwnerCandidate = env('ROBINHOOD_AUTOMATION_OWNER') || ''
const automationOwner = isAddress(automationOwnerCandidate) ? getAddress(automationOwnerCandidate) : null
const rpcUrl = env('ROBINHOOD_RPC_URL') || env('VITE_ROBINHOOD_RPC_URL') || 'https://rpc.mainnet.chain.robinhood.com'
const sequencerUrl = env('ROBINHOOD_SEQUENCER_URL') || 'https://sequencer.mainnet.chain.robinhood.com'
const pollMs = Math.max(2_000, Number(env('ROBINHOOD_KEEPER_POLL_MS') || 5_000))
const maxGas = BigInt(Math.max(500_000, Number(env('ROBINHOOD_KEEPER_MAX_GAS') || 4_000_000)))
const maxGasPriceWei = BigInt(Math.max(1, Number(env('ROBINHOOD_KEEPER_MAX_GAS_GWEI') || 5))) * 10n ** 9n
const harvestThresholdUp = Math.max(0.01, Number(env('ROBINHOOD_HARVEST_THRESHOLD_UP') || 1))
const harvestIntervalMs = Math.max(10 * 60_000, Number(env('ROBINHOOD_HARVEST_INTERVAL_MS') || 60 * 60_000))
const once = process.argv.includes('--once')
const service = createRobinhoodService({ rpcUrl })
const keeperIdentity = readKeeperIdentity()
let keeperAccount = null
let walletClient = null
let sequencerClient = null
let keeperKeyVerified = false
let keeperKeyError = null

if (requestedMode === 'auto' && liveAutomationAllowed) {
  try {
    const checked = loadKeeperAccount()
    if (!keeperIdentity || checked.address !== getAddress(keeperIdentity.address)) throw new Error('Keeper 공개 주소 검증에 실패했습니다.')
    keeperKeyVerified = true
  } catch (error) {
    keeperKeyError = error instanceof Error ? error.message : String(error)
  }
}

function previousState() {
  if (!existsSync(stateFile)) return null
  try { return JSON.parse(readFileSync(stateFile, 'utf8')) } catch { return null }
}

const previous = previousState()
let engine = new ShadowGuardEngine(DEFAULT_ROBINHOOD_GUARD_CONFIG, previous?.engine, { executionMode: 'SHADOW' })
let activeExecutionMode = 'SHADOW'
let idleVaultResetKey = null
const startedAt = Date.now()
let stopping = false
let lastTransaction = previous?.lastTransaction || null
let lastHarvestAt = Number(previous?.lastHarvestAt || 0)
let executionBackoff = previous?.executionBackoff || null
if (String(executionBackoff?.lastError || '').includes('Missing or invalid parameters')) executionBackoff = null

function writeState(value) {
  mkdirSync(workDirectory, { recursive: true })
  writeFileSync(temporaryStateFile, JSON.stringify(value, null, 2), 'utf8')
  renameSync(temporaryStateFile, stateFile)
}

function appendHistory(file, value, rotateBytes = 10 * 1024 * 1024) {
  try {
    if (existsSync(file) && statSync(file).size > rotateBytes) renameSync(file, `${file}.${Date.now()}.bak`)
    appendFileSync(file, `${JSON.stringify(value)}\n`, 'utf8')
  } catch (error) {
    console.error('Keeper history 기록 실패:', error instanceof Error ? error.message : error)
  }
}

function switchExecutionMode(nextMode, snapshot, vault) {
  if (nextMode === activeExecutionMode) {
    engine.setExecutionMode(nextMode)
    return
  }
  const serialized = engine.serialize()
  engine = new ShadowGuardEngine(DEFAULT_ROBINHOOD_GUARD_CONFIG, {
    samples: serialized.samples,
    virtualRange: vault?.position ? {
      lower: vault.position.tickLower,
      upper: vault.position.tickUpper,
      anchor: rangeAnchor(vault.position.tickLower, vault.position.tickUpper, snapshot.tickSpacing),
      width: vault.position.tickUpper - vault.position.tickLower,
    } : null,
    events: serialized.events,
  }, { executionMode: nextMode })
  activeExecutionMode = nextMode
}

function resetGuardForIdleVault(config, vault) {
  const isIdle = Boolean(config?.executorAddress && vault?.activeTokenId === '0' && vault?.mode === 'PAUSED')
  if (!isIdle) {
    idleVaultResetKey = null
    return
  }
  const key = config.executorAddress.toLowerCase()
  if (idleVaultResetKey === key) return
  const serialized = engine.serialize()
  // Preserve market/TWAP warm-up samples and audit events, but never carry a
  // previous position's range, rebalance counters or pause timer into an empty Vault.
  engine = new ShadowGuardEngine(DEFAULT_ROBINHOOD_GUARD_CONFIG, {
    samples: serialized.samples,
    events: serialized.events,
  }, { executionMode: activeExecutionMode })
  idleVaultResetKey = key
}

function signer() {
  if (!keeperAccount) {
    keeperAccount = loadKeeperAccount()
    walletClient = createWalletClient({
      account: keeperAccount,
      chain: ROBINHOOD_CHAIN,
      // Read nonce/fees and prepare the signature through the configured RPC.
      transport: http(rpcUrl, { timeout: 12_000, retryCount: 2, retryDelay: 300 }),
    })
    sequencerClient = createWalletClient({
      account: keeperAccount,
      chain: ROBINHOOD_CHAIN,
      // Submit only the fully signed raw transaction to the official Sequencer.
      // There is intentionally no public-RPC broadcast fallback.
      transport: http(sequencerUrl, { timeout: 12_000, retryCount: 0 }),
    })
  }
  return { account: keeperAccount, wallet: walletClient, sequencer: sequencerClient }
}

function sequencerSubmissionUnavailable(error) {
  const message = error instanceof Error ? error.message : String(error)
  return /Missing or invalid parameters|method not found|unsupported method/i.test(message)
}

async function sendVaultTransaction(executorAddress, functionName, args, actionName, snapshot) {
  const { account, wallet, sequencer } = signer()
  const vaultAddress = getAddress(executorAddress)
  const simulation = await service.client.simulateContract({
    account,
    address: vaultAddress,
    abi: vaultAbi,
    functionName,
    args,
  })
  const [gas, gasPrice, balance] = await Promise.all([
    service.client.estimateContractGas(simulation.request),
    service.client.getGasPrice(),
    service.client.getBalance({ address: account.address }),
  ])
  if (gas > maxGas) throw new Error(`예상 gas ${gas}가 Keeper 상한 ${maxGas}를 넘었습니다.`)
  const submissionGasPrice = gasPrice * 9n / 8n
  if (submissionGasPrice > maxGasPriceWei) throw new Error(`gas price가 설정 상한 ${Number(maxGasPriceWei) / 1e9} gwei를 넘었습니다.`)
  const required = gas * submissionGasPrice * 2n
  if (balance < required) throw new Error(`Keeper ETH가 부족합니다. 현재 ${formatEther(balance)} ETH, 안전 필요량 ${formatEther(required)} ETH`)
  const data = encodeFunctionData({ abi: vaultAbi, functionName, args })
  const prepared = await wallet.prepareTransactionRequest({
    account,
    to: vaultAddress,
    data,
    gas: gas * 12n / 10n,
    gasPrice: submissionGasPrice,
    type: 'legacy',
  })
  const serializedTransaction = await wallet.signTransaction(prepared)
  let transactionSubmission = 'DIRECT_FCFS_SEQUENCER'
  let hash
  try {
    hash = await sequencer.sendRawTransaction({ serializedTransaction })
  } catch (error) {
    if (!sequencerSubmissionUnavailable(error)) throw error
    // Robinhood 공식 문서가 권장하는 설정 RPC도 최종적으로 같은 FCFS
    // Sequencer에 전달한다. 직접 endpoint의 JSON-RPC 호환 오류에만 사용한다.
    hash = await wallet.sendRawTransaction({ serializedTransaction })
    transactionSubmission = 'CONFIGURED_RPC_TO_FCFS_SEQUENCER'
  }
  const receipt = await service.client.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 90_000 })
  if (receipt.status !== 'success') throw new Error(`${actionName} 트랜잭션이 revert됐습니다.`)
  if (!receipt.to || getAddress(receipt.to) !== vaultAddress) throw new Error(`${actionName} 트랜잭션 대상이 Vault와 일치하지 않습니다.`)
  if (!receipt.logs.some(log => getAddress(log.address) === vaultAddress)) throw new Error(`${actionName} Vault 이벤트가 없어 실행 성공을 확인할 수 없습니다.`)
  const tx = {
    at: Date.now(),
    action: actionName,
    hash,
    blockNumber: receipt.blockNumber.toString(),
    gasUsed: receipt.gasUsed.toString(),
    effectiveGasPrice: receipt.effectiveGasPrice.toString(),
    transactionSubmission,
    expectedTick: snapshot.tick,
    rewardUp: receipt.logs.reduce((total, log) => {
      const topics = Array.isArray(log?.topics) ? log.topics : []
      const from = typeof topics[1] === 'string' ? `0x${topics[1].slice(-40)}`.toLowerCase() : null
      if (String(log?.address).toLowerCase() !== ROBINHOOD_CONTRACTS.up.toLowerCase()
        || String(topics[0]).toLowerCase() !== transferTopic
        || from !== executorAddress.toLowerCase()) return total
      try { return total + Number(formatUnits(BigInt(log.data || 0), 18)) } catch { return total }
    }, 0),
  }
  return tx
}

function assertVaultPostcondition(actionName, before, after) {
  if (!after || getAddress(after.address) !== getAddress(before.address)) throw new Error(`${actionName} 이후 Vault 상태를 읽지 못했습니다.`)
  if (actionName === 'AUTO_REBALANCE') {
    if (after.totalRebalances !== before.totalRebalances + 1
      || after.activeTokenId === before.activeTokenId
      || after.activeTokenId === '0'
      || !after.position) {
      throw new Error('AUTO_REBALANCE 온체인 카운터·NFT 교체를 확인하지 못했습니다.')
    }
    return
  }
  if (actionName === 'AUTO_HARVEST_UP') {
    if (after.totalHarvestedUp <= before.totalHarvestedUp) throw new Error('AUTO_HARVEST_UP 온체인 수확량 증가를 확인하지 못했습니다.')
    return
  }
  if (actionName === 'AUTO_WITHDRAW_TO_IDLE') {
    if (after.activeTokenId !== '0' || after.mode !== 'WITHDRAW_ONLY') throw new Error('AUTO_WITHDRAW_TO_IDLE 온체인 회수를 확인하지 못했습니다.')
    return
  }
  if (actionName === 'AUTO_EXIT_TO_USDG') {
    if (after.activeTokenId !== '0'
      || after.mode !== 'WITHDRAW_ONLY'
      || Number(after.balances?.SPCX || 0) !== 0
      || Number(after.balances?.USDG || 0) !== 0) {
      throw new Error('AUTO_EXIT_TO_USDG 온체인 USDG 종료를 확인하지 못했습니다.')
    }
  }
}

function recordTransaction(tx, vault) {
  const enriched = {
    ...tx,
    executorAddress: vault?.address || null,
    principalUsdAfter: vault?.principalUsdg ?? null,
    navUsdAfter: vault?.navUsd ?? null,
    totalHarvestedUpAfter: vault?.totalHarvestedUp ?? null,
    earnedUpAfter: vault?.balances?.earnedUP ?? null,
    rangeAfter: vault?.position ? { lower: vault.position.tickLower, upper: vault.position.tickUpper } : null,
  }
  lastTransaction = enriched
  appendHistory(transactionHistoryFile, enriched, 5 * 1024 * 1024)
  return enriched
}

async function refreshVault(config, snapshot) {
  return readVaultStatus(service.client, config.executorAddress, config.keeperAddress, {
    sqrtPriceX96: snapshot.sqrtPriceX96,
    spotPrice: snapshot.spotPrice,
    officialPrice: snapshot.official?.tokenPrice,
  })
}

async function executeDecision(config, vault, snapshot, decision) {
  // 스냅샷 시각이 아니라 직전 확정 블록 시각을 사용해 RPC 지연으로 deadline이
  // 이미 만료되는 일을 막는다. 컨트랙트의 30초 상한보다 2초 짧게 둔다.
  const latestBlock = await service.client.getBlock()
  const deadline = latestBlock.timestamp + BigInt(DEFAULT_ROBINHOOD_GUARD_CONFIG.transactionDeadlineSec - 2)
  if (decision.action === 'USDG_EXIT_REQUIRED') {
    const hasManagedAssets = vault.activeTokenId !== '0'
      || Number(vault.balances?.SPCX || 0) > 0
      || Number(vault.balances?.USDG || 0) > 0
    if (!hasManagedAssets) return null
    if (!vault.autoUsdgSafetyExit) {
      if (vault.mode !== 'LIVE' || vault.activeTokenId === '0') return null
      const legacyTx = await sendVaultTransaction(config.executorAddress, 'withdrawToIdle', [deadline], 'AUTO_WITHDRAW_TO_IDLE', snapshot)
      let legacyRefreshed
      legacyRefreshed = await refreshVault(config, snapshot)
      assertVaultPostcondition('AUTO_WITHDRAW_TO_IDLE', vault, legacyRefreshed)
      recordTransaction(legacyTx, legacyRefreshed)
      return lastTransaction
    }
    const tx = await sendVaultTransaction(config.executorAddress, 'exitToUsdgAuto', [deadline], 'AUTO_EXIT_TO_USDG', snapshot)
    let refreshed
    refreshed = await refreshVault(config, snapshot)
    assertVaultPostcondition('AUTO_EXIT_TO_USDG', vault, refreshed)
    recordTransaction(tx, refreshed)
    return lastTransaction
  }
  if (vault.mode !== 'LIVE' || vault.activeTokenId === '0') return null
  if (decision.action === 'REBALANCE_REQUIRED') {
    const tx = await sendVaultTransaction(config.executorAddress, 'rebalanceAuto', [snapshot.tick, deadline], 'AUTO_REBALANCE', snapshot)
    let refreshed
    refreshed = await refreshVault(config, snapshot)
    assertVaultPostcondition('AUTO_REBALANCE', vault, refreshed)
    recordTransaction(tx, refreshed)
    if (refreshed?.position) {
      engine.recordConfirmedRebalance(Date.now(), {
        lower: refreshed.position.tickLower,
        upper: refreshed.position.tickUpper,
        anchor: rangeAnchor(refreshed.position.tickLower, refreshed.position.tickUpper, snapshot.tickSpacing),
        width: refreshed.position.tickUpper - refreshed.position.tickLower,
      })
    }
    return lastTransaction
  }
  if (decision.action === 'WITHDRAW_TO_IDLE_REQUIRED') {
    const tx = await sendVaultTransaction(config.executorAddress, 'withdrawToIdle', [deadline], 'AUTO_WITHDRAW_TO_IDLE', snapshot)
    let refreshed
    refreshed = await refreshVault(config, snapshot)
    assertVaultPostcondition('AUTO_WITHDRAW_TO_IDLE', vault, refreshed)
    recordTransaction(tx, refreshed)
    return lastTransaction
  }
  if (decision.state === 'LIVE' && decision.action === 'NO_ACTION' && vault.balances.earnedUP >= harvestThresholdUp && Date.now() - lastHarvestAt >= harvestIntervalMs) {
    const tx = await sendVaultTransaction(config.executorAddress, 'harvestUp', [], 'AUTO_HARVEST_UP', snapshot)
    let refreshed
    refreshed = await refreshVault(config, snapshot)
    assertVaultPostcondition('AUTO_HARVEST_UP', vault, refreshed)
    recordTransaction(tx, refreshed)
    lastHarvestAt = Date.now()
    return lastTransaction
  }
  return null
}

async function sample() {
  const sampledAt = Date.now()
  try {
    const snapshot = await service.loadSnapshot()
    const config = loadAutomationConfig()
    let vault = null
    let vaultError = null
    if (config) {
      try {
        vault = await readVaultStatus(service.client, config.executorAddress, keeperIdentity?.address, {
          sqrtPriceX96: snapshot.sqrtPriceX96,
          spotPrice: snapshot.spotPrice,
          officialPrice: snapshot.official?.tokenPrice,
        })
        snapshot.strategyNavUsd = vault.navUsd
        snapshot.strategyPrincipalUsd = vault.principalUsdg
        if (vault.position) {
          snapshot.managedRange = {
            lower: vault.position.tickLower,
            upper: vault.position.tickUpper,
            anchor: rangeAnchor(vault.position.tickLower, vault.position.tickUpper, snapshot.tickSpacing),
            width: vault.position.tickUpper - vault.position.tickLower,
          }
        }
      } catch (error) {
        vaultError = error instanceof Error ? error.message : String(error)
      }
    }
    if (executionBackoff && (
      !config?.executorAddress
      || executionBackoff.executorAddress?.toLowerCase() !== config.executorAddress.toLowerCase()
      || vault?.activeTokenId === '0'
    )) executionBackoff = null
    const vaultVerified = Boolean(vault?.routeVerified && vault?.ownerLocked && vault?.keeperVerified
      && config && automationOwner && vault.owner === automationOwner && config.ownerAddress === automationOwner)
    const live = Boolean(requestedMode === 'auto' && liveAutomationAllowed && keeperKeyVerified && config?.armed && keeperIdentity && vaultVerified)
    switchExecutionMode(live ? 'LIVE' : 'SHADOW', snapshot, vault)
    resetGuardForIdleVault(config, vault)
    const rawDecision = engine.ingest(snapshot)
    // An armed but not-yet-started Vault has no NFT to rebalance. Keep the
    // market guard state live for owner start validation, but suppress stale
    // REBALANCE_REQUIRED actions inherited from the previous Vault range.
    let decision = vault?.activeTokenId === '0'
      ? { ...rawDecision, action: 'NO_ACTION', reasons: [...rawDecision.reasons, 'Vault 시작 대기 중이며 재배치할 포지션이 없습니다.'] }
      : rawDecision
    let executionError = vaultError || keeperKeyError
    let executed = null
    if (live) {
      const blocked = activeExecutionBackoff(executionBackoff, {
        executorAddress: config.executorAddress,
        action: decision.action,
      })
      if (blocked) {
        decision = {
          ...decision,
          action: ['LIQUIDITY_SLIPPAGE', 'BALANCE_CONVERGENCE'].includes(blocked.code) ? 'LIQUIDITY_BLOCKED' : 'EXECUTION_BACKOFF',
          reasons: [executionBackoffReason(blocked), ...decision.reasons],
        }
      } else {
        try {
          executed = await executeDecision(config, vault, snapshot, decision)
          if (executed) executionBackoff = null
        } catch (error) {
          executionError = error instanceof Error ? error.message : String(error)
          executionBackoff = scheduleExecutionBackoff(executionBackoff, error, {
            executorAddress: config.executorAddress,
            action: decision.action,
          })
          decision = {
            ...decision,
            action: ['LIQUIDITY_SLIPPAGE', 'BALANCE_CONVERGENCE'].includes(executionBackoff.code) ? 'LIQUIDITY_BLOCKED' : 'EXECUTION_BACKOFF',
            reasons: [executionBackoffReason(executionBackoff), ...decision.reasons],
          }
        }
      }
    }
    const state = {
      service: 'bstocker-robinhood-keeper',
      mode: live ? 'LIVE' : 'SHADOW',
      healthy: true,
      startedAt,
      updatedAt: Date.now(),
      pollMs,
      rpcKind: rpcUrl.includes('rpc.mainnet.chain.robinhood.com') ? 'PUBLIC_RATE_LIMITED' : 'DEDICATED',
      transactionSubmission: 'DIRECT_FCFS_SEQUENCER',
      snapshot,
      decision,
      engine: engine.serialize(),
      writesEnabled: live,
      signerLoaded: Boolean(keeperAccount),
      keeperKeyVerified,
      keeperAddress: keeperIdentity?.address || null,
      executorAddress: config?.executorAddress || null,
      automationArmed: Boolean(config?.armed),
      automationOwner,
      vault,
      executionError,
      executionBackoff,
      lastTransaction,
      lastHarvestAt,
    }
    writeState(state)
    appendHistory(historyFile, {
      at: state.updatedAt,
      blockNumber: snapshot.blockNumber,
      tick: snapshot.tick,
      spotPrice: snapshot.spotPrice,
      officialPrice: snapshot.official?.tokenPrice ?? null,
      strategyNavUsd: snapshot.strategyNavUsd ?? null,
      state: decision.state,
      action: decision.action,
      reasons: decision.reasons,
      range: decision.range,
      mode: state.mode,
      executed,
      executionError,
      executionBackoff,
    })
    const executionSuffix = executed ? ` · tx ${executed.hash.slice(0, 10)}` : executionError ? ` · BLOCKED ${executionError}` : ''
    console.log(`[${new Date().toISOString()}] ${state.mode} · ${decision.state} · ${decision.action} · tick ${snapshot.tick} · ${snapshot.spotPrice.toFixed(4)} USDG${executionSuffix}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const state = {
      ...(previousState() || {}),
      service: 'bstocker-robinhood-keeper',
      mode: activeExecutionMode,
      healthy: false,
      startedAt,
      updatedAt: Date.now(),
      pollMs,
      error: message,
      writesEnabled: false,
      signerLoaded: Boolean(keeperAccount),
      keeperKeyVerified,
      keeperAddress: keeperIdentity?.address || null,
      executionError: keeperKeyError || message,
      engine: engine.serialize(),
      lastTransaction,
      lastHarvestAt,
    }
    writeState(state)
    appendHistory(historyFile, { at: sampledAt, state: 'RPC_ERROR', action: 'NO_ACTION', reasons: [message], mode: activeExecutionMode })
    console.error(`[${new Date().toISOString()}] keeper sample 실패: ${message}`)
  }
}

async function main() {
  do {
    await sample()
    if (once || stopping) break
    await new Promise(resolve => setTimeout(resolve, pollMs))
  } while (!stopping)
}

process.on('SIGINT', () => { stopping = true })
process.on('SIGTERM', () => { stopping = true })

await main()
