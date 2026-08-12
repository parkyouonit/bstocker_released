import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { LiquidityBin } from '../types'
import { formatNumber } from '../lib/format'

interface LiquidityChartProps {
  bins: LiquidityBin[]
  currentPrice: number
  minPrice: number
  maxPrice: number
  setMinPrice: (value: number) => void
  setMaxPrice: (value: number) => void
  belowSymbol: string
  aboveSymbol: string
}

type RangeHandle = 'min' | 'max'

export function LiquidityChart({ bins, currentPrice, minPrice, maxPrice, setMinPrice, setMaxPrice, belowSymbol, aboveSymbol }: LiquidityChartProps) {
  const dragHandle = useRef<RangeHandle | undefined>(undefined)
  const [activeHandle, setActiveHandle] = useState<RangeHandle>()
  const max = Math.max(1, ...bins.map(bin => bin.value))
  const scale = useMemo(() => {
    const low = Math.max(bins[0]?.low || currentPrice / 2, 0.00000001)
    const high = Math.max(bins[bins.length - 1]?.high || currentPrice * 2, low * 1.001)
    const logLow = Math.log(low)
    const logSpan = Math.max(Math.log(high) - logLow, 0.000001)
    const percent = (price: number) => Math.max(0, Math.min(100, (Math.log(Math.max(price, low)) - logLow) / logSpan * 100))
    const priceAtPercent = (value: number) => Math.exp(logLow + Math.max(0, Math.min(100, value)) / 100 * logSpan)
    return { low, high, percent, priceAtPercent }
  }, [bins, currentPrice])
  const minLeft = scale.percent(minPrice)
  const maxLeft = scale.percent(maxPrice)
  const currentLeft = scale.percent(currentPrice)

  function beginDrag(handle: RangeHandle, event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault()
    dragHandle.current = handle
    setActiveHandle(handle)
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function moveDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (!dragHandle.current || !bins.length) return
    const bounds = event.currentTarget.getBoundingClientRect()
    const percent = (event.clientX - bounds.left) / Math.max(bounds.width, 1) * 100
    const nextPrice = scale.priceAtPercent(percent)
    const minimumGap = Math.max(currentPrice * 0.001, 0.00000001)
    if (dragHandle.current === 'min') setMinPrice(Math.min(nextPrice, maxPrice - minimumGap))
    else setMaxPrice(Math.max(nextPrice, minPrice + minimumGap))
  }

  function endDrag() {
    dragHandle.current = undefined
    setActiveHandle(undefined)
  }

  return (
    <div className="liquidity-panel">
      <div className="liquidity-title-row">
        <div>
          <span className="section-label">LIQUIDITY DISTRIBUTION</span>
          <span className="section-note">실제 Pancake V3 tick 유동성 · 아래 {belowSymbol}, 위 {aboveSymbol}</span>
        </div>
        <span className="section-note onchain-note"><b /> ONCHAIN TICKS · 손잡이 드래그</span>
      </div>
      <div
        className={`liquidity-bars ${activeHandle ? 'is-dragging' : ''}`}
        aria-label="Actual onchain liquidity distribution with adjustable range"
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        {bins.map(bin => {
          const midpoint = (bin.low + bin.high) / 2
          const selected = midpoint >= minPrice && midpoint <= maxPrice
          return (
            <div
              className={`liquidity-bar ${bin.side} ${selected ? 'selected' : ''}`}
              key={`${bin.low}-${bin.high}`}
              style={{ height: `${Math.max(3, bin.value / max * 100)}%` }}
              title={`${formatNumber(bin.low, 4)} - ${formatNumber(bin.high, 4)} · active L ${formatNumber(bin.value, 0)}`}
            />
          )
        })}
        {bins.length > 0 && <div className="liquidity-range-fill" style={{ left: `${minLeft}%`, width: `${Math.max(0, maxLeft - minLeft)}%` }} />}
        {bins.length > 0 && <div className="liquidity-current-line" style={{ left: `${currentLeft}%` }} />}
        {bins.length > 0 && (
          <>
            <div className={`liquidity-range-handle min ${activeHandle === 'min' ? 'active' : ''}`} style={{ left: `${minLeft}%` }} onPointerDown={event => beginDrag('min', event)}><span>MIN</span></div>
            <div className={`liquidity-range-handle max ${activeHandle === 'max' ? 'active' : ''}`} style={{ left: `${maxLeft}%` }} onPointerDown={event => beginDrag('max', event)}><span>MAX</span></div>
          </>
        )}
        {!bins.length && <div className="liquidity-empty">온체인 tick 데이터를 불러오지 못했습니다 · 임의 분포는 표시하지 않습니다</div>}
      </div>
      <div className="liquidity-axis"><span>{formatNumber(scale.low, 2)}</span><span>현재 {formatNumber(currentPrice, 2)}</span><span>{formatNumber(scale.high, 2)}</span></div>
    </div>
  )
}
