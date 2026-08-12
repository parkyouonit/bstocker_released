import { isAddress, type Address } from 'viem'

const ZERO_ONE = '0x0000000000000000000000000000000000000001' as Address
const ZERO_TWO = '0x0000000000000000000000000000000000000002' as Address
const PANCAKE_V3_POSITION_MANAGER = '0x46A15B0b27311cedF172AB29E4f4766fbE7F4364' as Address
const PANCAKE_V3_SWAP_ROUTER = '0x1b81D678ffb9C0263b24A97847620C99d213eB14' as Address
const PANCAKE_V3_QUOTER_V2 = '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997' as Address
const PANCAKE_V3_FACTORY = '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865' as Address
const PANCAKE_V3_MASTER_CHEF = '0x556B9306565093C855AEA9AE92A594704c2Cd59e' as Address
const PANCAKE_CAKE = '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82' as Address
const MERKL_DISTRIBUTOR = '0x3Ef3D8bA38EBe18DB133cEc108f4D14CE00Dd9Ae' as Address

function envAddress(value: string | undefined, fallback: Address): Address {
  return value && isAddress(value) ? value : fallback
}

export const APP_CONFIG = {
  chainId: 56,
  rpcUrl: import.meta.env.VITE_BSC_RPC_URL || 'https://bsc-dataseed.bnbchain.org',
  poolAddress: envAddress(import.meta.env.VITE_POOL_ADDRESS, ZERO_ONE),
  token0Address: envAddress(import.meta.env.VITE_TOKEN0_ADDRESS, ZERO_ONE),
  token1Address: envAddress(import.meta.env.VITE_TOKEN1_ADDRESS, ZERO_TWO),
  token0Symbol: import.meta.env.VITE_TOKEN0_SYMBOL || 'USDT',
  token1Symbol: import.meta.env.VITE_TOKEN1_SYMBOL || 'SPCXB',
  token0Decimals: Number(import.meta.env.VITE_TOKEN0_DECIMALS || 18),
  token1Decimals: Number(import.meta.env.VITE_TOKEN1_DECIMALS || 18),
  poolFee: Number(import.meta.env.VITE_POOL_FEE || 2500),
  npmAddress: envAddress(import.meta.env.VITE_NPM_ADDRESS, PANCAKE_V3_POSITION_MANAGER),
  smartRouterAddress: envAddress(import.meta.env.VITE_SMART_ROUTER_ADDRESS, PANCAKE_V3_SWAP_ROUTER),
  quoterV2Address: envAddress(import.meta.env.VITE_QUOTER_V2_ADDRESS, PANCAKE_V3_QUOTER_V2),
  pancakeV3FactoryAddress: envAddress(import.meta.env.VITE_PANCAKE_V3_FACTORY_ADDRESS, PANCAKE_V3_FACTORY),
  pancakeV3MasterChefAddress: envAddress(import.meta.env.VITE_PANCAKE_V3_MASTER_CHEF_ADDRESS, PANCAKE_V3_MASTER_CHEF),
  cakeAddress: envAddress(import.meta.env.VITE_CAKE_ADDRESS, PANCAKE_CAKE),
  merklDistributorAddress: envAddress(import.meta.env.VITE_MERKL_DISTRIBUTOR_ADDRESS, MERKL_DISTRIBUTOR),
  apiBaseUrl: (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, ''),
  bridgeApiUrl: (import.meta.env.VITE_BRIDGE_API_URL || '/api/bridge').replace(/\/$/, ''),
  bridgeMetadataUrl: import.meta.env.VITE_BRIDGE_METADATA_URL || 'https://stargate-bridge-params.vercel.app/oft-checker/data/oft-snapshot.json',
  bridgeActivityUrl: import.meta.env.VITE_BRIDGE_ACTIVITY_URL || 'https://stargate-bridge-params.vercel.app/oft-checker/data/adapter-activity-index.json',
  enableMainnetWrites: import.meta.env.VITE_ENABLE_MAINNET_WRITES === 'true',
  enableRewardWrites: import.meta.env.VITE_ENABLE_REWARD_WRITES === 'true',
  enableMainnetBridge: import.meta.env.VITE_ENABLE_MAINNET_BRIDGE === 'true',
}

export const isLiveConfig = Boolean(
  import.meta.env.VITE_POOL_ADDRESS &&
  import.meta.env.VITE_TOKEN0_ADDRESS &&
  import.meta.env.VITE_TOKEN1_ADDRESS,
)

export const DEMO_POOL_ADDRESS = '0x977DaFFC095b33872E2741c19568925015C35b4d' as Address

export function explorerAddress(address: Address): string {
  return `https://bscscan.com/address/${address}`
}

export function explorerTx(hash: string): string {
  return `https://bscscan.com/tx/${hash}`
}
