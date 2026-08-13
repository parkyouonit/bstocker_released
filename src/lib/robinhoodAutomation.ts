import {
  createPublicClient,
  createWalletClient,
  custom,
  encodeFunctionData,
  getAddress,
  http,
  isAddress,
  parseAbi,
  parseEther,
  parseUnits,
  type Abi,
  type Address,
  type Hash,
  type Hex,
} from 'viem'
import { ensureRobinhoodNetwork } from './viem'
import { getWalletProvider } from './wallet'
import { ROBINHOOD_CHAIN } from './robinhoodStrategy'

const EXPECTED_USDG = getAddress('0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168')
const EXPECTED_SPCX = getAddress('0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa')
const EXPECTED_POOL = getAddress('0x9d590437ABaAe12cf9fE0627cAF4CFd633152599')
const USDG_DECIMALS = 6

const erc20Abi = parseAbi([
  'function allowance(address owner,address spender) view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
  'function approve(address spender,uint256 amount) returns (bool)',
])

const vaultAbi = parseAbi([
  'error InvalidDeadline()',
  'error InvalidMode()',
  'error InvalidPosition()',
  'error InvalidTick()',
  'error InvalidSlippage()',
  'error IdleBalanceTooHigh(uint256 idleValueUsdg,uint256 totalValueUsdg)',
  'error OracleNotReady()',
  'error PriceGuardFailed()',
  'error TransferFailed()',
  'function version() view returns (string)',
  'function owner() view returns (address)',
  'function recipient() view returns (address)',
  'function keeper() view returns (address)',
  'function guardian() view returns (address)',
  'function principalUsdg() view returns (uint256)',
  'function MAX_PILOT_USDG() view returns (uint256)',
  'function start(uint256 amountSpcx,uint256 amountUsdg,int24 expectedTick,uint256 deadline) returns (uint256 tokenId)',
  'function addCapital(uint256 amountSpcx,uint256 amountUsdg,int24 expectedTick,uint256 deadline) returns (uint256 nextTokenId)',
  'function withdrawToIdle(uint256 deadline)',
  'function exitToTokens(uint256 deadline)',
  'function exitToUsdgAuto(uint256 deadline) returns (uint256 amountOut)',
  'function pause()',
  'function resume()',
  'function setKeeper(address nextKeeper)',
])

const poolAbi = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,bool unlocked)',
])

export interface RobinhoodAutomationBootstrap {
  chainId: number
  expectedOwnerAddress: Address | null
  keeperAddress: Address | null
  keeperKeyReady: boolean
  keeperKeyError: string | null
  liveAutomationAllowed: boolean
  artifact: { abi: Abi; bytecode: Hex; compiler: string }
}

async function payloadOrError(response: Response) {
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload?.error || `자동화 API HTTP ${response.status}`)
  return payload
}

async function clients() {
  const provider = await getWalletProvider()
  await ensureRobinhoodNetwork(provider)
  return {
    provider,
    publicClient: createPublicClient({ chain: ROBINHOOD_CHAIN, transport: http(ROBINHOOD_CHAIN.rpcUrls.default.http[0], { timeout: 12_000, retryCount: 2 }) }),
    walletClient: createWalletClient({ chain: ROBINHOOD_CHAIN, transport: custom(provider as never) }),
  }
}

async function blockDeadline(publicClient: Awaited<ReturnType<typeof clients>>['publicClient'], delaySeconds = 28n) {
  const block = await publicClient.getBlock()
  return block.timestamp + delaySeconds
}

function assertStrategyWritesEnabled() {
  if (import.meta.env.VITE_ENABLE_ROBINHOOD_STRATEGY_WRITES !== 'true') {
    throw new Error('Robinhood 자동화 메인넷 쓰기 기능이 이 빌드에서 잠겨 있습니다.')
  }
}

export async function fetchRobinhoodAutomationBootstrap(signal?: AbortSignal): Promise<RobinhoodAutomationBootstrap> {
  const response = await fetch('/api/robinhood/automation/bootstrap', { signal, headers: { accept: 'application/json' } })
  return payloadOrError(response) as Promise<RobinhoodAutomationBootstrap>
}

export async function deployRobinhoodAutomationVault(account: Address, bootstrap: RobinhoodAutomationBootstrap) {
  assertStrategyWritesEnabled()
  if (!bootstrap.expectedOwnerAddress || getAddress(account) !== getAddress(bootstrap.expectedOwnerAddress)) {
    throw new Error(`이 서버의 자동화 owner는 ${bootstrap.expectedOwnerAddress || '미설정'}로 고정되어 있습니다.`)
  }
  if (!bootstrap.keeperKeyReady || !bootstrap.keeperAddress) throw new Error(bootstrap.keeperKeyError || '이 PC의 Keeper 키가 준비되지 않았습니다.')
  if (!bootstrap.liveAutomationAllowed) throw new Error('이 PC의 라이브 자동화 허용값이 꺼져 있습니다.')
  const { publicClient, walletClient } = await clients()
  const hash = await walletClient.deployContract({
    account,
    abi: bootstrap.artifact.abi,
    bytecode: bootstrap.artifact.bytecode,
    args: [account, account, bootstrap.keeperAddress, account],
  })
  const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 90_000 })
  if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error('자동화 금고 배포가 완료되지 않았습니다.')
  const executorAddress = getAddress(receipt.contractAddress)
  const [version, owner, recipient, keeper, guardian] = await Promise.all([
    publicClient.readContract({ address: executorAddress, abi: vaultAbi, functionName: 'version' }),
    publicClient.readContract({ address: executorAddress, abi: vaultAbi, functionName: 'owner' }),
    publicClient.readContract({ address: executorAddress, abi: vaultAbi, functionName: 'recipient' }),
    publicClient.readContract({ address: executorAddress, abi: vaultAbi, functionName: 'keeper' }),
    publicClient.readContract({ address: executorAddress, abi: vaultAbi, functionName: 'guardian' }),
  ])
  if (version !== '2.8.0' || [owner, recipient, guardian].some(value => getAddress(value) !== getAddress(account)) || getAddress(keeper) !== bootstrap.keeperAddress) {
    throw new Error('배포된 금고의 owner·수령 주소·Keeper 검증에 실패했습니다.')
  }
  return { hash, executorAddress, keeperAddress: bootstrap.keeperAddress }
}

export async function revokeRobinhoodVaultTokenApprovals(account: Address, executorAddress: Address): Promise<Hash[]> {
  if (!isAddress(executorAddress)) return []
  const { publicClient, walletClient } = await clients()
  const hashes: Hash[] = []
  for (const token of [EXPECTED_SPCX, EXPECTED_USDG]) {
    const allowance = await publicClient.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [account, executorAddress] })
    if (allowance === 0n) continue
    const approval = await publicClient.simulateContract({ account, address: token, abi: erc20Abi, functionName: 'approve', args: [executorAddress, 0n] })
    const hash = await walletClient.writeContract(approval.request)
    const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 90_000 })
    if (receipt.status !== 'success') throw new Error('이전 Vault의 토큰 승인을 해제하지 못했습니다.')
    hashes.push(hash)
  }
  return hashes
}

export async function readRobinhoodVaultKeeper(executorAddress: Address): Promise<Address> {
  if (!isAddress(executorAddress)) throw new Error('자동화 금고 주소가 올바르지 않습니다.')
  const { publicClient } = await clients()
  return getAddress(await publicClient.readContract({
    address: executorAddress,
    abi: vaultAbi,
    functionName: 'keeper',
  }))
}

export async function setRobinhoodAutomationAuthorization(account: Address, executorAddress: Address, armed: boolean) {
  if (armed) assertStrategyWritesEnabled()
  if (!isAddress(executorAddress)) throw new Error('자동화 금고 주소가 올바르지 않습니다.')
  const action = armed ? 'ARM' : 'DISARM'
  const challengeUrl = `/api/robinhood/automation/challenge?action=${action}&owner=${account}&executor=${executorAddress}`
  const challenge = await payloadOrError(await fetch(challengeUrl, { headers: { accept: 'application/json' } }))
  const { provider } = await clients()
  const signature = await provider.request({ method: 'personal_sign', params: [challenge.message, account] }) as Hex
  const response = await fetch('/api/robinhood/automation/configure', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ action, nonce: challenge.nonce, signature }),
  })
  try {
    return await payloadOrError(response)
  } catch (error) {
    // 게이트웨이가 설정 저장 후 응답 단계에서 5xx를 반환할 수 있다. 동일 서명을
    // 재전송하지 않고 서버의 실제 저장 상태를 읽어 성공 여부를 먼저 확정한다.
    if (response.status < 500) throw error
    await new Promise(resolve => window.setTimeout(resolve, 1_200))
    try {
      const statusResponse = await fetch('/api/robinhood/strategy', { headers: { accept: 'application/json' } })
      if (statusResponse.ok) {
        const status = await statusResponse.json() as { executorAddress?: string; automation?: { armed?: boolean } }
        if (status.executorAddress?.toLowerCase() === executorAddress.toLowerCase()
          && Boolean(status.automation?.armed) === armed) {
          return { executorAddress, armed, recoveredAfterGatewayError: true }
        }
      }
    } catch {
      // 원래 설정 오류를 유지한다.
    }
    throw error
  }
}

export async function fundRobinhoodKeeper(account: Address, keeperAddress: Address, ethAmount = '0.002'): Promise<Hash> {
  assertStrategyWritesEnabled()
  if (!isAddress(keeperAddress)) throw new Error('Keeper 주소가 올바르지 않습니다.')
  const { publicClient, walletClient } = await clients()
  const hash = await walletClient.sendTransaction({ account, to: keeperAddress, value: parseEther(ethAmount) })
  await publicClient.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 90_000 })
  return hash
}

async function ensureExactAllowance(
  publicClient: Awaited<ReturnType<typeof clients>>['publicClient'],
  walletClient: Awaited<ReturnType<typeof clients>>['walletClient'],
  account: Address,
  token: Address,
  spender: Address,
  amount: bigint,
) {
  const hashes: Hash[] = []
  const allowance = await publicClient.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [account, spender] })
  if (allowance === amount) return hashes
  if (allowance !== 0n) {
    const reset = await publicClient.simulateContract({ account, address: token, abi: erc20Abi, functionName: 'approve', args: [spender, 0n] })
    const resetHash = await walletClient.writeContract(reset.request)
    const resetReceipt = await publicClient.waitForTransactionReceipt({ hash: resetHash, confirmations: 1, timeout: 90_000 })
    if (resetReceipt.status !== 'success') throw new Error('기존 토큰 승인을 초기화하지 못했습니다.')
    hashes.push(resetHash)
  }
  if (amount === 0n) return hashes
  const approval = await publicClient.simulateContract({ account, address: token, abi: erc20Abi, functionName: 'approve', args: [spender, amount] })
  const approvalHash = await walletClient.writeContract(approval.request)
  const approvalReceipt = await publicClient.waitForTransactionReceipt({ hash: approvalHash, confirmations: 1, timeout: 90_000 })
  if (approvalReceipt.status !== 'success') throw new Error('토큰 승인이 완료되지 않았습니다.')
  hashes.push(approvalHash)
  return hashes
}

function friendlyDepositError(error: unknown, action: '시작' | '추가 입금') {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('InvalidTick')) return new Error('서명 직전 가격이 10틱보다 더 움직였습니다. 새로고침 후 다시 시도하세요. 자금은 이동하지 않았습니다.')
  if (message.includes('PriceGuardFailed')) return new Error('30초/5분 TWAP 안전가드가 현재 시장 변동을 차단했습니다. 안정된 뒤 다시 시도하세요. 자금은 이동하지 않았습니다.')
  if (message.includes('OracleNotReady')) return new Error('온체인 오라클 관측값이 아직 준비되지 않았습니다. 잠시 뒤 다시 시도하세요. 자금은 이동하지 않았습니다.')
  if (message.includes('InvalidMode')) return new Error(action === '추가 입금' ? '추가 입금은 v2.8 LIVE 포지션에서만 가능합니다.' : '새 포지션 시작은 PAUSED 상태에서만 가능합니다.')
  if (message.includes('IdleBalanceTooHigh')) return new Error('현재 풀 유동성에서 5틱 LP에 투입되지 못하는 대기 자산이 10%를 넘습니다. 가격이 안정되거나 유동성이 회복된 뒤 다시 시도하세요. 자금은 Vault로 이동하지 않았습니다.')
  if (message.includes('Too little received') || message.includes('InvalidSlippage')) return new Error('TWAP 기준 최소수령 또는 1% 가격 이동 MEV 가드를 만족하지 못했습니다. 자금은 Vault로 이동하지 않았습니다. 잠시 후 다시 시도하세요.')
  if (message.includes('PSC')) return new Error('민트 비율이 Slipstream 가격 검사(PSC)를 통과하지 못했습니다. v2.8 교체본을 사용하고 새로고침 후 다시 시도하세요. 자금은 Vault로 이동하지 않았습니다.')
  return new Error(`${action} 전 전체 시뮬레이션이 실패했습니다. 승인만 남았을 수 있으나 Vault로 자금은 이동하지 않았습니다. ${message}`)
}

async function depositRobinhoodAutomation(
  account: Address,
  executorAddress: Address,
  amountSpcx: bigint,
  amountUsdg: bigint,
  action: 'start' | 'addCapital',
) {
  assertStrategyWritesEnabled()
  if (amountSpcx <= 0n && amountUsdg <= 0n) throw new Error('입금 수량은 0보다 커야 합니다.')
  const { publicClient, walletClient } = await clients()
  const approvalHashes = [
    ...await ensureExactAllowance(publicClient, walletClient, account, EXPECTED_SPCX, executorAddress, amountSpcx),
    ...await ensureExactAllowance(publicClient, walletClient, account, EXPECTED_USDG, executorAddress, amountUsdg),
  ]
  const [, expectedTick] = await publicClient.readContract({ address: EXPECTED_POOL, abi: poolAbi, functionName: 'slot0' })
  const deadline = await blockDeadline(publicClient, 240n)
  let simulation
  try {
    simulation = await publicClient.simulateContract({
      account,
      address: executorAddress,
      abi: vaultAbi,
      functionName: action,
      args: [amountSpcx, amountUsdg, expectedTick, deadline],
    })
  } catch (error) {
    throw friendlyDepositError(error, action === 'start' ? '시작' : '추가 입금')
  }
  const hash = await walletClient.writeContract(simulation.request)
  const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 90_000 })
  if (receipt.status !== 'success') throw new Error(`${action === 'start' ? '5틱 자동화 시작' : '추가 입금 재예치'}이 완료되지 않았습니다.`)
  return { approvalHashes, hash }
}

export async function readRobinhoodAutomationTokenBalances(account: Address) {
  const { publicClient } = await clients()
  const [spcx, usdg] = await Promise.all([
    publicClient.readContract({ address: EXPECTED_SPCX, abi: erc20Abi, functionName: 'balanceOf', args: [account] }),
    publicClient.readContract({ address: EXPECTED_USDG, abi: erc20Abi, functionName: 'balanceOf', args: [account] }),
  ])
  return { spcx, usdg }
}

export async function startRobinhoodAutomationWithRawAmounts(account: Address, executorAddress: Address, amountSpcx: bigint, amountUsdg: bigint) {
  return depositRobinhoodAutomation(account, executorAddress, amountSpcx, amountUsdg, 'start')
}

export async function startRobinhoodAutomation(account: Address, executorAddress: Address, amountUsdgText: string) {
  const numericAmount = Number(amountUsdgText)
  if (!Number.isFinite(numericAmount) || numericAmount <= 0) throw new Error('시작 금액은 0보다 커야 합니다.')
  const amountUsdg = parseUnits(amountUsdgText, USDG_DECIMALS)
  const result = await depositRobinhoodAutomation(account, executorAddress, 0n, amountUsdg, 'start')
  return { approvalHash: result.approvalHashes.at(-1) || null, startHash: result.hash }
}

export async function addRobinhoodAutomationCapital(account: Address, executorAddress: Address, amountUsdgText: string) {
  const numericAmount = Number(amountUsdgText)
  if (!Number.isFinite(numericAmount) || numericAmount <= 0) throw new Error('추가 금액은 0보다 커야 합니다.')
  const amountUsdg = parseUnits(amountUsdgText, USDG_DECIMALS)
  const result = await depositRobinhoodAutomation(account, executorAddress, 0n, amountUsdg, 'addCapital')
  return { approvalHash: result.approvalHashes.at(-1) || null, addHash: result.hash }
}

export type RobinhoodVaultOwnerAction = 'pause' | 'resume' | 'withdrawToIdle' | 'exitToTokens' | 'exitToUsdgAuto'

export async function executeRobinhoodVaultOwnerAction(account: Address, executorAddress: Address, action: RobinhoodVaultOwnerAction): Promise<Hash> {
  const { publicClient, walletClient } = await clients()
  const deadlineActions = ['withdrawToIdle', 'exitToTokens', 'exitToUsdgAuto'] as const
  const data = deadlineActions.includes(action as typeof deadlineActions[number])
    ? encodeFunctionData({ abi: vaultAbi, functionName: action as typeof deadlineActions[number], args: [await blockDeadline(publicClient)] })
    : encodeFunctionData({ abi: vaultAbi, functionName: action as 'pause' | 'resume', args: [] })
  await publicClient.call({ account, to: executorAddress, data })
  const hash = await walletClient.sendTransaction({ account, to: executorAddress, data })
  const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 90_000 })
  if (receipt.status !== 'success') throw new Error(`${action} 실행이 완료되지 않았습니다.`)
  return hash
}

export async function updateRobinhoodVaultKeeper(account: Address, executorAddress: Address, keeperAddress: Address): Promise<Hash> {
  assertStrategyWritesEnabled()
  if (!isAddress(executorAddress) || !isAddress(keeperAddress)) throw new Error('금고 또는 Keeper 주소가 올바르지 않습니다.')
  const { publicClient, walletClient } = await clients()
  const simulation = await publicClient.simulateContract({
    account,
    address: executorAddress,
    abi: vaultAbi,
    functionName: 'setKeeper',
    args: [keeperAddress],
  })
  const hash = await walletClient.writeContract(simulation.request)
  const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 90_000 })
  if (receipt.status !== 'success') throw new Error('이 PC의 새 Keeper 등록이 완료되지 않았습니다.')
  return hash
}
