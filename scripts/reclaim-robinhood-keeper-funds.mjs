import { createConnection } from 'node:net'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { createPublicClient, createWalletClient, formatEther, getAddress, http, isAddress } from 'viem'
import { ROBINHOOD_CHAIN } from '../server/robinhood.mjs'
import { loadAutomationConfig } from '../server/robinhood-automation.mjs'
import { loadKeeperAccount } from '../server/robinhood-keeper-key.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

function loadEnvironment(file) {
  if (!existsSync(file)) return {}
  return Object.fromEntries(readFileSync(file, 'utf8').split(/\r?\n/).flatMap(raw => {
    const line = raw.trim()
    if (!line || line.startsWith('#')) return []
    const index = line.indexOf('=')
    if (index <= 0) return []
    return [[line.slice(0, index).trim(), line.slice(index + 1).trim().replace(/^['"]|['"]$/g, '')]]
  }))
}

export function keeperSweepAmount(balance, gasPrice, gas = 21_000n) {
  const fee = gas * gasPrice
  if (balance <= fee) return { fee, value: 0n }
  return { fee, value: balance - fee }
}

function portOpen(port) {
  return new Promise(resolvePort => {
    const socket = createConnection({ host: '127.0.0.1', port })
    let settled = false
    const finish = value => {
      if (settled) return
      settled = true
      socket.destroy()
      resolvePort(value)
    }
    socket.setTimeout(500)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

async function main() {
  if (await portOpen(8787)) throw new Error('bStocker API가 실행 중입니다. 먼저 실행 창에서 Ctrl+C로 앱과 Keeper를 완전히 종료하세요.')
  const environment = { ...loadEnvironment(join(root, '.env')), ...loadEnvironment(join(root, '.env.local')) }
  const ownerCandidate = environment.ROBINHOOD_AUTOMATION_OWNER || ''
  if (!isAddress(ownerCandidate)) throw new Error('.env.local의 ROBINHOOD_AUTOMATION_OWNER가 올바르지 않습니다.')
  const owner = getAddress(ownerCandidate)
  const config = loadAutomationConfig()
  if (config?.armed) throw new Error('자동화가 아직 켜져 있습니다. 앱에서 자동화를 끄고 상태가 반영된 뒤 앱을 종료하세요.')
  if (config?.ownerAddress && getAddress(config.ownerAddress) !== owner) throw new Error('자동화 설정 owner와 .env.local owner가 일치하지 않습니다.')

  const account = loadKeeperAccount()
  const rpcUrl = environment.ROBINHOOD_RPC_URL || environment.VITE_ROBINHOOD_RPC_URL || ROBINHOOD_CHAIN.rpcUrls.default.http[0]
  const publicClient = createPublicClient({ chain: ROBINHOOD_CHAIN, transport: http(rpcUrl, { timeout: 12_000 }) })
  const [balance, gasPrice] = await Promise.all([publicClient.getBalance({ address: account.address }), publicClient.getGasPrice()])
  const sweep = keeperSweepAmount(balance, gasPrice)
  console.log(`Keeper: ${account.address}`)
  console.log(`받는 주소: ${owner}`)
  console.log(`현재 잔액: ${formatEther(balance)} ETH`)
  console.log(`예상 네트워크 수수료: ${formatEther(sweep.fee)} ETH`)
  console.log(`예상 회수액: ${formatEther(sweep.value)} ETH`)
  if (sweep.value <= 0n) throw new Error('전송 수수료를 제외하면 회수할 ETH가 없습니다.')
  if (!process.argv.includes('--send')) {
    console.log('미리보기만 완료했습니다. 실제 회수는 운영체제별 3_RECLAIM_KEEPER_FUNDS 실행 파일을 사용하세요.')
    return
  }

  const prompt = createInterface({ input: stdin, output: stdout })
  const answer = (await prompt.question('실제 전송을 승인하려면 받는 주소 전체를 다시 입력하세요: ')).trim()
  prompt.close()
  if (!isAddress(answer) || getAddress(answer) !== owner) throw new Error('주소가 일치하지 않아 취소했습니다.')

  const walletClient = createWalletClient({ account, chain: ROBINHOOD_CHAIN, transport: http(rpcUrl, { timeout: 12_000 }) })
  const hash = await walletClient.sendTransaction({ account, to: owner, value: sweep.value, gas: 21_000n, gasPrice })
  const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 90_000 })
  if (receipt.status !== 'success') throw new Error('Keeper ETH 회수 트랜잭션이 완료되지 않았습니다.')
  const remaining = await publicClient.getBalance({ address: account.address })
  console.log(`회수 완료: ${hash}`)
  console.log(`Keeper 잔액: ${formatEther(remaining)} ETH`)
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : ''
const modulePath = fileURLToPath(import.meta.url)
const isDirectInvocation = process.platform === 'win32'
  ? invokedPath.toLowerCase() === modulePath.toLowerCase()
  : invokedPath === modulePath

if (isDirectInvocation) {
  main().catch(error => {
    console.error(`[오류] ${error instanceof Error ? error.message : error}`)
    process.exitCode = 1
  })
}
