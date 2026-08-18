/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_BSC_RPC_URL?: string
  readonly VITE_POOL_ADDRESS?: string
  readonly VITE_TOKEN0_ADDRESS?: string
  readonly VITE_TOKEN1_ADDRESS?: string
  readonly VITE_TOKEN0_SYMBOL?: string
  readonly VITE_TOKEN1_SYMBOL?: string
  readonly VITE_TOKEN0_DECIMALS?: string
  readonly VITE_TOKEN1_DECIMALS?: string
  readonly VITE_POOL_FEE?: string
  readonly VITE_NPM_ADDRESS?: string
  readonly VITE_SMART_ROUTER_ADDRESS?: string
  readonly VITE_API_BASE_URL?: string
  readonly VITE_ENABLE_MAINNET_WRITES?: string
  readonly VITE_ENABLE_MAINNET_BRIDGE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

interface Window {
  ethereum?: {
    request: (args: { method: string; params?: unknown[] | object }) => Promise<unknown>
    on?: (event: string, handler: (...args: unknown[]) => void) => void
    removeListener?: (event: string, handler: (...args: unknown[]) => void) => void
    isRabby?: boolean
    providers?: Window['ethereum'][]
  }
}
