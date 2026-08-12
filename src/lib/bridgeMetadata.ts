import { isAddress, type Address } from 'viem'
import { APP_CONFIG } from '../config'
import type { BridgeChainKey } from '../bridge'

export type BridgeMetadataSource = 'metadata' | 'activity' | 'local'

export interface BridgeMetadataRow {
  source: BridgeMetadataSource
  group: string
  symbol: string
  name: string
  chainKey: string
  type: string
  address: Address
  innerTokenAddress?: Address
  localDecimals?: number
  sharedDecimals?: number
  approvalRequired?: boolean | null
  confidence?: string
  evidence?: { count?: number; roles?: string[] }
}

export interface BridgeMetadataSnapshot {
  rows: BridgeMetadataRow[]
  loadedFrom: string
  fetchedAt: number
}

function asAddress(value: unknown): Address | undefined {
  return typeof value === 'string' && isAddress(value) ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return value === null || value === undefined || value === '' ? undefined : Number(value)
}

export function flattenBridgeMetadata(data: unknown): BridgeMetadataRow[] {
  const rows: BridgeMetadataRow[] = []
  if (!data || typeof data !== 'object' || Array.isArray(data)) return rows
  for (const [symbol, entries0] of Object.entries(data)) {
    const entries = Array.isArray(entries0) ? entries0 : [entries0]
    entries.forEach((entry, entryIndex) => {
      if (!entry || typeof entry !== 'object') return
      const deployments = (entry as { deployments?: Record<string, unknown> }).deployments || {}
      for (const [chainKey, rawDeployment] of Object.entries(deployments)) {
        if (!rawDeployment || typeof rawDeployment !== 'object') continue
        const deployment = rawDeployment as Record<string, unknown>
        const address = asAddress(deployment.address)
        if (!address) continue
        const innerTokenAddress = asAddress(deployment.innerTokenAddress)
        rows.push({
          source: 'metadata',
          group: `${symbol}:${entryIndex}`,
          symbol,
          name: typeof (entry as Record<string, unknown>).name === 'string' ? String((entry as Record<string, unknown>).name) : symbol,
          chainKey,
          type: typeof deployment.type === 'string' ? deployment.type : 'OFT',
          address,
          innerTokenAddress,
          localDecimals: asNumber(deployment.localDecimals) ?? asNumber((entry as Record<string, unknown>).sharedDecimals),
          sharedDecimals: asNumber((entry as Record<string, unknown>).sharedDecimals),
          approvalRequired: typeof deployment.approvalRequired === 'boolean' ? deployment.approvalRequired : null,
        })
      }
    })
  }
  return rows
}

export function flattenBridgeActivity(data: unknown): BridgeMetadataRow[] {
  if (!data || typeof data !== 'object') return []
  const adapters = (data as { adapters?: unknown }).adapters
  if (!Array.isArray(adapters)) return []
  return adapters.flatMap((raw, index) => {
    if (!raw || typeof raw !== 'object') return []
    const item = raw as Record<string, unknown>
    const address = asAddress(item.adapterAddress) || asAddress(item.address)
    const innerTokenAddress = asAddress(item.tokenAddress) || asAddress(item.innerTokenAddress)
    if (!address || !innerTokenAddress) return []
    const evidence = item.evidence && typeof item.evidence === 'object' ? item.evidence as Record<string, unknown> : undefined
    return [{
      source: 'activity' as const,
      group: `activity:${index}`,
      symbol: typeof item.symbol === 'string' ? item.symbol : 'UNKNOWN',
      name: typeof item.name === 'string' ? item.name : 'LayerZero activity adapter',
      chainKey: typeof item.chainKey === 'string' ? item.chainKey : '',
      type: 'OFT_ADAPTER_ACTIVITY',
      address,
      innerTokenAddress,
      localDecimals: asNumber(item.localDecimals),
      sharedDecimals: asNumber(item.sharedDecimals),
      approvalRequired: typeof item.approvalRequired === 'boolean' ? item.approvalRequired : null,
      confidence: typeof item.confidence === 'string' ? item.confidence : 'activity-confirmed',
      evidence: evidence ? {
        count: asNumber(evidence.count),
        roles: Array.isArray(evidence.roles) ? evidence.roles.filter((role): role is string => typeof role === 'string') : undefined,
      } : undefined,
    }]
  })
}

export function findBridgeMetadata(rows: BridgeMetadataRow[], query: string, chainKey?: BridgeChainKey): BridgeMetadataRow[] {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return []
  const scoped = chainKey ? rows.filter(row => row.chainKey === chainKey) : rows
  if (isAddress(normalized)) {
    return scoped.filter(row => row.address.toLowerCase() === normalized || row.innerTokenAddress?.toLowerCase() === normalized).slice(0, 50)
  }
  const exact = scoped.filter(row => row.symbol.toLowerCase() === normalized)
  return (exact.length ? exact : scoped.filter(row => `${row.symbol} ${row.name}`.toLowerCase().includes(normalized))).slice(0, 50)
}

export function relatedBridgeDeployments(rows: BridgeMetadataRow[], row: BridgeMetadataRow): BridgeMetadataRow[] {
  return rows.filter(candidate => candidate.group === row.group)
}

export function bridgeMetadataLabel(row: BridgeMetadataRow): string {
  return `${row.symbol} · ${row.chainKey} · ${row.type}`
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { cache: 'no-store' })
  if (!response.ok) throw new Error(`metadata HTTP ${response.status}`)
  return response.json()
}

export async function loadBridgeMetadata(): Promise<BridgeMetadataSnapshot> {
  const localEndpoint = `${APP_CONFIG.apiBaseUrl}/api/bridge/metadata`
  try {
    const payload = await fetchJson(localEndpoint)
    const data = payload as { metadata?: unknown; activity?: unknown; sources?: { metadata?: string }; fetchedAt?: number }
    return {
      rows: [...flattenBridgeMetadata(data.metadata), ...flattenBridgeActivity(data.activity)],
      loadedFrom: data.sources?.metadata || localEndpoint,
      fetchedAt: data.fetchedAt || Date.now(),
    }
  } catch {
    const [metadata, activity] = await Promise.all([
      fetchJson(APP_CONFIG.bridgeMetadataUrl),
      fetchJson(APP_CONFIG.bridgeActivityUrl).catch(() => ({ adapters: [] })),
    ])
    return {
      rows: [...flattenBridgeMetadata(metadata), ...flattenBridgeActivity(activity)],
      loadedFrom: APP_CONFIG.bridgeMetadataUrl,
      fetchedAt: Date.now(),
    }
  }
}
