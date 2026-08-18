import { spawnSync } from 'node:child_process'
import { basename } from 'node:path'
import { importKeeperPrivateKey, readKeeperIdentity } from '../server/robinhood-keeper-key.mjs'

if (process.platform !== 'win32') {
  throw new Error('클립보드 Keeper 가져오기는 현재 Windows에서만 지원합니다.')
}

function runPowerShell(command, input = '') {
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
    input,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  })
  if (result.status !== 0) throw new Error(`Windows 클립보드 처리에 실패했습니다: ${(result.stderr || 'unknown error').trim()}`)
  return result.stdout || ''
}

const privateKey = runPowerShell('[Console]::Out.Write((Get-Clipboard -Raw))').trim()
if (!privateKey) throw new Error('클립보드가 비어 있습니다. Keeper 개인키를 복사한 뒤 다시 실행하세요.')

const existing = readKeeperIdentity()
try {
  const imported = importKeeperPrivateKey(privateKey, { expectedAddress: existing?.address })
  console.log(`Keeper 가져오기 및 DPAPI 재암호화 완료: ${imported.identity.address}`)
  if (imported.backupFile) console.log(`이전 키 파일 백업: .secrets/${basename(imported.backupFile)}`)
} finally {
  try {
    runPowerShell("Set-Clipboard -Value ' '")
    console.log('Windows 클립보드를 지웠습니다.')
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
  }
}
