import type { Address } from 'viem'
import type { BridgeChainKey } from './bridge'
import type { BridgeMetadataRow } from './lib/bridgeMetadata'

export const DOS_BSC_OFT = '0xB0f09ea9ae0515C3551080D4a745C8115aA30e37' as Address
export const DOS_ETHEREUM_TOKEN = '0x951f086A127e280724fD93CcC543f65065afEb5E' as Address
export const DOS_ETHEREUM_ADAPTER = DOS_BSC_OFT
export const DOS_BRIDGE_GROUP = 'verified:DOS:layerzero-v2'

// Verified on-chain on 2026-08-11: both contracts use Endpoint V2, sharedDecimals=6,
// and their BSC/Ethereum peers point back to one another. No other configured peer exists.
export const VERIFIED_BRIDGE_DEPLOYMENTS: readonly BridgeMetadataRow[] = [
  {
    source: 'metadata',
    group: DOS_BRIDGE_GROUP,
    symbol: 'DOS',
    name: 'DAPPOS',
    chainKey: 'bsc',
    type: 'OFT',
    address: DOS_BSC_OFT,
    innerTokenAddress: DOS_BSC_OFT,
    localDecimals: 18,
    sharedDecimals: 6,
    approvalRequired: false,
    confidence: 'onchain-verified',
  },
  {
    source: 'metadata',
    group: DOS_BRIDGE_GROUP,
    symbol: 'DOS',
    name: 'DAPPOS',
    chainKey: 'ethereum',
    type: 'OFT_ADAPTER',
    address: DOS_ETHEREUM_ADAPTER,
    innerTokenAddress: DOS_ETHEREUM_TOKEN,
    localDecimals: 18,
    sharedDecimals: 6,
    approvalRequired: true,
    confidence: 'onchain-verified',
  },
]

export function verifiedBridgeDeployment(group: string, chainKey: BridgeChainKey): BridgeMetadataRow | undefined {
  return VERIFIED_BRIDGE_DEPLOYMENTS.find(row => row.group === group && row.chainKey === chainKey)
}

export function isVerifiedBridgeWriteRoute(input: {
  fromChainKey: BridgeChainKey
  toChainKey: BridgeChainKey
  tokenAddress: string
  oftAddress: string
}): boolean {
  const source = verifiedBridgeDeployment(DOS_BRIDGE_GROUP, input.fromChainKey)
  const destination = verifiedBridgeDeployment(DOS_BRIDGE_GROUP, input.toChainKey)
  if (!source || !destination || input.fromChainKey === input.toChainKey) return false
  const expectedToken = (source.innerTokenAddress || source.address).toLowerCase()
  return input.tokenAddress.toLowerCase() === expectedToken && input.oftAddress.toLowerCase() === source.address.toLowerCase()
}
