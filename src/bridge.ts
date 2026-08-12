import type { Chain } from 'viem'
import { arbitrum, avalanche, base, bsc, mainnet, optimism, polygon } from 'viem/chains'
import { APP_CONFIG } from './config'

export type BridgeChainKey = string

export interface BridgeChainConfig {
  key: BridgeChainKey
  name: string
  shortName: string
  eid: number
  chainId: number
  nativeSymbol: string
  nativeDecimals: number
  rpcUrl: string
  rpcUrls: readonly string[]
  explorerUrl?: string
  viemChain: Chain
}

export interface BridgeChainWire {
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

const FALLBACK_BRIDGE_CHAINS: BridgeChainConfig[] = [
  {
    key: 'bsc', name: 'BNB Chain', shortName: 'BSC', eid: 30102, chainId: 56,
    nativeSymbol: 'BNB', nativeDecimals: 18, rpcUrl: APP_CONFIG.rpcUrl,
    rpcUrls: [APP_CONFIG.rpcUrl, 'https://bsc-rpc.publicnode.com', 'https://binance.llamarpc.com'],
    explorerUrl: 'https://bscscan.com', viemChain: bsc,
  },
  {
    key: 'ethereum', name: 'Ethereum', shortName: 'ETH', eid: 30101, chainId: 1,
    nativeSymbol: 'ETH', nativeDecimals: 18, rpcUrl: 'https://ethereum.publicnode.com',
    rpcUrls: ['https://ethereum.publicnode.com', 'https://ethereum-rpc.publicnode.com', 'https://eth.llamarpc.com'],
    explorerUrl: 'https://etherscan.io', viemChain: mainnet,
  },
  {
    key: 'arbitrum', name: 'Arbitrum', shortName: 'ARB', eid: 30110, chainId: 42161,
    nativeSymbol: 'ETH', nativeDecimals: 18, rpcUrl: 'https://arb1.arbitrum.io/rpc',
    rpcUrls: ['https://arb1.arbitrum.io/rpc', 'https://arbitrum-one-rpc.publicnode.com', 'https://arbitrum.llamarpc.com'],
    explorerUrl: 'https://arbiscan.io', viemChain: arbitrum,
  },
  {
    key: 'avalanche', name: 'Avalanche', shortName: 'AVAX', eid: 30106, chainId: 43114,
    nativeSymbol: 'AVAX', nativeDecimals: 18, rpcUrl: 'https://api.avax.network/ext/bc/C/rpc',
    rpcUrls: ['https://api.avax.network/ext/bc/C/rpc', 'https://avalanche-c-chain-rpc.publicnode.com'],
    explorerUrl: 'https://snowtrace.io', viemChain: avalanche,
  },
  {
    key: 'polygon', name: 'Polygon', shortName: 'POL', eid: 30109, chainId: 137,
    nativeSymbol: 'POL', nativeDecimals: 18, rpcUrl: 'https://polygon-bor-rpc.publicnode.com',
    rpcUrls: ['https://polygon-bor-rpc.publicnode.com', 'https://polygon.llamarpc.com'],
    explorerUrl: 'https://polygonscan.com', viemChain: polygon,
  },
  {
    key: 'base', name: 'Base', shortName: 'BASE', eid: 30184, chainId: 8453,
    nativeSymbol: 'ETH', nativeDecimals: 18, rpcUrl: 'https://base.publicnode.com',
    rpcUrls: ['https://base.publicnode.com', 'https://base-rpc.publicnode.com', 'https://base.llamarpc.com'],
    explorerUrl: 'https://basescan.org', viemChain: base,
  },
  {
    key: 'optimism', name: 'Optimism', shortName: 'OP', eid: 30111, chainId: 10,
    nativeSymbol: 'ETH', nativeDecimals: 18, rpcUrl: 'https://optimism.publicnode.com',
    rpcUrls: ['https://optimism.publicnode.com', 'https://optimism-rpc.publicnode.com', 'https://optimism.llamarpc.com'],
    explorerUrl: 'https://optimistic.etherscan.io', viemChain: optimism,
  },
]

export const BRIDGE_CHAINS: BridgeChainConfig[] = [...FALLBACK_BRIDGE_CHAINS]

export const DEFAULT_BRIDGE_FROM: BridgeChainKey = 'bsc'
export const DEFAULT_BRIDGE_TO: BridgeChainKey = 'ethereum'

function dynamicViemChain(chain: BridgeChainWire, rpcUrls: string[]): Chain {
  const nativeSymbol = chain.nativeSymbol || 'ETH'
  const explorerUrl = chain.explorerUrl
  return {
    id: chain.chainId,
    name: chain.name,
    nativeCurrency: {
      name: nativeSymbol,
      symbol: nativeSymbol,
      decimals: chain.nativeDecimals ?? 18,
    },
    rpcUrls: {
      default: { http: rpcUrls },
      public: { http: rpcUrls },
    },
    blockExplorers: explorerUrl ? {
      default: { name: `${chain.name} Explorer`, url: explorerUrl },
    } : undefined,
  }
}

export function installBridgeChains(rows: BridgeChainWire[]): BridgeChainConfig[] {
  const fallbackByKey = new Map(FALLBACK_BRIDGE_CHAINS.map(chain => [chain.key, chain]))
  const next = rows.flatMap(row => {
    if (!row.key || !Number.isInteger(row.chainId) || !Number.isInteger(row.eid)) return []
    const fallback = fallbackByKey.get(row.key)
    const rpcUrls = [...new Set([
      ...(row.rpcUrls || []),
      row.rpcUrl,
      ...(fallback?.rpcUrls || []),
    ].filter((value): value is string => Boolean(value && /^https:\/\//i.test(value))))]
    const rpcUrl = rpcUrls[0] || ''
    const config: BridgeChainConfig = {
      key: row.key,
      name: row.name || row.key,
      shortName: row.shortName || row.name?.slice(0, 5).toUpperCase() || row.key.toUpperCase(),
      eid: row.eid,
      chainId: row.chainId,
      nativeSymbol: row.nativeSymbol || fallback?.nativeSymbol || 'ETH',
      nativeDecimals: row.nativeDecimals ?? fallback?.nativeDecimals ?? 18,
      rpcUrl,
      rpcUrls,
      explorerUrl: row.explorerUrl || fallback?.explorerUrl,
      viemChain: fallback?.chainId === row.chainId
        ? fallback.viemChain
        : dynamicViemChain(row, rpcUrls),
    }
    return [config]
  }).sort((a, b) => a.name.localeCompare(b.name))

  if (!next.some(chain => chain.key === DEFAULT_BRIDGE_FROM)) next.unshift(FALLBACK_BRIDGE_CHAINS[0])
  if (!next.some(chain => chain.key === DEFAULT_BRIDGE_TO)) next.push(FALLBACK_BRIDGE_CHAINS[1])
  BRIDGE_CHAINS.splice(0, BRIDGE_CHAINS.length, ...next)
  return [...BRIDGE_CHAINS]
}

export function getBridgeChain(key: BridgeChainKey): BridgeChainConfig {
  return BRIDGE_CHAINS.find(chain => chain.key === key) || BRIDGE_CHAINS[0] || FALLBACK_BRIDGE_CHAINS[0]
}
