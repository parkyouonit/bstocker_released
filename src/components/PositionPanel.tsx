import type { Dispatch, SetStateAction } from 'react'
import { formatUnits } from 'viem'
import type { PoolSummary, Simulation, TransactionState, TokenMeta, ZapQuote } from '../types'
import { formatMoney, formatNumber, formatPercent, formatToken } from '../lib/format'

interface PositionPanelProps {
  summary: PoolSummary
  baseToken: TokenMeta
  quoteToken: TokenMeta
  baseAmount: string
  quoteAmount: string
  setBaseAmount: (value: string) => void
  setQuoteAmount: (value: string) => void
  minPrice: number
  maxPrice: number
  setMinPrice: Dispatch<SetStateAction<number>>
  setMaxPrice: Dispatch<SetStateAction<number>>
  autoFill: boolean
  setAutoFill: Dispatch<SetStateAction<boolean>>
  zap: boolean
  setZap: Dispatch<SetStateAction<boolean>>
  zapQuote?: ZapQuote
  zapQuoteLoading: boolean
  zapQuoteError?: string
  slippage: number
  setSlippage: Dispatch<SetStateAction<number>>
  simulation: Simulation
  transaction: TransactionState
  walletAddress?: string
  onConnect: () => void
  onCreate: () => void
  onPreset: (preset: string) => void
}

function TokenInput({ token, amount, setAmount, unitPrice, disabled = false }: { token: TokenMeta; amount: string; setAmount: (value: string) => void; unitPrice: number; disabled?: boolean }) {
  const exactBalance = formatUnits(token.balanceUiRaw, token.decimals)
  return (
    <div className="token-input">
      <div className="token-input-top">
        <div className="token-name"><span className={`token-logo ${token.symbol === 'USDT' ? 'usdt' : 'stock'}`}>{token.symbol.slice(0, 2)}</span><strong>{token.symbol}</strong></div>
        <span className="balance-copy">잔고 {formatNumber(token.balanceUi, 6)} · <button type="button" disabled={disabled} onClick={() => setAmount(exactBalance)}>MAX</button></span>
      </div>
      <div className="token-input-bottom">
        <input inputMode="decimal" value={amount} disabled={disabled} onChange={event => setAmount(event.target.value.replace(/[^0-9.]/g, ''))} placeholder="0.0" aria-label={`${token.symbol} amount`} />
        <span>{formatMoney(Number(amount || 0) * unitPrice, 2)}</span>
      </div>
    </div>
  )
}

function Toggle({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return <button type="button" className={`toggle ${active ? 'active' : ''}`} onClick={onClick} aria-label={label}><span /></button>
}

export function PositionPanel(props: PositionPanelProps) {
  const {
    summary, baseToken, quoteToken, baseAmount, quoteAmount, setBaseAmount, setQuoteAmount,
    minPrice, maxPrice, setMinPrice, setMaxPrice, autoFill, setAutoFill, zap, setZap, zapQuote, zapQuoteLoading, zapQuoteError,
    slippage, setSlippage, simulation, transaction, walletAddress, onConnect, onCreate, onPreset,
  } = props
  const depositUsd = Number(baseAmount || 0) * summary.displayPrice + Number(quoteAmount || 0)
  const txBusy = ['approving', 'simulating', 'pending'].includes(transaction.status)
  const quoteBudget = Number(quoteAmount || 0)
  const zapReady = Boolean(zapQuote && !zapQuoteLoading && !zapQuoteError && zapQuote.priceImpactPercent <= 5 && quoteBudget <= quoteToken.balanceUi)
  const baseOverBalance = Number(baseAmount || 0) > baseToken.balanceUi
  const quoteOverBalance = Number(quoteAmount || 0) > quoteToken.balanceUi
  const directBalancesReady = zap || (!baseOverBalance && !quoteOverBalance)
  const canSubmit = Boolean(walletAddress && summary.writesEnabled && depositUsd > 0 && minPrice > 0 && maxPrice > minPrice && !txBusy && directBalancesReady && (!zap || zapReady))
  const quoteFraction = (numerator: bigint, denominator: bigint) => formatUnits(quoteToken.balanceUiRaw * numerator / denominator, quoteToken.decimals)

  return (
    <aside className="position-panel">
      <div className="panel-heading"><h2>CREATE POSITION</h2><label>Auto-Fill <Toggle active={autoFill} onClick={() => setAutoFill(value => !value)} label="Auto fill" /></label></div>
      <div className="quick-amounts"><span>AMOUNT</span><button type="button" onClick={() => setQuoteAmount(quoteFraction(1n, 4n))}>25%</button><button type="button" onClick={() => setQuoteAmount(quoteFraction(1n, 2n))}>50%</button><button type="button" onClick={() => setQuoteAmount(quoteFraction(1n, 1n))}>MAX</button></div>
      <TokenInput token={baseToken} amount={baseAmount} setAmount={setBaseAmount} unitPrice={summary.displayPrice} disabled={zap} />
      <TokenInput token={quoteToken} amount={quoteAmount} setAmount={setQuoteAmount} unitPrice={1} />
      <div className="helper-line">{zap ? `${quoteToken.symbol} 단일 예산을 실제 스왑한 뒤 V3 LP를 생성합니다` : autoFill ? `AUTO-FILL · 마지막 입력 토큰을 유지하고 현재 PRICE RANGE 비율로 상대 수량을 맞춥니다` : `스왑 없이 ${quoteToken.symbol} + ${baseToken.symbol}를 직접 예치합니다`}</div>
      {!zap && baseOverBalance && <div className="zap-quote-box error">{baseToken.symbol} 자동 계산 수량이 현재 잔고보다 많습니다. 입력 수량을 줄여 주세요.</div>}
      {!zap && quoteOverBalance && <div className="zap-quote-box error">{quoteToken.symbol} 자동 계산 수량이 현재 잔고보다 많습니다. 입력 수량을 줄여 주세요.</div>}
      <div className="setting-row"><div><span className="setting-title">PRICE RANGE</span><span className="setting-unit">{quoteToken.symbol} / {baseToken.symbol}</span></div><button type="button" className="text-button" onClick={() => onPreset('reset')}>↻ 초기화</button></div>
      <div className="preset-row">
        {['2%', '5%', '10%', '20%', 'x2'].map(preset => <button type="button" key={preset} onClick={() => onPreset(preset)}>{preset === 'x2' ? '±2x' : `±${preset}`}</button>)}
      </div>
      <div className="price-fields">
        <label><span>MIN PRICE</span><input value={minPrice ? minPrice.toFixed(4) : ''} onChange={event => setMinPrice(Number(event.target.value))} /><small>{summary.displayPrice > 0 ? `${((minPrice / summary.displayPrice - 1) * 100).toFixed(2)}%` : '—'}</small></label>
        <label><span>MAX PRICE</span><input value={maxPrice ? maxPrice.toFixed(4) : ''} onChange={event => setMaxPrice(Number(event.target.value))} /><small className="positive">{summary.displayPrice > 0 ? `+${((maxPrice / summary.displayPrice - 1) * 100).toFixed(2)}%` : '—'}</small></label>
      </div>
      <div className="tick-info">tick {summary.tick - 1350} — {summary.tick + 1800} · 실제 {minPrice.toFixed(4)} — {maxPrice.toFixed(4)}</div>
      <div className="simulation-box">
        <div className="simulation-title"><strong>SIMULATION</strong><span>최근 24h 수수료·통계 추정</span></div>
        <div className="simulation-grid">
          <div><span>FEE APR (IN-RANGE)</span><strong className="teal">{formatPercent(simulation.feeApr, 2)}</strong></div>
          <div><span>이달 확률 반영</span><strong>{formatPercent(simulation.inRangeShare, 1)}</strong></div>
          <div><span>기본 효율</span><strong>{formatPercent(simulation.liquidityShare, 3)}</strong></div>
          <div><span>range 유지 기대</span><strong>{simulation.rangeStayDays ? `${simulation.rangeStayDays.toFixed(1)}일` : '—'}</strong></div>
          <div><span>30일 예상 수수료</span><strong>{simulation.expectedFeeUsd30d ? formatMoney(simulation.expectedFeeUsd30d, 2) : '—'}</strong></div>
          <div><span>현재 유동성 점유</span><strong>{formatPercent(simulation.liquidityShare, 3)}</strong></div>
        </div>
      </div>
      <div className="stat-note">TWAP {formatNumber(summary.twapPrice, 4)} · 현재 괴리 {formatPercent(simulation.twapDivergence, 2)}</div>
      {simulation.warnings.length > 0 && <div className="warning-list">{simulation.warnings.slice(0, 2).map(warning => <div key={warning}>⚠ {warning}</div>)}</div>}
      <div className="deposit-summary"><span>예치 합계</span><strong>{formatMoney(depositUsd, 2)}</strong><small>예상 가스·slippage는 확인 단계에서 재검증</small></div>
      <div className="slippage-row"><span>슬리피지 허용</span>{[0.1, 0.5, 1].map(value => <button type="button" key={value} className={slippage === value ? 'selected' : ''} onClick={() => setSlippage(value)}>{value}%</button>)}</div>
      <div className="setting-row zap-row"><span>Zap ({quoteToken.symbol}만으로)</span><Toggle active={zap} onClick={() => setZap(value => !value)} label="Zap" /></div>
      {zap && <div className="zap-note live"><strong>LIVE 2-STEP ZAP</strong><span>Rabby에서 승인·스왑·LP 생성을 차례로 확인합니다. 스왑 후 LP 생성이 실패하면 두 토큰이 지갑에 남습니다.</span></div>}
      {zap && zapQuoteLoading && <div className="zap-quote-box pending">PancakeSwap 최신 견적 확인 중…</div>}
      {zap && zapQuoteError && <div className="zap-quote-box error">{zapQuoteError}</div>}
      {zap && walletAddress && quoteBudget > quoteToken.balanceUi && <div className="zap-quote-box error">{quoteToken.symbol} 잔고가 입력한 Zap 예산보다 부족합니다.</div>}
      {zap && zapQuote && !zapQuoteLoading && (
        <div className="zap-quote-box">
          <div><span>스왑 입력</span><strong>{formatToken(zapQuote.swapQuoteUi, quoteToken.symbol, 6)}</strong></div>
          <div><span>예상 수령</span><strong>{formatToken(zapQuote.expectedBaseUi, baseToken.symbol, 6)}</strong></div>
          <div><span>LP 잔여 예산</span><strong>{formatToken(zapQuote.remainingQuoteUi, quoteToken.symbol, 6)}</strong></div>
          <div><span>최소 수령</span><strong>{formatToken(zapQuote.minimumBaseUi, baseToken.symbol, 6)}</strong></div>
          <div><span>가격 충격</span><strong className={zapQuote.priceImpactPercent > 5 ? 'danger' : ''}>{zapQuote.priceImpactPercent.toFixed(3)}%</strong></div>
          <div><span>통과 tick</span><strong>{zapQuote.initializedTicksCrossed}</strong></div>
        </div>
      )}
      <button type="button" className="primary-action" disabled={!canSubmit} onClick={onCreate}>
        {transaction.status === 'pending' ? '지갑에서 확인 중…' : transaction.status === 'success' ? '포지션 생성 완료' : walletAddress ? (summary.writesEnabled ? (zap ? 'LIVE ZAP 실행' : 'V3 포지션 생성') : '주소 검증 후 거래 활성화') : '지갑 연결'}
      </button>
      {!walletAddress && <button type="button" className="secondary-action" onClick={onConnect}>Connect Wallet</button>}
      {transaction.message && <div className={`transaction-message ${transaction.status}`}>{transaction.message}{transaction.hash ? <span> · {transaction.hash.slice(0, 10)}…</span> : null}</div>}
      <div className="panel-footer">유동성 제공은 가격 변동·비영구적 손실 위험이 있습니다.</div>
    </aside>
  )
}
