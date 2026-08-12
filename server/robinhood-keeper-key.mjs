import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const secretDirectory = join(root, '.secrets')
export const keeperKeyFile = join(secretDirectory, 'robinhood-keeper.dpapi.json')
const temporaryKeyFile = join(secretDirectory, 'robinhood-keeper.dpapi.tmp.json')
const entropyLabel = 'bStocker Robinhood keeper v1'

const protectScript = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$plain = [Console]::In.ReadToEnd()
$bytes = [Text.Encoding]::UTF8.GetBytes($plain)
$entropy = [Text.Encoding]::UTF8.GetBytes('${entropyLabel}')
$cipher = [Security.Cryptography.ProtectedData]::Protect($bytes, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Convert]::ToBase64String($cipher))
`

const unprotectScript = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$cipherText = [Console]::In.ReadToEnd()
$cipher = [Convert]::FromBase64String($cipherText)
$entropy = [Text.Encoding]::UTF8.GetBytes('${entropyLabel}')
$plain = [Security.Cryptography.ProtectedData]::Unprotect($cipher, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Text.Encoding]::UTF8.GetString($plain))
`

function runDpapi(script, input) {
  if (process.platform !== 'win32') throw new Error('Robinhood Keeper 키 보관은 현재 Windows DPAPI만 지원합니다.')
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    input,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  })
  if (result.status !== 0 || !result.stdout?.trim()) {
    throw new Error(`Windows DPAPI 처리에 실패했습니다: ${(result.stderr || 'unknown error').trim()}`)
  }
  return result.stdout.trim()
}

export function readKeeperIdentity() {
  if (!existsSync(keeperKeyFile)) return null
  try {
    const stored = JSON.parse(readFileSync(keeperKeyFile, 'utf8'))
    if (stored?.version !== 1 || stored?.protection !== 'Windows-DPAPI-CurrentUser' || !stored?.address || !stored?.ciphertext) return null
    return {
      version: stored.version,
      address: stored.address,
      createdAt: stored.createdAt,
      protection: stored.protection,
      portable: false,
    }
  } catch {
    return null
  }
}

export function ensureKeeperIdentity() {
  const existing = readKeeperIdentity()
  if (existing) return { ...existing, created: false }
  mkdirSync(secretDirectory, { recursive: true })
  const privateKey = generatePrivateKey()
  const account = privateKeyToAccount(privateKey)
  const stored = {
    version: 1,
    address: account.address,
    createdAt: new Date().toISOString(),
    protection: 'Windows-DPAPI-CurrentUser',
    ciphertext: runDpapi(protectScript, privateKey),
  }
  writeFileSync(temporaryKeyFile, JSON.stringify(stored, null, 2), { encoding: 'utf8', mode: 0o600 })
  renameSync(temporaryKeyFile, keeperKeyFile)
  return { version: 1, address: account.address, createdAt: stored.createdAt, protection: stored.protection, portable: false, created: true }
}

export function loadKeeperPrivateKey() {
  if (!existsSync(keeperKeyFile)) throw new Error('Keeper 키가 없습니다. 먼저 로컬 실행기로 bStocker를 시작하세요.')
  const stored = JSON.parse(readFileSync(keeperKeyFile, 'utf8'))
  if (stored?.version !== 1 || stored?.protection !== 'Windows-DPAPI-CurrentUser' || !stored?.ciphertext) {
    throw new Error('Keeper 키 파일 형식이 올바르지 않습니다.')
  }
  const privateKey = runDpapi(unprotectScript, stored.ciphertext)
  const account = privateKeyToAccount(privateKey)
  if (account.address.toLowerCase() !== String(stored.address).toLowerCase()) throw new Error('Keeper 키 주소 검증에 실패했습니다.')
  return privateKey
}

export function loadKeeperAccount() {
  return privateKeyToAccount(loadKeeperPrivateKey())
}
