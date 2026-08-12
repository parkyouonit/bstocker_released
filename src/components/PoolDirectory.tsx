import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { formatMoney, formatPercent, shortAddress } from '../lib/format'
import type { PoolDirectoryEntry, PoolDirectoryResponse } from '../types'

type SortField = 'asset' | 'fee' | 'tvl' | 'volume' | 'apr'

interface PoolDirectoryProps {
  entries: PoolDirectoryEntry[]
  metadata?: PoolDirectoryResponse
  selectedAddress: string
  loading: boolean
  refreshing: boolean
  error?: string
  open: boolean
  onClose: () => void
  onSelect: (entry: PoolDirectoryEntry) => void
  onRefresh: () => void
}

const ROW_HEIGHT = 66
const OVERSCAN = 5

function savedMinimumTvl(): string {
  try { return window.localStorage.getItem('bstocker:min-tvl') || '0' } catch { return '0' }
}

function initials(symbol: string): string {
  return symbol.replace(/[^A-Z0-9]/gi, '').slice(0, 2).toUpperCase() || 'BS'
}

export function PoolDirectory({ entries, metadata, selectedAddress, loading, refreshing, error, open, onClose, onSelect, onRefresh }: PoolDirectoryProps) {
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query.trim().toLowerCase())
  const [minimumTvl, setMinimumTvl] = useState(savedMinimumTvl)
  const [fee, setFee] = useState('all')
  const [sortField, setSortField] = useState<SortField>('tvl')
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc')
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(560)
  const viewportRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    try { window.localStorage.setItem('bstocker:min-tvl', minimumTvl) } catch { /* device preference is optional */ }
  }, [minimumTvl])

  useEffect(() => {
    const node = viewportRef.current
    if (!node) return
    const update = () => setViewportHeight(node.clientHeight || 560)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  const feeOptions = useMemo(() => Array.from(new Set(entries.map(entry => entry.feeTierLabel))).sort(), [entries])
  const filtered = useMemo(() => {
    const threshold = Math.max(0, Number(minimumTvl || 0))
    const values = entries.filter(entry => {
      const haystack = `${entry.stockSymbol} ${entry.stockName} ${entry.description} ${entry.address} ${entry.stockAddress} ${entry.label}`.toLowerCase()
      if (deferredQuery && !haystack.includes(deferredQuery)) return false
      if (fee !== 'all' && entry.feeTierLabel !== fee) return false
      if (threshold > 0 && (entry.tvlUsd == null || entry.tvlUsd < threshold)) return false
      return true
    })
    const numberValue = (entry: PoolDirectoryEntry) => {
      if (sortField === 'fee') return entry.feeTier
      if (sortField === 'tvl') return entry.tvlUsd ?? -1
      if (sortField === 'volume') return entry.volume24hUsd ?? -1
      if (sortField === 'apr') return entry.feeApr ?? -1
      return 0
    }
    return values.sort((a, b) => {
      const compared = sortField === 'asset'
        ? a.stockSymbol.localeCompare(b.stockSymbol)
        : numberValue(a) - numberValue(b)
      return sortDirection === 'asc' ? compared : -compared
    })
  }, [entries, deferredQuery, minimumTvl, fee, sortField, sortDirection])

  useEffect(() => setScrollTop(0), [deferredQuery, minimumTvl, fee, sortField, sortDirection])

  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN)
  const count = Math.ceil(viewportHeight / ROW_HEIGHT) + OVERSCAN * 2
  const visible = filtered.slice(start, start + count)

  function changeSort(next: SortField) {
    if (next === sortField) setSortDirection(value => value === 'asc' ? 'desc' : 'asc')
    else {
      setSortField(next)
      setSortDirection(next === 'asset' ? 'asc' : 'desc')
    }
  }

  const sortMark = (field: SortField) => sortField === field ? (sortDirection === 'asc' ? ' ↑' : ' ↓') : ''

  return (
    <aside className={`pool-directory ${open ? 'open' : ''}`} aria-label="bStock pool directory">
      <div className="directory-heading">
        <div><small>bStock</small><strong>POOL DIRECTORY</strong></div>
        <div><span>{filtered.length}/{metadata?.total ?? entries.length}</span><button type="button" onClick={onClose} aria-label="풀 디렉터리 닫기">×</button></div>
      </div>
      <div className="directory-search">
        <input value={query} onChange={event => setQuery(event.target.value)} placeholder="티커, 종목명 또는 주소 검색" aria-label="풀 검색" />
        {query && <button type="button" onClick={() => setQuery('')} aria-label="검색 지우기">×</button>}
      </div>
      <div className="directory-filters">
        <label><span>최소 TVL (USD)</span><input type="number" min="0" step="10000" value={minimumTvl} onChange={event => setMinimumTvl(event.target.value)} /></label>
        <label><span>Fee</span><select value={fee} onChange={event => setFee(event.target.value)}><option value="all">전체</option>{feeOptions.map(value => <option key={value} value={value}>{value}</option>)}</select></label>
      </div>
      <div className="directory-source-row">
        <span className={metadata?.partial ? 'partial' : 'verified'}>{metadata?.partial ? 'PARTIAL DATA' : 'FACTORY VERIFIED'}</span>
        <button type="button" onClick={onRefresh} disabled={refreshing}>{refreshing ? '갱신 중…' : '↻ 새로고침'}</button>
      </div>
      {error && <div className="directory-message error">{error}</div>}
      {metadata?.warnings?.length ? <details className="directory-warning"><summary>일부 시장 데이터 지연 {metadata.warnings.length}건</summary><p>{metadata.warnings.join(' · ')}</p></details> : null}
      <div className="directory-columns">
        <button type="button" onClick={() => changeSort('asset')}>자산{sortMark('asset')}</button>
        <button type="button" onClick={() => changeSort('fee')}>Fee{sortMark('fee')}</button>
        <span><button type="button" onClick={() => changeSort('tvl')}>TVL{sortMark('tvl')}</button><button type="button" onClick={() => changeSort('volume')}>Vol{sortMark('volume')}</button></span>
        <button type="button" onClick={() => changeSort('apr')}>APR{sortMark('apr')}</button>
      </div>
      <div className="directory-list" ref={viewportRef} onScroll={event => setScrollTop(event.currentTarget.scrollTop)}>
        {loading && !entries.length && <div className="directory-skeleton">검증된 풀을 불러오는 중…</div>}
        {!loading && !filtered.length && <div className="directory-empty">조건에 맞는 검증된 풀이 없습니다.</div>}
        <div className="directory-list-spacer" style={{ height: filtered.length * ROW_HEIGHT }}>
          {visible.map((entry, offset) => {
            const selected = selectedAddress.toLowerCase() === entry.address.toLowerCase()
            return (
              <button
                type="button"
                key={entry.id}
                className={`directory-pool-row ${selected ? 'selected' : ''}`}
                style={{ transform: `translateY(${(start + offset) * ROW_HEIGHT}px)` }}
                aria-pressed={selected}
                onClick={() => onSelect(entry)}
                title={entry.warnings.includes('HIGH_TURNOVER_APR') ? '24시간 거래 회전율이 높아 APR 변동이 클 수 있습니다.' : `${entry.stockName} · ${entry.address}`}
              >
                <span className="directory-token-logo">
                  <i>{initials(entry.stockSymbol)}</i>
                  {entry.logoUrl && <img src={entry.logoUrl} alt="" loading="lazy" referrerPolicy="no-referrer" onError={event => { event.currentTarget.style.display = 'none' }} />}
                </span>
                <span className="directory-asset-copy"><strong>{entry.stockSymbol}</strong><small><b>●</b> {entry.dexLabel} · {entry.description}</small></span>
                <span className="directory-number">{entry.feeTierLabel}</span>
                <span className="directory-number"><strong>{entry.tvlUsd == null ? '—' : formatMoney(entry.tvlUsd, entry.tvlUsd >= 1_000_000 ? 2 : 1)}</strong><small>{entry.volume24hUsd == null ? (entry.marketStatus === 'stale' ? '온체인 TVL' : 'Vol —') : `Vol ${formatMoney(entry.volume24hUsd, 0)}`}</small></span>
                <span className={`directory-number apr ${entry.marketStatus} ${entry.warnings.length ? 'warning' : ''}`}>{entry.feeApr == null ? '—' : formatPercent(entry.feeApr, 2)}<small>{entry.warnings.includes('HIGH_TURNOVER_APR') ? '⚠ high turnover' : entry.verified ? '✓ verified' : shortAddress(entry.address)}</small></span>
              </button>
            )
          })}
        </div>
      </div>
      <div className="directory-footer"><span>{metadata?.source || 'Onchain directory'}</span><span>{metadata?.rejected ? `검증 제외 ${metadata.rejected}` : '검증 통과'}</span></div>
    </aside>
  )
}
