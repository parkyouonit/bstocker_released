import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const secretDirectory = join(root, '.secrets')
const entropyLabel = 'bStocker Robinhood keeper v1'
const macKeychainService = 'bStocker Robinhood Keeper'

export function keeperStorageForPlatform(platform = process.platform) {
  if (platform === 'win32') {
    return {
      supported: true,
      fileName: 'robinhood-keeper.dpapi.json',
      protection: 'Windows-DPAPI-CurrentUser',
      label: 'Windows 현재 사용자 DPAPI',
    }
  }
  if (platform === 'darwin') {
    return {
      supported: true,
      fileName: 'robinhood-keeper.keychain.json',
      protection: 'macOS-Keychain-CurrentUser',
      label: 'macOS 로그인 Keychain',
    }
  }
  return {
    supported: false,
    fileName: 'robinhood-keeper.unsupported.json',
    protection: 'Unsupported',
    label: `${platform} 운영체제`,
  }
}

const storage = keeperStorageForPlatform()
export const keeperKeyFile = join(secretDirectory, storage.fileName)
const temporaryKeyFile = `${keeperKeyFile}.tmp`

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

function assertSupported() {
  if (!storage.supported) throw new Error('Robinhood Keeper 키 보관은 Windows DPAPI와 macOS Keychain만 지원합니다.')
}

function runDpapi(script, input) {
  if (process.platform !== 'win32') throw new Error('Windows DPAPI는 Windows에서만 사용할 수 있습니다.')
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

function runMacKeychain(args, { outputRequired = false } = {}) {
  if (process.platform !== 'darwin') throw new Error('macOS Keychain은 macOS에서만 사용할 수 있습니다.')
  const result = spawnSync('/usr/bin/security', args, {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  })
  const output = result.stdout?.trim() || ''
  if (result.status !== 0 || (outputRequired && !output)) {
    throw new Error(`macOS Keychain 처리에 실패했습니다: ${(result.stderr || 'unknown error').trim()}`)
  }
  return output
}

function validStoredKey(stored) {
  if (stored?.version !== 1 || !stored?.address || stored?.protection !== storage.protection) return false
  if (storage.protection === 'Windows-DPAPI-CurrentUser') return Boolean(stored.ciphertext)
  if (storage.protection === 'macOS-Keychain-CurrentUser') {
    return stored.keychainService === macKeychainService && typeof stored.keychainAccount === 'string' && stored.keychainAccount.length > 0
  }
  return false
}

function publicIdentity(stored) {
  return {
    version: stored.version,
    address: stored.address,
    createdAt: stored.createdAt,
    protection: stored.protection,
    portable: false,
  }
}

export function readKeeperIdentity() {
  if (!storage.supported || !existsSync(keeperKeyFile)) return null
  try {
    const stored = JSON.parse(readFileSync(keeperKeyFile, 'utf8'))
    return validStoredKey(stored) ? publicIdentity(stored) : null
  } catch {
    return null
  }
}

function writeWindowsKeeper(privateKey, address) {
  return {
    version: 1,
    address,
    createdAt: new Date().toISOString(),
    protection: storage.protection,
    ciphertext: runDpapi(protectScript, privateKey),
  }
}

function writeMacKeeper(privateKey, address) {
  const keychainAccount = `bstocker-${randomUUID()}`
  const stored = {
    version: 1,
    address,
    createdAt: new Date().toISOString(),
    protection: storage.protection,
    keychainService: macKeychainService,
    keychainAccount,
  }
  writeFileSync(temporaryKeyFile, JSON.stringify(stored, null, 2), { encoding: 'utf8', mode: 0o600 })
  try {
    runMacKeychain(['add-generic-password', '-U', '-a', keychainAccount, '-s', macKeychainService, '-w', privateKey])
    renameSync(temporaryKeyFile, keeperKeyFile)
  } catch (error) {
    rmSync(temporaryKeyFile, { force: true })
    try { runMacKeychain(['delete-generic-password', '-a', keychainAccount, '-s', macKeychainService]) } catch { /* best effort */ }
    throw error
  }
  return stored
}

export function ensureKeeperIdentity() {
  assertSupported()
  const existing = readKeeperIdentity()
  if (existing) {
    loadKeeperPrivateKey()
    return { ...existing, created: false }
  }
  if (existsSync(keeperKeyFile)) {
    throw new Error(`Keeper 키 메타데이터를 읽을 수 없습니다. 자동으로 교체하지 않았습니다: ${keeperKeyFile}`)
  }
  mkdirSync(secretDirectory, { recursive: true, mode: 0o700 })
  const privateKey = generatePrivateKey()
  const account = privateKeyToAccount(privateKey)
  const stored = process.platform === 'win32'
    ? writeWindowsKeeper(privateKey, account.address)
    : writeMacKeeper(privateKey, account.address)
  if (process.platform === 'win32') {
    writeFileSync(temporaryKeyFile, JSON.stringify(stored, null, 2), { encoding: 'utf8', mode: 0o600 })
    renameSync(temporaryKeyFile, keeperKeyFile)
  }
  return { ...publicIdentity(stored), created: true }
}

export function loadKeeperPrivateKey() {
  assertSupported()
  if (!existsSync(keeperKeyFile)) throw new Error('Keeper 키가 없습니다. 먼저 로컬 실행기로 bStocker를 시작하세요.')
  const stored = JSON.parse(readFileSync(keeperKeyFile, 'utf8'))
  if (!validStoredKey(stored)) throw new Error('Keeper 키 파일 형식 또는 현재 운영체제가 올바르지 않습니다.')
  const privateKey = storage.protection === 'Windows-DPAPI-CurrentUser'
    ? runDpapi(unprotectScript, stored.ciphertext)
    : runMacKeychain(['find-generic-password', '-a', stored.keychainAccount, '-s', stored.keychainService, '-w'], { outputRequired: true })
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw new Error('Keeper 개인키 형식 검증에 실패했습니다.')
  const account = privateKeyToAccount(privateKey)
  if (account.address.toLowerCase() !== String(stored.address).toLowerCase()) throw new Error('Keeper 키 주소 검증에 실패했습니다.')
  return privateKey
}

export function loadKeeperAccount() {
  return privateKeyToAccount(loadKeeperPrivateKey())
}
