import { useMemo, useState } from 'react'
import type { Address } from 'viem'
import type { Position, RewardsData, TransactionState } from '../types'
import { formatMoney, formatNumber, formatPercent, formatToken } from '../lib/format'

interface PositionsTableProps {
  positions: Position[]
  selectedPoolAddress: Address
  walletAddress?: Address
  onCollect: (position: Position) => void
  onCollectAll: (positions: Position[]) => void
  onDecrease: (position: Position) => void
  onStake: (position: Position) => void
  onHarvest: (position: Position) => void
  onUnstake: (position: Position) => void
  transaction: TransactionState
  rewards?: RewardsData
  token0Symbol: string
  token1Symbol: string
  rangeQuoteSymbol: string
}

type Scope = 'selected' | 'all'
type StatusFilter = 'all' | 'IN RANGE' | 'OUT OF RANGE'
type PositionSort = 'value' | 'fees' | 'newest'

export function PositionsTable({ positions, selectedPoolAddress, walletAddress, onCollect, onCollectAll, onDecrease, onStake, onHarvest, onUnstake, transaction, rewards, token0Symbol, token1Symbol, rangeQuoteSymbol }: PositionsTableProps) {
  const [scope, setScope] = useState<Scope>('selected')
  const [status, setStatus] = useState<StatusFilter>('all')
  const [sort, setSort] = useState<PositionSort>('value')
  const collecting = transaction.status === 'pending' && transaction.message?.toLowerCase().includes('수수료')
  const visible = useMemo(() => positions
    .filter(position => scope === 'all' || position.poolAddress.toLowerCase() === selectedPoolAddress.toLowerCase())
    .filter(position => status === 'all' || (status === 'IN RANGE' ? position.status === 'IN RANGE' : position.status !== 'IN RANGE'))
    .sort((a, b) => {
      if (sort === 'fees') return b.feesUsd - a.feesUsd
      if (sort === 'newest') return b.createdAt !== a.createdAt
        ? b.createdAt - a.createdAt
        : a.tokenId === b.tokenId ? 0 : a.tokenId < b.tokenId ? 1 : -1
      return (b.amount0Usd + b.amount1Usd) - (a.amount0Usd + a.amount1Usd)
    }), [positions, scope, selectedPoolAddress, status, sort])
  const feesTotal = visible.reduce((sum, position) => sum + position.feesUsd, 0)

  return (
    <section className="positions-section">
      <div className="positions-heading">
        <div><span className="section-label">포지션 {visible.length}</span><span className="position-count-line" /></div>
        <div className="positions-tabs" role="group" aria-label="포지션 범위">
          <button type="button" className={scope === 'selected' ? 'active' : ''} onClick={() => setScope('selected')}>선택 풀</button>
          <button type="button" className={scope === 'all' ? 'active' : ''} onClick={() => setScope('all')}>전체</button>
        </div>
        <div className="positions-filters">
          <select value={status} onChange={event => setStatus(event.target.value as StatusFilter)} aria-label="포지션 상태"><option value="all">모든 상태</option><option value="IN RANGE">IN RANGE</option><option value="OUT OF RANGE">OUT OF RANGE</option></select>
          <select value={sort} onChange={event => setSort(event.target.value as PositionSort)} aria-label="포지션 정렬"><option value="value">평가액순</option><option value="fees">수수료순</option><option value="newest">최신순</option></select>
        </div>
        <button type="button" className="collect-all" disabled={!walletAddress || visible.length === 0 || transaction.status === 'pending'} onClick={() => onCollectAll(visible)}>표시된 수수료 전체 수령</button>
      </div>
      <div className="withdraw-row"><span>수수료 수령 후 유동성을 회수할 수 있습니다.</span><span className="fee-total">표시된 미수령 추정 {formatMoney(feesTotal, 2)}</span></div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>POSITION</th><th>RANGE ({rangeQuoteSymbol})</th><th>STATUS</th><th>현재 보유</th><th>미수령 수수료</th><th>LP 보상</th><th>수수료율</th><th /></tr></thead>
          <tbody>
            {visible.length === 0 && <tr><td colSpan={8} className="empty-row">{walletAddress ? '조건에 맞는 포지션이 없습니다.' : '지갑을 연결하면 보유 포지션이 표시됩니다.'}</td></tr>}
            {visible.map(position => {
              const positionToken0 = position.token0Symbol || token0Symbol
              const positionToken1 = position.token1Symbol || token1Symbol
              const reward = rewards?.positions[position.tokenId.toString()]
              const samePool = position.poolAddress.toLowerCase() === selectedPoolAddress.toLowerCase()
              const farmActive = samePool && rewards?.farm.verified && rewards.farm.status === 'ACTIVE'
              const stakeEligible = farmActive && position.liquidity > 0n
              return (
                <tr key={position.tokenId.toString()}>
                  <td data-label="POSITION"><div className="position-pair"><span className="token-logo stock">{position.pair.slice(0, 2)}</span><div><strong>{position.pair}</strong><small>#{position.tokenId.toString()}</small></div></div></td>
                  <td data-label={`RANGE (${rangeQuoteSymbol})`} className="range-cell">{formatNumber(position.minPrice, 4)} - {formatNumber(position.maxPrice, 4)}</td>
                  <td data-label="STATUS"><span className={`status-pill ${position.status.toLowerCase().replace(/ /g, '-')}`}>● {position.status}</span></td>
                  <td data-label="현재 보유"><div>{formatToken(position.amount0, positionToken0, 6)} · {formatToken(position.amount1, positionToken1, 6)}<small>{formatMoney(position.amount0Usd + position.amount1Usd, 2)}</small></div></td>
                  <td data-label="미수령 수수료"><div className="fees-cell">{formatToken(position.fees0, positionToken0, 6)} · {formatToken(position.fees1, positionToken1, 6)}<small>{formatMoney(position.feesUsd, 2)}</small></div></td>
                  <td data-label="LP 보상"><div className="position-reward-cell"><span className={position.farmStaked ? 'staked' : ''}>{position.farmStaked ? 'FARM STAKED' : position.liquidity <= 0n ? 'EMPTY POSITION' : stakeEligible ? 'READY TO STAKE' : 'NO ACTIVE FARM'}</span><small>{position.farmStaked ? `${formatNumber(reward?.pendingCake || 0, 6)} CAKE` : position.status === 'IN RANGE' ? '범위 내' : '범위 이탈'}</small></div></td>
                  <td data-label="수수료율" className="fee-apr-cell">{formatPercent(position.feeApr, 2)}</td>
                  <td><div className="row-actions reward-actions"><button type="button" onClick={() => onCollect(position)} disabled={!walletAddress || transaction.status === 'pending'}>{collecting ? '…' : '수수료'}</button><button type="button" onClick={() => onDecrease(position)} disabled={!walletAddress || transaction.status === 'pending' || position.farmStaked || position.liquidity <= 0n} title={position.farmStaked ? '먼저 Farm에서 언스테이킹하세요.' : undefined}>회수</button>{position.farmStaked ? <><button type="button" className="reward-action" onClick={() => onHarvest(position)} disabled={!walletAddress || transaction.status === 'pending' || !reward?.pendingCakeRaw}>CAKE</button><button type="button" className="reward-action danger" onClick={() => onUnstake(position)} disabled={!walletAddress || transaction.status === 'pending'}>Unstake</button></> : <button type="button" className="reward-action" onClick={() => onStake(position)} disabled={!walletAddress || transaction.status === 'pending' || !stakeEligible}>Stake</button>}</div></td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </section>
  )
}
