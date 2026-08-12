import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const exampleFile = join(root, '.env.example')
const localFile = join(root, '.env.local')
const owner = String(process.argv[2] || '').trim()
const force = process.argv.includes('--force')

if (!/^0x[0-9a-fA-F]{40}$/.test(owner)) {
  console.error('올바른 EVM 지갑 주소를 입력하세요. 예: 0x + 40자리')
  process.exit(1)
}

if (existsSync(localFile) && !force) {
  console.error('.env.local이 이미 있습니다. 기존 설정을 유지했습니다.')
  console.error('다시 만들려면: node scripts/setup-release.mjs <지갑주소> --force')
  process.exit(1)
}

function setValue(source, key, value) {
  const line = `${key}=${value}`
  const matcher = new RegExp(`^${key}=.*$`, 'm')
  return matcher.test(source) ? source.replace(matcher, line) : `${source.trimEnd()}\n${line}\n`
}

let environment = readFileSync(exampleFile, 'utf8')
environment = setValue(environment, 'ROBINHOOD_KEEPER_MODE', 'auto')
environment = setValue(environment, 'ROBINHOOD_LIVE_AUTOMATION_ALLOWED', 'true')
environment = setValue(environment, 'ROBINHOOD_AUTOMATION_OWNER', owner)
environment = setValue(environment, 'VITE_ENABLE_ROBINHOOD_STRATEGY_WRITES', 'true')
environment = setValue(environment, 'VITE_ENABLE_ROBINHOOD_ORACLE_PREP', 'true')
environment = setValue(environment, 'VITE_ENABLE_MAINNET_WRITES', 'false')
environment = setValue(environment, 'VITE_ENABLE_REWARD_WRITES', 'false')
environment = setValue(environment, 'VITE_ENABLE_MAINNET_BRIDGE', 'false')
writeFileSync(localFile, environment, 'utf8')

console.log(`로컬 owner 설정 완료: ${owner}`)
console.log('개인키는 저장하지 않았습니다. 첫 실행 때 이 Windows 계정 전용 Keeper가 별도로 생성됩니다.')
