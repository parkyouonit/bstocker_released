export type WalletKind = 'rabby' | 'metamask'

export interface WalletProvider {
  request: (args: { method: string; params?: unknown[] | object }) => Promise<unknown>
  on?: (event: string, handler: (...args: unknown[]) => void) => void
  removeListener?: (event: string, handler: (...args: unknown[]) => void) => void
  isRabby?: boolean
  isMetaMask?: boolean
  providers?: WalletProvider[]
}

interface AnnouncedProvider {
  provider: WalletProvider
  info?: { name?: string; rdns?: string; uuid?: string; icon?: string }
}

export interface AvailableWallet {
  kind: WalletKind
  name: string
  installed: boolean
}

let activeProvider: WalletProvider | undefined
let activeKind: WalletKind | undefined
const preferenceKey = 'bstocker.wallet.preference'

function isMobileBrowser(): boolean {
  return typeof navigator !== 'undefined' && /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
}

async function discoverProviders(): Promise<AnnouncedProvider[]> {
  if (typeof window === 'undefined') return []
  const providers: AnnouncedProvider[] = []
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<AnnouncedProvider>).detail
    if (detail?.provider && !providers.some(item => item.provider === detail.provider)) providers.push(detail)
  }
  window.addEventListener('eip6963:announceProvider', handler)
  window.dispatchEvent(new Event('eip6963:requestProvider'))
  await new Promise(resolve => window.setTimeout(resolve, 180))
  window.removeEventListener('eip6963:announceProvider', handler)
  return providers
}

function kindOf(item: AnnouncedProvider): WalletKind | undefined {
  const rdns = item.info?.rdns?.toLowerCase() || ''
  const name = item.info?.name?.toLowerCase() || ''
  if (item.provider.isRabby || rdns.includes('rabby') || name.includes('rabby')) return 'rabby'
  if ((!item.provider.isRabby && item.provider.isMetaMask) || rdns.includes('metamask') || name.includes('metamask')) return 'metamask'
  return undefined
}

async function walletCandidates(): Promise<AnnouncedProvider[]> {
  const injected = window.ethereum as WalletProvider | undefined
  const announced = await discoverProviders()
  const legacy = [...(injected?.providers || []), ...(injected ? [injected] : [])].map(provider => ({ provider }))
  const unique: AnnouncedProvider[] = []
  for (const item of [...announced, ...legacy]) {
    if (!unique.some(candidate => candidate.provider === item.provider)) unique.push(item)
  }
  return unique
}

export async function getAvailableWallets(): Promise<AvailableWallet[]> {
  const candidates = await walletCandidates()
  const installed = new Set(candidates.map(kindOf).filter(Boolean))
  return [
    { kind: 'rabby', name: 'Rabby Wallet', installed: installed.has('rabby') },
    { kind: 'metamask', name: 'MetaMask', installed: installed.has('metamask') },
  ]
}

export async function getWalletProvider(preferred?: WalletKind): Promise<WalletProvider> {
  if (activeProvider && (!preferred || preferred === activeKind)) return activeProvider
  const candidates = await walletCandidates()
  const saved = typeof window !== 'undefined' ? window.localStorage.getItem(preferenceKey) as WalletKind | null : null
  const requested = preferred || (saved === 'rabby' || saved === 'metamask' ? saved : undefined)
  const selected = requested
    ? candidates.find(item => kindOf(item) === requested)
    : candidates.find(item => kindOf(item) === 'rabby') || candidates.find(item => kindOf(item) === 'metamask') || candidates[0]
  if (!selected) {
    throw new Error(isMobileBrowser()
      ? '현재 브라우저에는 지갑이 연결되어 있지 않습니다. Rabby 또는 MetaMask 앱의 내장 브라우저에서 이 사이트를 다시 열어주세요.'
      : 'Rabby Wallet 또는 MetaMask 확장 프로그램이 설치되어 있지 않습니다.')
  }
  const selectedKind = kindOf(selected)
  if (requested && selectedKind !== requested) throw new Error(`${requested === 'rabby' ? 'Rabby Wallet' : 'MetaMask'}을 현재 브라우저에서 찾지 못했습니다.`)
  activeProvider = selected.provider
  activeKind = selectedKind || requested
  if (activeKind) window.localStorage.setItem(preferenceKey, activeKind)
  return activeProvider
}

export function getActiveWalletProvider(): WalletProvider | undefined {
  return activeProvider || (window.ethereum as WalletProvider | undefined)
}

export function getActiveWalletKind(): WalletKind | undefined {
  return activeKind
}

export function walletErrorMessage(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : '지갑 연결에 실패했습니다.'
  if (/지갑이 연결되어 있지 않습니다|설치되어 있지 않습니다|확장 프로그램|찾지 못했습니다/.test(message)) return message
  return message
}
