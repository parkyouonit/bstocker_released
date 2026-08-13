import assert from 'node:assert/strict'
import test from 'node:test'
import { keeperStorageForPlatform } from '../server/robinhood-keeper-key.mjs'
import { keeperSweepAmount } from '../scripts/reclaim-robinhood-keeper-funds.mjs'

test('keeper storage selects user-bound protection on Windows and macOS', () => {
  assert.deepEqual(keeperStorageForPlatform('win32'), {
    supported: true,
    fileName: 'robinhood-keeper.dpapi.json',
    protection: 'Windows-DPAPI-CurrentUser',
    label: 'Windows 현재 사용자 DPAPI',
  })
  assert.deepEqual(keeperStorageForPlatform('darwin'), {
    supported: true,
    fileName: 'robinhood-keeper.keychain.json',
    protection: 'macOS-Keychain-CurrentUser',
    label: 'macOS 로그인 Keychain',
  })
  assert.equal(keeperStorageForPlatform('linux').supported, false)
})

test('keeper sweep leaves exactly the fixed native-transfer fee', () => {
  const result = keeperSweepAmount(2_000_000_000_000_000n, 1_000_000_000n)
  assert.equal(result.fee, 21_000_000_000_000n)
  assert.equal(result.value, 1_979_000_000_000_000n)
  assert.deepEqual(keeperSweepAmount(result.fee, 1_000_000_000n), { fee: result.fee, value: 0n })
})
