import { useEffect, useMemo, useRef, useState } from 'react'
import { formatUnits, parseUnits, type Address } from 'viem'
import { APP_CONFIG } from '../config'
import { BRIDGE_CHAINS, DEFAULT_BRIDGE_FROM, DEFAULT_BRIDGE_TO, getBridgeChain, installBridgeChains, type BridgeChainConfig, type BridgeChainKey } from '../bridge'
import { VERIFIED_BRIDGE_DEPLOYMENTS } from '../bridgeAssets'
import {
  connectBridgeWallet,
  isValidBridgeAddress,
  layerZeroScanUrl,
  quoteBridgeTransfer,
  readBridgeTokenInfo,
  sendBridgeTransfer,
  sendStargateBackendTransfer,
  type BridgeQuote,
  type BridgeTokenInfo,
} from '../lib/bridgeAdapter'
import {
  fetchBridgeTokens,
  fetchBridgeChains,
  fetchBridgeTransactionStatus,
  getBridgeBackendInfo,
  requestBridgeQuote,
  type BridgeBackendInfo,
  type BridgeBackendQuote,
  type BridgeBackendToken,
  type BridgeTransactionStatus,
} from '../lib/stargateBackend'
import {
  findBridgeMetadata,
  loadBridgeMetadata,
  relatedBridgeDeployments,
  type BridgeMetadataRow,
} from '../lib/bridgeMetadata'
import { shortAddress } from '../lib/format'
import { walletErrorMessage } from '../lib/wallet'

type BridgeStatus = 'idle' | 'detecting' | 'discovering' | 'quoting' | 'sending' | 'success' | 'error'

interface BridgeHistoryItem {
  hash: string
  fromChainKey: string
  fromChainName: string
  toChainKey: string
  toChainName: string
  tokenSymbol: string
  amount: string
  sender: string
  recipient: string
  submittedAt: number
  status: string
  statusUpdatedAt?: string
  destinationHash?: string
}

interface BridgePageProps {
  walletAddress?: Address
  onWalletConnected: (address: Address) => void
  onBack?: () => void
}

const BRIDGE_METADATA: BridgeMetadataRow[] = [...VERIFIED_BRIDGE_DEPLOYMENTS]
const BRIDGE_HISTORY_KEY = 'bstocker-bridge-history:v1'
const FINAL_HISTORY_STATUSES = new Set(['DELIVERED', 'FAILED', 'BLOCKED'])

function loadBridgeHistory(): BridgeHistoryItem[] {
  if (typeof window === 'undefined') return []
  try {
    const value = JSON.parse(window.localStorage.getItem(BRIDGE_HISTORY_KEY) || '[]')
    if (!Array.isArray(value)) return []
    return value.filter(item => item && typeof item === 'object' && /^0x[0-9a-fA-F]{64}$/.test(String(item.hash)))
      .slice(0, 200) as BridgeHistoryItem[]
  } catch {
    return []
  }
}

function historyStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    SUBMITTED: '제출됨', INDEXING: '인덱싱 중', INFLIGHT: '전송 중', CONFIRMING: '확정 중',
    PAYLOAD_STORED: '실행 대기', DELIVERED: '완료', FAILED: '실패', BLOCKED: '차단됨', UNKNOWN: '확인 중',
  }
  return labels[status] || status
}

function displayRawAmount(raw: string | undefined, decimals: number, fallback = '0.00'): string {
  if (!raw || !/^\d+$/.test(raw)) return fallback
  try {
    const value = formatUnits(BigInt(raw), decimals)
    return Number(value).toLocaleString('en-US', { maximumFractionDigits: 6 })
  } catch {
    return fallback
  }
}

function routeTime(seconds: number | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return '—'
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))}s`
  return `${Math.round(seconds / 60)}m`
}

export function BridgePage({ walletAddress, onWalletConnected, onBack }: BridgePageProps) {
  const [fromChainKey, setFromChainKey] = useState<BridgeChainKey>(DEFAULT_BRIDGE_FROM)
  const [toChainKey, setToChainKey] = useState<BridgeChainKey>(DEFAULT_BRIDGE_TO)
  const [chainCatalog, setChainCatalog] = useState<BridgeChainConfig[]>(() => [...BRIDGE_CHAINS])
  const [chainStatus, setChainStatus] = useState(`${BRIDGE_CHAINS.length} chains · RPC 자동 연결`)
  const [metadataSearch, setMetadataSearch] = useState('')
  const [remoteMetadata, setRemoteMetadata] = useState<BridgeMetadataRow[]>([])
  const [metadataStatus, setMetadataStatus] = useState('metadata 연결 중…')
  const [backendInfo, setBackendInfo] = useState<BridgeBackendInfo>()
  const [backendTokens, setBackendTokens] = useState<BridgeBackendToken[]>([])
  const [backendStatus, setBackendStatus] = useState('Direct OFT 우선 · route backend 준비 중…')
  const [transferMode, setTransferMode] = useState<'direct' | 'route'>('direct')
  const [tokenAddress, setTokenAddress] = useState('')
  const [tokenSymbol, setTokenSymbol] = useState('')
  const [oftAddress, setOftAddress] = useState('')
  const [customRpc, setCustomRpc] = useState('')
  const [destinationCustomRpc, setDestinationCustomRpc] = useState('')
  const [sourceAddress, setSourceAddress] = useState(walletAddress || '')
  const [recipient, setRecipient] = useState('')
  const [customRecipient, setCustomRecipient] = useState(false)
  const [amount, setAmount] = useState('')
  const [decimals, setDecimals] = useState('18')
  const [slippage, setSlippage] = useState('0.5')
  const [lzReceiveEnabled, setLzReceiveEnabled] = useState(true)
  const [gasLimit, setGasLimit] = useState('80000')
  const [nativeDropEnabled, setNativeDropEnabled] = useState(false)
  const [nativeDropAmount, setNativeDropAmount] = useState('')
  const [tokenInfo, setTokenInfo] = useState<BridgeTokenInfo>()
  const [backendQuote, setBackendQuote] = useState<BridgeBackendQuote>()
  const [directQuote, setDirectQuote] = useState<BridgeQuote>()
  const [status, setStatus] = useState<BridgeStatus>('idle')
  const [statusMessage, setStatusMessage] = useState('')
  const [txHash, setTxHash] = useState('')
  const [assetFinderOpen, setAssetFinderOpen] = useState(false)
  const [assetPickerTarget, setAssetPickerTarget] = useState<'source' | 'destination' | null>(null)
  const [chainPickerTarget, setChainPickerTarget] = useState<'source' | 'destination' | null>(null)
  const [chainSearch, setChainSearch] = useState('')
  const [selectedAssetGroup, setSelectedAssetGroup] = useState('')
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [trackingHash, setTrackingHash] = useState('')
  const [transactionHistory, setTransactionHistory] = useState<BridgeHistoryItem[]>(loadBridgeHistory)
  const [historyRefreshing, setHistoryRefreshing] = useState(false)
  const detectRequestRef = useRef(0)

  const fromChain = getBridgeChain(fromChainKey)
  const toChain = getBridgeChain(toChainKey)
  const resolvedRecipient = (customRecipient ? recipient : sourceAddress).trim()
  const quote = backendQuote || directQuote
  const busy = status === 'detecting' || status === 'discovering' || status === 'quoting' || status === 'sending'
  const routeApiAvailable = Boolean(backendInfo?.valueTransferApiConfigured || backendInfo?.legacyApiAvailable)
  const backendLabel = transferMode === 'direct'
    ? 'Direct contract · quoteSend'
    : routeApiAvailable
      ? backendInfo?.quoteBackend === 'layerzero-value-transfer' ? 'LayerZero Value Transfer API' : 'Stargate route API'
      : 'Route quote API key required'
  const destinationToken = backendTokens.find(item => item.chainKey === toChainKey && item.isBridgeable !== false)
  const destinationSymbol = destinationToken?.symbol || tokenSymbol || ''
  const destinationLabel = destinationSymbol || 'Select destination'
  const destinationDecimals = destinationToken?.decimals ?? Number(decimals)
  const pendingHistoryKey = useMemo(() => transactionHistory
    .filter(item => !FINAL_HISTORY_STATUSES.has(item.status))
    .map(item => item.hash.toLowerCase())
    .join('|'), [transactionHistory])

  const allMetadata = useMemo(() => {
    const seen = new Set<string>()
    return [...BRIDGE_METADATA, ...remoteMetadata].filter(row => {
      const key = `${row.chainKey}:${row.address.toLowerCase()}:${row.innerTokenAddress?.toLowerCase() || ''}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }, [remoteMetadata])

  const metadataResults = useMemo(() => {
    const query = metadataSearch.trim().toLowerCase()
    if (!query) return []
    return findBridgeMetadata(allMetadata, query).slice(0, 40)
  }, [allMetadata, metadataSearch])

  const chainResults = useMemo(() => {
    const query = chainSearch.trim().toLowerCase()
    return chainCatalog
      .filter(chain => chain.key !== (chainPickerTarget === 'source' ? toChainKey : fromChainKey))
      .filter(chain => !query || `${chain.name} ${chain.shortName} ${chain.key} ${chain.eid} ${chain.chainId}`.toLowerCase().includes(query))
  }, [chainCatalog, chainPickerTarget, chainSearch, fromChainKey, toChainKey])

  const pickerResults = useMemo(() => {
    if (assetPickerTarget === 'destination') {
      const related = allMetadata.filter(row => row.group === selectedAssetGroup && row.chainKey !== fromChainKey)
      const query = metadataSearch.trim()
      const destinations = related.length || !isValidBridgeAddress(tokenAddress)
        ? related
        : chainCatalog.filter(chain => chain.key !== fromChainKey).map(chain => ({
          source: 'local' as const,
          group: selectedAssetGroup,
          symbol: tokenSymbol || 'TOKEN',
          name: chain.name,
          chainKey: chain.key,
          type: 'CHAIN',
          address: tokenAddress as Address,
        } as BridgeMetadataRow))
      return (query ? findBridgeMetadata(destinations, query) : destinations)
        .filter(row => chainCatalog.some(chain => chain.key === row.chainKey))
        .slice(0, 40)
    }
    return metadataResults.filter(row => chainCatalog.some(chain => chain.key === row.chainKey)).slice(0, 40)
  }, [allMetadata, assetPickerTarget, chainCatalog, fromChainKey, metadataResults, metadataSearch, selectedAssetGroup, tokenAddress, tokenSymbol])

  useEffect(() => {
    let active = true
    Promise.allSettled([loadBridgeMetadata(), getBridgeBackendInfo(), fetchBridgeChains()]).then(([metadataResult, backendResult, chainResult]) => {
      if (!active) return
      if (metadataResult.status === 'fulfilled') {
        setRemoteMetadata(metadataResult.value.rows)
        setMetadataStatus(`metadata ${metadataResult.value.rows.length}개 · snapshot/activity 자동 갱신`)
      } else {
        setMetadataStatus('metadata 원본 연결 실패 · RPC 감지로 계속')
      }
      if (backendResult.status === 'fulfilled') {
        setBackendInfo(backendResult.value)
        const routeReady = backendResult.value.valueTransferApiConfigured || backendResult.value.legacyApiAvailable
        setBackendStatus(routeReady
          ? `Direct OFT 우선 · ${backendResult.value.quoteBackend === 'layerzero-value-transfer' ? 'Value Transfer' : 'Stargate'} route 연결됨`
          : 'Direct OFT 연결됨 · Route quote API 키 없음')
      } else {
        setBackendStatus('route backend 연결 대기 중')
      }
      if (chainResult.status === 'fulfilled' && chainResult.value.chains.length) {
        const installed = installBridgeChains(chainResult.value.chains)
        setChainCatalog(installed)
        setChainStatus(`${installed.length} chains · ${installed.filter(chain => chain.rpcUrls.length).length} RPC 자동 연결`)
      } else {
        setChainStatus(`${BRIDGE_CHAINS.length} fallback chains · RPC 자동 연결`)
      }
    })
    return () => { active = false }
  }, [])

  useEffect(() => {
    try {
      setCustomRpc(window.localStorage.getItem(`bstocker-bridge-rpc:${fromChainKey}`) || '')
    } catch { setCustomRpc('') }
  }, [fromChainKey])

  useEffect(() => {
    try {
      setDestinationCustomRpc(window.localStorage.getItem(`bstocker-bridge-rpc:${toChainKey}`) || '')
    } catch { setDestinationCustomRpc('') }
  }, [toChainKey])

  function updateCustomRpc(value: string, chainKey: BridgeChainKey, destination = false) {
    if (destination) setDestinationCustomRpc(value)
    else setCustomRpc(value)
    try {
      if (value.trim()) window.localStorage.setItem(`bstocker-bridge-rpc:${chainKey}`, value.trim())
      else window.localStorage.removeItem(`bstocker-bridge-rpc:${chainKey}`)
    } catch { /* private browsing can disable storage */ }
    clearQuote()
  }

  useEffect(() => {
    if (walletAddress) {
      setSourceAddress(walletAddress)
      if (!customRecipient) setRecipient(walletAddress)
    }
  }, [customRecipient, walletAddress])

  useEffect(() => {
    try { window.localStorage.setItem(BRIDGE_HISTORY_KEY, JSON.stringify(transactionHistory.slice(0, 200))) } catch { /* storage unavailable */ }
  }, [transactionHistory])

  useEffect(() => {
    if (!pendingHistoryKey) return
    const hashes = pendingHistoryKey.split('|')
    void refreshHistoryItems(hashes)
    const timer = window.setInterval(() => { void refreshHistoryItems(hashes) }, 30_000)
    return () => window.clearInterval(timer)
  }, [pendingHistoryKey])

  function clearQuote() {
    setBackendQuote(undefined)
    setDirectQuote(undefined)
    if (status === 'success' || status === 'error') setStatus('idle')
    setStatusMessage('')
  }

  function rememberTransaction(hash: string) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) return
    setTransactionHistory(current => {
      const existing = current.find(item => item.hash.toLowerCase() === hash.toLowerCase())
      if (existing) return [existing, ...current.filter(item => item !== existing)]
      return [{
        hash,
        fromChainKey,
        fromChainName: fromChain.name,
        toChainKey,
        toChainName: toChain.name,
        tokenSymbol: tokenSymbol || 'TOKEN',
        amount: amount || '—',
        sender: sourceAddress,
        recipient: resolvedRecipient,
        submittedAt: Date.now(),
        status: 'SUBMITTED',
      }, ...current].slice(0, 200)
    })
  }

  async function refreshHistoryItems(hashes?: string[]) {
    const targets = (hashes?.length ? hashes : transactionHistory.map(item => item.hash))
      .filter((hash, index, values) => values.indexOf(hash) === index)
      .slice(0, 40)
    if (!targets.length) return
    setHistoryRefreshing(true)
    try {
      const results = await Promise.allSettled(targets.map(async hash => ({
        hash: hash.toLowerCase(),
        value: await fetchBridgeTransactionStatus(hash),
      })))
      const updates = new Map<string, BridgeTransactionStatus>()
      results.forEach(result => { if (result.status === 'fulfilled') updates.set(result.value.hash, result.value.value) })
      if (!updates.size) return
      setTransactionHistory(current => current.map(item => {
        const update = updates.get(item.hash.toLowerCase())
        if (!update) return item
        const sourceEid = update.srcEid && update.srcEid < 30_000 ? update.srcEid + 30_000 : update.srcEid
        const destinationEid = update.dstEid && update.dstEid < 30_000 ? update.dstEid + 30_000 : update.dstEid
        const detectedSource = chainCatalog.find(chain => chain.eid === sourceEid)
        const detectedDestination = chainCatalog.find(chain => chain.eid === destinationEid)
        return {
          ...item,
          fromChainKey: detectedSource?.key || item.fromChainKey,
          fromChainName: detectedSource?.name || item.fromChainName,
          toChainKey: detectedDestination?.key || item.toChainKey,
          toChainName: detectedDestination?.name || item.toChainName,
          status: update.status || item.status,
          statusUpdatedAt: update.updatedAt || item.statusUpdatedAt,
          destinationHash: update.dstTxHash || item.destinationHash,
        }
      }))
    } finally {
      setHistoryRefreshing(false)
    }
  }

  async function handleConnect() {
    setStatus('detecting')
    setStatusMessage(`${fromChain.name} 지갑 연결과 네트워크를 확인하는 중…`)
    try {
      const address = await connectBridgeWallet(fromChainKey)
      onWalletConnected(address)
      setSourceAddress(address)
      if (!customRecipient) setRecipient(address)
      setStatus('idle')
      setStatusMessage(`${fromChain.name} 지갑 연결 완료 · ${shortAddress(address)}`)
    } catch (cause) {
      setStatus('error')
      setStatusMessage(walletErrorMessage(cause))
    }
  }

  async function discoverRoutes(sourceTokenAddress: string, sourceChain = fromChainKey) {
    if (!isValidBridgeAddress(sourceTokenAddress)) return []
    setStatus('discovering')
    setBackendStatus(`${fromChain.name} → 지원 토큰 경로를 찾는 중…`)
    try {
      const result = await fetchBridgeTokens({ srcChainKey: sourceChain, srcToken: sourceTokenAddress })
      setBackendTokens(result.tokens)
      const destination = result.tokens.find(item => item.chainKey === toChainKey && item.isBridgeable !== false)
      if (destination) {
        setBackendStatus(`${result.tokens.length}개 destination · ${toChain.name} 경로 확인`)
      } else {
        setBackendStatus(`${result.tokens.length}개 destination · ${toChain.name} 경로 없음`)
      }
      return result.tokens
    } catch (cause) {
      setBackendTokens([])
      setBackendStatus('route discovery 실패 · quote에서 다시 확인')
      throw cause
    } finally {
      setStatus(current => current === 'discovering' ? 'idle' : current)
    }
  }

  async function handleDetect(silent = false) {
    const requestId = ++detectRequestRef.current
    const rawTokenAddress = tokenAddress.trim()
    if (!isValidBridgeAddress(rawTokenAddress)) {
      if (!silent) {
        setStatus('error')
        setStatusMessage('토큰 주소를 올바르게 입력하세요.')
      }
      return
    }
    const selectedMatch = findBridgeMetadata(allMetadata, rawTokenAddress, fromChainKey)[0]
    const anyChainMatch = selectedMatch || findBridgeMetadata(allMetadata, rawTokenAddress)[0]
    const metadataIsDeployment = Boolean(anyChainMatch && anyChainMatch.source !== 'local')
    const effectiveFromKey = anyChainMatch && chainCatalog.some(chain => chain.key === anyChainMatch.chainKey)
      ? anyChainMatch.chainKey as BridgeChainKey
      : fromChainKey
    const effectiveFromChain = getBridgeChain(effectiveFromKey)
    const resolvedTokenAddress = metadataIsDeployment
      ? anyChainMatch?.innerTokenAddress || anyChainMatch.address
      : rawTokenAddress
    const resolvedOftAddress = metadataIsDeployment ? anyChainMatch?.address : undefined
    if (effectiveFromKey !== fromChainKey) {
      setFromChainKey(effectiveFromKey)
      clearQuote()
    }
    if (metadataIsDeployment && anyChainMatch) {
      setSelectedAssetGroup(anyChainMatch.group)
      setTokenAddress(resolvedTokenAddress)
      setOftAddress(anyChainMatch.address)
      setTokenSymbol(anyChainMatch.symbol)
      if (anyChainMatch.localDecimals != null) setDecimals(String(anyChainMatch.localDecimals))
      const destination = relatedBridgeDeployments(allMetadata, anyChainMatch)
        .find(row => row.chainKey !== effectiveFromKey && chainCatalog.some(chain => chain.key === row.chainKey))
      if (destination) setToChainKey(destination.chainKey as BridgeChainKey)
    }
    if (!silent) {
      setStatus('detecting')
      setStatusMessage(`${effectiveFromChain.name} RPC와 metadata에서 토큰 정보를 읽는 중…`)
    }
    try {
      const detectedChainKey = effectiveFromKey
      let info: BridgeTokenInfo
      if (metadataIsDeployment) {
        info = await readBridgeTokenInfo({
          chainKey: effectiveFromKey,
          tokenAddress: resolvedTokenAddress,
          owner: isValidBridgeAddress(sourceAddress) ? sourceAddress : undefined,
          oftAddress: resolvedOftAddress,
          customRpc,
        })
      } else {
        info = await readBridgeTokenInfo({
          chainKey: effectiveFromKey,
          tokenAddress: rawTokenAddress,
          owner: isValidBridgeAddress(sourceAddress) ? sourceAddress : undefined,
          customRpc,
        })
      }
      if (requestId !== detectRequestRef.current) return
      if (detectedChainKey !== fromChainKey) setFromChainKey(detectedChainKey)
      setTokenInfo(info)
      setTokenAddress(info.address)
      setTokenSymbol(info.symbol)
      setDecimals(String(info.decimals))
      if (info.oftAddress) setOftAddress(info.oftAddress)
      if (!silent) {
        setStatus('idle')
        setStatusMessage(`${info.symbol} · ${info.decimals} decimals · ${getBridgeChain(detectedChainKey).shortName} ${info.oftAddress ? `${info.oftType} 자동 연결` : 'ERC20 감지'}`)
      }
      if (!silent) setStatusMessage(`${info.symbol} 토큰 정보와 Stargate route를 확인했습니다.`)
    } catch (cause) {
      if (requestId !== detectRequestRef.current) return
      if (metadataIsDeployment && resolvedOftAddress) {
        try {
          const fallbackInfo = await readBridgeTokenInfo({
            chainKey: effectiveFromKey,
            tokenAddress: resolvedTokenAddress,
            owner: isValidBridgeAddress(sourceAddress) ? sourceAddress : undefined,
            customRpc,
          })
          if (requestId !== detectRequestRef.current) return
          setTokenInfo(fallbackInfo)
          setTokenAddress(fallbackInfo.address)
          setTokenSymbol(fallbackInfo.symbol)
          setDecimals(String(fallbackInfo.decimals))
          if (!silent) setStatusMessage(`${fallbackInfo.symbol} 토큰 RPC 확인 완료 · Stargate route를 재검증합니다.`)
          return
        } catch { /* show the original error */ }
      }
      if (!silent) {
        setStatus('error')
        setStatusMessage(cause instanceof Error ? cause.message : '토큰 정보를 읽지 못했습니다.')
      }
    }
  }

  useEffect(() => {
    if (!isValidBridgeAddress(tokenAddress)) return
    const timer = window.setTimeout(() => { void handleDetect(true) }, 650)
    return () => window.clearTimeout(timer)
  }, [tokenAddress, fromChainKey])

  async function handleTransferMode(nextMode: 'direct' | 'route') {
    if (nextMode === 'route' && !routeApiAvailable) {
      setStatus('error')
      setStatusMessage('Stargate 일반 자산 route 견적은 LayerZero Value Transfer API 키가 필요합니다. OFT 토큰은 Direct OFT로 바로 전송할 수 있습니다.')
      return
    }
    setTransferMode(nextMode)
    clearQuote()
    if (nextMode === 'route' && isValidBridgeAddress(tokenAddress)) {
      try { await discoverRoutes(tokenAddress) } catch { /* the quote action shows the exact backend error */ }
    }
  }

  async function handleQuote() {
    if (!walletAddress) {
      await handleConnect()
      return
    }
    if (fromChainKey === toChainKey) {
      setStatus('error')
      setStatusMessage('출발 체인과 도착 체인은 달라야 합니다.')
      return
    }
    if (!isValidBridgeAddress(tokenAddress) || !isValidBridgeAddress(sourceAddress) || !isValidBridgeAddress(resolvedRecipient)) {
      setStatus('error')
      setStatusMessage('토큰 주소와 지갑 주소를 올바르게 입력하세요.')
      return
    }
    if (!amount.trim()) {
      setStatus('error')
      setStatusMessage('브릿지 수량을 입력하세요.')
      return
    }
    setStatus('quoting')
    setStatusMessage(`${backendLabel}에서 지원 경로와 수수료를 조회하는 중…`)
    try {
      const info = tokenInfo || await readBridgeTokenInfo({
        chainKey: fromChainKey,
        tokenAddress,
        owner: sourceAddress,
        oftAddress: isValidBridgeAddress(oftAddress) ? oftAddress : undefined,
        customRpc,
      })
      setTokenInfo(info)
      setTokenAddress(info.address)
      setTokenSymbol(info.symbol)
      setDecimals(String(info.decimals))
      const amountRaw = parseUnits(amount, info.decimals)
      if (amountRaw <= 0n) throw new Error('브릿지 수량을 입력하세요.')
      const slippageBps = Math.round(Math.max(0, Math.min(50, Number(slippage || 0.5))) * 100)
      const minAmountRaw = amountRaw * BigInt(10_000 - slippageBps) / 10_000n
      if (transferMode === 'direct') {
        if (!info.oftAddress) throw new Error('출발 체인에서 OFT/Adapter 컨트랙트를 찾지 못했습니다. Stargate route 모드로 전환하세요.')
        const direct = await quoteBridgeTransfer({
          fromChain,
          toChain,
          tokenAddress: info.address,
          oftAddress: info.oftAddress,
          sender: sourceAddress,
          recipient: resolvedRecipient,
          amount,
          decimals: info.decimals,
          slippagePercent: Number(slippage || 0),
          gasLimit: Math.max(1, Math.round(Number(gasLimit || 0))),
          lzReceiveEnabled,
          nativeDropEnabled: nativeDropEnabled && lzReceiveEnabled,
          nativeDropAmount,
          customRpc,
          destinationCustomRpc,
        })
        setDirectQuote(direct)
        setBackendQuote(undefined)
        setBackendStatus('Direct OFT quote 준비됨')
        setStatus('success')
        setStatusMessage('OFT 컨트랙트 quoteSend가 준비되었습니다. 전송 시 연결 지갑에서 approve/send를 직접 서명합니다.')
        return
      }
      const routes = backendTokens.length ? backendTokens : await discoverRoutes(info.address)
      const dstToken = routes.find(item => item.chainKey === toChainKey && item.isBridgeable !== false) || destinationToken
      if (!dstToken) throw new Error(`${toChain.name}에서 ${info.symbol} Stargate 지원 경로를 찾지 못했습니다.`)
      const nextQuote = await requestBridgeQuote({
        srcChainKey: fromChainKey,
        dstChainKey: toChainKey,
        srcToken: info.address,
        dstToken: dstToken.address,
        srcAddress: sourceAddress,
        dstAddress: resolvedRecipient,
        srcAmount: amountRaw.toString(),
        dstAmountMin: minAmountRaw.toString(),
        slippagePercent: Number(slippage || 0.5),
      })
      setBackendQuote(nextQuote)
      setDirectQuote(undefined)
      setBackendStatus(`${nextQuote.route} · ${nextQuote.steps.length}단계 서명 준비`)
      setStatus('success')
      setStatusMessage(`Stargate ${nextQuote.route} 견적이 준비되었습니다.`)
    } catch (cause) {
      setBackendQuote(undefined)
      if (transferMode === 'route' && isValidBridgeAddress(oftAddress)) {
        try {
          const direct = await quoteBridgeTransfer({
            fromChain,
            toChain,
            tokenAddress,
            oftAddress,
            sender: sourceAddress,
            recipient: resolvedRecipient,
            amount,
            decimals: Number(decimals),
            slippagePercent: Number(slippage || 0),
            gasLimit: Math.max(1, Math.round(Number(gasLimit || 0))),
            lzReceiveEnabled,
            nativeDropEnabled: nativeDropEnabled && lzReceiveEnabled,
            nativeDropAmount,
            customRpc,
            destinationCustomRpc,
          })
          setDirectQuote(direct)
          setStatus('success')
          setStatusMessage('Stargate 경로가 없어 직접 OFT quote로 전환했습니다.')
          return
        } catch { /* preserve the Stargate error below */ }
      }
      setDirectQuote(undefined)
      setStatus('error')
      setStatusMessage(cause instanceof Error ? cause.message : 'Stargate 견적 생성에 실패했습니다.')
    }
  }

  async function handleSend() {
    if (!quote || !isValidBridgeAddress(sourceAddress) || !isValidBridgeAddress(resolvedRecipient)) return
    if (!APP_CONFIG.enableMainnetBridge) {
      setStatus('error')
      setStatusMessage('메인넷 전송은 안전 잠금 상태입니다. 경로·수수료·서명 단계는 확인할 수 있으며, 운영 전송은 별도 활성화가 필요합니다.')
      return
    }
    setStatus('sending')
    setStatusMessage('연결한 Rabby 또는 MetaMask에서 브릿지 서명 단계를 순서대로 확인하세요…')
    try {
      if (backendQuote) {
        const hashes = await sendStargateBackendTransfer({ fromChain, sender: sourceAddress, quote: backendQuote })
        const lastHash = hashes[hashes.length - 1]
        setTxHash(lastHash)
        rememberTransaction(lastHash)
        setStatus('success')
        setStatusMessage('Stargate 출발 트랜잭션이 제출되었습니다. 상태 추적에서 진행 상황을 확인하세요.')
      } else if (directQuote && isValidBridgeAddress(tokenAddress) && isValidBridgeAddress(oftAddress)) {
        const hash = await sendBridgeTransfer({
          fromChain,
          toChain,
          tokenAddress,
          oftAddress,
          sender: sourceAddress,
          recipient: resolvedRecipient,
          amount,
          decimals: Number(decimals),
          slippagePercent: Number(slippage || 0),
          gasLimit: Math.max(1, Math.round(Number(gasLimit || 0))),
          lzReceiveEnabled,
          nativeDropEnabled: nativeDropEnabled && lzReceiveEnabled,
          nativeDropAmount,
          customRpc,
          destinationCustomRpc,
        }, directQuote)
        setTxHash(hash)
        rememberTransaction(hash)
        setStatus('success')
        setStatusMessage('출발 체인 OFT 트랜잭션이 제출되었습니다.')
      }
    } catch (cause) {
      setStatus('error')
      setStatusMessage(cause instanceof Error ? cause.message : '브릿지 전송에 실패했습니다.')
    }
  }

  function handleManualAddressSelect() {
    const address = metadataSearch.trim()
    if (!isValidBridgeAddress(address)) return
    detectRequestRef.current += 1
    setTokenAddress(address)
    setTokenSymbol('TOKEN')
    setOftAddress('')
    setSelectedAssetGroup(`custom:${address.toLowerCase()}`)
    setTokenInfo(undefined)
    setBackendTokens([])
    setAssetPickerTarget(null)
    setAssetFinderOpen(false)
    clearQuote()
  }

  function handleAssetSelect(asset: BridgeMetadataRow, target: 'source' | 'destination' = assetPickerTarget || 'source') {
    if (target === 'destination') {
      if (asset.group !== selectedAssetGroup) return
      const destinationChain = chainCatalog.find(chain => chain.key === asset.chainKey)
      if (!destinationChain || destinationChain.key === fromChainKey) return
      setToChainKey(destinationChain.key)
      setAssetPickerTarget(null)
      setAssetFinderOpen(false)
      clearQuote()
      return
    }
    detectRequestRef.current += 1
    const isDeployment = asset.source !== 'local'
    const sourceChain = chainCatalog.find(chain => chain.key === asset.chainKey)
    if (isDeployment && !sourceChain) return
    if (sourceChain) setFromChainKey(sourceChain.key)
    setTokenAddress(isDeployment ? asset.innerTokenAddress || asset.address : asset.address)
    setOftAddress(isDeployment ? asset.address : '')
    setTokenSymbol(asset.symbol)
    setSelectedAssetGroup(asset.group)
    setTokenInfo(undefined)
    setBackendTokens([])
    if (asset.localDecimals != null) setDecimals(String(asset.localDecimals))
    const destination = relatedBridgeDeployments(allMetadata, asset)
      .find(row => row.chainKey !== asset.chainKey && chainCatalog.some(chain => chain.key === row.chainKey))
    if (destination) setToChainKey(destination.chainKey as BridgeChainKey)
    setAssetFinderOpen(false)
    setAssetPickerTarget(null)
    clearQuote()
  }

  function handleChainSelect(chain: BridgeChainConfig) {
    const target = chainPickerTarget || 'destination'
    setChainPickerTarget(null)
    setChainSearch('')
    if (target === 'destination') {
      if (chain.key === fromChainKey) return
      setToChainKey(chain.key)
      clearQuote()
      setStatusMessage(chain.rpcUrls.length
        ? `${chain.name} 도착 체인을 선택했습니다.`
        : `${chain.name}을 선택했습니다. 견적 검증에는 Advanced Settings의 목적지 RPC가 필요합니다.`)
      return
    }
    if (chain.key === toChainKey) return
    const matchingDeployment = allMetadata.find(row => row.group === selectedAssetGroup && row.chainKey === chain.key)
    if (matchingDeployment) {
      handleAssetSelect(matchingDeployment, 'source')
      return
    }
    setFromChainKey(chain.key)
    detectRequestRef.current += 1
    setTokenAddress('')
    setTokenSymbol('')
    setOftAddress('')
    setSelectedAssetGroup('')
    setTokenInfo(undefined)
    setBackendTokens([])
    clearQuote()
    setStatusMessage(`${chain.name} 출발 체인을 선택했습니다. 이 체인의 토큰 또는 OFT 주소를 검색하세요.`)
  }

  function handleSwap() {
    const destinationDeployment = allMetadata.find(row => row.group === selectedAssetGroup && row.chainKey === toChainKey)
    if (destinationDeployment) {
      handleAssetSelect(destinationDeployment, 'source')
      return
    }
    clearQuote()
    const nextFrom = toChainKey
    setToChainKey(fromChainKey)
    setFromChainKey(nextFrom)
    setCustomRpc(destinationCustomRpc)
    setDestinationCustomRpc(customRpc)
    if (directQuote?.destinationOft) {
      setTokenAddress(directQuote.destinationOft)
      setOftAddress(directQuote.destinationOft)
      setTokenInfo(undefined)
    } else if (tokenAddress) {
      setTokenAddress('')
      setTokenSymbol('')
      setOftAddress('')
      setSelectedAssetGroup('')
      setTokenInfo(undefined)
      setBackendTokens([])
      setStatusMessage('체인을 뒤집었습니다. 새 출발 체인의 토큰을 검색하세요.')
    }
  }

  function handleTrack() {
    if (!/^0x[0-9a-fA-F]{64}$/.test(trackingHash.trim())) {
      setStatus('error')
      setStatusMessage('64자리 트랜잭션 해시를 입력하세요.')
      return
    }
    rememberTransaction(trackingHash.trim())
    void refreshHistoryItems([trackingHash.trim()])
    setStatus('success')
    setStatusMessage('LayerZero Scan 상태를 조회하고 전송 내역에 저장했습니다.')
  }

  const sourceBalance = tokenInfo?.balanceUi || '0'
  const destinationAmount = backendQuote
    ? displayRawAmount(backendQuote.dstAmount, destinationDecimals)
    : directQuote?.minAmountUi || '0.00'
  const minimumAmount = backendQuote
    ? displayRawAmount(backendQuote.dstAmountMin, destinationDecimals)
    : directQuote?.minAmountUi || '—'
  const quoteFee = backendQuote?.feeUsd ? `$${backendQuote.feeUsd}` : directQuote ? `${formatUnits(directQuote.nativeFee, 18)} ${fromChain.nativeSymbol}` : '—'
  const canSendCurrentQuote = APP_CONFIG.enableMainnetBridge && Boolean(quote)

  return (
    <div className="bridge-page">
      <div className="bridge-starfield" aria-hidden="true" />
      <header className="bridge-page-header">
        <div className="bridge-page-brand">{onBack && <button type="button" className="bridge-back-button" onClick={onBack}>←</button>}<div className="bridge-logo-mark">✦</div><div className="brand-mark">Bridge<span>·</span></div><span className="bridge-page-slash">OFT</span></div>
        <div className="bridge-page-actions"><button type="button" className="bridge-settings-link" onClick={() => setAdvancedOpen(value => !value)}>⚙ Advanced Settings</button><span className="network-pill">{fromChain.shortName}</span><button type="button" className="wallet-button bridge-wallet-button" onClick={handleConnect}>{walletAddress ? shortAddress(walletAddress) : 'Connect Wallet'}</button></div>
      </header>

      <main className="bridge-content">
        <div className="bridge-heading"><div><span className="section-label">LAYERZERO · CROSS-CHAIN TRANSFER</span><h1>Bridge</h1><p>토큰을 검색하고 OFT 컨트랙트를 직접 호출합니다. 필요한 경우 Stargate route를 사용합니다.</p></div><div className="bridge-live-chip"><span />{backendStatus}</div></div>

        <div className="bridge-transfer-mode"><button type="button" className="active">⇄ Transfer</button><button type="button" onClick={handleSwap}>⇅ Swap chains</button></div>

        <section className="bridge-transfer-stack">
          <div className="bridge-transfer-card">
            <div className="bridge-card-topline"><span className="bridge-connection-state"><i />{walletAddress ? 'Connected' : 'Not connected'}</span><button type="button" className="bridge-chain-open" onClick={() => { setChainSearch(''); setChainPickerTarget('source') }}>FROM · {fromChain.shortName} · eid {fromChain.eid} ⌄</button></div>
            <button type="button" className="bridge-token-selector" onClick={() => { setMetadataSearch(''); setAssetPickerTarget('source') }}><span className="bridge-token-icon source">{tokenSymbol.slice(0, 2) || '—'}</span><span className="bridge-token-copy"><strong>{tokenSymbol || 'Select asset'}</strong><small>{fromChain.name}</small></span><span className="bridge-token-chevron">⌄</span></button>
            <div className="bridge-amount-row"><input aria-label="출발 수량" type="number" min="0" step="any" value={amount} onChange={event => { setAmount(event.target.value); clearQuote() }} placeholder="0.00" /><div className="bridge-amount-actions"><button type="button" onClick={() => { const balance = Number(sourceBalance); setAmount(Number.isFinite(balance) ? (balance * 0.5).toString() : '') }}>½</button><button type="button" onClick={() => setAmount(sourceBalance)}>Max</button></div></div>
            <div className="bridge-balance-row"><span>Balance: {sourceBalance} {tokenSymbol}</span><span>{amount ? `${amount} ${tokenSymbol}` : '—'}</span></div>
          </div>

          <button type="button" className="bridge-swap-button bridge-swap-overlay" onClick={handleSwap} aria-label="출발 도착 체인 바꾸기">⇅</button>

          <div className="bridge-transfer-card destination">
            <div className="bridge-card-topline"><span className="bridge-connection-state"><i />{walletAddress ? 'Connected' : 'Not connected'}</span><label className="bridge-custom-toggle"><span>Custom Address</span><input type="checkbox" checked={customRecipient} onChange={event => { setCustomRecipient(event.target.checked); clearQuote() }} /><i /></label></div>
            <button type="button" className="bridge-token-selector" onClick={() => { setChainSearch(''); setChainPickerTarget('destination') }}><span className="bridge-token-icon destination">{destinationSymbol.slice(0, 2) || '—'}</span><span className="bridge-token-copy"><strong>{destinationLabel}</strong><small>{toChain.name} · eid {toChain.eid}</small></span><span className="bridge-token-chevron">⌄</span></button>
            <div className="bridge-amount-row"><input aria-label="도착 예상 수량" readOnly value={destinationAmount} placeholder="0.00" /><span className="bridge-output-note">EST.</span></div>
            <div className="bridge-balance-row"><span>Min: {minimumAmount} {destinationSymbol}</span><span>{backendQuote ? 'Quote ready' : '—'}</span></div>
            {customRecipient && <input className="bridge-recipient-inline" aria-label="커스텀 수신 주소" value={recipient} onChange={event => { setRecipient(event.target.value); clearQuote() }} placeholder="0x… 수신 주소" />}
          </div>
        </section>

        {!walletAddress ? <button type="button" className="bridge-primary-cta" onClick={handleConnect} disabled={busy}>Connect Wallet <span>✦</span></button> : <button type="button" className="bridge-primary-cta" onClick={quote ? handleSend : handleQuote} disabled={busy || (Boolean(quote) && !canSendCurrentQuote)}>{busy ? 'Preparing quote…' : quote ? (canSendCurrentQuote ? `Bridge ${tokenSymbol || 'token'}` : 'Write locked') : transferMode === 'direct' ? 'Quote OFT contract' : 'Get route quote'} <span>✦</span></button>}

        {statusMessage && <div className={`bridge-status-message ${status === 'error' ? 'error' : status === 'sending' || status === 'quoting' || status === 'detecting' || status === 'discovering' ? 'pending' : ''}`}>{statusMessage}</div>}

        <section className="bridge-route-summary">
          <div className="bridge-route-summary-head"><div><span className="section-label">ROUTE PREVIEW</span><strong>{backendQuote?.route || (directQuote ? 'Direct OFT' : 'Select an asset and amount')}</strong></div><span className="bridge-backend-badge">{backendLabel}</span></div>
          <div className="bridge-route-metrics"><div><span>ROUTE</span><strong>{backendQuote?.route || (directQuote ? 'OFT' : '—')}</strong></div><div><span>TOTAL FEE</span><strong>{quoteFee}</strong></div><div><span>TIME</span><strong>{routeTime(backendQuote?.durationSeconds)}</strong></div><div><span>STEPS</span><strong>{backendQuote ? `${backendQuote.steps.length} sign` : '—'}</strong></div></div>
          {backendQuote && <details className="bridge-quote-details"><summary>Quote details</summary><code>{JSON.stringify({ id: backendQuote.id, src: backendQuote.srcAmount, dst: backendQuote.dstAmount, dstMin: backendQuote.dstAmountMin, route: backendQuote.route, steps: backendQuote.steps.map(step => ({ type: step.type, description: step.description, chainKey: step.chainKey, to: step.transaction?.to })) }, null, 2)}</code></details>}
          {txHash && <div className="bridge-tx-success">출발 트랜잭션 <a href={layerZeroScanUrl(txHash)} target="_blank" rel="noreferrer">{shortAddress(txHash)} · LayerZero Scan ↗</a></div>}
        </section>

        {advancedOpen && <section className="bridge-advanced-drawer"><div className="bridge-section-title"><span>ADVANCED SETTINGS</span><small>route parameter override</small></div><div className="bridge-advanced-grid"><div><label htmlFor="bridge-token-address">Source token address</label><div className="bridge-input-action compact"><input id="bridge-token-address" aria-label="브릿지 토큰 주소" value={tokenAddress} onChange={event => { detectRequestRef.current += 1; setTokenAddress(event.target.value); setTokenInfo(undefined); setBackendTokens([]); clearQuote() }} placeholder="0x…" /><button type="button" onClick={() => { void handleDetect() }} disabled={busy}>Detect</button></div></div><div><label htmlFor="bridge-oft-address">OFT / Adapter (optional)</label><input id="bridge-oft-address" value={oftAddress} onChange={event => { setOftAddress(event.target.value); clearQuote() }} placeholder="0x…" /></div><div><label htmlFor="bridge-source-address">Source wallet</label><input id="bridge-source-address" value={sourceAddress} onChange={event => setSourceAddress(event.target.value)} placeholder="0x…" /></div><div><label htmlFor="bridge-recipient-address">Recipient</label><input id="bridge-recipient-address" value={recipient} onChange={event => { setRecipient(event.target.value); setCustomRecipient(true); clearQuote() }} placeholder="0x…" /></div><div><label htmlFor="bridge-custom-rpc">Source RPC · {fromChain.shortName}</label><input id="bridge-custom-rpc" value={customRpc} onChange={event => updateCustomRpc(event.target.value, fromChainKey)} placeholder={fromChain.rpcUrl || 'https://…'} /></div><div><label htmlFor="bridge-destination-rpc">Destination RPC · {toChain.shortName}</label><input id="bridge-destination-rpc" value={destinationCustomRpc} onChange={event => updateCustomRpc(event.target.value, toChainKey, true)} placeholder={toChain.rpcUrl || 'https://…'} /></div><div><label htmlFor="bridge-decimals">Decimals</label><input id="bridge-decimals" type="number" min="0" max="36" value={decimals} onChange={event => { setDecimals(event.target.value); clearQuote() }} /></div><div><label htmlFor="bridge-slippage">Slippage %</label><input id="bridge-slippage" type="number" min="0" max="50" step="0.1" value={slippage} onChange={event => { setSlippage(event.target.value); clearQuote() }} /></div><div><label htmlFor="bridge-gas-limit">LZ receive gas</label><input id="bridge-gas-limit" type="number" min="1" value={gasLimit} onChange={event => { setGasLimit(event.target.value); clearQuote() }} /></div></div><div className="bridge-advanced-toggles"><label><input type="checkbox" checked={lzReceiveEnabled} onChange={event => { setLzReceiveEnabled(event.target.checked); clearQuote() }} /> LZ_RECEIVE options</label><label><input type="checkbox" checked={nativeDropEnabled} onChange={event => { setNativeDropEnabled(event.target.checked); clearQuote() }} /> Destination gas drop</label>{nativeDropEnabled && <input aria-label="목적지 네이티브 가스 드롭" value={nativeDropAmount} onChange={event => { setNativeDropAmount(event.target.value); clearQuote() }} placeholder={`0.001 ${toChain.nativeSymbol}`} />}</div></section>}

        <section className="bridge-finder-panel">
          <div className="bridge-finder-heading"><div><span className="section-label">LAYERZERO OFT FINDER</span><strong>Supported routes</strong><p>기본은 OFT 컨트랙트 직접 실행이며, 일반 Stargate 지원 자산은 route API를 보조로 사용합니다.</p></div><div className="bridge-finder-tabs"><button type="button" className={transferMode === 'direct' ? 'active' : ''} onClick={() => { void handleTransferMode('direct') }}>Direct OFT</button><button type="button" className={transferMode === 'route' ? 'active' : ''} onClick={() => { void handleTransferMode('route') }} disabled={!routeApiAvailable}>Stargate Route</button></div></div>
          <div className="bridge-finder-meta"><span>{metadataStatus}</span><span>{chainStatus}</span><span>{backendStatus}</span><button type="button" onClick={() => setAssetFinderOpen(value => !value)}>{assetFinderOpen ? 'Hide assets' : 'Find asset'}</button></div>
          {assetFinderOpen && <div className="bridge-finder-search"><input aria-label="브릿지 자산 검색" value={metadataSearch} onChange={event => setMetadataSearch(event.target.value)} placeholder="심볼, 이름 또는 0x 컨트랙트 주소" /><div className="bridge-metadata-results">{metadataResults.length ? metadataResults.map(asset => { const supported = chainCatalog.some(chain => chain.key === asset.chainKey); return <button type="button" className="bridge-metadata-item" key={`${asset.chainKey}:${asset.address}:${asset.innerTokenAddress || ''}`} onClick={() => handleAssetSelect(asset)} disabled={!supported}><span><strong>{asset.symbol}</strong><small>{asset.name} · {asset.chainKey} · {asset.type}</small></span><code>{shortAddress(asset.address)}</code><em>{supported ? (asset.source === 'activity' ? 'activity' : asset.source === 'metadata' ? 'deployment' : 'custom') : 'unsupported chain'}</em></button> }) : <div className="bridge-empty">{metadataSearch.trim() ? '메타데이터 결과가 없습니다. 컨트랙트 주소라면 자동 감지를 사용할 수 있습니다.' : '토큰 심볼·이름·컨트랙트 주소를 검색하세요.'}</div>}</div></div>}
        </section>

        <section className="bridge-history-panel"><div className="bridge-history-head"><div><span className="section-label">TRANSACTION HISTORY</span><strong>브릿지 전송 내역</strong><small>완료된 내역도 이 브라우저에 계속 저장됩니다.</small></div><button type="button" onClick={() => { void refreshHistoryItems() }} disabled={historyRefreshing || !transactionHistory.length}>{historyRefreshing ? '확인 중…' : '상태 새로고침'}</button></div>{transactionHistory.length ? <div className="bridge-history-list">{transactionHistory.map(item => <article className="bridge-history-item" key={item.hash}><div className="bridge-history-route"><span className={`bridge-history-status ${item.status.toLowerCase()}`}>{historyStatusLabel(item.status)}</span><strong>{item.fromChainName} <i>→</i> {item.toChainName}</strong><small>{item.amount} {item.tokenSymbol}</small></div><div className="bridge-history-meta"><span>{new Date(item.submittedAt).toLocaleString('ko-KR')}</span>{item.sender && <span>{shortAddress(item.sender)} → {item.recipient ? shortAddress(item.recipient) : '—'}</span>}</div><div className="bridge-history-links"><a href={layerZeroScanUrl(item.hash)} target="_blank" rel="noreferrer">{shortAddress(item.hash)} · LayerZero Scan ↗</a>{item.destinationHash && <span>도착 tx {shortAddress(item.destinationHash)}</span>}</div></article>)}</div> : <div className="bridge-history-empty">아직 저장된 브릿지 전송 내역이 없습니다. 전송하거나 아래에 기존 tx hash를 입력하면 자동으로 남습니다.</div>}</section>

        <section className="bridge-tracker-panel"><div className="bridge-section-title"><span>TRANSACTION STATUS</span><small>LayerZero Scan · 기존 tx도 내역에 저장</small></div><div className="bridge-input-action"><input aria-label="LayerZero 트랜잭션 해시" value={trackingHash} onChange={event => setTrackingHash(event.target.value)} placeholder="0x transaction hash" /><button type="button" onClick={handleTrack}>Track & Save</button></div>{trackingHash && /^0x[0-9a-fA-F]{64}$/.test(trackingHash) && <a className="bridge-scan-link" href={layerZeroScanUrl(trackingHash)} target="_blank" rel="noreferrer">Open LayerZero Scan ↗</a>}</section>

        {!APP_CONFIG.enableMainnetBridge && <div className="bridge-lock-note"><strong>MAINNET WRITE LOCKED</strong><span>메인넷 전송 잠금이 켜져 있습니다.</span></div>}
      </main>
      {chainPickerTarget && <div className="bridge-picker-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setChainPickerTarget(null) }}><section className="bridge-asset-picker bridge-chain-picker" role="dialog" aria-modal="true" aria-label={chainPickerTarget === 'source' ? '출발 체인 선택' : '도착 체인 선택'}><div className="bridge-picker-head"><div><span className="section-label">{chainPickerTarget === 'source' ? 'FROM CHAIN' : 'TO CHAIN'}</span><strong>체인 검색 및 선택</strong><small>{chainStatus}</small></div><button type="button" aria-label="체인 선택 닫기" onClick={() => setChainPickerTarget(null)}>×</button></div><input autoFocus aria-label="체인 검색" value={chainSearch} onChange={event => setChainSearch(event.target.value)} placeholder="체인 이름, key, EID 또는 chain ID" /><div className="bridge-picker-list">{chainResults.length ? chainResults.map(chain => <button type="button" className="bridge-picker-item bridge-chain-item" key={`chain:${chain.key}`} onClick={() => handleChainSelect(chain)}><span className="bridge-token-icon destination">{chain.shortName.slice(0, 2)}</span><span><strong>{chain.name}</strong><small>{chain.key} · chain {chain.chainId}</small><code>LayerZero eid {chain.eid}</code></span><em className={chain.rpcUrls.length ? '' : 'warning'}>{chain.rpcUrls.length ? 'RPC AUTO' : 'CUSTOM RPC'}</em></button>) : <div className="bridge-empty">검색 결과가 없습니다.</div>}</div></section></div>}
      {assetPickerTarget && <div className="bridge-picker-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setAssetPickerTarget(null) }}><section className="bridge-asset-picker" role="dialog" aria-modal="true" aria-label={assetPickerTarget === 'source' ? '출발 토큰 선택' : '도착 토큰 선택'}><div className="bridge-picker-head"><div><span className="section-label">{assetPickerTarget === 'source' ? 'FROM ASSET' : 'TO CHAIN'}</span><strong>{assetPickerTarget === 'source' ? '검색해서 토큰 선택' : '도착 체인 선택'}</strong></div><button type="button" aria-label="토큰 선택 닫기" onClick={() => setAssetPickerTarget(null)}>×</button></div><input autoFocus aria-label="토큰 선택 검색" value={metadataSearch} onChange={event => setMetadataSearch(event.target.value)} placeholder={assetPickerTarget === 'source' ? '심볼, 이름 또는 0x 컨트랙트 주소' : '체인 검색'} /><div className="bridge-picker-list">{pickerResults.length ? pickerResults.map(asset => <button type="button" className="bridge-picker-item" key={`picker:${asset.group}:${asset.chainKey}:${asset.address}`} onClick={() => handleAssetSelect(asset, assetPickerTarget)}><span className={`bridge-token-icon ${assetPickerTarget === 'destination' ? 'destination' : 'source'}`}>{asset.symbol.slice(0, 2)}</span><span><strong>{asset.symbol}</strong><small>{asset.name} · {getBridgeChain(asset.chainKey as BridgeChainKey).name}</small><code>{shortAddress(asset.innerTokenAddress || asset.address)}</code></span><em>{asset.confidence === 'onchain-verified' ? 'VERIFIED' : asset.type}</em></button>) : <div className="bridge-empty">{assetPickerTarget === 'source' ? (metadataSearch.trim() ? '검색 결과가 없습니다. 주소를 입력했다면 아래 자동 감지를 사용하세요.' : '기본 목록 없이 검색으로 토큰을 선택합니다.') : '먼저 출발 토큰을 선택하세요.'}</div>}</div>{assetPickerTarget === 'source' && isValidBridgeAddress(metadataSearch.trim()) && <button type="button" className="bridge-picker-detect" onClick={handleManualAddressSelect}>이 컨트랙트 주소 자동 감지</button>}<button type="button" className="bridge-picker-manual" onClick={() => { setAssetPickerTarget(null); setAdvancedOpen(true) }}>Advanced Settings에서 직접 입력</button></section></div>}
      <footer className="bridge-page-footer"><span>LayerZero OFT Bridge</span><span>{fromChain.shortName} → {toChain.shortName}</span><span>Non-custodial · Rabby / MetaMask</span></footer>
    </div>
  )
}
