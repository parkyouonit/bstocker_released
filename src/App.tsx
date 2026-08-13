import { useEffect, useMemo, useRef, useState } from 'react'
import type { Address } from 'viem'
import { LiquidityChart } from './components/LiquidityChart'
import { PoolDirectory } from './components/PoolDirectory'
import { PoolHeader } from './components/PoolHeader'
import { PositionPanel } from './components/PositionPanel'
import { PositionsTable } from './components/PositionsTable'
import { PriceChart } from './components/PriceChart'
import { RewardsPanel } from './components/RewardsPanel'
import { RobinhoodStrategyPage } from './components/RobinhoodStrategyPage'
import { WalletPicker } from './components/WalletPicker'
import { APP_CONFIG, isLiveConfig } from './config'
import { connectAndLoad, collectPosition, decreasePosition, executeZapPosition, mintPosition, quoteZap } from './lib/chainAdapter'
import { calculatePositionAmounts, calculateSimulation, priceRangeForPreset } from './lib/math'
import { formatMoney, formatNumber, relativeTime, shortAddress } from './lib/format'
import { connectRobinhoodWallet, getPublicClient } from './lib/viem'
import { walletErrorMessage, type WalletKind } from './lib/wallet'
import { useTerminalData } from './hooks/useTerminalData'
import { usePoolDirectory } from './hooks/usePoolDirectory'
import { useRewardsData } from './hooks/useRewardsData'
import { useRobinhoodStrategy } from './hooks/useRobinhoodStrategy'
import { claimMerklRewards, collectStakedPancakePosition, harvestPancakePosition, stakePancakePosition, unstakePancakePosition } from './lib/rewardAdapter'
import { BSTOCK_DIRECTORY_FALLBACKS, BSTOCK_POOL_PRESETS, DEFAULT_POOL_ID, findPoolPreset, poolPresetFromDirectory, type PoolPreset } from './pools'
import type { PoolDirectoryEntry, Position, TransactionState, ZapQuote } from './types'
import { prepareRobinhoodOracle } from './lib/robinhoodStrategy'

const timeframes = ['5m', '15m', '1h', '4h', '1d', '1w']

function initialPool(): PoolPreset {
  const queryAddress = new URLSearchParams(window.location.search).get('pool')?.toLowerCase()
  return BSTOCK_POOL_PRESETS.find(pool => pool.poolAddress.toLowerCase() === queryAddress)
    || BSTOCK_POOL_PRESETS.find(pool => pool.poolAddress.toLowerCase() === APP_CONFIG.poolAddress.toLowerCase())
    || findPoolPreset(DEFAULT_POOL_ID)
}

function App() {
  const [page, setPage] = useState<'lp' | 'robinhood'>(() => window.location.hash === '#robinhood-strategy' ? 'robinhood' : 'lp')
  const [walletAddress, setWalletAddress] = useState<Address>()
  const [robinhoodWallet, setRobinhoodWallet] = useState<Address>()
  const [walletTarget, setWalletTarget] = useState<'bsc' | 'robinhood' | null>(null)
  const [robinhoodOracleTransaction, setRobinhoodOracleTransaction] = useState<TransactionState>({ status: 'idle' })
  const [selectedPool, setSelectedPool] = useState<PoolPreset>(initialPool)
  const [directoryOpen, setDirectoryOpen] = useState(() => window.matchMedia('(min-width: 1440px)').matches)
  const [timeframe, setTimeframe] = useState('1d')
  const directory = usePoolDirectory()
  const directoryEntries = directory.entries.length ? directory.entries : BSTOCK_DIRECTORY_FALLBACKS
  const { data, loading, refreshing, error, refresh } = useTerminalData(walletAddress, selectedPool, timeframe)
  const [rangePoolId, setRangePoolId] = useState<string>()
  const [minPrice, setMinPrice] = useState(0)
  const [maxPrice, setMaxPrice] = useState(0)
  const [baseAmount, setBaseAmount] = useState('0.0')
  const [quoteAmount, setQuoteAmount] = useState('0.0')
  const [autoFill, setAutoFill] = useState(true)
  const [zap, setZap] = useState(false)
  const [zapQuote, setZapQuote] = useState<ZapQuote>()
  const [zapQuoteLoading, setZapQuoteLoading] = useState(false)
  const [zapQuoteError, setZapQuoteError] = useState<string>()
  const [slippage, setSlippage] = useState(0.5)
  const [transaction, setTransaction] = useState<TransactionState>({ status: 'idle' })
  const lastEditedAmount = useRef<'base' | 'quote'>('quote')

  const summary = data?.summary
  const baseToken = summary?.displayBase
  const quoteToken = summary?.displayQuote
  const rewards = useRewardsData(summary, walletAddress, data?.positions || [])
  const robinhood = useRobinhoodStrategy(robinhoodWallet, page === 'robinhood')

  useEffect(() => {
    const onHashChange = () => setPage(window.location.hash === '#robinhood-strategy' ? 'robinhood' : 'lp')
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  useEffect(() => {
    if (!summary || summary.address.toLowerCase() !== selectedPool.poolAddress.toLowerCase() || rangePoolId === selectedPool.id) return
    setMinPrice(summary.displayPrice * 0.8)
    setMaxPrice(summary.displayPrice * 1.1327)
    setRangePoolId(selectedPool.id)
  }, [summary, selectedPool, rangePoolId])

  useEffect(() => {
    const urlAddress = new URLSearchParams(window.location.search).get('pool')?.toLowerCase()
    const matched = directoryEntries.find(entry => entry.address.toLowerCase() === urlAddress)
      || directoryEntries.find(entry => entry.address.toLowerCase() === selectedPool.poolAddress.toLowerCase())
    if (!matched) return
    const next = poolPresetFromDirectory(matched)
    if (next.id !== selectedPool.id || next.verified !== selectedPool.verified) setSelectedPool(next)
  }, [directoryEntries, selectedPool])

  useEffect(() => {
    if (!zap) return
    setBaseAmount('0.0')
  }, [zap])

  function formatAutoAmount(value: number, decimals: number): string {
    if (!Number.isFinite(value) || value <= 0) return '0'
    const precision = Math.min(decimals, 12)
    const factor = 10 ** precision
    const floored = Math.floor(value * factor) / factor
    return floored.toFixed(precision).replace(/\.?0+$/, '') || '0'
  }

  function matchingAmount(side: 'base' | 'quote', source: string): string {
    if (!summary || !baseToken || !quoteToken || minPrice <= 0 || maxPrice <= minPrice) return '0'
    const amount = Number(source)
    if (!Number.isFinite(amount) || amount <= 0) return '0'
    const unit = calculatePositionAmounts(1, summary.displayPrice, minPrice, maxPrice)
    if (side === 'base') {
      if (unit.base <= 0) return '0'
      return formatAutoAmount(amount * unit.quote / unit.base, quoteToken.decimals)
    }
    if (unit.quote <= 0) return '0'
    return formatAutoAmount(amount * unit.base / unit.quote, baseToken.decimals)
  }

  function handleBaseAmountChange(value: string) {
    lastEditedAmount.current = 'base'
    setBaseAmount(value)
    if (autoFill && !zap) setQuoteAmount(matchingAmount('base', value))
  }

  function handleQuoteAmountChange(value: string) {
    lastEditedAmount.current = 'quote'
    setQuoteAmount(value)
    if (autoFill && !zap) setBaseAmount(matchingAmount('quote', value))
  }

  useEffect(() => {
    if (!autoFill || zap || !summary || !baseToken || !quoteToken || minPrice <= 0 || maxPrice <= minPrice) return
    if (lastEditedAmount.current === 'base') setQuoteAmount(matchingAmount('base', baseAmount))
    else setBaseAmount(matchingAmount('quote', quoteAmount))
    // Recompute only when the pool price/range or Auto-Fill mode changes. Amount edits use the handlers above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoFill, zap, summary?.displayPrice, minPrice, maxPrice, baseToken?.address, quoteToken?.address])

  useEffect(() => {
    if (!zap || !summary || Number(quoteAmount || 0) <= 0 || minPrice <= 0 || maxPrice <= minPrice) {
      setZapQuote(undefined)
      setZapQuoteError(undefined)
      setZapQuoteLoading(false)
      return
    }
    let cancelled = false
    setZapQuoteLoading(true)
    setZapQuoteError(undefined)
    const timer = window.setTimeout(() => {
      void quoteZap({
        summary,
        budgetQuoteUi: Number(quoteAmount),
        minPrice,
        maxPrice,
        slippageBps: Math.round(slippage * 100),
      }).then(value => {
        if (!cancelled) setZapQuote(value)
      }).catch(cause => {
        if (!cancelled) {
          setZapQuote(undefined)
          setZapQuoteError(cause instanceof Error ? cause.message : 'Zap 견적을 불러오지 못했습니다.')
        }
      }).finally(() => {
        if (!cancelled) setZapQuoteLoading(false)
      })
    }, 450)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [zap, summary, quoteAmount, minPrice, maxPrice, slippage])

  const depositUsd = summary && baseToken && quoteToken
    ? Number(baseAmount || 0) * summary.displayPrice + Number(quoteAmount || 0)
    : 0
  const simulation = useMemo(() => summary
    ? calculateSimulation(summary, minPrice, maxPrice, depositUsd)
    : { feeApr: null, inRangeShare: null, rangeStayDays: null, expectedFee30d: null, expectedFeeUsd30d: null, liquidityShare: null, twapDivergence: null, priceImpact: null, warnings: [] },
  [summary, minPrice, maxPrice, depositUsd])
  const currentPairPositions = data?.positions.filter(position => position.poolAddress.toLowerCase() === summary?.address.toLowerCase()) || []

  function handlePoolSelect(entry: PoolDirectoryEntry) {
    const pool = poolPresetFromDirectory(entry)
    setSelectedPool(pool)
    setMinPrice(0)
    setMaxPrice(0)
    setBaseAmount('0.0')
    setQuoteAmount('0.0')
    lastEditedAmount.current = 'quote'
    setZap(false)
    setTransaction({ status: 'idle' })
    const url = new URL(window.location.href)
    url.searchParams.set('pool', pool.poolAddress)
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`)
    if (window.innerWidth < 1440) setDirectoryOpen(false)
  }

  function handleConnect() {
    setWalletTarget('bsc')
  }

  function handleRobinhoodConnect() {
    setWalletTarget('robinhood')
  }

  async function connectSelectedWallet(kind: WalletKind) {
    const target = walletTarget
    setWalletTarget(null)
    if (target === 'robinhood') {
      try {
        const address = await connectRobinhoodWallet(kind)
        setRobinhoodWallet(address)
      } catch (cause) {
        window.alert(walletErrorMessage(cause))
      }
      return
    }
    setTransaction({ status: 'connecting', message: '지갑 연결과 BSC 네트워크를 확인하는 중…' })
    try {
      const address = await connectAndLoad(kind)
      setWalletAddress(address)
      setTransaction({ status: 'success', message: `지갑 연결 완료 · ${shortAddress(address)}` })
      window.setTimeout(() => setTransaction({ status: 'idle' }), 2200)
    } catch (cause) {
      setTransaction({ status: 'error', message: walletErrorMessage(cause) })
    }
  }

  async function handlePrepareRobinhoodOracle() {
    try {
      let account = robinhoodWallet
      if (!account) {
        account = await connectRobinhoodWallet()
        setRobinhoodWallet(account)
      }
      if (!robinhood.data) throw new Error('Robinhood 전략 상태를 먼저 불러와야 합니다.')
      setRobinhoodOracleTransaction({ status: 'simulating', message: '풀 주소와 오라클 확장 호출을 시뮬레이션하는 중…' })
      const hash = await prepareRobinhoodOracle(account, robinhood.data.contracts.pool)
      setRobinhoodOracleTransaction({ status: 'success', message: '오라클 저장 용량을 64개로 확장했습니다. 5분 이상 기록이 쌓여야 TWAP이 활성화됩니다.', hash })
      await robinhood.refresh()
    } catch (cause) {
      setRobinhoodOracleTransaction({ status: 'error', message: cause instanceof Error ? cause.message : '오라클 준비에 실패했습니다.' })
    }
  }

  function openRobinhood() {
    window.location.hash = 'robinhood-strategy'
    setPage('robinhood')
  }

  function closeRobinhood() {
    history.replaceState(null, '', `${window.location.pathname}${window.location.search}`)
    setPage('lp')
  }

  function handlePreset(preset: string) {
    if (!summary) return
    const [nextMin, nextMax] = preset === 'reset'
      ? [summary.displayPrice * 0.8, summary.displayPrice * 1.1327]
      : priceRangeForPreset(summary.displayPrice, preset)
    setMinPrice(nextMin)
    setMaxPrice(nextMax)
  }

  async function handleCreate() {
    if (!summary || !baseToken || !quoteToken) return
    if (!walletAddress) {
      await handleConnect()
      return
    }
    if (!summary.writesEnabled) {
      setTransaction({ status: 'error', message: '현재는 안전한 데모/읽기 모드입니다. 검증된 주소와 쓰기 설정을 추가해야 합니다.' })
      return
    }
    try {
      if (zap) {
        const result = await executeZapPosition({
          summary,
          account: walletAddress,
          budgetQuoteUi: Number(quoteAmount || 0),
          minPrice,
          maxPrice,
          slippageBps: Math.round(slippage * 100),
          onProgress: progress => setTransaction({
            status: progress.hash ? 'pending' : progress.phase.includes('approving') ? 'approving' : 'simulating',
            message: progress.message,
            hash: progress.hash,
          }),
        })
        setTransaction({ status: 'success', message: '실제 Zap 스왑과 V3 LP 포지션 생성이 완료되었습니다.', hash: result.mintHash })
        await refresh()
        return
      }
      setTransaction({ status: 'simulating', message: '포지션 생성과 토큰 승인을 시뮬레이션하는 중…' })
      const amount0Ui = summary.token0.address.toLowerCase() === baseToken.address.toLowerCase() ? baseAmount : quoteAmount
      const amount1Ui = summary.token1.address.toLowerCase() === baseToken.address.toLowerCase() ? baseAmount : quoteAmount
      const hash = await mintPosition({ summary, account: walletAddress, minPrice, maxPrice, amount0Ui, amount1Ui, slippageBps: Math.round(slippage * 100) })
      setTransaction({ status: 'pending', message: '지갑 트랜잭션 확인을 기다리는 중…', hash })
      await waitForReceipt(hash)
      setTransaction({ status: 'success', message: '새 포지션이 생성되었습니다.', hash })
      await refresh()
    } catch (cause) {
      setTransaction({ status: 'error', message: cause instanceof Error ? cause.message : '포지션 생성에 실패했습니다.' })
    }
  }

  async function handleCollect(position: Position) {
    if (!walletAddress) return handleConnect()
    if (!summary?.writesEnabled || data?.summary.mode === 'demo') {
      setTransaction({ status: 'error', message: '데모 모드에서는 수수료 수령을 실행하지 않습니다.' })
      return
    }
    try {
      if (position.farmStaked && position.poolAddress.toLowerCase() !== summary.address.toLowerCase()) {
        setTransaction({ status: 'error', message: '해당 Farm 풀을 먼저 선택한 뒤 수수료를 수령하세요.' })
        return
      }
      setTransaction({ status: 'simulating', message: `#${position.tokenId.toString()} 포지션 수수료 수령을 준비하는 중…` })
      const hash = position.farmStaked
        ? await collectStakedPancakePosition(summary, position, walletAddress)
        : await collectPosition(position.tokenId, walletAddress)
      setTransaction({ status: 'pending', message: '수수료 수령 트랜잭션 확인 중…', hash })
      await waitForReceipt(hash)
      setTransaction({ status: 'success', message: '미수령 수수료를 수령했습니다.', hash })
      await refresh()
      await rewards.refresh()
    } catch (cause) {
      setTransaction({ status: 'error', message: cause instanceof Error ? cause.message : '수수료 수령에 실패했습니다.' })
    }
  }

  async function handleCollectAll(targets?: Position[]) {
    if (!walletAddress) return handleConnect()
    if (!data) return
    if (!summary?.writesEnabled || data?.summary.mode === 'demo') {
      setTransaction({ status: 'error', message: '데모 모드에서는 수수료 수령을 실행하지 않습니다.' })
      return
    }
    try {
      for (const position of targets || data.positions) {
        if (position.farmStaked && position.poolAddress.toLowerCase() !== summary.address.toLowerCase()) continue
        setTransaction({ status: 'simulating', message: `#${position.tokenId.toString()} 수수료 수령을 준비하는 중…` })
        const hash = position.farmStaked
          ? await collectStakedPancakePosition(summary, position, walletAddress)
          : await collectPosition(position.tokenId, walletAddress)
        setTransaction({ status: 'pending', message: `#${position.tokenId.toString()} 수수료 수령 확인 중…`, hash })
        await waitForReceipt(hash)
      }
      setTransaction({ status: 'success', message: '모든 포지션의 미수령 수수료를 수령했습니다.' })
      await refresh()
      await rewards.refresh()
    } catch (cause) {
      setTransaction({ status: 'error', message: cause instanceof Error ? cause.message : '전체 수수료 수령에 실패했습니다.' })
    }
  }

  async function handleDecrease(position: Position) {
    if (!walletAddress) return handleConnect()
    if (!summary?.writesEnabled || data?.summary.mode === 'demo') {
      setTransaction({ status: 'error', message: '데모 모드에서는 유동성 회수를 실행하지 않습니다.' })
      return
    }
    if (position.farmStaked) {
      setTransaction({ status: 'error', message: 'Farm에 스테이킹된 LP는 먼저 Unstake한 뒤 회수하세요.' })
      return
    }
    try {
      setTransaction({ status: 'simulating', message: `#${position.tokenId.toString()} 유동성 회수를 준비하는 중…` })
      const hash = await decreasePosition(position.tokenId, position.liquidity, walletAddress)
      setTransaction({ status: 'pending', message: '유동성 회수 트랜잭션 확인 중…', hash })
      await waitForReceipt(hash)
      setTransaction({ status: 'success', message: '유동성을 회수했습니다. 수수료는 별도로 collect하세요.', hash })
      await refresh()
    } catch (cause) {
      setTransaction({ status: 'error', message: cause instanceof Error ? cause.message : '유동성 회수에 실패했습니다.' })
    }
  }

  async function handleStake(position: Position) {
    if (!walletAddress) return handleConnect()
    if (!summary || position.poolAddress.toLowerCase() !== summary.address.toLowerCase()) {
      setTransaction({ status: 'error', message: '스테이킹할 포지션의 풀을 먼저 선택하세요.' })
      return
    }
    try {
      setTransaction({ status: 'simulating', message: `#${position.tokenId.toString()} Farm 계약과 소유권을 다시 검증하는 중…` })
      const hash = await stakePancakePosition(summary, position, walletAddress)
      setTransaction({ status: 'pending', message: 'LP NFT 스테이킹 트랜잭션 확인 중…', hash })
      await waitForReceipt(hash)
      setTransaction({ status: 'success', message: 'PancakeSwap V3 Farm 스테이킹이 완료되었습니다.', hash })
      await refresh()
      await rewards.refresh()
    } catch (cause) {
      setTransaction({ status: 'error', message: cause instanceof Error ? cause.message : 'Farm 스테이킹에 실패했습니다.' })
    }
  }

  async function handleHarvest(position: Position) {
    if (!walletAddress) return handleConnect()
    if (!summary || position.poolAddress.toLowerCase() !== summary.address.toLowerCase()) {
      setTransaction({ status: 'error', message: '수확할 포지션의 풀을 먼저 선택하세요.' })
      return
    }
    try {
      setTransaction({ status: 'simulating', message: `#${position.tokenId.toString()} CAKE 보상을 검증하는 중…` })
      const hash = await harvestPancakePosition(summary, position, walletAddress)
      setTransaction({ status: 'pending', message: 'CAKE 수확 트랜잭션 확인 중…', hash })
      await waitForReceipt(hash)
      setTransaction({ status: 'success', message: 'CAKE 보상을 수령했습니다.', hash })
      await rewards.refresh()
    } catch (cause) {
      setTransaction({ status: 'error', message: cause instanceof Error ? cause.message : 'CAKE 수확에 실패했습니다.' })
    }
  }

  async function handleUnstake(position: Position) {
    if (!walletAddress) return handleConnect()
    if (!summary || position.poolAddress.toLowerCase() !== summary.address.toLowerCase()) {
      setTransaction({ status: 'error', message: '언스테이킹할 포지션의 풀을 먼저 선택하세요.' })
      return
    }
    try {
      setTransaction({ status: 'simulating', message: `#${position.tokenId.toString()} Farm 소유권과 수령 주소를 검증하는 중…` })
      const hash = await unstakePancakePosition(summary, position, walletAddress)
      setTransaction({ status: 'pending', message: 'LP NFT 언스테이킹 트랜잭션 확인 중…', hash })
      await waitForReceipt(hash)
      setTransaction({ status: 'success', message: 'LP NFT와 남은 CAKE가 지갑으로 반환되었습니다.', hash })
      await refresh()
      await rewards.refresh()
    } catch (cause) {
      setTransaction({ status: 'error', message: cause instanceof Error ? cause.message : 'Farm 언스테이킹에 실패했습니다.' })
    }
  }

  async function handleMerklClaim() {
    if (!walletAddress) return handleConnect()
    try {
      setTransaction({ status: 'simulating', message: 'Merkl 증명과 온체인 청구 상태를 다시 검증하는 중…' })
      const hash = await claimMerklRewards(walletAddress)
      setTransaction({ status: 'pending', message: 'Merkl 보상 청구 트랜잭션 확인 중…', hash })
      await waitForReceipt(hash)
      setTransaction({ status: 'success', message: 'Merkl 보상을 수령했습니다.', hash })
      await rewards.refresh()
    } catch (cause) {
      setTransaction({ status: 'error', message: cause instanceof Error ? cause.message : 'Merkl 보상 청구에 실패했습니다.' })
    }
  }

  if (page === 'robinhood') {
    return <><RobinhoodStrategyPage data={robinhood.data} loading={robinhood.loading} refreshing={robinhood.refreshing} error={robinhood.error} walletAddress={robinhoodWallet} onConnect={handleRobinhoodConnect} onRefresh={robinhood.refresh} onBack={closeRobinhood} oracleTransaction={robinhoodOracleTransaction} onPrepareOracle={handlePrepareRobinhoodOracle} /><WalletPicker open={walletTarget != null} onClose={() => setWalletTarget(null)} onSelect={kind => { void connectSelectedWallet(kind) }} /></>
  }

  if (!data || !summary || !baseToken || !quoteToken) {
    return <div className="loading-screen"><div className="loading-spinner" /><strong>bStocker를 준비하는 중…</strong><span>풀 상태와 가격 범위를 불러오고 있습니다.</span></div>
  }

  const poolSwitching = loading && summary.address.toLowerCase() !== selectedPool.poolAddress.toLowerCase()

  return (
    <div className="app-shell">
      <button type="button" className={`directory-backdrop ${directoryOpen ? 'visible' : ''}`} onClick={() => setDirectoryOpen(false)} aria-label="풀 디렉터리 닫기" />
      <div className={`terminal-layout ${directoryOpen ? 'directory-open' : 'directory-collapsed'}`}>
        <PoolDirectory
          entries={directoryEntries}
          metadata={directory.data}
          selectedAddress={selectedPool.poolAddress}
          loading={directory.loading}
          refreshing={directory.refreshing}
          error={directory.error}
          open={directoryOpen}
          onClose={() => setDirectoryOpen(false)}
          onSelect={handlePoolSelect}
          onRefresh={directory.refresh}
        />
        <div className="terminal-main">
          <PoolHeader summary={summary} walletAddress={walletAddress} onConnect={handleConnect} onRefresh={refresh} refreshing={refreshing} onToggleDirectory={() => setDirectoryOpen(value => !value)} directoryCount={directory.data?.total || directoryEntries.length} onOpenStrategy={openRobinhood} />
          <div className="mode-strip">
            <div><span className={`mode-dot ${summary.mode}`} />{summary.mode === 'demo' ? 'DEMO PREVIEW' : 'LIVE READ MODE'}<span className="mode-copy">{summary.mode === 'demo' ? '실제 주소를 설정하면 BSC 데이터로 전환됩니다.' : `block ${summary.sourceBlock?.toString() || '—'} · ${relativeTime(summary.lastUpdated)}`}</span></div>
            <div className="mode-actions"><span>Market: {summary.marketStatus || 'unavailable'}</span><span>RPC: {summary.mode === 'live' ? 'connected' : 'mock'}</span></div>
          </div>
          {transaction.status === 'error' && transaction.message && <div className="global-error wallet-error">{transaction.message}</div>}
          {error && <div className="global-error">데이터를 갱신하지 못했습니다: {error}</div>}
          <div className="workspace-grid">
            {poolSwitching && <div className="pool-switching-overlay"><div className="loading-spinner" /><strong>{selectedPool.label}</strong><span>검증된 온체인 데이터를 불러오는 중…</span></div>}
            <main className="market-panel">
              <div className="chart-toolbar"><div className="chart-tabs"><span className="section-label">PRICE &amp; RANGE</span>{timeframes.map(item => <button type="button" key={item} className={timeframe === item ? 'active' : ''} onClick={() => setTimeframe(item)}>{item}</button>)}</div><button type="button" className="underlying-button" onClick={() => refresh()}>↻ Yahoo underlying USD · {summary.underlyingStatus === 'fresh' ? 'fresh' : 'unavailable'}</button><span className="chart-disclaimer">기초자산 USD 기준 · 풀 가격은 온체인 기준</span></div>
              <div className="chart-alert-row"><div className="chart-alert"><span>신규 포지션 범위 · 드래그 가능</span><strong>{formatNumber(minPrice, 4)} — {formatNumber(maxPrice, 4)} {summary.displayQuote.symbol}</strong><small>현재 multiplier 적용 UI price</small></div><div className="chart-alert muted"><span>보유 포지션 범위</span><strong>{currentPairPositions.length ? `${currentPairPositions.length}개 position · ${formatNumber(Math.min(...currentPairPositions.map(p => p.minPrice)), 2)} — ${formatNumber(Math.max(...currentPairPositions.map(p => p.maxPrice)), 2)}` : '지갑 연결 필요'}</strong><small>차트 오버레이는 현재 풀 position 기준</small></div></div>
              <PriceChart candles={data.candles} currentPrice={summary.displayPrice} minPrice={minPrice} maxPrice={maxPrice} setMinPrice={setMinPrice} setMaxPrice={setMaxPrice} positions={currentPairPositions} symbol={summary.displayBase.symbol} />
              <LiquidityChart bins={data.liquidity} currentPrice={summary.displayPrice} minPrice={minPrice} maxPrice={maxPrice} setMinPrice={setMinPrice} setMaxPrice={setMaxPrice} belowSymbol={summary.displayQuote.symbol} aboveSymbol={summary.displayBase.symbol} />
            </main>
            <PositionPanel
          summary={summary}
          baseToken={baseToken}
          quoteToken={quoteToken}
          baseAmount={baseAmount}
          quoteAmount={quoteAmount}
          setBaseAmount={handleBaseAmountChange}
          setQuoteAmount={handleQuoteAmountChange}
          minPrice={minPrice}
          maxPrice={maxPrice}
          setMinPrice={setMinPrice}
          setMaxPrice={setMaxPrice}
          autoFill={autoFill}
          setAutoFill={setAutoFill}
          zap={zap}
          setZap={setZap}
          zapQuote={zapQuote}
          zapQuoteLoading={zapQuoteLoading}
          zapQuoteError={zapQuoteError}
          slippage={slippage}
          setSlippage={setSlippage}
          simulation={simulation}
          transaction={transaction}
          walletAddress={walletAddress}
          onConnect={handleConnect}
          onCreate={handleCreate}
          onPreset={handlePreset}
            />
          </div>
          <RewardsPanel rewards={rewards.data} loading={rewards.loading} error={rewards.error} walletAddress={walletAddress} transaction={transaction} onClaimMerkl={handleMerklClaim} onRefresh={rewards.refresh} />
          <PositionsTable positions={data.positions} selectedPoolAddress={summary.address} walletAddress={walletAddress} onCollect={handleCollect} onCollectAll={handleCollectAll} onDecrease={handleDecrease} onStake={handleStake} onHarvest={handleHarvest} onUnstake={handleUnstake} rewards={rewards.data} transaction={transaction} token0Symbol={summary.token0.symbol} token1Symbol={summary.token1.symbol} rangeQuoteSymbol={summary.displayQuote.symbol} />
          <footer className="app-footer"><span>bStocker · {summary.mode === 'demo' ? 'demo data only' : `source block ${summary.sourceBlock?.toString() || '—'}`}</span><span>Fee APR is an estimate · Range risk applies · BNB gas required</span><span>{summary.mode === 'live' || isLiveConfig ? `pool ${shortAddress(summary.address)}` : 'Select a verified pool'}</span></footer>
        </div>
      </div>
      <WalletPicker open={walletTarget != null} onClose={() => setWalletTarget(null)} onSelect={kind => { void connectSelectedWallet(kind) }} />
    </div>
  )
}

async function waitForReceipt(hash: `0x${string}`) {
  await getPublicClient().waitForTransactionReceipt({ hash })
}

export default App
