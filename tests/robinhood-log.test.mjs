import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { loadRecentKeeperLogs } from '../server/robinhood-log.mjs'

test('keeper log tail is bounded, parsed and secret-like RPC URLs are removed', () => {
  const directory = mkdtempSync(join(tmpdir(), 'bstocker-keeper-log-'))
  const file = join(directory, 'history.ndjson')
  try {
    const rows = Array.from({ length: 8 }, (_, index) => JSON.stringify({
      at: 1_000 + index,
      blockNumber: String(90 + index),
      mode: 'LIVE',
      state: 'LIVE',
      action: index === 7 ? 'REBALANCE_REQUIRED' : 'NO_ACTION',
      tick: -227_250 + index,
      spotPrice: 135 + index / 100,
      strategyNavUsd: 25,
      reasons: index === 7 ? ['RPC https://example.invalid/?apiKey=secret failed'] : [],
      executionError: null,
    }))
    writeFileSync(file, `${rows.join('\n')}\n`, 'utf8')
    const logs = loadRecentKeeperLogs(file, 3)
    assert.equal(logs.length, 3)
    assert.equal(logs[0].at, 1_005)
    assert.equal(logs[2].action, 'REBALANCE_REQUIRED')
    assert.equal(logs[2].reasons[0], 'RPC [RPC] failed')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('missing or malformed history safely returns usable entries only', () => {
  const directory = mkdtempSync(join(tmpdir(), 'bstocker-keeper-log-'))
  const file = join(directory, 'history.ndjson')
  try {
    assert.deepEqual(loadRecentKeeperLogs(file), [])
    writeFileSync(file, '{broken}\n{"at":42,"state":"LIVE","action":"NO_ACTION"}\n', 'utf8')
    const logs = loadRecentKeeperLogs(file)
    assert.equal(logs.length, 1)
    assert.equal(logs[0].at, 42)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
