export interface WalletProvider {
  request: (args: { method: string; params?: unknown[] | object }) => Promise<unknown>
  on?: (event: string, handler: (...args: unknown[]) => void) => void
  removeListener?: (event: string, handler: (...args: unknown[]) => void) => void
  isRabby?: boolean
  providers?: WalletProvider[]
}

let activeProvider: WalletProvider | undefined

function isMobileBrowser(): boolean {
  return typeof navigator !== 'undefined' && /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
}

async function discoverProviders(): Promise<WalletProvider[]> {
  if (typeof window === 'undefined') return []
  const providers: WalletProvider[] = []
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<{ provider?: WalletProvider }>).detail
    if (detail?.provider && !providers.includes(detail.provider)) providers.push(detail.provider)
  }
  window.addEventListener('eip6963:announceProvider', handler)
  window.dispatchEvent(new Event('eip6963:requestProvider'))
  await new Promise(resolve => window.setTimeout(resolve, 180))
  window.removeEventListener('eip6963:announceProvider', handler)
  return providers
}

export async function getWalletProvider(): Promise<WalletProvider> {
  if (activeProvider) return activeProvider
  const injected = window.ethereum as WalletProvider | undefined
  const injectedProviders = injected?.providers || []
  const discovered = await discoverProviders()
  const candidates = [...injectedProviders, ...discovered, ...(injected ? [injected] : [])]
  const rabby = candidates.find(provider => provider.isRabby)
  const provider = rabby || candidates[0]
  if (!provider) {
    throw new Error(isMobileBrowser()
      ? '현재 브라우저에는 지갑이 연결되어 있지 않습니다. Rabby 앱을 열고 내장 DApp 브라우저에서 이 사이트를 다시 열어주세요.'
      : 'Rabby 확장 프로그램 또는 Web3 지갑이 설치되어 있지 않습니다.')
  }
  activeProvider = provider
  return provider
}

export function getActiveWalletProvider(): WalletProvider | undefined {
  return activeProvider || (window.ethereum as WalletProvider | undefined)
}

export function walletErrorMessage(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : '지갑 연결에 실패했습니다.'
  if (/지갑이 연결되어 있지 않습니다|Web3 지갑이 설치되어 있지 않습니다|확장 프로그램/.test(message)) {
    return message
  }
  return message
}
