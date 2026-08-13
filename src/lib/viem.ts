import { bsc } from 'viem/chains'
import { createPublicClient, createWalletClient, custom, http, type Address, type PublicClient, type WalletClient } from 'viem'
import { APP_CONFIG } from '../config'
import { getActiveWalletProvider, getWalletProvider, type WalletKind, type WalletProvider } from './wallet'

let publicClient: PublicClient | undefined

export function getPublicClient(): PublicClient {
  if (!publicClient) {
    publicClient = createPublicClient({
      chain: bsc,
      transport: http(APP_CONFIG.rpcUrl, { timeout: 12_000 }),
      batch: { multicall: true },
    })
  }
  return publicClient
}

export function getWalletClient(provider?: WalletProvider): WalletClient {
  const active = provider || getActiveWalletProvider()
  if (!active) throw new Error('Web3 지갑이 설치되어 있지 않습니다.')
  return createWalletClient({
    chain: bsc,
    transport: custom(active as never),
  })
}

export async function ensureBscNetwork(provider?: WalletProvider): Promise<void> {
  const active = provider || await getWalletProvider()
  const chainId = await active.request({ method: 'eth_chainId' })
  if (String(chainId).toLowerCase() === '0x38') return
  try {
    await active.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x38' }] })
  } catch (error) {
    const code = (error as { code?: number }).code
    if (code !== 4902) throw error
    await active.request({
      method: 'wallet_addEthereumChain',
      params: [{
        chainId: '0x38',
        chainName: 'BNB Smart Chain',
        nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
        rpcUrls: [APP_CONFIG.rpcUrl],
        blockExplorerUrls: ['https://bscscan.com'],
      }],
    })
  }
}

export async function connectWallet(preferred?: WalletKind): Promise<Address> {
  const provider = await getWalletProvider(preferred)
  await ensureBscNetwork(provider)
  const walletClient = getWalletClient(provider)
  const addresses = await walletClient.requestAddresses()
  if (!addresses[0]) throw new Error('지갑 주소를 읽지 못했습니다.')
  return addresses[0]
}

export async function ensureRobinhoodNetwork(provider?: WalletProvider): Promise<void> {
  const active = provider || await getWalletProvider()
  const chainId = await active.request({ method: 'eth_chainId' })
  if (String(chainId).toLowerCase() === '0x1237') return
  try {
    await active.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x1237' }] })
  } catch (error) {
    const code = (error as { code?: number }).code
    if (code !== 4902) throw error
    await active.request({
      method: 'wallet_addEthereumChain',
      params: [{
        chainId: '0x1237',
        chainName: 'Robinhood Chain',
        nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
        rpcUrls: [import.meta.env.VITE_ROBINHOOD_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com'],
        blockExplorerUrls: ['https://robinhoodchain.blockscout.com'],
      }],
    })
  }
}

export async function connectRobinhoodWallet(preferred?: WalletKind): Promise<Address> {
  const provider = await getWalletProvider(preferred)
  await ensureRobinhoodNetwork(provider)
  const addresses = await provider.request({ method: 'eth_requestAccounts' }) as string[]
  if (!addresses?.[0]) throw new Error('지갑 주소를 읽지 못했습니다.')
  return addresses[0] as Address
}
