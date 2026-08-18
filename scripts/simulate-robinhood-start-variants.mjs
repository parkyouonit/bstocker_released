import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import solc from 'solc'
import {
  createPublicClient,
  decodeErrorResult,
  decodeFunctionResult,
  encodeDeployData,
  encodeFunctionData,
  getAddress,
  http,
  parseAbi,
} from 'viem'
import { robinhoodLocalAddress } from './robinhood-local-config.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const source = readFileSync(join(root, 'contracts', 'BStockerThreeTickVault.sol'), 'utf8')
const rpcUrl = process.env.ROBINHOOD_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com'
const owner = robinhoodLocalAddress('ROBINHOOD_AUTOMATION_OWNER', 'ownerAddress')
const keeper = robinhoodLocalAddress('ROBINHOOD_KEEPER_ADDRESS', 'keeperAddress')
const vault = robinhoodLocalAddress('ROBINHOOD_EXECUTOR_ADDRESS', 'executorAddress')
const pool = getAddress('0x9d590437ABaAe12cf9fE0627cAF4CFd633152599')
const amountUsdg = BigInt(process.env.ROBINHOOD_TEST_USDG || '350000000')

const input = {
  language: 'Solidity',
  sources: { 'BStockerThreeTickVault.sol': { content: source } },
  settings: {
    optimizer: { enabled: true, runs: 500 },
    viaIR: true,
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } },
  },
}
const output = JSON.parse(solc.compile(JSON.stringify(input)))
const errors = (output.errors || []).filter(item => item.severity === 'error')
if (errors.length) throw new Error(errors.map(item => item.formattedMessage).join('\n'))
const compiled = output.contracts['BStockerThreeTickVault.sol'].BStockerThreeTickVault
const abi = compiled.abi
const bytecode = `0x${compiled.evm.bytecode.object}`

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

const deployData = encodeDeployData({ abi, bytecode, args: [owner, owner, keeper, owner] })
const runtimeResponse = await rpc('eth_call', [{ from: owner, data: deployData, gas: '0x2faf080' }, 'latest'], 1)
if (runtimeResponse.error) throw new Error(JSON.stringify(runtimeResponse.error))
const callData = encodeFunctionData({
  abi,
  functionName: 'start',
  args: [0n, amountUsdg, slot0[1], block.timestamp + 240n],
})
const call = { from: owner, to: vault, data: callData, gas: '0x2faf080' }
const stateOverride = { [vault]: { code: runtimeResponse.result } }
const response = await rpc('eth_call', [call, 'latest', stateOverride], 2)
if (response.error) {
  let decodedError = null
  try {
    const decoded = decodeErrorResult({ abi, data: response.error.data })
    decodedError = { name: decoded.errorName, args: decoded.args?.map(value => value.toString()) || [] }
  } catch {}
  console.error(JSON.stringify({ success: false, reason: response.error.message, data: response.error.data || null, decodedError }))
  process.exitCode = 1
} else {
  const tokenId = decodeFunctionResult({ abi, functionName: 'start', data: response.result })
  const gasResponse = await rpc('eth_estimateGas', [call, 'latest', stateOverride], 3)
  console.log(JSON.stringify({
    success: true,
    version: '2.9.0',
    tokenId: tokenId.toString(),
    estimatedGas: gasResponse.error ? null : Number(BigInt(gasResponse.result)),
    estimateError: gasResponse.error || null,
    runtimeBytes: compiled.evm.deployedBytecode.object.length / 2,
    tick: Number(slot0[1]),
    amountUsdg: Number(amountUsdg) / 1e6,
    actualTransactionSent: false,
  }))
}
