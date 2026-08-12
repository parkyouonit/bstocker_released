import { useEffect, useMemo, useRef, useState } from 'react'
import { isAddress, parseUnits, type Address, type Hash } from 'viem'
import { formatMoney, formatNumber, formatPercent, shortAddress } from '../lib/format'
import {
  deployRobinhoodAutomationVault,
  addRobinhoodAutomationCapital,
  executeRobinhoodVaultOwnerAction,
  fetchRobinhoodAutomationBootstrap,
  fundRobinhoodKeeper,
  readRobinhoodVaultKeeper,
  readRobinhoodAutomationTokenBalances,
  revokeRobinhoodVaultTokenApprovals,
  setRobinhoodAutomationAuthorization,
  startRobinhoodAutomation,
  startRobinhoodAutomationWithRawAmounts,
  updateRobinhoodVaultKeeper,
  type RobinhoodAutomationBootstrap,
  type RobinhoodVaultOwnerAction,
} from '../lib/robinhoodAutomation'
import type { RobinhoodStrategyStatus } from '../lib/robinhoodStrategy'

interface Props {
  data: RobinhoodStrategyStatus
  walletAddress?: Address
  onConnect: () => void
  onRefresh: () => void
}

type Activity = { state: 'idle' | 'busy' | 'success' | 'error'; message?: string; hash?: Hash }

function signedMoney(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return '—'
  return `${value >= 0 ? '+' : '-'}${formatMoney(Math.abs(value))}`
}

function signedPercent(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return '—'
  return `${value >= 0 ? '+' : ''}${formatPercent(value)}`
}

function pnlTone(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return 'neutral'
  return value >= 0 ? 'positive' : 'negative'
}

const localExecutorKey = 'bstocker.robinhood.executor.v3'
const targetVaultVersion = '2.6.0'
const migrationKey = 'bstocker.robinhood.migration.v2.6'
const legacyMigrationKeys = ['bstocker.robinhood.migration.v2.5', 'bstocker.robinhood.migration.v2.4', 'bstocker.robinhood.migration.v2.3', 'bstocker.robinhood.migration.v2.2']

interface MigrationState {
  oldExecutor: Address
  newExecutor: Address | null
  abandonedExecutors: Address[]
  spcx: string
  usdg: string
  extraUsdg: string
}

function loadMigration(): MigrationState | null {
  for (const key of [migrationKey, ...legacyMigrationKeys]) {
    try {
      const value = JSON.parse(window.localStorage.getItem(key) || 'null')
      if (value?.oldExecutor && typeof value?.spcx === 'string' && typeof value?.usdg === 'string' && typeof value?.extraUsdg === 'string') {
        const abandonedExecutors = Array.isArray(value.abandonedExecutors)
          ? value.abandonedExecutors.filter((address: unknown): address is Address => typeof address === 'string' && isAddress(address))
          : []
        if (key !== migrationKey && typeof value.newExecutor === 'string' && isAddress(value.newExecutor)) {
          abandonedExecutors.push(value.newExecutor)
        }
        return {
          ...value,
          newExecutor: key === migrationKey && typeof value.newExecutor === 'string' && isAddress(value.newExecutor)
            ? value.newExecutor
            : null,
          abandonedExecutors: [...new Set(abandonedExecutors.map((address: Address) => address.toLowerCase()))] as Address[],
        } as MigrationState
      }
    } catch {
      // 다음 이전 버전의 복구 상태를 확인한다.
    }
  }
  return null
}

export function RobinhoodAutomationPanel({ data, walletAddress, onConnect, onRefresh }: Props) {
  const [bootstrap, setBootstrap] = useState<RobinhoodAutomationBootstrap>()
  const [bootstrapError, setBootstrapError] = useState<string>()
  const [accepted, setAccepted] = useState(false)
  const [amount, setAmount] = useState('25')
  const [localExecutor, setLocalExecutor] = useState<Address | null>(() => {
    const value = window.localStorage.getItem(localExecutorKey)
    return value?.startsWith('0x') ? value as Address : null
  })
  const [activity, setActivity] = useState<Activity>({ state: 'idle' })
  const [migration, setMigration] = useState<MigrationState | null>(loadMigration)
  const liveLogRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (migration && !window.localStorage.getItem(migrationKey)) window.localStorage.setItem(migrationKey, JSON.stringify(migration))
    legacyMigrationKeys.forEach(key => window.localStorage.removeItem(key))
    const controller = new AbortController()
    void fetchRobinhoodAutomationBootstrap(controller.signal)
      .then(setBootstrap)
      .catch(error => setBootstrapError(error instanceof Error ? error.message : '자동화 준비 정보를 불러오지 못했습니다.'))
    return () => controller.abort()
  }, [migration])

  const latestLogAt = data.keeper.logs.at(-1)?.at
  useEffect(() => {
    const element = liveLogRef.current
    if (element) element.scrollTop = element.scrollHeight
  }, [latestLogAt])

  const vault = data.automation.vault
  const configuredExecutor = data.executorAddress
  const stagedExecutor = localExecutor && (!configuredExecutor || localExecutor.toLowerCase() !== configuredExecutor.toLowerCase())
    ? localExecutor
    : null
  const executorAddress = stagedExecutor || configuredExecutor || localExecutor
  const executorConfigured = Boolean(executorAddress && configuredExecutor
    && executorAddress.toLowerCase() === configuredExecutor.toLowerCase())
  const replacementRequired = Boolean(vault && !vault.routeVerified && !stagedExecutor)
  const upgradeAvailable = Boolean(vault?.routeVerified && vault.version !== targetVaultVersion)
  const replacementSafe = Boolean(vault
    && vault.activeTokenId === '0'
    && vault.mode === 'PAUSED'
    && vault.balances.SPCX === 0
    && vault.balances.USDG === 0)
  const executorArmed = executorConfigured && data.automation.armed && !replacementRequired
  const explorer = data.contracts.explorer
  const ownerMatches = Boolean(walletAddress && data.automation.expectedOwnerAddress
    && walletAddress.toLowerCase() === data.automation.expectedOwnerAddress.toLowerCase())
  const readyToStart = Boolean(
    walletAddress
      && accepted
      && data.automation.allowed
      && executorArmed
      && vault?.routeVerified
      && !upgradeAvailable
      && vault?.mode === 'PAUSED'
      && data.decision.state === 'LIVE'
      && data.decision.metrics.onchainTwapReady,
  )
  const capitalLimit = vault?.supportsCapitalAdd ? vault.maxPilotUsdg : 350
  const capitalBasis = vault?.supportsCapitalAdd
    ? vault.principalUsdg
    : Math.max(vault?.principalUsdg || 0, vault?.navUsd || 0)
  const remainingCapital = Math.max(0, capitalLimit - capitalBasis)
  const readyToAdd = Boolean(
    walletAddress
      && accepted
      && data.automation.allowed
      && executorArmed
      && vault?.routeVerified
      && vault?.supportsCapitalAdd
      && !upgradeAvailable
      && vault?.mode === 'LIVE'
      && data.decision.state === 'LIVE'
      && data.decision.metrics.onchainTwapReady
      && remainingCapital > 0,
  )
  const migrationCompleted = Boolean(
    migration
      && configuredExecutor
      && vault?.address.toLowerCase() === configuredExecutor.toLowerCase()
      && vault.version === targetVaultVersion
      && vault.routeVerified
      && vault.supportsCapitalAdd
      && vault.mode === 'LIVE'
      && vault.activeTokenId !== '0',
  )
  const pendingMigration = migrationCompleted ? null : migration
  const performance = data.performance
  const rangeIntervals = Math.max(3, Math.round((vault?.rangeWidth || 50) / data.contracts.tickSpacing))

  useEffect(() => {
    if (!migrationCompleted || !configuredExecutor) return
    window.localStorage.removeItem(migrationKey)
    legacyMigrationKeys.forEach(key => window.localStorage.removeItem(key))
    window.localStorage.setItem(localExecutorKey, configuredExecutor)
    setLocalExecutor(configuredExecutor)
    setMigration(null)
    setActivity(current => current.state === 'error'
      ? { state: 'success', message: `v2.6 교체와 ${formatNumber(vault?.principalUsdg || 0, 2)} USDG 시작이 온체인에서 완료되었습니다.` }
      : current)
  }, [configuredExecutor, migrationCompleted, vault?.principalUsdg])
  const setupStep = useMemo(() => {
    if (!executorAddress || replacementRequired) return 1
    if (!executorConfigured || !executorArmed) return 2
    if ((vault?.keeperGasEth || 0) < 0.0001) return 3
    if (vault?.mode === 'PAUSED') return 4
    return 5
  }, [executorAddress, executorArmed, executorConfigured, replacementRequired, vault?.keeperGasEth, vault?.mode])

  async function run(message: string, task: () => Promise<{ hash?: Hash } | Hash | unknown>) {
    setActivity({ state: 'busy', message })
    try {
      const result = await task()
      const hash = typeof result === 'string' && result.startsWith('0x')
        ? result as Hash
        : result && typeof result === 'object' && 'hash' in result ? (result as { hash?: Hash }).hash : undefined
      setActivity({ state: 'success', message: `${message.replace(' 중…', '')} 완료`, hash })
    } catch (error) {
      setActivity({ state: 'error', message: error instanceof Error ? error.message : '자동화 작업에 실패했습니다.' })
      return
    }
    try {
      await Promise.resolve(onRefresh())
    } catch {
      // 온체인 작업 성공 뒤 상태 새로고침만 실패해도 성공 결과는 유지한다.
    }
  }

  async function deploy() {
    if (!walletAddress) return onConnect()
    if (!ownerMatches) return setActivity({ state: 'error', message: `자동화 owner 고정 주소(${shortAddress(data.automation.expectedOwnerAddress || '')})와 연결 지갑이 다릅니다.` })
    if (!accepted) return setActivity({ state: 'error', message: '파일럿 위험 확인을 먼저 체크하세요.' })
    if (replacementRequired && !replacementSafe) return setActivity({ state: 'error', message: '이전 Vault에 포지션 또는 잔액이 있어 자동 교체할 수 없습니다. 먼저 자산을 회수하세요.' })
    await run(replacementRequired ? '이전 승인 해제 후 수정 Vault 배포 중…' : '제한형 자동화 금고 배포 중…', async () => {
      if (replacementRequired && configuredExecutor) {
        await revokeRobinhoodVaultTokenApprovals(walletAddress, configuredExecutor)
      }
      // 오래 열어둔 탭의 이전 Keeper 주소로 배포하지 않도록 서명 직전에 다시 읽는다.
      const freshBootstrap = await fetchRobinhoodAutomationBootstrap()
      setBootstrap(freshBootstrap)
      const result = await deployRobinhoodAutomationVault(walletAddress, freshBootstrap)
      window.localStorage.setItem(localExecutorKey, result.executorAddress)
      setLocalExecutor(result.executorAddress)
      return result
    })
  }

  async function authorize(armed: boolean) {
    if (!walletAddress) return onConnect()
    if (!executorAddress) return setActivity({ state: 'error', message: '먼저 자동화 금고를 배포하세요.' })
    await run(armed ? 'Keeper 확인 후 자동화 연결 중…' : '자동화 해제 서명 확인 중…', async () => {
      let keeperUpdateHash: Hash | undefined
      if (armed) {
        const freshBootstrap = await fetchRobinhoodAutomationBootstrap()
        setBootstrap(freshBootstrap)
        if (!freshBootstrap.keeperAddress) throw new Error('이 PC의 Keeper 주소가 준비되지 않았습니다.')
        const vaultKeeper = await readRobinhoodVaultKeeper(executorAddress)
        if (vaultKeeper.toLowerCase() !== freshBootstrap.keeperAddress.toLowerCase()) {
          const confirmed = window.confirm(
            `이 Vault에는 이전 Keeper ${shortAddress(vaultKeeper)}가 등록되어 있습니다.\n\n현재 PC의 Keeper ${shortAddress(freshBootstrap.keeperAddress)}로 교체한 뒤 자동화 연결 서명을 계속할까요?`,
          )
          if (!confirmed) throw new Error('Keeper 교체가 취소되어 자동화를 연결하지 않았습니다.')
          keeperUpdateHash = await updateRobinhoodVaultKeeper(walletAddress, executorAddress, freshBootstrap.keeperAddress)
        }
      }
      const result = await setRobinhoodAutomationAuthorization(walletAddress, executorAddress, armed)
      return keeperUpdateHash ? { ...result, hash: keeperUpdateHash } : result
    })
  }

  async function fundKeeper() {
    if (!walletAddress) return onConnect()
    if (!data.automation.keeperAddress) return setActivity({ state: 'error', message: 'Keeper 주소가 준비되지 않았습니다.' })
    await run('Keeper 가스 0.002 ETH 전송 중…', () => fundRobinhoodKeeper(walletAddress, data.automation.keeperAddress!, '0.002'))
  }

  async function replaceKeeper() {
    if (!walletAddress) return onConnect()
    if (!executorAddress || !data.automation.keeperAddress) return setActivity({ state: 'error', message: '금고 또는 이 PC의 Keeper 주소가 없습니다.' })
    await run('이 PC의 새 Keeper 등록 중…', () => updateRobinhoodVaultKeeper(walletAddress, executorAddress, data.automation.keeperAddress!))
  }

  async function start() {
    if (!walletAddress) return onConnect()
    if (!executorAddress) return setActivity({ state: 'error', message: '자동화 금고 주소가 없습니다.' })
    if (!readyToStart) return setActivity({ state: 'error', message: 'Keeper 설정·가스·TWAP·LIVE 안전가드를 먼저 확인하세요.' })
    await run('USDG 승인 후 5틱 포지션 시작 중…', async () => {
      const result = await startRobinhoodAutomation(walletAddress, executorAddress, amount)
      return { hash: result.startHash }
    })
  }

  async function addCapital() {
    if (!walletAddress) return onConnect()
    if (!executorAddress) return setActivity({ state: 'error', message: '자동화 금고 주소가 없습니다.' })
    if (!readyToAdd) return setActivity({ state: 'error', message: 'v2.6 LIVE·Keeper·TWAP 안전가드를 먼저 확인하세요.' })
    await run('추가 USDG 합산 후 5틱 재예치 중…', async () => {
      const result = await addRobinhoodAutomationCapital(walletAddress, executorAddress, amount)
      return { hash: result.addHash }
    })
  }

  function saveMigration(value: MigrationState | null) {
    legacyMigrationKeys.forEach(key => window.localStorage.removeItem(key))
    if (value) window.localStorage.setItem(migrationKey, JSON.stringify(value))
    else window.localStorage.removeItem(migrationKey)
    setMigration(value)
  }

  async function finishMigration(initial: MigrationState) {
    if (!walletAddress) return onConnect()
    let next = { ...initial, abandonedExecutors: initial.abandonedExecutors || [] }
    for (const abandonedExecutor of next.abandonedExecutors) {
      await revokeRobinhoodVaultTokenApprovals(walletAddress, abandonedExecutor)
      next = {
        ...next,
        abandonedExecutors: next.abandonedExecutors.filter(address => address.toLowerCase() !== abandonedExecutor.toLowerCase()),
      }
      saveMigration(next)
    }
    if (next.newExecutor && configuredExecutor
      && next.newExecutor.toLowerCase() === configuredExecutor.toLowerCase()
      && replacementRequired) {
      await revokeRobinhoodVaultTokenApprovals(walletAddress, configuredExecutor)
      next = { ...next, newExecutor: null }
      saveMigration(next)
    }
    if (!next.newExecutor) {
      const freshBootstrap = await fetchRobinhoodAutomationBootstrap()
      setBootstrap(freshBootstrap)
      const deployed = await deployRobinhoodAutomationVault(walletAddress, freshBootstrap)
      next = { ...next, newExecutor: deployed.executorAddress }
      saveMigration(next)
      window.localStorage.setItem(localExecutorKey, deployed.executorAddress)
      setLocalExecutor(deployed.executorAddress)
    }
    await setRobinhoodAutomationAuthorization(walletAddress, next.newExecutor!, true)
    const result = await startRobinhoodAutomationWithRawAmounts(
      walletAddress,
      next.newExecutor!,
      BigInt(next.spcx),
      BigInt(next.usdg) + BigInt(next.extraUsdg),
    )
    saveMigration(null)
    return { hash: result.hash }
  }

  async function upgradeAndMigrate(extraAmount = amount) {
    if (!walletAddress) return onConnect()
    if (!configuredExecutor || !vault) return setActivity({ state: 'error', message: '현재 자동화 금고를 확인할 수 없습니다.' })
    if (!accepted) return setActivity({ state: 'error', message: '파일럿 위험 확인을 먼저 체크하세요.' })
    if (!ownerMatches) return setActivity({ state: 'error', message: '자동화 owner 지갑으로 연결하세요.' })
    const numericExtra = Number(extraAmount)
    if (!Number.isFinite(numericExtra) || numericExtra < 0 || numericExtra > remainingCapital) {
      return setActivity({ state: 'error', message: `현재 원금 기준 최대 ${remainingCapital.toFixed(2)} USDG까지 추가할 수 있습니다.` })
    }
    const capitalMessage = numericExtra > 0 ? `${numericExtra} USDG를 추가합니다.` : '추가 입금 없이 기존 자산만 다시 예치합니다.'
    if (!window.confirm(`현재 ${rangeIntervals}틱 LP를 원물로 회수한 뒤 v2.6 5틱 Vault로 교체하고 ${capitalMessage} 여러 Rabby 서명이 순서대로 표시됩니다. 중간 실패 시 자산은 Rabby에 남습니다. 계속할까요?`)) return
    await run(pendingMigration ? 'v2.6 교체 작업 이어서 진행 중…' : '기존 LP 회수 후 v2.6 교체·재예치 중…', async () => {
      if (pendingMigration) return finishMigration(pendingMigration)
      const extraUsdg = parseUnits(extraAmount || '0', 6)
      const before = await readRobinhoodAutomationTokenBalances(walletAddress)
      if (before.usdg < extraUsdg) throw new Error(`Rabby USDG 잔고가 추가 요청액 ${extraAmount}보다 적습니다.`)
      await setRobinhoodAutomationAuthorization(walletAddress, configuredExecutor, false)
      await new Promise(resolve => window.setTimeout(resolve, 6_000))
      await executeRobinhoodVaultOwnerAction(walletAddress, configuredExecutor, 'exitToTokens')
      const after = await readRobinhoodAutomationTokenBalances(walletAddress)
      const recoveredSpcx = after.spcx - before.spcx
      const recoveredUsdg = after.usdg - before.usdg
      if (recoveredSpcx <= 0n && recoveredUsdg <= 0n) throw new Error('기존 Vault에서 회수된 SPCX/USDG 수량을 확인하지 못했습니다. 자산은 Rabby 잔고에서 확인하세요.')
      const next: MigrationState = {
        oldExecutor: configuredExecutor,
        newExecutor: null,
        abandonedExecutors: [],
        spcx: recoveredSpcx.toString(),
        usdg: recoveredUsdg.toString(),
        extraUsdg: extraUsdg.toString(),
      }
      saveMigration(next)
      return finishMigration(next)
    })
  }

  async function ownerAction(action: RobinhoodVaultOwnerAction, label: string, confirmation?: string) {
    if (!walletAddress) return onConnect()
    if (!executorAddress) return setActivity({ state: 'error', message: '자동화 금고 주소가 없습니다.' })
    if (!executorConfigured) return setActivity({ state: 'error', message: '새 Vault를 자동화 서버에 먼저 연결하세요.' })
    if (confirmation && !window.confirm(confirmation)) return
    await run(`${label} 중…`, () => executeRobinhoodVaultOwnerAction(walletAddress, executorAddress, action))
  }

  return (
    <section className="strategy-automation">
      <div className="strategy-automation-heading">
        <div><span>AUTOMATED {rangeIntervals}-TICK VAULT</span><strong>범위 이탈 자동 재배치</strong><p>철회 → 사전검증 → 현재 비율 스왑 → 새 {rangeIntervals}틱 민트 → Gauge 재예치를 한 트랜잭션으로 실행합니다.</p></div>
        <div className={`strategy-live-badge ${data.writesEnabled ? 'live' : ''}`}><i />{data.writesEnabled ? 'LIVE AUTOMATION' : 'SETUP LOCKED'}</div>
      </div>

      <div className="strategy-automation-flow">
        {['범위 감시', 'LP 철회', '비율 스왑', `${rangeIntervals}틱 민트`, 'Gauge 재예치'].map((label, index) => <div key={label}><b>{index + 1}</b><span>{label}</span></div>)}
      </div>

      <div className="strategy-automation-layout">
        <article className="strategy-setup-card">
          <div className="strategy-section-heading"><div><span>ONE-TIME SETUP</span><strong>현재 단계 {setupStep} / 5</strong></div><em>RABBY</em></div>
          <label className="strategy-risk-check"><input type="checkbox" checked={accepted} onChange={event => setAccepted(event.target.checked)} /><span>미감사 파일럿이며 최대 350 USDG, 가스·비영구손실·스마트컨트랙트 위험이 있음을 확인합니다.</span></label>
          <ol className="strategy-setup-steps">
          <li className={setupStep > 1 ? 'done' : setupStep === 1 ? 'current' : ''}><b>1</b><div><strong>{replacementRequired ? '수정 Vault 교체 배포' : '제한형 금고 배포'}</strong><small>{replacementRequired ? '이전 SPCX·USDG 승인을 먼저 0으로 해제한 뒤 v2.6 5틱 수정본을 배포' : 'owner·수령·guardian은 내 Rabby, Keeper는 이 PC 주소로 고정'}</small></div>{executorAddress && !replacementRequired ? <a href={`${explorer}/address/${executorAddress}`} target="_blank" rel="noreferrer">{shortAddress(executorAddress)} ↗</a> : <button type="button" disabled={activity.state === 'busy' || !walletAddress || !accepted || !ownerMatches || (replacementRequired && !replacementSafe)} onClick={deploy}>{replacementRequired ? '승인 해제 + 교체' : '배포'}</button>}</li>
            <li className={setupStep > 2 ? 'done' : setupStep === 2 ? 'current' : ''}><b>2</b><div><strong>자동화 연결 서명</strong><small>토큰 이동 없는 메시지 서명 · 공개 서버의 설정 위조 방지</small></div><button type="button" disabled={!executorAddress || replacementRequired || activity.state === 'busy' || executorArmed} onClick={() => authorize(true)}>{replacementRequired ? '교체 후 연결' : executorArmed ? '연결됨' : '연결'}</button></li>
            <li className={setupStep > 3 ? 'done' : setupStep === 3 ? 'current' : ''}><b>3</b><div><strong>Keeper 가스</strong><small>저권한 지갑 · 자산 수령 불가 · 현재 {formatNumber(vault?.keeperGasEth || 0, 6)} ETH</small></div><button type="button" disabled={!executorArmed || activity.state === 'busy'} onClick={fundKeeper}>0.002 ETH</button></li>
            <li className={setupStep > 4 ? 'done' : setupStep === 4 ? 'current' : ''}><b>4</b><div><strong>USDG 파일럿 시작</strong><small>정확한 금액만 승인하고 내부에서 SPCX 비율을 자동 계산 · 최대 350 USDG</small></div><div className="strategy-start-input"><input value={amount} onChange={event => setAmount(event.target.value)} inputMode="decimal" /><span>USDG</span><button type="button" disabled={!readyToStart || activity.state === 'busy'} onClick={start}>승인 + 시작</button></div></li>
            <li className={setupStep === 5 ? 'done current' : ''}><b>5</b><div><strong>24시간 자동 운용</strong><small>PC·4174/API·Keeper가 켜져 있어야 하며 모든 실행 전 전체 tx를 시뮬레이션</small></div><span>{vault?.mode || 'WAITING'}</span></li>
          </ol>
          {!walletAddress && <button className="strategy-connect-cta" type="button" onClick={onConnect}>Rabby 연결하고 설정 시작</button>}
          {walletAddress && !ownerMatches && <p className="strategy-automation-error">연결 지갑이 이 서버에 고정된 자동화 owner {shortAddress(data.automation.expectedOwnerAddress || '')}와 다릅니다.</p>}
          {replacementRequired && <p className="strategy-automation-error">현재 Vault v{vault?.version}는 검증 경로에서 제외됐습니다. Vault 잔액이 0이면 위 버튼으로 이전 토큰 승인을 해제하고 v2.6 5틱 수정본을 배포하세요.</p>}
          {upgradeAvailable && !pendingMigration && <div className="strategy-migration-resume"><span>v{vault?.version}는 단일자산 진입 수렴 문제가 있을 수 있습니다. v2.6은 5틱 범위·1% 체결·2% 미사용 자산 가드와 실패 백오프를 사용합니다.</span><button type="button" disabled={!walletAddress || !accepted || !ownerMatches || activity.state === 'busy'} onClick={() => upgradeAndMigrate('0')}>v2.6 교체 + 재예치</button></div>}
          {pendingMigration && <div className="strategy-migration-resume"><span>v2.6 교체 진행 상태가 저장되었습니다. 회수 자산은 Rabby에 있습니다.</span><button type="button" disabled={!walletAddress || activity.state === 'busy'} onClick={() => run('v2.6 교체 작업 이어서 진행 중…', () => finishMigration(pendingMigration))}>교체 계속</button></div>}
          {data.keeper.executionGate && data.keeper.executionGate.nextRetryAt > Date.now() && <div className="strategy-migration-resume"><span>{data.keeper.executionGate.publicMessage} 다음 사전검증: {new Date(data.keeper.executionGate.nextRetryAt).toLocaleTimeString('ko-KR', { hour12: false })}</span></div>}
          {(bootstrapError || data.automation.keeperKeyError || data.automation.error || data.keeper.error) && <p className="strategy-automation-error">{bootstrapError || data.automation.keeperKeyError || data.automation.error || data.keeper.error}</p>}
          {vault && !vault.keeperVerified && <button className="strategy-connect-cta" type="button" disabled={!walletAddress || activity.state === 'busy'} onClick={replaceKeeper}>Rabby로 이 PC의 새 Keeper 등록</button>}
          {activity.message && <div className={`strategy-automation-activity ${activity.state}`}>{activity.message}{activity.hash && <a href={`${explorer}/tx/${activity.hash}`} target="_blank" rel="noreferrer"> 트랜잭션 ↗</a>}</div>}
        </article>

        <article className="strategy-vault-card">
          <div className="strategy-section-heading"><div><span>LIVE VAULT</span><strong>{vault ? `${vault.mode} · #${vault.activeTokenId}` : '배포 대기'}</strong></div><em className={vault?.routeVerified ? 'verified' : ''}>{vault?.routeVerified ? 'VERIFIED' : replacementRequired ? 'REPLACE' : 'NO VAULT'}</em></div>
          <div className="strategy-vault-metrics">
            <div><span>NAV</span><strong>{vault?.navUsd == null ? '—' : formatMoney(vault.navUsd)}</strong><small>원금 {formatMoney(vault?.principalUsdg || 0)}</small></div>
            <div><span>현재 범위</span><strong>{vault?.position ? `${vault.position.tickLower} → ${vault.position.tickUpper}` : '—'}</strong><small>{vault?.position?.inRange ? 'IN RANGE' : vault?.position ? 'OUT OF RANGE' : 'NO POSITION'}</small></div>
            <div><span>자동 재배치</span><strong>{vault?.totalRebalances || 0}회</strong><small>10분 {vault?.rebalanceCounts.tenMinutes || 0} · 1시간 {vault?.rebalanceCounts.oneHour || 0}</small></div>
            <div><span>미수확 UP</span><strong>{formatNumber(vault?.balances.earnedUP || 0, 4)}</strong><small>수확 시 내 Rabby로 직송</small></div>
          </div>
          <div className="strategy-vault-assets"><span>금고 환산 보유</span><b>{formatNumber(vault?.balances.SPCX || 0, 6)} SPCX</b><b>{formatNumber(vault?.balances.USDG || 0, 4)} USDG</b></div>
          {performance && <section className="strategy-performance-summary">
            <div className="strategy-performance-total">
              <span>현재 순수익률</span>
              <strong className={pnlTone(performance.current.netReturnPercent)}>{signedPercent(performance.current.netReturnPercent)}</strong>
              <small>순손익 {signedMoney(performance.current.netProfitUsd)}</small>
            </div>
            <div className="strategy-performance-breakdown">
              <div><span>LP NAV 손익</span><strong className={pnlTone(performance.current.lpProfitUsd)}>{signedMoney(performance.current.lpProfitUsd)}</strong><small>수수료·가격변동 포함</small></div>
              <div><span>UP 보상</span><strong className="positive">+{formatMoney(performance.current.upValueUsd)}</strong><small>{formatNumber(performance.current.totalRewardUp, 4)} UP</small></div>
              <div><span>Keeper 가스</span><strong className="negative">-{formatMoney(performance.current.gasSpentUsd)}</strong><small>{formatNumber(performance.current.gasSpentEth, 7)} ETH</small></div>
            </div>
            <small className="strategy-performance-source">Relay · UP {formatMoney(performance.prices.upUsd, 4)} · ETH {formatMoney(performance.prices.ethUsd, 2)}{performance.prices.stale ? ' · 지연 가격' : ' · 60초 갱신'}</small>
          </section>}
          <div className="strategy-capital-add">
            <div><span>CAPITAL</span><strong>원금 {formatMoney(vault?.principalUsdg || 0)} / 현재 한도 {formatMoney(vault?.maxPilotUsdg || 350)}</strong><small>{upgradeAvailable ? 'v2.6 5틱 교체 후 추가 입금 가능' : vault?.supportsCapitalAdd ? `추가 가능 ${formatNumber(remainingCapital, 2)} USDG` : `v2.6 교체 후 한도 $350 · 추가 가능 약 ${formatNumber(remainingCapital, 2)} USDG`}</small></div>
            <div><input aria-label="추가 USDG" value={amount} onChange={event => setAmount(event.target.value)} inputMode="decimal" /><span>USDG</span><button type="button" disabled={activity.state === 'busy' || upgradeAvailable || (!vault?.supportsCapitalAdd && !upgradeAvailable) || (vault?.supportsCapitalAdd && !readyToAdd)} onClick={vault?.supportsCapitalAdd ? addCapital : () => upgradeAndMigrate(amount)}>{pendingMigration ? '교체 계속' : upgradeAvailable ? 'v2.6 교체 먼저' : vault?.supportsCapitalAdd ? '승인 + 추가' : 'v2.6 교체 + 추가'}</button></div>
          </div>
          <div className="strategy-vault-safety"><p><b>정상 이탈</b> 안전가드가 LIVE면 자동 재배치</p><p><b>급변/괴리</b> 5분 정지, 스왑·민트 없음</p><p><b>-3% 또는 NAV hard stop</b> 자동으로 LP만 풀어 금고에 원물 대기</p><p><b>최종 USDG 전환</b> Keeper 불가, 내 Rabby에서만 실행</p></div>
          <div className="strategy-vault-actions">
            <button type="button" disabled={!executorConfigured || !data.automation.armed || activity.state === 'busy'} onClick={() => authorize(false)}>자동화 끄기</button>
            <button type="button" disabled={!executorConfigured || !vault?.position || activity.state === 'busy'} onClick={() => ownerAction('withdrawToIdle', 'LP 원물 대기', 'LP를 풀고 SPCX·USDG를 금고 안에 대기시킬까요? 자동 재민트는 중단됩니다.')}>LP만 풀기</button>
            <button type="button" disabled={!executorConfigured || !vault || activity.state === 'busy'} onClick={() => ownerAction('exitToTokens', '두 토큰 회수', '포지션을 종료하고 SPCX·USDG·UP을 내 Rabby로 모두 회수할까요?')}>두 토큰 회수</button>
            <button className="danger" type="button" disabled={!executorConfigured || !vault || activity.state === 'busy'} onClick={() => ownerAction('exitToUsdgAuto', '급락 USDG 전환', '온체인 연속 5분 -5% 급락 조건이 확인된 경우에만 실행됩니다. SPCX를 USDG로 전환하고 전부 회수할까요?')}>급락 USDG 전환</button>
          </div>
          {data.keeper.lastTransaction && <a className="strategy-last-tx" href={`${explorer}/tx/${data.keeper.lastTransaction.hash}`} target="_blank" rel="noreferrer">최근 {data.keeper.lastTransaction.action} · {new Date(data.keeper.lastTransaction.at).toLocaleString('ko-KR')} ↗</a>}
          <small className="strategy-portability">Keeper 키는 Windows 현재 사용자에 묶여 있어 다른 노트북으로 단순 복사되지 않습니다. 이동 시 새 Keeper 생성 후 Rabby에서 `setKeeper`가 필요합니다.</small>
        </article>
      </div>

      <article className="strategy-performance-card">
        <div className="strategy-section-heading"><div><span>REBALANCE P&L</span><strong>리밸런싱별 수익률 기록</strong></div><em className={performance && !performance.prices.stale ? 'verified' : ''}>{performance ? `${performance.rebalances.length} / ${vault?.totalRebalances || 0}` : 'WAITING'}</em></div>
        {performance?.rebalances.length ? <div className="strategy-performance-table-wrap"><table className="strategy-performance-table">
          <thead><tr><th>시각</th><th>틱 / 새 범위</th><th>LP NAV 손익</th><th>누적 UP</th><th>누적 가스</th><th>순수익률</th><th>TX</th></tr></thead>
          <tbody>{performance.rebalances.map(entry => <tr key={entry.hash}>
            <td data-label="시각">{new Date(entry.at).toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}</td>
            <td data-label="틱 / 범위"><b>{entry.tick ?? '—'}</b><small>{entry.range?.lower == null || entry.range?.upper == null ? '—' : `${entry.range.lower} → ${entry.range.upper}`}</small></td>
            <td data-label="LP NAV"><b className={pnlTone(entry.lpProfitUsd)}>{signedMoney(entry.lpProfitUsd)}</b><small>{signedPercent(entry.lpReturnPercent)}</small></td>
            <td data-label="누적 UP"><b>{formatNumber(entry.paidUp, 4)} UP</b><small>{entry.upValueUsd == null ? '—' : `현재가 ${formatMoney(entry.upValueUsd)}`}</small></td>
            <td data-label="누적 가스"><b>{formatNumber(entry.gasSpentEth, 7)} ETH</b><small>{entry.gasSpentUsd == null ? '—' : formatMoney(entry.gasSpentUsd)}</small></td>
            <td data-label="순수익률"><strong className={pnlTone(entry.netReturnPercent)}>{signedPercent(entry.netReturnPercent)}</strong><small>{signedMoney(entry.netProfitUsd)}</small></td>
            <td data-label="TX"><a href={`${explorer}/tx/${entry.hash}`} target="_blank" rel="noreferrer">보기 ↗</a></td>
          </tr>)}</tbody>
        </table></div> : <p className="strategy-performance-empty">첫 자동 리밸런싱이 완료되면 원금·LP NAV·UP 보상·실사용 가스를 합산한 스냅샷이 여기에 남습니다.</p>}
        {performance && <details className="strategy-performance-notes"><summary>계산 기준</summary>{performance.warnings.map(note => <p key={note}>{note}</p>)}</details>}
      </article>

      <article className="strategy-live-log-card">
        <div className="strategy-section-heading"><div><span>LIVE KEEPER LOG</span><strong>실시간 감시·실행 내역</strong></div><em className={data.keeper.healthy ? 'verified' : ''}>{data.keeper.healthy ? '5초 자동 갱신' : 'STALE'}</em></div>
        <div className="strategy-live-log" ref={liveLogRef} aria-live="polite">
          {data.keeper.logs.length ? data.keeper.logs.map(entry => {
            const detail = [
              entry.tick == null ? null : `tick ${entry.tick}`,
              entry.spotPrice == null ? null : `${entry.spotPrice.toFixed(4)} USDG`,
              entry.navUsd == null ? null : `NAV $${entry.navUsd.toFixed(4)}`,
              entry.range?.lower == null || entry.range?.upper == null ? null : `range ${entry.range.lower}→${entry.range.upper}`,
            ].filter(Boolean).join(' · ')
            const message = entry.executionError || entry.reasons[0] || (entry.action === 'NO_ACTION' ? '안전가드 정상 · 대기' : entry.action)
            return <div className={entry.executionError ? 'error' : entry.transaction ? 'transaction' : entry.action === 'NO_ACTION' ? 'idle' : 'action'} key={entry.id}>
              <time>{new Date(entry.at).toLocaleTimeString('ko-KR', { hour12: false })}</time>
              <b>{entry.mode} · {entry.state}</b>
              <code>{detail || '시장 상태 확인'}</code>
              <span>{message}</span>
              {entry.transaction && <a href={`${explorer}/tx/${entry.transaction.hash}`} target="_blank" rel="noreferrer">{entry.transaction.action} ↗</a>}
            </div>
          }) : <p>Keeper 첫 감시 로그를 기다리는 중입니다.</p>}
        </div>
      </article>
    </section>
  )
}
