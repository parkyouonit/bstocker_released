import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import solc from 'solc'
import { createPublicClient, decodeAbiParameters, defineChain, getAddress, http, parseAbiParameters } from 'viem'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const vaultSource = readFileSync(join(root, 'contracts', 'BStockerThreeTickVault.sol'), 'utf8')
const rpcUrl = process.env.ROBINHOOD_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com'
const probeSource = `
pragma solidity 0.8.30;
import "./BStockerThreeTickVault.sol";

contract BStockerBalanceProbe {
    constructor() {
        BStockerThreeTickVault vault = new BStockerThreeTickVault(
            address(0xB501), address(0xB502), address(0xB503), address(0xB504)
        );
        (address a0, uint256 a1, uint256 a2, uint160 a3, int24 a4, int24 a5) = vault.previewBalance(0, 200 * 1e6);
        (address b0, uint256 b1, uint256 b2, uint160 b3, int24 b4, int24 b5) = vault.previewBalance(1 ether, 0);
        bytes memory output = abi.encode(a0, a1, a2, a3, a4, a5, b0, b1, b2, b3, b4, b5);
        assembly { return(add(output, 32), mload(output)) }
    }
}
`

const input = {
  language: 'Solidity',
  sources: {
    'BStockerThreeTickVault.sol': { content: vaultSource },
    'BStockerBalanceProbe.sol': { content: probeSource },
  },
  settings: {
    optimizer: { enabled: true, runs: 500 },
    viaIR: true,
    outputSelection: { '*': { '*': ['evm.bytecode.object'] } },
  },
}
const output = JSON.parse(solc.compile(JSON.stringify(input)))
const errors = (output.errors || []).filter(item => item.severity === 'error')
if (errors.length) throw new Error(errors.map(item => item.formattedMessage).join('\n'))
const object = output.contracts['BStockerBalanceProbe.sol'].BStockerBalanceProbe.evm.bytecode.object
const chain = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
})
const client = createPublicClient({ chain, transport: http(rpcUrl, { timeout: 20_000, retryCount: 2 }) })
const result = await client.call({ data: `0x${object}`, gas: 15_000_000n })
if (!result.data || result.data === '0x') throw new Error('메인넷 preview probe가 결과를 반환하지 않았습니다.')
const decoded = decodeAbiParameters(parseAbiParameters(
  'address,uint256,uint256,uint160,int24,int24,address,uint256,uint256,uint160,int24,int24',
), result.data)
const usdg = getAddress('0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168')
const spcx = getAddress('0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa')
assert.equal(getAddress(decoded[0]), usdg)
assert.ok(decoded[1] > 0n && decoded[1] < 200n * 10n ** 6n)
assert.ok(decoded[2] > 0n)
assert.equal(getAddress(decoded[6]), spcx)
assert.ok(decoded[7] > 0n && decoded[7] < 10n ** 18n)
assert.ok(decoded[8] > 0n)
assert.equal(decoded[4], decoded[10])
assert.equal(decoded[5], decoded[11])

console.log(JSON.stringify({
  blockNumber: (await client.getBlockNumber()).toString(),
  range: { lower: Number(decoded[4]), upper: Number(decoded[5]) },
  oneSided200Usdg: {
    tokenIn: decoded[0],
    amountInUsdg: Number(decoded[1]) / 1e6,
    minimumSpcxOut: Number(decoded[2]) / 1e18,
  },
  oneSidedOneSpcx: {
    tokenIn: decoded[6],
    amountInSpcx: Number(decoded[7]) / 1e18,
    minimumUsdgOut: Number(decoded[8]) / 1e6,
  },
}, null, 2))
