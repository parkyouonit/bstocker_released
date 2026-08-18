import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import solc from 'solc'
import {
  createPublicClient,
  decodeFunctionResult,
  encodeDeployData,
  encodeFunctionData,
  getAddress,
  http,
  parseAbi,
} from 'viem'
import { robinhoodLocalAddress } from './robinhood-local-config.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const baseSource = readFileSync(join(root, 'contracts', 'BStockerThreeTickVault.sol'), 'utf8')
const rpcUrl = process.env.ROBINHOOD_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com'
const owner = robinhoodLocalAddress('ROBINHOOD_AUTOMATION_OWNER', 'ownerAddress')
const keeper = robinhoodLocalAddress('ROBINHOOD_KEEPER_ADDRESS', 'keeperAddress')
const vault = robinhoodLocalAddress('ROBINHOOD_EXECUTOR_ADDRESS', 'executorAddress')
const pool = getAddress('0x9d590437ABaAe12cf9fE0627cAF4CFd633152599')
const candidates = [
  { passes: 8, priceLimitTicks: 35, slippageBps: 100, maxUnusedBps: 100 },
  { passes: 8, priceLimitTicks: 40, slippageBps: 100, maxUnusedBps: 100 },
  { passes: 8, priceLimitTicks: 45, slippageBps: 100, maxUnusedBps: 100 },
  { passes: 8, priceLimitTicks: 50, slippageBps: 100, maxUnusedBps: 100 },
]

const sources = Object.fromEntries(candidates.map(candidate => {
  const key = `p${candidate.passes}-l${candidate.priceLimitTicks}-s${candidate.slippageBps}-u${candidate.maxUnusedBps}`
  const content = baseSource
    .replace(/uint256 public constant MAX_BALANCE_PASSES = \d+;/, `uint256 public constant MAX_BALANCE_PASSES = ${candidate.passes};`)
    .replace(/int24 public constant SWAP_PRICE_LIMIT_TICKS = \d+;/, `int24 public constant SWAP_PRICE_LIMIT_TICKS = ${candidate.priceLimitTicks};`)
    .replace(/int24 public constant SPOT_TWAP_30_MAX_TICKS = \d+;/, `int24 public constant SPOT_TWAP_30_MAX_TICKS = ${candidate.priceLimitTicks + 10};`)
    .replace(/uint256 public constant NORMAL_SLIPPAGE_BPS = \d+;/, `uint256 public constant NORMAL_SLIPPAGE_BPS = ${candidate.slippageBps};`)
    .replace(/uint256 public constant MAX_UNUSED_BPS = \d+;/, `uint256 public constant MAX_UNUSED_BPS = ${candidate.maxUnusedBps};`)
  return [`${key}.sol`, { content }]
}))
const input = {
  language: 'Solidity',
  sources,
  settings: {
    optimizer: { enabled: true, runs: 500 },
    viaIR: true,
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } },
  },
}
const output = JSON.parse(solc.compile(JSON.stringify(input)))
const errors = (output.errors || []).filter(item => item.severity === 'error')
if (errors.length) throw new Error(errors.map(item => item.formattedMessage).join('\n'))

const poolAbi = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,bool unlocked)',
])
const client = createPublicClient({ transport: http(rpcUrl, { timeout: 30_000, retryCount: 2 }) })
const [slot0, block] = await Promise.all([
  client.readContract({ address: pool, abi: poolAbi, functionName: 'slot0' }),
  client.getBlock(),
])

async function rpc(method, params, id) {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  })
  return response.json()
}

for (const [index, candidate] of candidates.entries()) {
  const key = `p${candidate.passes}-l${candidate.priceLimitTicks}-s${candidate.slippageBps}-u${candidate.maxUnusedBps}`
  const compiled = output.contracts[`${key}.sol`].BStockerThreeTickVault
  const abi = compiled.abi
  const deployData = encodeDeployData({
    abi,
    bytecode: `0x${compiled.evm.bytecode.object}`,
    args: [owner, owner, keeper, owner],
  })
  const runtimeResponse = await rpc('eth_call', [{ from: owner, data: deployData, gas: '0x2faf080' }, 'latest'], index * 3 + 1)
  if (runtimeResponse.error) {
    console.log(JSON.stringify({ ...candidate, success: false, phase: 'runtime', error: runtimeResponse.error }))
    continue
  }
  const callData = encodeFunctionData({
    abi,
    functionName: 'rebalanceAuto',
    args: [slot0[1], block.timestamp + 30n],
  })
  const call = { from: keeper, to: vault, data: callData, gas: '0x2faf080' }
  const zeroWord = `0x${'0'.repeat(64)}`
  const storageSlot = value => `0x${value.toString(16).padStart(64, '0')}`
  const stateOverride = {
    [vault]: {
      code: runtimeResponse.result,
      // 읽기 전용 비교에서 재배치 시간·횟수 제한만 비워 각 후보의 민트 경로까지 검사한다.
      stateDiff: {
        [storageSlot(8)]: zeroWord,
        [storageSlot(9)]: zeroWord,
        [storageSlot(10)]: zeroWord,
        [storageSlot(11)]: zeroWord,
      },
    },
  }
  const response = await rpc('eth_call', [call, 'latest', stateOverride], index * 3 + 2)
  if (response.error) {
    console.log(JSON.stringify({ ...candidate, success: false, phase: 'rebalance', reason: response.error.message, data: response.error.data || null }))
    continue
  }
  const tokenId = decodeFunctionResult({ abi, functionName: 'rebalanceAuto', data: response.result })
  const gasResponse = await rpc('eth_estimateGas', [call, 'latest', stateOverride], index * 3 + 3)
  console.log(JSON.stringify({
    ...candidate,
    success: true,
    tokenId: tokenId.toString(),
    estimatedGas: gasResponse.error ? null : Number(BigInt(gasResponse.result)),
    estimateError: gasResponse.error || null,
    runtimeBytes: compiled.evm.deployedBytecode.object.length / 2,
  }))
}

console.log(JSON.stringify({ vault, tick: Number(slot0[1]), actualTransactionSent: false }))
