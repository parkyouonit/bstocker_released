import {
  concatHex,
  createPublicClient,
  createWalletClient,
  custom,
  encodePacked,
  formatUnits,
  getAddress,
  http,
  isAddress,
  padHex,
  parseUnits,
  type Address,
  type Hash,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem'
import { erc20Abi, oftAbi } from '../abi'
import { BRIDGE_CHAINS, getBridgeChain, type BridgeChainConfig, type BridgeChainKey } from '../bridge'
import { getWalletProvider, type WalletProvider } from './wallet'
import { isBridgeTransaction, type BridgeBackendQuote } from './stargateBackend'

export interface BridgeTokenInfo {
  address: Address
  symbol: string
  name: string
  decimals: number
  balanceRaw: bigint
  balanceUi: string
  allowanceRaw: bigint
  approvalRequired: boolean | null
  linkedToken?: Address
  oftAddress?: Address
  oftType?: 'OFT' | 'OFT_ADAPTER'
  rpcUrl?: string
}

export interface BridgeQuoteInput {
  fromChain: BridgeChainConfig
  toChain: BridgeChainConfig
  tokenAddress: Address
  oftAddress: Address
  sender: Address
  recipient: Address
  amount: string
  decimals: number
  slippagePercent: number
  gasLimit: number
  lzReceiveEnabled: boolean
  nativeDropEnabled: boolean
  nativeDropAmount: string
  customRpc?: string
  destinationCustomRpc?: string
}

export interface BridgeSendParam {
  dstEid: number
  to: `0x${string}`
  amountLD: bigint
  minAmountLD: bigint
  extraOptions: `0x${string}`
  composeMsg: `0x${string}`
  oftCmd: `0x${string}`
}

export interface BridgeQuote {
  sendParam: BridgeSendParam
  nativeFee: bigint
  lzTokenFee: bigint
  approvalRequired: boolean
  linkedToken?: Address
  destinationOft: Address
  sharedDecimals: number
  sourceBalanceRaw: bigint
  sourceBalanceUi: string
  amountUi: string
  minAmountUi: string
  options: `0x${string}`
}

export interface BridgeTokenDiscovery {
  chainKey: BridgeChainKey
  info: BridgeTokenInfo
}

const publicClients = new Map<string, PublicClient>()
const LAYERZERO_ENDPOINT_V2 = '0x1A44076050125825900e736c501f859c50fE728c' as Address

function addExecutorOption(options: Hex, optionType: number, params: Hex): Hex {
  const paramBytes = (params.length - 2) / 2
  return concatHex([
    options,
    encodePacked(['uint8', 'uint16', 'uint8', 'bytes'], [1, paramBytes + 1, optionType, params]),
  ])
}

function buildExecutorOptions(input: BridgeQuoteInput): Hex {
  if (!input.lzReceiveEnabled) return '0x'
  let options = encodePacked(['uint16'], [3])
  options = addExecutorOption(options, 1, encodePacked(['uint128'], [BigInt(input.gasLimit)]))
  if (input.nativeDropEnabled && input.nativeDropAmount.trim()) {
    const nativeDropRaw = parseUnits(input.nativeDropAmount, input.toChain.nativeDecimals)
    if (nativeDropRaw > 0n) {
      options = addExecutorOption(
        options,
        2,
        encodePacked(['uint128', 'bytes32'], [nativeDropRaw, padHex(input.recipient, { size: 32 })]),
      )
    }
  }
  return options
}

export function getBridgeRpcUrls(chain: BridgeChainConfig, customRpc?: string): string[] {
  return [...new Set([
    customRpc?.trim(),
    ...chain.rpcUrls,
    chain.rpcUrl,
  ].filter((value): value is string => Boolean(value)))]
}

export function getBridgePublicClient(chainKey: BridgeChainKey, rpcUrl?: string): PublicClient {
  const chain = getBridgeChain(chainKey)
  const rpc = rpcUrl || chain.rpcUrl
  const cacheKey = `${chain.key}:${rpc}`
  const cached = publicClients.get(cacheKey)
  if (cached) return cached
  const client = createPublicClient({
    chain: chain.viemChain,
    transport: http(rpc, { timeout: 12_000 }),
    batch: { multicall: true },
  })
  publicClients.set(cacheKey, client)
  return client
}

export async function getWorkingBridgePublicClient(chainKey: BridgeChainKey, customRpc?: string): Promise<{ client: PublicClient; rpcUrl: string }> {
  const chain = getBridgeChain(chainKey)
  let lastError: unknown
  for (const rpcUrl of getBridgeRpcUrls(chain, customRpc)) {
    try {
      const client = getBridgePublicClient(chainKey, rpcUrl)
      await assertRpcChain(client, chain)
      return { client, rpcUrl }
    } catch (error) {
      lastError = error
    }
  }
  const message = lastError instanceof Error ? lastError.message : 'RPC 응답이 없습니다.'
  throw new Error(`${chain.name} RPC를 자동으로 연결하지 못했습니다. 커스텀 RPC를 입력해보세요. (${message})`)
}

async function assertRpcChain(client: PublicClient, chain: BridgeChainConfig): Promise<void> {
  const actualChainId = await client.getChainId()
  if (actualChainId !== chain.chainId) {
    throw new Error(`RPC chain ID가 ${actualChainId}입니다. ${chain.name}(${chain.chainId}) RPC를 입력하세요.`)
  }
}

function peerAddress(peer: Hex): Address | undefined {
  const normalized = peer.toLowerCase().replace(/^0x/, '')
  if (normalized.length !== 64 || /^0{64}$/.test(normalized) || !/^0{24}/.test(normalized)) return undefined
  return getAddress(`0x${normalized.slice(24)}`)
}

async function validateOftRoute(input: BridgeQuoteInput, sourceClient: PublicClient, destinationClient: PublicClient): Promise<{ destinationOft: Address; sharedDecimals: number }> {
  const [sourceEndpoint, sourceSharedDecimals, destinationPeerRaw] = await Promise.all([
    sourceClient.readContract({ address: input.oftAddress, abi: oftAbi, functionName: 'endpoint' }),
    sourceClient.readContract({ address: input.oftAddress, abi: oftAbi, functionName: 'sharedDecimals' }),
    sourceClient.readContract({ address: input.oftAddress, abi: oftAbi, functionName: 'peers', args: [input.toChain.eid] }),
  ])
  if (sourceEndpoint.toLowerCase() !== LAYERZERO_ENDPOINT_V2.toLowerCase()) {
    throw new Error(`LayerZero EndpointV2 주소가 아닙니다: ${sourceEndpoint}`)
  }
  const destinationOft = peerAddress(destinationPeerRaw)
  if (!destinationOft) throw new Error(`${input.toChain.name} eid ${input.toChain.eid}에 등록된 OFT peer가 없습니다.`)
  const [destinationEndpoint, destinationSharedDecimals, reversePeerRaw] = await Promise.all([
    destinationClient.readContract({ address: destinationOft, abi: oftAbi, functionName: 'endpoint' }),
    destinationClient.readContract({ address: destinationOft, abi: oftAbi, functionName: 'sharedDecimals' }),
    destinationClient.readContract({ address: destinationOft, abi: oftAbi, functionName: 'peers', args: [input.fromChain.eid] }),
  ])
  if (destinationEndpoint.toLowerCase() !== LAYERZERO_ENDPOINT_V2.toLowerCase()) {
    throw new Error(`목적지 peer가 LayerZero EndpointV2를 사용하지 않습니다: ${destinationOft}`)
  }
  const reversePeer = peerAddress(reversePeerRaw)
  if (!reversePeer || reversePeer.toLowerCase() !== input.oftAddress.toLowerCase()) {
    throw new Error(`${input.toChain.name} OFT의 역방향 peer가 출발 OFT와 일치하지 않습니다.`)
  }
  if (Number(destinationSharedDecimals) !== Number(sourceSharedDecimals)) {
    throw new Error(`sharedDecimals 불일치: ${sourceSharedDecimals} → ${destinationSharedDecimals}`)
  }
  return { destinationOft, sharedDecimals: Number(sourceSharedDecimals) }
}

async function ensureWalletNetwork(chain: BridgeChainConfig, provider: WalletProvider): Promise<void> {
  const wanted = `0x${chain.chainId.toString(16)}`
  const current = await provider.request({ method: 'eth_chainId' })
  if (String(current).toLowerCase() === wanted) return
  try {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: wanted }] })
  } catch (error) {
    const code = (error as { code?: number }).code
    if (code !== 4902) throw error
    await provider.request({
      method: 'wallet_addEthereumChain',
      params: [{
        chainId: wanted,
        chainName: chain.name,
        nativeCurrency: { name: chain.nativeSymbol, symbol: chain.nativeSymbol, decimals: chain.nativeDecimals },
        rpcUrls: [chain.rpcUrl],
        blockExplorerUrls: chain.key === 'bsc' ? ['https://bscscan.com'] : undefined,
      }],
    })
  }
}

export async function connectBridgeWallet(chainKey: BridgeChainKey): Promise<Address> {
  const chain = getBridgeChain(chainKey)
  const provider = await getWalletProvider()
  await ensureWalletNetwork(chain, provider)
  const walletClient = getBridgeWalletClient(chain, provider)
  const addresses = await walletClient.requestAddresses()
  if (!addresses[0]) throw new Error('지갑 주소를 읽지 못했습니다.')
  return addresses[0]
}

function getBridgeWalletClient(chain: BridgeChainConfig, provider: WalletProvider): WalletClient {
  return createWalletClient({
    chain: chain.viemChain,
    transport: custom(provider as never),
  })
}

async function readTokenField<T>(client: PublicClient, address: Address, functionName: 'name' | 'symbol', fallback: T): Promise<T> {
  try {
    return await client.readContract({ address, abi: erc20Abi, functionName }) as T
  } catch {
    return fallback
  }
}

export async function readBridgeTokenInfo({
  chainKey,
  tokenAddress,
  owner,
  oftAddress,
  customRpc,
}: {
  chainKey: BridgeChainKey
  tokenAddress: Address
  owner?: Address
  oftAddress?: Address
  customRpc?: string
}): Promise<BridgeTokenInfo> {
  const working = await getWorkingBridgePublicClient(chainKey, customRpc)
  const client = working.client
  const candidateOftAddress = oftAddress || tokenAddress
  let approvalRequired: boolean | null = null
  let linkedToken: Address | undefined
  let detectedOftAddress: Address | undefined
  let oftType: BridgeTokenInfo['oftType']
  try {
    const endpoint = await client.readContract({ address: candidateOftAddress, abi: oftAbi, functionName: 'endpoint' })
    if (endpoint.toLowerCase() === LAYERZERO_ENDPOINT_V2.toLowerCase()) {
      detectedOftAddress = candidateOftAddress
      approvalRequired = await client.readContract({ address: candidateOftAddress, abi: oftAbi, functionName: 'approvalRequired' })
      oftType = approvalRequired ? 'OFT_ADAPTER' : 'OFT'
    }
  } catch (error) {
    if (oftAddress) {
      throw new Error(`OFT/Adapter 주소를 읽지 못했습니다: ${oftAddress}`)
    }
  }
  if (detectedOftAddress) {
    try {
      linkedToken = await client.readContract({ address: detectedOftAddress, abi: oftAbi, functionName: 'token' })
    } catch {
      linkedToken = undefined
    }
  }
  const resolvedTokenAddress = linkedToken && linkedToken.toLowerCase() !== candidateOftAddress.toLowerCase()
    ? linkedToken
    : tokenAddress
  const decimals = await client.readContract({ address: resolvedTokenAddress, abi: erc20Abi, functionName: 'decimals' })
  const [symbol, name, balanceRaw] = await Promise.all([
    readTokenField<string>(client, resolvedTokenAddress, 'symbol', 'TOKEN'),
    readTokenField<string>(client, resolvedTokenAddress, 'name', 'Bridge asset'),
    owner
      ? client.readContract({ address: resolvedTokenAddress, abi: erc20Abi, functionName: 'balanceOf', args: [owner] })
      : Promise.resolve(0n),
  ])
  const allowanceRaw = owner && detectedOftAddress
    ? await client.readContract({ address: resolvedTokenAddress, abi: erc20Abi, functionName: 'allowance', args: [owner, detectedOftAddress] })
    : 0n
  return {
    address: resolvedTokenAddress,
    symbol,
    name,
    decimals: Number(decimals),
    balanceRaw,
    balanceUi: formatUnits(balanceRaw, Number(decimals)),
    allowanceRaw,
    approvalRequired,
    linkedToken,
    oftAddress: detectedOftAddress,
    oftType,
    rpcUrl: working.rpcUrl,
  }
}

export async function discoverBridgeTokens({
  tokenAddress,
  owner,
  preferredChainKey,
  customRpc,
}: {
  tokenAddress: Address
  owner?: Address
  preferredChainKey: BridgeChainKey
  customRpc?: string
}): Promise<BridgeTokenDiscovery[]> {
  const chainKeys = [preferredChainKey, ...BRIDGE_CHAINS.map(chain => chain.key).filter(key => key !== preferredChainKey)]
  const results = await Promise.allSettled(chainKeys.map(async chainKey => ({
    chainKey,
    info: await readBridgeTokenInfo({
      chainKey,
      tokenAddress,
      owner,
      customRpc: chainKey === preferredChainKey ? customRpc : undefined,
    }),
  })))
  return results.flatMap(result => result.status === 'fulfilled' ? [result.value] : [])
}

function buildSendParam(input: BridgeQuoteInput): { sendParam: BridgeSendParam; amountRaw: bigint; minAmountRaw: bigint; options: `0x${string}` } {
  const amountRaw = parseUnits(input.amount, input.decimals)
  if (amountRaw <= 0n) throw new Error('브릿지 수량을 입력하세요.')
  const slippageBps = Math.round(Math.max(0, Math.min(50, input.slippagePercent)) * 100)
  const minAmountRaw = amountRaw * BigInt(10_000 - slippageBps) / 10_000n
  const options = buildExecutorOptions(input)
  const sendParam: BridgeSendParam = {
    dstEid: input.toChain.eid,
    to: padHex(input.recipient, { size: 32 }),
    amountLD: amountRaw,
    minAmountLD: minAmountRaw,
    extraOptions: options,
    composeMsg: '0x',
    oftCmd: '0x',
  }
  return { sendParam, amountRaw, minAmountRaw, options }
}

function feeField(fee: unknown, field: 'nativeFee' | 'lzTokenFee'): bigint {
  if (fee && typeof fee === 'object' && field in fee) return BigInt((fee as Record<string, unknown>)[field] as bigint)
  if (Array.isArray(fee)) return BigInt(fee[field === 'nativeFee' ? 0 : 1] as bigint)
  throw new Error('LayerZero fee 응답을 읽지 못했습니다.')
}

export async function quoteBridgeTransfer(input: BridgeQuoteInput): Promise<BridgeQuote> {
  if (input.fromChain.key === input.toChain.key) throw new Error('출발 체인과 도착 체인은 달라야 합니다.')
  const [sourceWorking, destinationWorking] = await Promise.all([
    getWorkingBridgePublicClient(input.fromChain.key, input.customRpc),
    getWorkingBridgePublicClient(input.toChain.key, input.destinationCustomRpc),
  ])
  const client = sourceWorking.client
  const route = await validateOftRoute(input, sourceWorking.client, destinationWorking.client)
  const { sendParam, amountRaw, minAmountRaw, options } = buildSendParam(input)
  const [fee, approvalRequired, linkedToken, sourceBalanceRaw] = await Promise.all([
    client.readContract({ address: input.oftAddress, abi: oftAbi, functionName: 'quoteSend', args: [sendParam, false] }),
    client.readContract({ address: input.oftAddress, abi: oftAbi, functionName: 'approvalRequired' }),
    client.readContract({ address: input.oftAddress, abi: oftAbi, functionName: 'token' }).catch(() => undefined),
    client.readContract({ address: input.tokenAddress, abi: erc20Abi, functionName: 'balanceOf', args: [input.sender] }),
  ])
  if (linkedToken && String(linkedToken).toLowerCase() !== input.tokenAddress.toLowerCase()) {
    throw new Error(`OFT가 연결한 토큰이 다릅니다: ${String(linkedToken)}`)
  }
  if (sourceBalanceRaw < amountRaw) throw new Error('출발 지갑 잔액이 부족합니다.')
  return {
    sendParam,
    nativeFee: feeField(fee, 'nativeFee'),
    lzTokenFee: feeField(fee, 'lzTokenFee'),
    approvalRequired,
    linkedToken: linkedToken as Address | undefined,
    destinationOft: route.destinationOft,
    sharedDecimals: route.sharedDecimals,
    sourceBalanceRaw,
    sourceBalanceUi: formatUnits(sourceBalanceRaw, input.decimals),
    amountUi: formatUnits(amountRaw, input.decimals),
    minAmountUi: formatUnits(minAmountRaw, input.decimals),
    options,
  }
}

export async function sendBridgeTransfer(input: BridgeQuoteInput, quote: BridgeQuote): Promise<Hash> {
  const [sourceWorking, destinationWorking] = await Promise.all([
    getWorkingBridgePublicClient(input.fromChain.key, input.customRpc),
    getWorkingBridgePublicClient(input.toChain.key, input.destinationCustomRpc),
  ])
  await validateOftRoute(input, sourceWorking.client, destinationWorking.client)
  const provider = await getWalletProvider()
  await ensureWalletNetwork(input.fromChain, provider)
  const walletClient = getBridgeWalletClient(input.fromChain, provider)
  const connected = await walletClient.requestAddresses()
  if (!connected[0] || connected[0].toLowerCase() !== input.sender.toLowerCase()) {
    throw new Error('현재 지갑 계정과 출발 지갑 주소가 다릅니다.')
  }
  const publicClient = sourceWorking.client
  if (quote.approvalRequired) {
    const currentAllowance = await publicClient.readContract({ address: input.tokenAddress, abi: erc20Abi, functionName: 'allowance', args: [connected[0], input.oftAddress] })
    if (currentAllowance < quote.sendParam.amountLD) {
      if (currentAllowance > 0n) {
        const resetHash = await walletClient.writeContract({ address: input.tokenAddress, abi: erc20Abi, functionName: 'approve', args: [input.oftAddress, 0n], account: connected[0], chain: input.fromChain.viemChain })
        await publicClient.waitForTransactionReceipt({ hash: resetHash })
      }
      const approvalHash = await walletClient.writeContract({ address: input.tokenAddress, abi: erc20Abi, functionName: 'approve', args: [input.oftAddress, quote.sendParam.amountLD], account: connected[0], chain: input.fromChain.viemChain })
      await publicClient.waitForTransactionReceipt({ hash: approvalHash })
    }
  }
  const bufferedNativeFee = quote.nativeFee * 120n / 100n
  return walletClient.writeContract({
    address: input.oftAddress,
    abi: oftAbi,
    functionName: 'send',
    args: [quote.sendParam, { nativeFee: bufferedNativeFee, lzTokenFee: quote.lzTokenFee }, input.sender],
    account: connected[0],
    chain: input.fromChain.viemChain,
    value: bufferedNativeFee,
  })
}

export async function sendStargateBackendTransfer({
  fromChain,
  sender,
  quote,
}: {
  fromChain: BridgeChainConfig
  sender: Address
  quote: BridgeBackendQuote
}): Promise<Hash[]> {
  const provider = await getWalletProvider()
  await ensureWalletNetwork(fromChain, provider)
  const walletClient = getBridgeWalletClient(fromChain, provider)
  const connected = await walletClient.requestAddresses()
  if (!connected[0] || connected[0].toLowerCase() !== sender.toLowerCase()) {
    throw new Error('현재 지갑 계정과 출발 지갑 주소가 다릅니다.')
  }
  const publicClient = (await getWorkingBridgePublicClient(fromChain.key)).client
  const hashes: Hash[] = []
  for (const step of quote.steps) {
    if (step.type !== 'TRANSACTION' || !step.transaction || !isBridgeTransaction(step.transaction)) {
      throw new Error('현재 브릿지 경로에 지갑 서명이 필요한 미지원 단계가 포함되어 있습니다.')
    }
    if (step.chainKey !== fromChain.key) {
      throw new Error(`브릿지 단계의 체인이 출발 체인과 다릅니다: ${step.chainKey}`)
    }
    if (step.chainId != null && step.chainId !== fromChain.chainId) {
      throw new Error(`브릿지 단계 chainId가 ${fromChain.chainId}와 다릅니다.`)
    }
    if (step.signerAddress && step.signerAddress.toLowerCase() !== connected[0].toLowerCase()) {
      throw new Error('브릿지 API가 반환한 서명자 주소와 현재 지갑 주소가 다릅니다.')
    }
    if (step.transaction.from && step.transaction.from.toLowerCase() !== connected[0].toLowerCase()) {
      throw new Error('브릿지 트랜잭션의 from 주소와 현재 지갑 주소가 다릅니다.')
    }
    const hash = await walletClient.sendTransaction({
      account: connected[0],
      chain: fromChain.viemChain,
      to: step.transaction.to,
      data: step.transaction.data,
      value: BigInt(step.transaction.value || '0'),
      gas: step.transaction.gasLimit ? BigInt(step.transaction.gasLimit) : undefined,
    })
    hashes.push(hash)
    await publicClient.waitForTransactionReceipt({ hash })
  }
  if (!hashes.length) throw new Error('브릿지 API가 실행할 트랜잭션을 반환하지 않았습니다.')
  return hashes
}

export function layerZeroScanUrl(hash: string): string {
  return `https://layerzeroscan.com/tx/${hash}`
}

export function isValidBridgeAddress(value: string): value is Address {
  return isAddress(value)
}
