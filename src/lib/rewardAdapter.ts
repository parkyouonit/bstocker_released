import { getAddress, isAddress, maxUint128, type Address, type Hash } from 'viem'
import { APP_CONFIG } from '../config'
import {
  erc20Abi,
  merklDistributorAbi,
  pancakeV3LmPoolAbi,
  pancakeV3MasterChefAbi,
  positionManagerAbi,
} from '../abi'
import type {
  MerklClaimItem,
  MerklOpportunity,
  PancakeFarmProgram,
  PoolSummary,
  Position,
  PositionRewardState,
  RewardsData,
} from '../types'
import { ensureBscNetwork, getPublicClient, getWalletClient } from './viem'

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const FARM_RATE_PRECISION = 1e12

type FarmPoolInfo = readonly [bigint, Address, Address, Address, number, bigint, bigint]
type FarmUserInfo = readonly [bigint, bigint, number, number, bigint, bigint, Address, bigint, bigint]

interface MerklTokenPayload {
  address?: string
  symbol?: string
  decimals?: number
}

interface MerklRewardPayload {
  token?: MerklTokenPayload
  amount?: string
  claimed?: string
  pending?: string
  proofs?: string[]
}

interface MerklChainRewardsPayload {
  chain?: { id?: number }
  rewards?: MerklRewardPayload[]
}

function inactiveFarm(reason: string): PancakeFarmProgram {
  return {
    provider: 'pancake-v3',
    status: 'UNAVAILABLE',
    verified: false,
    contract: APP_CONFIG.pancakeV3MasterChefAddress,
    rewardToken: APP_CONFIG.cakeAddress,
    rewardSymbol: 'CAKE',
    rewardRatePerSecond: null,
    reason,
  }
}

async function fetchJson<T>(path: string, signal?: AbortSignal): Promise<T | undefined> {
  try {
    const response = await fetch(`${APP_CONFIG.apiBaseUrl}${path}`, { signal, headers: { accept: 'application/json' } })
    if (!response.ok) return undefined
    return await response.json() as T
  } catch (cause) {
    if (signal?.aborted) throw cause
    return undefined
  }
}

function sameAddress(a: unknown, b: unknown): boolean {
  return String(a).toLowerCase() === String(b).toLowerCase()
}

async function readFarmProgram(summary: PoolSummary): Promise<PancakeFarmProgram> {
  const client = getPublicClient()
  const masterChef = APP_CONFIG.pancakeV3MasterChefAddress
  try {
    const [code, npm, cake, emergency, pid] = await Promise.all([
      client.getBytecode({ address: masterChef }),
      client.readContract({ address: masterChef, abi: pancakeV3MasterChefAbi, functionName: 'nonfungiblePositionManager' }),
      client.readContract({ address: masterChef, abi: pancakeV3MasterChefAbi, functionName: 'CAKE' }),
      client.readContract({ address: masterChef, abi: pancakeV3MasterChefAbi, functionName: 'emergency' }),
      client.readContract({ address: masterChef, abi: pancakeV3MasterChefAbi, functionName: 'v3PoolAddressPid', args: [summary.address] }),
    ])
    if (!code || code === '0x') return inactiveFarm('MasterChef V3 bytecode를 확인하지 못했습니다.')
    if (!sameAddress(npm, APP_CONFIG.npmAddress) || !sameAddress(cake, APP_CONFIG.cakeAddress)) {
      return inactiveFarm('MasterChef의 Position Manager 또는 CAKE 주소가 공식 설정과 다릅니다.')
    }
    if (BigInt(pid) === 0n) {
      return { ...inactiveFarm('선택한 풀에 연결된 Pancake Farm이 없습니다.'), status: 'INACTIVE', verified: true }
    }
    const [poolInfoValue, periodValue, lmPool] = await Promise.all([
      client.readContract({ address: masterChef, abi: pancakeV3MasterChefAbi, functionName: 'poolInfo', args: [BigInt(pid)] }),
      client.readContract({ address: masterChef, abi: pancakeV3MasterChefAbi, functionName: 'getLatestPeriodInfo', args: [summary.address] }),
      client.readContract({ address: summary.address, abi: pancakeV3LmPoolAbi, functionName: 'lmPool' }),
    ])
    const poolInfo = poolInfoValue as FarmPoolInfo
    const period = periodValue as readonly [bigint, bigint]
    const matchesPool = sameAddress(poolInfo[1], summary.address)
      && sameAddress(poolInfo[2], summary.token0.address)
      && sameAddress(poolInfo[3], summary.token1.address)
      && Number(poolInfo[4]) === summary.feeTier
    if (!matchesPool || sameAddress(lmPool, ZERO_ADDRESS)) {
      return inactiveFarm('Farm의 풀·토큰·수수료·LM Pool 구성이 화면과 일치하지 않습니다.')
    }
    const [npmCode, cakeCode, lmPoolCode] = await Promise.all([
      client.getBytecode({ address: APP_CONFIG.npmAddress }),
      client.getBytecode({ address: APP_CONFIG.cakeAddress }),
      client.getBytecode({ address: getAddress(String(lmPool)) }),
    ])
    if (!npmCode || npmCode === '0x' || !cakeCode || cakeCode === '0x' || !lmPoolCode || lmPoolCode === '0x') {
      return inactiveFarm('Farm 의존 컨트랙트의 bytecode를 모두 확인하지 못했습니다.')
    }
    const endsAt = Number(period[1]) * 1000
    const rewardRatePerSecond = Number(period[0]) / FARM_RATE_PRECISION / 1e18
    const active = !emergency && poolInfo[0] > 0n && period[0] > 0n && endsAt > Date.now()
    return {
      provider: 'pancake-v3',
      status: active ? 'ACTIVE' : endsAt > 0 && endsAt <= Date.now() ? 'ENDED' : 'INACTIVE',
      verified: true,
      contract: masterChef,
      pid: BigInt(pid),
      rewardToken: getAddress(String(cake)),
      rewardSymbol: 'CAKE',
      rewardRatePerSecond: Number.isFinite(rewardRatePerSecond) ? rewardRatePerSecond : null,
      endsAt,
      totalLiquidity: BigInt(poolInfo[5]),
      reason: emergency ? 'MasterChef가 비상 모드입니다.' : active ? undefined : '현재 CAKE 배출이 중단됐거나 기간이 종료됐습니다.',
    }
  } catch (cause) {
    return inactiveFarm(cause instanceof Error ? cause.message : 'Farm 상태를 읽지 못했습니다.')
  }
}

function normalizeMerklOpportunity(payload: unknown): MerklOpportunity {
  const value = payload && typeof payload === 'object' ? payload as Record<string, unknown> : undefined
  if (!value) return { provider: 'merkl', status: 'UNAVAILABLE', apr: null, liveCampaigns: 0, reason: 'Merkl 응답을 받지 못했습니다.' }
  const sourceStatus = String(value.status || '').toUpperCase()
  const liveCampaigns = Math.max(0, Number(value.liveCampaigns || 0))
  const apr = Number(value.apr)
  return {
    provider: 'merkl',
    status: sourceStatus === 'LIVE' && liveCampaigns > 0 ? 'ACTIVE' : sourceStatus === 'PAST' ? 'ENDED' : 'INACTIVE',
    apr: Number.isFinite(apr) && apr >= 0 ? apr : null,
    liveCampaigns,
    name: typeof value.name === 'string' ? value.name : undefined,
    reason: sourceStatus === 'PAST' ? '추가 보상 캠페인이 종료됐습니다. 남은 개인 보상은 계속 확인할 수 있습니다.' : undefined,
  }
}

async function loadMerklClaims(owner?: Address, signal?: AbortSignal, refresh = false): Promise<MerklClaimItem[]> {
  if (!owner) return []
  const payload = await fetchJson<MerklChainRewardsPayload[]>(`/api/rewards/merkl/user/${owner}${refresh ? '?refresh=1' : ''}`, signal)
  const groups = Array.isArray(payload) ? payload : []
  const rewards = groups.filter(group => Number(group.chain?.id) === APP_CONFIG.chainId).flatMap(group => Array.isArray(group.rewards) ? group.rewards : [])
  return rewards.flatMap(reward => {
    const tokenAddress = reward.token?.address
    if (!tokenAddress || !isAddress(tokenAddress)) return []
    try {
      const amount = BigInt(reward.amount || '0')
      const claimed = BigInt(reward.claimed || '0')
      const pending = BigInt(reward.pending || '0')
      const proofs = (Array.isArray(reward.proofs) ? reward.proofs : []).filter((proof): proof is `0x${string}` => /^0x[0-9a-fA-F]{64}$/.test(proof))
      return [{
        token: getAddress(tokenAddress),
        symbol: reward.token?.symbol || 'TOKEN',
        decimals: Number(reward.token?.decimals ?? 18),
        amount,
        claimed,
        claimable: amount > claimed ? amount - claimed : 0n,
        pending,
        proofs,
      }]
    } catch {
      return []
    }
  })
}

export async function loadRewardsData(summary: PoolSummary, owner: Address | undefined, positions: Position[], signal?: AbortSignal): Promise<RewardsData> {
  const [farm, merklPayload, merklClaims] = await Promise.all([
    readFarmProgram(summary),
    fetchJson<unknown>(`/api/rewards/merkl/opportunity?pool=${summary.address}`, signal),
    loadMerklClaims(owner, signal),
  ])
  const staked = positions.filter(position => position.farmStaked)
  const pendingResults = owner && staked.length
    ? await getPublicClient().multicall({
      allowFailure: true,
      contracts: staked.map(position => ({
        address: APP_CONFIG.pancakeV3MasterChefAddress,
        abi: pancakeV3MasterChefAbi,
        functionName: 'pendingCake' as const,
        args: [position.tokenId],
      })),
    })
    : []
  const positionRewards: Record<string, PositionRewardState> = {}
  positions.forEach((position, index) => {
    const pendingResult = position.farmStaked ? pendingResults[staked.findIndex(item => item.tokenId === position.tokenId)] : undefined
    const pendingRaw = pendingResult?.status === 'success' ? BigInt(pendingResult.result) : 0n
    positionRewards[position.tokenId.toString()] = {
      tokenId: position.tokenId,
      staked: Boolean(position.farmStaked),
      pendingCake: Number(pendingRaw) / 1e18,
      pendingCakeRaw: pendingRaw,
      farmPid: position.farmStaked ? farm.pid : undefined,
    }
  })
  const warnings: string[] = []
  if (!farm.verified) warnings.push(farm.reason || 'Farm 검증에 실패했습니다.')
  if (farm.status !== 'ACTIVE' && farm.reason) warnings.push(farm.reason)
  const merkl = normalizeMerklOpportunity(merklPayload)
  if (merkl.status === 'UNAVAILABLE') warnings.push(merkl.reason || 'Merkl 상태를 확인하지 못했습니다.')
  return { farm, merkl, positions: positionRewards, merklClaims, warnings, updatedAt: Date.now() }
}

function assertRewardWritesEnabled(): void {
  if (!APP_CONFIG.enableMainnetWrites || !APP_CONFIG.enableRewardWrites) {
    throw new Error('보상 계약 쓰기 설정이 비활성화되어 있습니다.')
  }
}

async function assertFarmWriteContext(summary: PoolSummary, account: Address, tokenId: bigint, requireActive: boolean): Promise<{ farm: PancakeFarmProgram; userInfo: FarmUserInfo }> {
  assertRewardWritesEnabled()
  await ensureBscNetwork()
  const farm = await readFarmProgram(summary)
  if (!farm.verified || !farm.pid) throw new Error(farm.reason || '검증된 Pancake Farm이 아닙니다.')
  if (requireActive && farm.status !== 'ACTIVE') throw new Error('현재 보상 배출이 활성화된 Farm이 아닙니다.')
  const userInfo = await getPublicClient().readContract({
    address: APP_CONFIG.pancakeV3MasterChefAddress,
    abi: pancakeV3MasterChefAbi,
    functionName: 'userPositionInfos',
    args: [tokenId],
  }) as FarmUserInfo
  if (userInfo[7] !== 0n && (!sameAddress(userInfo[6], account) || userInfo[7] !== farm.pid)) {
    throw new Error('Farm에 기록된 포지션 사용자 또는 풀이 현재 지갑과 일치하지 않습니다.')
  }
  return { farm, userInfo }
}

export async function stakePancakePosition(summary: PoolSummary, position: Position, account: Address): Promise<Hash> {
  if (position.liquidity <= 0n) throw new Error('유동성이 0인 LP NFT는 Farm에 스테이킹할 수 없습니다.')
  const { userInfo } = await assertFarmWriteContext(summary, account, position.tokenId, true)
  if (userInfo[7] !== 0n) throw new Error('이미 Farm에 스테이킹된 포지션입니다.')
  const owner = await getPublicClient().readContract({ address: APP_CONFIG.npmAddress, abi: positionManagerAbi, functionName: 'ownerOf', args: [position.tokenId] })
  if (!sameAddress(owner, account)) throw new Error('현재 지갑이 이 LP NFT의 소유자가 아닙니다.')
  const simulation = await getPublicClient().simulateContract({
    account,
    address: APP_CONFIG.npmAddress,
    abi: positionManagerAbi,
    functionName: 'safeTransferFrom',
    args: [account, APP_CONFIG.pancakeV3MasterChefAddress, position.tokenId],
  })
  return getWalletClient().writeContract(simulation.request)
}

export async function harvestPancakePosition(summary: PoolSummary, position: Position, account: Address): Promise<Hash> {
  const { userInfo } = await assertFarmWriteContext(summary, account, position.tokenId, false)
  if (userInfo[7] === 0n || !sameAddress(userInfo[6], account)) throw new Error('현재 지갑의 스테이킹 포지션이 아닙니다.')
  const simulation = await getPublicClient().simulateContract({
    account,
    address: APP_CONFIG.pancakeV3MasterChefAddress,
    abi: pancakeV3MasterChefAbi,
    functionName: 'harvest',
    args: [position.tokenId, account],
  })
  return getWalletClient().writeContract(simulation.request)
}

export async function unstakePancakePosition(summary: PoolSummary, position: Position, account: Address): Promise<Hash> {
  const { userInfo } = await assertFarmWriteContext(summary, account, position.tokenId, false)
  if (userInfo[7] === 0n || !sameAddress(userInfo[6], account)) throw new Error('현재 지갑의 스테이킹 포지션이 아닙니다.')
  const simulation = await getPublicClient().simulateContract({
    account,
    address: APP_CONFIG.pancakeV3MasterChefAddress,
    abi: pancakeV3MasterChefAbi,
    functionName: 'withdraw',
    args: [position.tokenId, account],
  })
  return getWalletClient().writeContract(simulation.request)
}

export async function collectStakedPancakePosition(summary: PoolSummary, position: Position, account: Address): Promise<Hash> {
  const { userInfo } = await assertFarmWriteContext(summary, account, position.tokenId, false)
  if (userInfo[7] === 0n || !sameAddress(userInfo[6], account)) throw new Error('현재 지갑의 스테이킹 포지션이 아닙니다.')
  const simulation = await getPublicClient().simulateContract({
    account,
    address: APP_CONFIG.pancakeV3MasterChefAddress,
    abi: pancakeV3MasterChefAbi,
    functionName: 'collect',
    args: [{ tokenId: position.tokenId, recipient: account, amount0Max: maxUint128, amount1Max: maxUint128 }],
  })
  return getWalletClient().writeContract(simulation.request)
}

export async function claimMerklRewards(account: Address): Promise<Hash> {
  assertRewardWritesEnabled()
  await ensureBscNetwork()
  const client = getPublicClient()
  const distributor = APP_CONFIG.merklDistributorAddress
  const [code, claims] = await Promise.all([client.getBytecode({ address: distributor }), loadMerklClaims(account, undefined, true)])
  if (!code || code === '0x') throw new Error('Merkl Distributor 컨트랙트를 BNB Chain에서 확인하지 못했습니다.')
  const candidates = claims.filter(claim => claim.amount > 0n && claim.proofs.length > 0)
  if (!candidates.length) throw new Error('현재 청구 가능한 Merkl 보상이 없습니다.')
  const onchainClaimed = await client.multicall({
    allowFailure: true,
    contracts: candidates.map(claim => ({ address: distributor, abi: merklDistributorAbi, functionName: 'claimed' as const, args: [account, claim.token] })),
  })
  const verified = candidates.filter((claim, index) => {
    const result = onchainClaimed[index]
    return result?.status === 'success' && claim.amount > BigInt((result.result as readonly [bigint, number, `0x${string}`])[0])
  })
  if (!verified.length) throw new Error('온체인 기준으로 청구 가능한 Merkl 보상이 없습니다.')
  const simulation = await client.simulateContract({
    account,
    address: distributor,
    abi: merklDistributorAbi,
    functionName: 'claim',
    args: [
      verified.map(() => account),
      verified.map(claim => claim.token),
      verified.map(claim => claim.amount),
      verified.map(claim => claim.proofs),
    ],
  })
  return getWalletClient().writeContract(simulation.request)
}
