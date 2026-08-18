import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPublicClient, defineChain, encodeDeployData, getAddress, http } from 'viem'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const artifact = JSON.parse(readFileSync(join(root, 'contracts', 'build', 'BStockerThreeTickVault.json'), 'utf8'))
const rpcUrl = process.env.ROBINHOOD_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com'
const chain = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
})
const client = createPublicClient({ chain, transport: http(rpcUrl, { timeout: 15_000 }) })
const owner = getAddress('0x000000000000000000000000000000000000B501')
const recipient = getAddress('0x000000000000000000000000000000000000B502')
const keeper = getAddress('0x000000000000000000000000000000000000B503')
const guardian = getAddress('0x000000000000000000000000000000000000B504')
const data = encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode, args: [owner, recipient, keeper, guardian] })
const result = await client.call({ account: owner, data })
if (!result.data || result.data === '0x') throw new Error('Constructor eth_call이 runtime bytecode를 반환하지 않았습니다.')
console.log(`Robinhood mainnet constructor simulation passed at block ${await client.getBlockNumber()}`)
console.log(`Returned runtime bytecode: ${(result.data.length - 2) / 2} bytes`)
