import type { Address } from 'viem'
import type { PoolSummary } from '../types'
import { explorerAddress } from '../config'
import { formatMoney, formatNumber, formatPercent, shortAddress } from '../lib/format'

interface PoolHeaderProps {
  summary: PoolSummary
  walletAddress?: Address
  onConnect: () => void
  onRefresh: () => void
  refreshing: boolean
  onToggleDirectory: () => void
  directoryCount: number
  onOpenStrategy: () => void
}

export function PoolHeader({ summary, walletAddress, onConnect, onRefresh, refreshing, onToggleDirectory, directoryCount, onOpenStrategy }: PoolHeaderProps) {
  return (
    <header className="pool-header">
      <div className="brand-block"><button type="button" className="directory-toggle" onClick={onToggleDirectory} aria-label="풀 디렉터리 열기"><span>POOL</span><b>{directoryCount || '—'}</b></button><div className="brand-mark">bStock<span>er</span></div><div className="header-divider" /><div className="pair-block"><span className="token-logo stock">{summary.displayBase.symbol.slice(0, 2)}</span><div><strong>{summary.displayBase.symbol}/{summary.displayQuote.symbol}</strong><small>{summary.displayBase.name} · {summary.feeTierLabel}</small></div></div></div>
      <div className="metric-grid">
        <div className="metric"><span>POOL PRICE</span><strong>{formatNumber(summary.displayPrice, 4)} <em>{summary.displayQuote.symbol}</em> <b className="live-dot">● LIVE</b></strong></div>
        <div className="metric"><span>TVL</span><strong>{formatMoney(summary.tvlUsd, 2)}</strong></div>
        <div className="metric"><span>24H FEES</span><strong>{summary.marketStatus === 'fresh' ? formatMoney(summary.fees24hUsd, 0) : '—'}</strong><small>{summary.marketStatus === 'fresh' ? `Vol ${formatMoney(summary.volume24hUsd, 0)}` : '시장 데이터 없음'}</small></div>
        <div className="metric apr"><span>추정 GROSS APR</span><strong>{summary.marketStatus === 'fresh' && summary.feeApr ? formatPercent(summary.feeApr, 2) : '—'}</strong><small>24h fee / TVL 연환산</small></div>
        <div className="metric"><span>FEE TIER</span><strong>{summary.feeTierLabel}</strong></div>
      </div>
      <div className="wallet-block"><button type="button" className="strategy-nav-button" onClick={onOpenStrategy}>RH 5-TICK</button><span className="network-pill">BSC</span><button type="button" className="wallet-button" onClick={onConnect}>{walletAddress ? shortAddress(walletAddress) : 'Connect Wallet'}</button><button type="button" className="refresh-button" onClick={onRefresh} disabled={refreshing} title="Refresh">{refreshing ? '…' : '↻'}</button><a className="address-link" href={explorerAddress(summary.address)} target="_blank" rel="noreferrer">pool ↗</a></div>
    </header>
  )
}
