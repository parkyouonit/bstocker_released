import { isAddress, type Address, type Hex } from 'viem'
import { APP_CONFIG } from '../config'

export type BridgeBackendKind = 'stargate-v1' | 'layerzero-value-transfer'

export interface BridgeBackendToken {
  chainKey: string
  address: string
  decimals: number
  symbol: string
  name: string
  isBridgeable?: boolean
  priceUsd?: number
}

export interface BridgeTransaction {
  to: Address
  data: Hex
  value: string
  from?: Address
  chainId?: number
  gasLimit?: string
}

export interface BridgeBackendStep {
  type: 'TRANSACTION' | 'SIGNATURE'
  description: string
  chainKey: string
  chainId?: number
  signerAddress?: Address
  transaction?: BridgeTransaction
}

export interface BridgeBackendQuote {
  backend: BridgeBackendKind
  id?: string
  route: string
  srcChainKey: string
  dstChainKey: string
  srcToken: string
  dstToken: string
  srcAmount: string
  dstAmount: string
  dstAmountMin: string
  feeUsd?: string
  feePercent?: string
  durationSeconds?: number
  allowance?: string
  dstNativeAmount?: string
  fees: Array<Record<string, unknown>>
  steps: BridgeBackendStep[]
  rejected?: string[]
}

export interface BridgeBackendInfo {
  quoteBackend: BridgeBackendKind
  discoveryBackend: BridgeBackendKind
  valueTransferApiConfigured: boolean
  legacyApiAvailable: boolean
}

export interface BridgeBackendChain {
  key: string
  name: string
  shortName?: string
  eid: number
  chainId: number
  nativeSymbol?: string
  nativeDecimals?: number
  rpcUrl?: string
  rpcUrls?: string[]
  explorerUrl?: string
}

export interface BridgeTransactionStatus {
  txHash: string
  status: string
  indexed: boolean
  srcEid?: number
  dstEid?: number
  srcTxHash?: string
  dstTxHash?: string
  createdAt?: string
  updatedAt?: string
}

export interface BridgeBackendQuoteInput {
  srcChainKey: string
  dstChainKey: string
  srcToken: string
  dstToken: string
  srcAddress: Address
  dstAddress: Address
  srcAmount: string
  dstAmountMin: string
  slippagePercent: number
}

const BRIDGE_API_BASE = APP_CONFIG.bridgeApiUrl || '/api/bridge'

async function bridgeFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BRIDGE_API_BASE}${path}`, {
    ...init,
    headers: {
      accept: 'application/json',
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...init?.headers,
    },
  })
  const body = await response.json().catch(() => ({})) as { error?: string } & T
  if (!response.ok) throw new Error(body.error || `브릿지 서버 응답 오류 (${response.status})`)
  return body
}

export async function getBridgeBackendInfo(): Promise<BridgeBackendInfo> {
  return bridgeFetch<BridgeBackendInfo>('/backend')
}

export async function fetchBridgeChains(): Promise<{ source: string; chains: BridgeBackendChain[] }> {
  return bridgeFetch('/chains')
}

export async function fetchBridgeTokens({
  srcChainKey,
  srcToken,
}: {
  srcChainKey: string
  srcToken: string
}): Promise<{ backend: BridgeBackendKind; tokens: BridgeBackendToken[] }> {
  const params = new URLSearchParams({ srcChainKey, srcToken })
  return bridgeFetch(`/tokens?${params.toString()}`)
}

export async function requestBridgeQuote(input: BridgeBackendQuoteInput): Promise<BridgeBackendQuote> {
  return bridgeFetch<BridgeBackendQuote>('/quote', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export async function getBridgeStatus(quoteId: string, txHash?: string): Promise<Record<string, unknown>> {
  const suffix = txHash ? `?txHash=${encodeURIComponent(txHash)}` : ''
  return bridgeFetch(`/status/${encodeURIComponent(quoteId)}${suffix}`)
}

export async function fetchBridgeTransactionStatus(txHash: string): Promise<BridgeTransactionStatus> {
  return bridgeFetch(`/tx/${encodeURIComponent(txHash)}`)
}

export function isNativeBridgeToken(address: string): boolean {
  return address.toLowerCase() === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
}

export function isBridgeTransaction(value: unknown): value is BridgeTransaction {
  if (!value || typeof value !== 'object') return false
  const transaction = value as Partial<BridgeTransaction>
  return Boolean(
    typeof transaction.to === 'string' && isAddress(transaction.to) &&
    typeof transaction.data === 'string' && transaction.data.startsWith('0x') &&
    typeof transaction.value === 'string',
  )
}
