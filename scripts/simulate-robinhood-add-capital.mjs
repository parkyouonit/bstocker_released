import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  concatHex,
  createPublicClient,
  decodeFunctionResult,
  encodeDeployData,
  encodeFunctionData,
  getAddress,
  http,
  keccak256,
  pad,
  parseAbi,
  toHex,
} from 'viem'
import { robinhoodLocalAddress } from './robinhood-local-config.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const artifact = JSON.parse(readFileSync(join(root, 'contracts', 'build', 'BStockerThreeTickVault.json'), 'utf8'))
const rpcUrl = process.env.ROBINHOOD_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com'
const owner = robinhoodLocalAddress('ROBINHOOD_AUTOMATION_OWNER', 'ownerAddress')
const keeper = robinhoodLocalAddress('ROBINHOOD_KEEPER_ADDRESS', 'keeperAddress')
const vault = robinhoodLocalAddress('ROBINHOOD_EXECUTOR_ADDRESS', 'executorAddress')
const pool = getAddress('0x9d590437ABaAe12cf9fE0627cAF4CFd633152599')
const usdg = getAddress('0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168')
const amountUsdg = 1_000_000n

const poolAbi = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,bool unlocked)',
])
const erc20Abi = parseAbi(['function allowance(address owner,address spender) view returns (uint256)'])
const currentVaultAbi = parseAbi(['function activeTokenId() view returns (uint256)'])
const client = createPublicClient({ transport: http(rpcUrl, { timeout: 20_000, retryCount: 2 }) })

function mappingSlot(address, slot) {
  const encodedSlot = typeof slot === 'bigint' ? toHex(slot, { size: 32 }) : pad(slot, { size: 32 })
  return keccak256(concatHex([pad(address, { size: 32 }), encodedSlot]))
}

// USDG BaseStorageV3 declares `allowed` at slot 3. The nested key order is
// allowed[owner][spender], so the outer owner hash is used as the inner slot.
const allowanceMappingSlot = 3n
const allowanceSlot = mappingSlot(vault, mappingSlot(owner, allowanceMappingSlot))
const deployData = encodeDeployData({
  abi: artifact.abi,
  bytecode: artifact.bytecode,
  args: [owner, owner, keeper, owner],
})
const [runtimeResponse, slot0, block, currentTokenId] = await Promise.all([
  fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ from: owner, data: deployData, gas: '0x2faf080' }, 'latest'] }),
  }).then(response => response.json()),
  client.readContract({ address: pool, abi: poolAbi, functionName: 'slot0' }),
  client.getBlock(),
  client.readContract({ address: vault, abi: currentVaultAbi, functionName: 'activeTokenId' }),
])
if (runtimeResponse.error) throw new Error(`v2.5 runtime 생성 실패: ${JSON.stringify(runtimeResponse.error)}`)

const allowanceData = encodeFunctionData({ abi: erc20Abi, functionName: 'allowance', args: [owner, vault] })
const allowanceResponse = await fetch(rpcUrl, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 2,
    method: 'eth_call',
    params: [{ to: usdg, data: allowanceData }, 'latest', { [usdg]: { stateDiff: { [allowanceSlot]: toHex(amountUsdg, { size: 32 }) } } }],
  }),
}).then(response => response.json())
if (allowanceResponse.error) throw new Error(`USDG allowance 상태 대체 실패: ${JSON.stringify(allowanceResponse.error)}`)
const overriddenAllowance = decodeFunctionResult({ abi: erc20Abi, functionName: 'allowance', data: allowanceResponse.result })
if (overriddenAllowance !== amountUsdg) throw new Error(`USDG allowance 슬롯 검증 실패: ${overriddenAllowance}`)

const stateOverride = {
  [vault]: { code: runtimeResponse.result },
  [usdg]: { stateDiff: { [allowanceSlot]: toHex(amountUsdg, { size: 32 }) } },
}
const callData = encodeFunctionData({
  abi: artifact.abi,
  functionName: 'addCapital',
  args: [0n, amountUsdg, slot0[1], block.timestamp + 240n],
})
const call = { from: owner, to: vault, data: callData, gas: '0x2faf080' }
const response = await fetch(rpcUrl, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'eth_call', params: [call, 'latest', stateOverride] }),
}).then(value => value.json())
if (response.error) throw new Error(`addCapital 전체 시뮬레이션 실패: ${JSON.stringify(response.error)}`)
const nextTokenId = decodeFunctionResult({ abi: artifact.abi, functionName: 'addCapital', data: response.result })

const gasResponse = await fetch(rpcUrl, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'eth_estimateGas', params: [call, 'latest', stateOverride] }),
}).then(value => value.json())

console.log(JSON.stringify({
  version: '2.5.0',
  currentVault: vault,
  currentTokenIdReplacedInSimulation: currentTokenId.toString(),
  addedUsdg: '1.0',
  nextTokenId: nextTokenId.toString(),
  tick: Number(slot0[1]),
  allowanceMappingSlot: Number(allowanceMappingSlot),
  estimatedGas: gasResponse.error ? null : Number(BigInt(gasResponse.result)),
  estimateError: gasResponse.error || null,
  actualTransactionSent: false,
}, null, 2))
