import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { Candle, Position } from '../types'
import { formatNumber } from '../lib/format'

interface PriceChartProps {
  candles: Candle[]
  currentPrice: number
  minPrice: number
  maxPrice: number
  setMinPrice: (value: number) => void
  setMaxPrice: (value: number) => void
  positions: Position[]
  symbol: string
}

type RangeHandle = 'min' | 'max'

const WIDTH = 940
const HEIGHT = 340
const PLOT_TOP = 20
const PLOT_BOTTOM = 268
const VOLUME_TOP = 284
const VOLUME_BOTTOM = 322

export function PriceChart({ candles, currentPrice, minPrice, maxPrice, setMinPrice, setMaxPrice, positions, symbol }: PriceChartProps) {
  const dragHandle = useRef<RangeHandle | undefined>(undefined)
  const [activeHandle, setActiveHandle] = useState<RangeHandle>()
  const [hoverIndex, setHoverIndex] = useState<number>()
  const model = useMemo(() => {
    const finiteValues = candles.flatMap(candle => [candle.high, candle.low])
      .concat([currentPrice, minPrice, maxPrice])
      .filter(value => Number.isFinite(value) && value > 0)
    const minimum = finiteValues.length ? Math.min(...finiteValues) : Math.max(currentPrice * 0.8, 0.000001)
    const maximum = finiteValues.length ? Math.max(...finiteValues) : Math.max(currentPrice * 1.2, minimum * 1.01)
    const rawSpan = Math.max(maximum - minimum, maximum * 0.01, 0.000001)
    const low = Math.max(0.00000001, minimum - rawSpan * 0.08)
    const high = maximum + rawSpan * 0.08
    const span = Math.max(high - low, 0.000001)
    const x = (index: number) => 22 + index * (WIDTH - 70) / Math.max(1, candles.length - 1)
    const y = (value: number) => PLOT_BOTTOM - (value - low) / span * (PLOT_BOTTOM - PLOT_TOP)
    const priceAtY = (chartY: number) => low + (PLOT_BOTTOM - chartY) / (PLOT_BOTTOM - PLOT_TOP) * span
    const maxVolume = Math.max(1, ...candles.map(candle => candle.volume))
    return { low, high, span, x, y, priceAtY, maxVolume }
  }, [candles, currentPrice, minPrice, maxPrice])

  const rangeTop = model.y(maxPrice)
  const rangeBottom = model.y(minPrice)
  const currentY = model.y(currentPrice)
  const rangeExists = minPrice > 0 && maxPrice > minPrice
  const hovered = hoverIndex == null ? undefined : candles[hoverIndex]

  function beginRangeDrag(handle: RangeHandle, event: ReactPointerEvent<SVGElement>) {
    event.preventDefault()
    dragHandle.current = handle
    setActiveHandle(handle)
    event.currentTarget.ownerSVGElement?.setPointerCapture(event.pointerId)
  }

  function moveRange(event: ReactPointerEvent<SVGSVGElement>) {
    const bounds = event.currentTarget.getBoundingClientRect()
    const chartX = (event.clientX - bounds.left) / Math.max(bounds.width, 1) * WIDTH
    if (candles.length) {
      const index = Math.max(0, Math.min(candles.length - 1, Math.round((chartX - 22) / (WIDTH - 70) * Math.max(1, candles.length - 1))))
      setHoverIndex(index)
    }
    if (!dragHandle.current) return
    const chartY = (event.clientY - bounds.top) / Math.max(bounds.height, 1) * HEIGHT
    const nextPrice = Math.max(model.low, Math.min(model.high, model.priceAtY(chartY)))
    const minimumGap = Math.max(currentPrice * 0.001, model.span * 0.002)
    if (dragHandle.current === 'min') setMinPrice(Math.min(nextPrice, maxPrice - minimumGap))
    else setMaxPrice(Math.max(nextPrice, minPrice + minimumGap))
  }

  function endRangeDrag() {
    dragHandle.current = undefined
    setActiveHandle(undefined)
  }

  return (
    <div className="chart-shell">
      <div className="chart-source-line"><span><b /> REAL POOL TRADES</span><span className="chart-source-actions"><button type="button" onClick={() => { setMinPrice(currentPrice * 0.9); setMaxPrice(currentPrice * 1.1) }}>현재가 ±10%</button><button type="button" disabled={!candles.length} onClick={() => { setMinPrice(Math.min(...candles.map(candle => candle.low))); setMaxPrice(Math.max(...candles.map(candle => candle.high))) }}>캔들 범위</button><i>{candles.length} candles</i></span></div>
      <svg
        className={`price-chart ${activeHandle ? 'is-dragging' : ''}`}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label={`${symbol} actual pool price and adjustable range chart`}
        onPointerMove={moveRange}
        onPointerUp={endRangeDrag}
        onPointerCancel={endRangeDrag}
        onPointerLeave={() => { if (!dragHandle.current) setHoverIndex(undefined) }}
      >
        <defs>
          <linearGradient id="rangeFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#55cdb3" stopOpacity="0.14" />
            <stop offset="100%" stopColor="#55cdb3" stopOpacity="0.035" />
          </linearGradient>
        </defs>
        {[0, 1, 2, 3, 4].map(index => {
          const value = model.high - model.span * index / 4
          const y = model.y(value)
          return (
            <g key={`grid-${index}`}>
              <line x1="22" x2={WIDTH - 42} y1={y} y2={y} className="chart-grid" />
              <text x={WIDTH - 35} y={y + 4} className="chart-axis-label">{formatNumber(value, 2)}</text>
            </g>
          )
        })}
        {rangeExists && <rect x="22" y={rangeTop} width={WIDTH - 64} height={Math.max(0, rangeBottom - rangeTop)} fill="url(#rangeFill)" />}
        {positions.slice(0, 4).map((position, index) => {
          const top = model.y(position.maxPrice)
          const bottom = model.y(position.minPrice)
          return (
            <g key={position.tokenId.toString()} className="position-overlay">
              <line x1={22} x2={WIDTH - 42} y1={top} y2={top} stroke={index === 0 ? '#7fd3ff' : '#8b84e8'} strokeDasharray="5 5" />
              <line x1={22} x2={WIDTH - 42} y1={bottom} y2={bottom} stroke={index === 0 ? '#7fd3ff' : '#8b84e8'} strokeDasharray="5 5" />
            </g>
          )
        })}
        {candles.map((candle, index) => {
          const candleX = model.x(index)
          const width = Math.max(2.5, Math.min(8, (WIDTH - 76) / Math.max(1, candles.length) * 0.66))
          const bodyTop = model.y(Math.max(candle.open, candle.close))
          const bodyBottom = model.y(Math.min(candle.open, candle.close))
          const color = candle.close >= candle.open ? '#55cdb3' : '#e06b59'
          const volumeHeight = candle.volume / model.maxVolume * (VOLUME_BOTTOM - VOLUME_TOP)
          return (
            <g key={candle.time} className="candle" role="presentation">
              <line x1={candleX} x2={candleX} y1={model.y(candle.high)} y2={model.y(candle.low)} stroke={color} strokeWidth="1.3" />
              <rect x={candleX - width / 2} y={bodyTop} width={width} height={Math.max(2, bodyBottom - bodyTop)} fill={color} rx="0.8" />
              <rect x={candleX - width / 2} y={VOLUME_BOTTOM - volumeHeight} width={width} height={volumeHeight} fill={color} opacity="0.22" />
            </g>
          )
        })}
        {rangeExists && (
          <g className="range-overlay">
            <line x1="22" x2={WIDTH - 42} y1={rangeTop} y2={rangeTop} className={`range-line ${activeHandle === 'max' ? 'active' : ''}`} />
            <line x1="22" x2={WIDTH - 42} y1={rangeBottom} y2={rangeBottom} className={`range-line ${activeHandle === 'min' ? 'active' : ''}`} />
            <line x1="22" x2={WIDTH - 42} y1={rangeTop} y2={rangeTop} className="range-hit-line" onPointerDown={event => beginRangeDrag('max', event)} />
            <line x1="22" x2={WIDTH - 42} y1={rangeBottom} y2={rangeBottom} className="range-hit-line" onPointerDown={event => beginRangeDrag('min', event)} />
            <g className={`range-tag range-handle ${activeHandle === 'max' ? 'active' : ''}`} transform={`translate(24 ${Math.max(16, rangeTop - 12)})`} onPointerDown={event => beginRangeDrag('max', event)}>
              <rect width="98" height="20" rx="3" />
              <text x="8" y="14">MAX {formatNumber(maxPrice, 2)} ↕</text>
            </g>
            <g className={`range-tag range-handle ${activeHandle === 'min' ? 'active' : ''}`} transform={`translate(24 ${Math.min(PLOT_BOTTOM - 18, rangeBottom + 4)})`} onPointerDown={event => beginRangeDrag('min', event)}>
              <rect width="98" height="20" rx="3" />
              <text x="8" y="14">MIN {formatNumber(minPrice, 2)} ↕</text>
            </g>
          </g>
        )}
        <line x1="22" x2={WIDTH - 42} y1={currentY} y2={currentY} className="current-price-line" />
        <g className="current-price-tag" transform={`translate(${WIDTH - 42} ${Math.max(18, currentY - 10)})`}>
          <rect width="42" height="20" rx="2" />
          <text x="4" y="14">{formatNumber(currentPrice, 2)}</text>
        </g>
        {hovered && hoverIndex != null && (
          <g className="chart-crosshair" pointerEvents="none">
            <line x1={model.x(hoverIndex)} x2={model.x(hoverIndex)} y1={PLOT_TOP} y2={VOLUME_BOTTOM} />
            <circle cx={model.x(hoverIndex)} cy={model.y(hovered.close)} r="3" />
            <g transform={`translate(${Math.min(WIDTH - 238, Math.max(28, model.x(hoverIndex) + 12))} ${PLOT_TOP + 8})`}>
              <rect width="205" height="60" rx="5" />
              <text x="10" y="16">{new Date(hovered.time).toLocaleString('ko-KR')}</text>
              <text x="10" y="34">O {formatNumber(hovered.open, 3)} · H {formatNumber(hovered.high, 3)}</text>
              <text x="10" y="50">L {formatNumber(hovered.low, 3)} · C {formatNumber(hovered.close, 3)} · Vol ${formatNumber(hovered.volume, 0)}</text>
            </g>
          </g>
        )}
        {!candles.length && (
          <g className="chart-empty-state">
            <text x={WIDTH / 2} y={HEIGHT / 2 - 8} textAnchor="middle">실제 체결 데이터가 아직 없습니다</text>
            <text x={WIDTH / 2} y={HEIGHT / 2 + 12} textAnchor="middle">가짜 캔들은 표시하지 않습니다</text>
          </g>
        )}
        <line x1="22" x2={WIDTH - 42} y1={VOLUME_TOP - 7} y2={VOLUME_TOP - 7} className="chart-divider" />
        <text x="24" y={VOLUME_TOP + 12} className="chart-volume-label">REAL SWAP VOLUME (USD)</text>
        <text x="22" y={HEIGHT - 4} className="chart-date-label">{candles.length ? new Date(candles[0].time).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' }) : '—'}</text>
        <text x={WIDTH - 85} y={HEIGHT - 4} className="chart-date-label">{candles.length ? new Date(candles[candles.length - 1].time).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' }) : '—'}</text>
      </svg>
    </div>
  )
}
