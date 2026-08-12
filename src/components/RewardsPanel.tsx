import type { Address } from 'viem'
import type { RewardsData, TransactionState } from '../types'
import { formatNumber, formatPercent } from '../lib/format'

interface RewardsPanelProps {
  rewards?: RewardsData
  loading: boolean
  error?: string
  walletAddress?: Address
  transaction: TransactionState
  onClaimMerkl: () => void
  onRefresh: () => void
}

function statusLabel(status?: string): string {
  if (status === 'ACTIVE') return 'ACTIVE'
  if (status === 'ENDED') return 'ENDED'
  if (status === 'INACTIVE') return 'NO EMISSIONS'
  return 'VERIFYING'
}

export function RewardsPanel({ rewards, loading, error, walletAddress, transaction, onClaimMerkl, onRefresh }: RewardsPanelProps) {
  const pendingCake = Object.values(rewards?.positions || {}).reduce((sum, position) => sum + position.pendingCake, 0)
  const claimable = (rewards?.merklClaims || []).filter(item => item.claimable > 0n && item.proofs.length > 0)
  const pendingMerkl = (rewards?.merklClaims || []).filter(item => item.pending > 0n)
  const busy = transaction.status === 'pending' || transaction.status === 'simulating' || transaction.status === 'approving'

  return (
    <section className="rewards-panel" aria-label="LP 보상">
      <div className="rewards-heading">
        <div><span className="section-label">LP REWARDS</span><strong>스테이킹과 추가 보상</strong></div>
        <button type="button" onClick={onRefresh} disabled={loading}>{loading ? '확인 중…' : '새로고침'}</button>
      </div>
      <div className="reward-program-grid">
        <article className="reward-program-card">
          <div className="reward-program-title"><span className="reward-icon pancake">P</span><div><strong>PancakeSwap V3 Farm</strong><small>LP NFT · CAKE</small></div><em className={(rewards?.farm.status || 'UNAVAILABLE').toLowerCase()}>{statusLabel(rewards?.farm.status)}</em></div>
          <div className="reward-metrics">
            <div><span>Pool PID</span><strong>{rewards?.farm.pid?.toString() || '—'}</strong></div>
            <div><span>CAKE / sec</span><strong>{rewards?.farm.rewardRatePerSecond == null ? '—' : formatNumber(rewards.farm.rewardRatePerSecond, 6)}</strong></div>
            <div><span>내 미수령 CAKE</span><strong className="teal">{formatNumber(pendingCake, 6)}</strong></div>
            <div><span>배출 종료</span><strong>{rewards?.farm.endsAt ? new Date(rewards.farm.endsAt).toLocaleString('ko-KR') : '—'}</strong></div>
          </div>
          <p>{rewards?.farm.reason || '활성 범위 안의 스테이킹 포지션이 CAKE 보상을 받습니다.'}</p>
        </article>
        <article className="reward-program-card">
          <div className="reward-program-title"><span className="reward-icon merkl">M</span><div><strong>Merkl Bonus</strong><small>별도 캠페인 보상</small></div><em className={(rewards?.merkl.status || 'UNAVAILABLE').toLowerCase()}>{statusLabel(rewards?.merkl.status)}</em></div>
          <div className="reward-metrics compact">
            <div><span>추가 APR</span><strong>{rewards?.merkl.apr == null ? '—' : formatPercent(rewards.merkl.apr, 2)}</strong></div>
            <div><span>활성 캠페인</span><strong>{rewards?.merkl.liveCampaigns ?? '—'}</strong></div>
            <div><span>청구 가능 토큰</span><strong>{claimable.length}</strong></div>
            <div><span>계산 중 보상</span><strong>{pendingMerkl.length}</strong></div>
          </div>
          <div className="reward-claim-row">
            <p>{rewards?.merkl.reason || '청구 가능 보상과 아직 계산 중인 보상을 구분해 표시합니다.'}</p>
            <button type="button" disabled={!walletAddress || !claimable.length || busy} onClick={onClaimMerkl}>Merkl Claim</button>
          </div>
        </article>
      </div>
      {(error || rewards?.warnings.length) ? <div className="reward-warning">{error || rewards?.warnings.join(' · ')}</div> : null}
    </section>
  )
}
