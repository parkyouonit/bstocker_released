import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getAddress } from 'viem'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

function loadEnvironment() {
  const file = join(root, '.env.local')
  if (!existsSync(file)) return
  for (const rawLine of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const separator = line.indexOf('=')
    if (separator < 1) continue
    const key = line.slice(0, separator).trim()
    let value = line.slice(separator + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    if (!(key in process.env)) process.env[key] = value
  }
}

function loadAutomationConfig() {
  const file = join(root, 'work', 'robinhood-automation-config.json')
  if (!existsSync(file)) return {}
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
}

loadEnvironment()
const automation = loadAutomationConfig()

export function robinhoodLocalAddress(environmentKey, configKey) {
  const value = process.env[environmentKey] || automation[configKey]
  if (!value) throw new Error(`${environmentKey} 또는 로컬 자동화 설정 ${configKey} 값이 필요합니다.`)
  return getAddress(value)
}
