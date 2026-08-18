import type { Address } from 'viem'
import type { PoolDirectoryEntry } from './types'

export interface PoolPreset {
  id: string
  label: string
  description: string
  poolAddress: Address
  token0Address: Address
  token1Address: Address
  token0Symbol: string
  token1Symbol: string
  token0Decimals: number
  token1Decimals: number
  feeTier: number
  officialUrl: string
  dexId?: string
  verified?: boolean
  logoUrl?: string
}

const USDT = '0x55d398326f99059fF775485246999027B3197955' as Address

function pancakePoolUrl(address: string): string {
  return `https://pancakeswap.finance/liquidity/pool/bsc/${address}?chainName=bsc&id=${address}&chain=bsc`
}

export const BSTOCK_POOL_PRESETS: PoolPreset[] = [
  {
    id: 'spcxb-usdt-025',
    label: 'SPCXB/USDT',
    description: 'SpaceX bStock',
    poolAddress: '0x977DaFFC095b33872E2741c19568925015C35b4d' as Address,
    token0Address: USDT,
    token1Address: '0xbe9d156892e55e7154bcd3cb0fea677f9d3103e1' as Address,
    token0Symbol: 'USDT',
    token1Symbol: 'SPCXB',
    token0Decimals: 18,
    token1Decimals: 18,
    feeTier: 2500,
    officialUrl: pancakePoolUrl('0x977DaFFC095b33872E2741c19568925015C35b4d'),
  },
  {
    id: 'gmeb-usdt-025',
    label: 'GMEB/USDT',
    description: 'GameStop bStock',
    poolAddress: '0x908d49048EB3a7bEdfd238972403842805EAF2bE' as Address,
    token0Address: '0x46cEeFDa28Dd7207059ed19B0acdc026955bb15C' as Address,
    token1Address: USDT,
    token0Symbol: 'GMEB',
    token1Symbol: 'USDT',
    token0Decimals: 18,
    token1Decimals: 18,
    feeTier: 2500,
    officialUrl: pancakePoolUrl('0x908d49048EB3a7bEdfd238972403842805EAF2bE'),
    verified: true,
  },
  {
    id: 'skhyb-usdt-025',
    label: 'SKHYB/USDT',
    description: 'SK Hynix bStock',
    poolAddress: '0xD7d30F434b12F7Ed9b0Ae11fF1C754745a10aD52' as Address,
    token0Address: USDT,
    token1Address: '0xca750ef65f295bbecd685abf54e82caf297bdb61' as Address,
    token0Symbol: 'USDT',
    token1Symbol: 'SKHYB',
    token0Decimals: 18,
    token1Decimals: 18,
    feeTier: 2500,
    officialUrl: pancakePoolUrl('0xD7d30F434b12F7Ed9b0Ae11fF1C754745a10aD52'),
  },
  {
    id: 'mub-usdt-025',
    label: 'MUB/USDT',
    description: 'Micron bStock',
    poolAddress: '0x9E75Ced0a01590890917C5180c3e3ed6a86A071e' as Address,
    token0Address: USDT,
    token1Address: '0xcdf2f3e0fa43c47a6662a91c9e4a7c5f69762699' as Address,
    token0Symbol: 'USDT',
    token1Symbol: 'MUB',
    token0Decimals: 18,
    token1Decimals: 18,
    feeTier: 2500,
    officialUrl: pancakePoolUrl('0x9E75Ced0a01590890917C5180c3e3ed6a86A071e'),
  },
  {
    id: 'spyb-usdt-001',
    label: 'SPYB/USDT',
    description: 'SPY bStock',
    poolAddress: '0x7aA6d92Fc369A8C1EDc631A3aAc44eFB0808ddbF' as Address,
    token0Address: USDT,
    token1Address: '0x7138b48df7d98d7e3cc221bfe7192d0a178182d8' as Address,
    token0Symbol: 'USDT',
    token1Symbol: 'SPYB',
    token0Decimals: 18,
    token1Decimals: 18,
    feeTier: 100,
    officialUrl: pancakePoolUrl('0x7aA6d92Fc369A8C1EDc631A3aAc44eFB0808ddbF'),
  },
  {
    id: 'qqqb-usdt-001',
    label: 'QQQB/USDT',
    description: 'Nasdaq-100 bStock · 0.01%',
    poolAddress: '0xe531fcb1F5a195de7608B9F4f9518544C2cdB693' as Address,
    token0Address: '0x205812cdbed920aff76c6580abd681a46d11efc7' as Address,
    token1Address: USDT,
    token0Symbol: 'QQQB',
    token1Symbol: 'USDT',
    token0Decimals: 18,
    token1Decimals: 18,
    feeTier: 100,
    officialUrl: pancakePoolUrl('0xe531fcb1F5a195de7608B9F4f9518544C2cdB693'),
  },
  {
    id: 'qqqb-usdt-005',
    label: 'QQQB/USDT',
    description: 'Nasdaq-100 bStock · 0.05%',
    poolAddress: '0x7C84F9943Ec82cf2233c97A7Ee417f18bD2eC295' as Address,
    token0Address: '0x205812cdbed920aff76c6580abd681a46d11efc7' as Address,
    token1Address: USDT,
    token0Symbol: 'QQQB',
    token1Symbol: 'USDT',
    token0Decimals: 18,
    token1Decimals: 18,
    feeTier: 500,
    officialUrl: pancakePoolUrl('0x7C84F9943Ec82cf2233c97A7Ee417f18bD2eC295'),
  },
]

export const DEFAULT_POOL_ID = 'spcxb-usdt-025'

export const BSTOCK_DIRECTORY_FALLBACKS: PoolDirectoryEntry[] = BSTOCK_POOL_PRESETS.map(pool => {
  const token0IsUsdt = pool.token0Address.toLowerCase() === USDT.toLowerCase()
  const stockAddress = token0IsUsdt ? pool.token1Address : pool.token0Address
  const stockSymbol = token0IsUsdt ? pool.token1Symbol : pool.token0Symbol
  return {
    id: pool.id,
    address: pool.poolAddress,
    dexId: 'pancakeswap-v3-bsc',
    dexLabel: 'Pancake V3',
    label: pool.label,
    description: pool.description,
    token0Address: pool.token0Address,
    token1Address: pool.token1Address,
    token0Symbol: pool.token0Symbol,
    token1Symbol: pool.token1Symbol,
    token0Decimals: pool.token0Decimals,
    token1Decimals: pool.token1Decimals,
    stockAddress,
    stockSymbol,
    stockName: pool.description,
    quoteAddress: USDT,
    quoteSymbol: 'USDT',
    feeTier: pool.feeTier,
    feeTierLabel: `${(pool.feeTier / 10000).toFixed(pool.feeTier % 10000 === 0 ? 0 : 2)}%`,
    tickSpacing: 0,
    tvlUsd: null,
    volume24hUsd: null,
    fees24hUsd: null,
    feeApr: null,
    priceUsd: null,
    priceChange24h: null,
    activeLiquidity: '0',
    currentTick: 0,
    poolCreatedAt: null,
    verified: true,
    marketStatus: 'unavailable',
    warnings: ['MARKET_DATA_UNAVAILABLE'],
    source: 'configured fallback',
    lastUpdated: Date.now(),
  }
})

export function findPoolPreset(id: string): PoolPreset {
  return BSTOCK_POOL_PRESETS.find(pool => pool.id === id) || BSTOCK_POOL_PRESETS[0]
}

export function poolPresetFromDirectory(entry: PoolDirectoryEntry): PoolPreset {
  return {
    id: entry.id,
    label: entry.label,
    description: entry.description,
    poolAddress: entry.address,
    token0Address: entry.token0Address,
    token1Address: entry.token1Address,
    token0Symbol: entry.token0Symbol,
    token1Symbol: entry.token1Symbol,
    token0Decimals: entry.token0Decimals,
    token1Decimals: entry.token1Decimals,
    feeTier: entry.feeTier,
    officialUrl: pancakePoolUrl(entry.address),
    dexId: entry.dexId,
    verified: entry.verified,
    logoUrl: entry.logoUrl,
  }
}
