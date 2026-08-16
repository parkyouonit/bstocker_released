import type { Address } from 'viem'
import { formatMoney, formatNumber, shortAddress } from '../lib/format'
import type { RobinhoodGuardState, RobinhoodStrategyStatus } from '../lib/robinhoodStrategy'
import type { TransactionState } from '../types'
import { RobinhoodAutomationPanel } from './RobinhoodAutomationPanel'

interface RobinhoodStrategyPageProps {
  data?: RobinhoodStrategyStatus
  loading: boolean
  refreshing: boolean
  error?: string
  walletAddress?: Address
  onConnect: () => void
  onRefresh: () => void
  onBack: () => void
  oracleTransaction: TransactionState
  onPrepareOracle: () => void
}

const stateLabels: Record<RobinhoodGuardState, string> = {
  WARMING: '관찰 준비',
  LIVE: '정상 관찰',
  SOFT_PAUSE: '재배치 정지',
  WITHDRAW_ONLY: '원물 회수 필요',
  USDG_EXIT_PENDING: 'USDG 탈출 견적 필요',
}

function metric(value: number | null | undefined, suffix = '%', digits = 2) {
  return value == null || !Number.isFinite(value) ? '—' : `${value.toFixed(digits)}${suffix}`
}

function stateTone(state: RobinhoodGuardState) {
  if (state === 'LIVE') return 'safe'
  if (state === 'WARMING') return 'warming'
  if (state === 'SOFT_PAUSE') return 'warning'
  return 'danger'
}

export function RobinhoodStrategyPage({ data, loading, refreshing, error, walletAddress, onConnect, onRefresh, onBack, oracleTransaction, onPrepareOracle }: RobinhoodStrategyPageProps) {
  if (!data) {
    return <div className="strategy-loading"><div className="loading-spinner" /><strong>Robinhood 5틱 전략을 준비하는 중…</strong><span>{error || '공식 가격·풀 TWAP·Gauge 상태를 교차 확인합니다.'}</span><button type="button" onClick={onBack}>BNB LP로 돌아가기</button></div>
  }
  const { snapshot, decision, keeper, contracts } = data
  const capitalUnlimited = data.automation.vault?.capitalUnlimited ?? !data.automation.vault
  const currentPilotLimit = data.automation.vault?.maxPilotUsdg ?? null
  const range = decision.range
  const rangeIntervals = Math.max(3, Math.round((range?.width || data.automation.vault?.rangeWidth || 50) / contracts.tickSpacing))
  const official = snapshot.official
  const oracleMode = decision.metrics.oracleMode || snapshot.oracleGuard?.mode || 'FAIL_CLOSED'
  const oracleAgeHours = decision.metrics.officialAgeSec == null ? null : decision.metrics.officialAgeSec / 3600
  const oracleLabel = oracleMode === 'CHAINLINK_FRESH'
    ? 'CHAINLINK FRESH'
    : oracleMode === 'MARKET_CLOSED_QUORUM' ? 'MARKET CLOSED QUORUM' : 'ORACLE FAIL CLOSED'
  const owner = snapshot.owner
  const statusAge = keeper.updatedAt ? Math.max(0, Math.round((Date.now() - keeper.updatedAt) / 1000)) : null
  const replay = data.replay
  const fiveTickReplay = replay?.rangeComparison.find(item => item.intervals === 5)

  return (
    <div className="strategy-page">
      <header className="strategy-header">
        <div className="strategy-brand"><button type="button" onClick={onBack}>←</button><div><strong>bStock<span>er</span></strong><small>ROBINHOOD {rangeIntervals}-TICK</small></div><div className="strategy-pair"><span>SP</span><div><b>SPCX/USDG</b><small>up. Slipstream · spacing 10</small></div></div></div>
        <div className="strategy-header-actions"><span className="strategy-network">RH · 4663</span><button type="button" onClick={onConnect}>{walletAddress ? shortAddress(walletAddress) : '지갑 연결'}</button><button type="button" onClick={onRefresh} disabled={refreshing}>{refreshing ? '…' : '↻'}</button></div>
      </header>

      <div className={`strategy-mode-banner ${data.writesEnabled ? 'live' : ''}`}><div><i className={keeper.healthy ? 'online' : ''} /> {data.writesEnabled ? 'LIVE AUTOMATION · 제한형 Keeper 실행 가능' : 'SHADOW MODE · 실제 거래 없음'}</div><span>{keeper.error ? `Keeper 차단: ${keeper.error}` : keeper.healthy ? `keeper ${statusAge ?? '—'}초 전 갱신` : 'Keeper 상태를 확인할 수 없습니다.'}</span></div>
      {error && <div className="strategy-error">{error}</div>}

      <main className="strategy-content">
        <section className="strategy-metrics">
          <article><span>DEX SPOT</span><strong>{formatNumber(snapshot.spotPrice, 4)}</strong><small>USDG / SPCX · tick {snapshot.tick}</small></article>
          <article><span>{oracleLabel}</span><strong>{official?.tokenPrice == null ? '—' : formatNumber(official.tokenPrice, 4)}</strong><small>{oracleMode === 'MARKET_CLOSED_QUORUM' ? `휴장 3중 합의 · ${oracleAgeHours?.toFixed(1)}시간` : official?.generatedAt ? `온체인 · ${oracleAgeHours?.toFixed(1) ?? '—'}시간 전` : '가격 없음'}</small></article>
          <article><span>UP EMISSIONS</span><strong>{formatNumber(snapshot.gauge.rewardPerDay, 2)}</strong><small>UP / day · 전체 Gauge</small></article>
          <article><span>GAUGE</span><strong className={snapshot.gauge.active ? 'teal' : ''}>{snapshot.gauge.active ? 'ACTIVE' : 'ENDED'}</strong><small>{formatNumber(snapshot.gauge.rewardsLeft, 2)} UP left</small></article>
          <article><span>KEEPER</span><strong className={keeper.healthy ? 'teal' : 'danger'}>{keeper.healthy ? 'ONLINE' : 'STALE'}</strong><small>{keeper.rpcKind.replaceAll('_', ' ')}</small></article>
        </section>

        <section className="strategy-grid">
          <div className="strategy-main-column">
            <article className={`strategy-state-card ${stateTone(decision.state)}`}>
              <div className="strategy-state-title"><div><span>급락 안전가드</span><strong>{stateLabels[decision.state]}</strong></div><em>{decision.state}</em></div>
              <div className="strategy-state-track"><i /><i /><i /><i /></div>
              <div className="strategy-state-steps"><span>LIVE</span><span>SOFT PAUSE</span><span>WITHDRAW</span><span>USDG EXIT</span></div>
              <div className="strategy-reasons">{decision.reasons.length ? decision.reasons.map(reason => <p key={reason}>• {reason}</p>) : <p>• {oracleMode === 'MARKET_CLOSED_QUORUM' ? '휴장 구간 Chainlink·Robinhood 호가 범위·DEX TWAP 합의가 정상입니다.' : '모든 가격 검증이 정상입니다.'}</p>}</div>
            </article>

            <article className="strategy-range-card">
              <div className="strategy-section-heading"><div><span>{rangeIntervals}-TICK {data.writesEnabled ? 'MANAGED' : 'SHADOW'} RANGE</span><strong>{data.writesEnabled ? '온체인 자동화 범위' : '가상 재배치 범위'}</strong></div><span>raw width {range?.width || 50} · 약 {(rangeIntervals / 10).toFixed(2)}%</span></div>
              <div className="strategy-range-visual"><div className="strategy-range-fill" /><i className="strategy-price-marker" style={{ left: range ? `${Math.max(0, Math.min(100, ((snapshot.tick - range.lower) / (range.upper - range.lower)) * 100))}%` : '50%' }} /><span className="range-low">{range?.lower ?? '—'}</span><span className="range-now">NOW {snapshot.tick}</span><span className="range-high">{range?.upper ?? '—'}</span></div>
              <div className="strategy-price-grid"><div><span>30초 TWAP</span><strong>{snapshot.twap30Price == null ? '—' : formatNumber(snapshot.twap30Price, 4)}</strong></div><div><span>5분 TWAP</span><strong>{snapshot.twap300Price == null ? '—' : formatNumber(snapshot.twap300Price, 4)}</strong></div><div><span>Spot / 30초</span><strong>{metric(decision.metrics.spotTwap30DeviationPercent)}</strong></div><div><span>DEX / 공식가</span><strong>{metric(decision.metrics.dexOfficialDeviationPercent)}</strong></div></div>
            </article>

            <article className="strategy-log-card">
              <div className="strategy-section-heading"><div><span>KEEPER EVENT LOG</span><strong>관찰 결정 내역</strong></div><span>{decision.action}</span></div>
              <div className="strategy-log">{decision.events.length ? decision.events.map(event => <div key={`${event.at}-${event.type}`}><time>{new Date(event.at).toLocaleTimeString('ko-KR')}</time><b>{event.type}</b><span>{event.message}</span></div>) : <p>첫 상태 변경을 기다리는 중입니다.</p>}</div>
            </article>
          </div>

          <aside className="strategy-side-column">
            <article className="strategy-guard-card">
              <div className="strategy-section-heading"><div><span>SAFETY LIMITS</span><strong>고정 안전 기준</strong></div><em>LOCKED</em></div>
              <dl><div><dt>1분 Soft Pause</dt><dd>{data.guardConfig.softDrop1mPercent}%</dd></div><div><dt>5분 Withdraw</dt><dd>{data.guardConfig.withdrawDrop5mPercent}%</dd></div><div><dt>5분 USDG Exit</dt><dd>{data.guardConfig.exitDrop5mPercent}%</dd></div><div><dt>Chainlink 신선도</dt><dd>{Math.round(data.guardConfig.officialMaxAgeSec / 3600)}시간</dd></div><div><dt>휴장 3중 합의</dt><dd>최대 {Math.round((data.guardConfig.closedMarketMaxAgeSec || 259200) / 3600)}시간</dd></div><div><dt>최대 Exit 충격</dt><dd>{data.guardConfig.maxExitPriceImpactPercent}%</dd></div><div><dt>10분 재배치</dt><dd>최대 {data.guardConfig.maxRebalances10m}회</dd></div><div><dt>일 손실 Soft Stop</dt><dd>{data.guardConfig.navSoftLossPercent}%</dd></div><div><dt>전략 Hard Stop</dt><dd>{data.guardConfig.navHardLossPercent}%</dd></div></dl>
              <div className={`strategy-oracle-prep ${decision.metrics.onchainTwapReady ? 'ready' : ''}`}><div><span>ONCHAIN TWAP BUFFER</span><strong>{snapshot.observationCardinality} / {snapshot.observationCardinalityNext}</strong><small>{decision.metrics.onchainTwapReady ? '30초·5분 TWAP 사용 가능' : snapshot.observationCardinalityNext >= 64 ? '용량 확장 완료 · 거래 관찰 기록 대기' : '연결 지갑 1회 서명으로 64개까지 확장 필요'}</small></div><button type="button" disabled={snapshot.observationCardinalityNext >= 64 || ['simulating', 'pending'].includes(oracleTransaction.status)} onClick={onPrepareOracle}>{oracleTransaction.status === 'pending' ? '확인 중…' : snapshot.observationCardinalityNext >= 64 ? '준비됨' : '오라클 준비'}</button></div>
              {oracleTransaction.message && <div className={`strategy-oracle-message ${oracleTransaction.status}`}>{oracleTransaction.message}</div>}
            </article>

            {replay && fiveTickReplay && <article className="strategy-replay-card">
              <div className="strategy-section-heading"><div><span>REAL SWAP REPLAY</span><strong>최근 24시간 5틱 검증</strong></div><em>{replay.swapEvents.toLocaleString()} swaps</em></div>
              <div className="strategy-replay-summary"><div><span>범위 유지</span><strong>{metric(fiveTickReplay.inRangePercent)}</strong></div><div><span>재배치</span><strong>{fiveTickReplay.rebalances}회</strong></div><div><span>5분 최저</span><strong>{metric(replay.crashGuards.minimum5mPercent)}</strong></div><div><span>회수 가드</span><strong>{replay.crashGuards.withdrawEpisodes}회</strong></div></div>
              <div className="strategy-replay-compare">{replay.rangeComparison.map(item => <div className={item.intervals === 5 ? 'selected' : ''} key={item.intervals}><span>{item.intervals}틱</span><b>{metric(item.inRangePercent)}</b><small>{item.rebalances} rebalance</small></div>)}</div>
              <p>최종 USDG 전환 조건 {replay.crashGuards.exitEpisodes}회 · 가격 {metric(replay.price.changePercent)} · {replay.hoursCovered.toFixed(1)}시간 범위</p>
              <small>{new Date(replay.generatedAt).toLocaleString('ko-KR')} 생성 · 수수료·가스·UP·MEV 제외</small>
            </article>}

            <article className="strategy-wallet-card">
              <div className="strategy-section-heading"><div><span>STRATEGY WALLET</span><strong>{walletAddress ? shortAddress(walletAddress) : '지갑 미연결'}</strong></div><button type="button" onClick={onConnect}>{walletAddress ? '새로고침' : '연결'}</button></div>
              {owner ? <><div className="strategy-balances">{Object.entries(owner.balances).map(([symbol, amount]) => <div key={symbol}><span>{symbol}</span><strong>{formatNumber(amount, symbol === 'ETH' ? 5 : 4)}</strong></div>)}</div><div className="strategy-position-list">{owner.positions.length ? owner.positions.map(position => <div key={`${position.custody}-${position.tokenId}`}><span>#{position.tokenId} · {position.custody.toUpperCase()}</span><strong>{position.tickLower} — {position.tickUpper}</strong><small>{formatNumber(position.earnedUp, 4)} UP pending</small></div>) : <p>SPCX/USDG 포지션이 없습니다.</p>}</div></> : <p className="strategy-wallet-note">Rabby 또는 MetaMask 연결 시 지갑 잔고와 Gauge에 맡긴 Slipstream NFT를 읽기 전용으로 표시합니다.</p>}
            </article>

            <article className="strategy-deploy-card"><span>MAINNET EXECUTOR</span><strong>{data.deployment.contractDeployed ? `${data.writesEnabled ? 'LIVE' : '배포됨'} · ${data.executorAddress ? shortAddress(data.executorAddress) : ''}` : data.deployment.contractCompiled ? 'V2.9 컴파일 완료 · 배포 대기' : '컴파일 전'}</strong><p>{data.deployment.note}</p><button type="button" onClick={() => document.querySelector('.strategy-automation')?.scrollIntoView({ behavior: 'smooth' })}>자동화 설정으로 이동</button><small>고정 수령 주소 · {capitalUnlimited ? '온체인 금액 상한 없음' : `현재 계약 ${formatMoney(currentPilotLimit, 0)} 한도`} · {data.automation.vault?.chainlinkSafetyExit ? 'Chainlink 자동 USDG 안전 종료 적용' : 'v2.9 교체 후 Chainlink 안전 종료 적용'}</small></article>
          </aside>
        </section>

        <RobinhoodAutomationPanel data={data} walletAddress={walletAddress} onConnect={onConnect} onRefresh={onRefresh} />

        <section className="strategy-contracts"><span>VERIFIED ROUTE</span><a href={`${contracts.explorer}/address/${contracts.pool}`} target="_blank" rel="noreferrer">Pool {shortAddress(contracts.pool)} ↗</a><a href={`${contracts.explorer}/address/${contracts.gauge}`} target="_blank" rel="noreferrer">Gauge {shortAddress(contracts.gauge)} ↗</a><a href={`${contracts.explorer}/address/${contracts.positionManager}`} target="_blank" rel="noreferrer">NFT Manager {shortAddress(contracts.positionManager)} ↗</a><strong>{snapshot.contractsVerified ? '✓ 교차검증 통과' : '검증 실패'}</strong></section>
        <footer className="strategy-footer">{capitalUnlimited ? 'v2.9 온체인 금액 상한 없음' : `현재 계약 한도 ${formatMoney(currentPilotLimit, 0)}`} · {data.automation.vault?.chainlinkSafetyExit ? '-3% 급락/-5% Chainlink NAV 자동 USDG 종료 · TWAP·가격한도·직접 Sequencer MEV 방어' : 'v2.9 교체 전 Chainlink USDG 종료 가드 미적용'}</footer>
      </main>
    </div>
  )
}
