import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs'

function safeText(value, maximumLength = 280) {
  if (value == null) return null
  return String(value)
    .replace(/https?:\/\/\S+/gi, '[RPC]')
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, maximumLength)
}

function finiteNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function mapEntry(row, index) {
  const at = finiteNumber(row?.at)
  if (at == null) return null
  const executed = row?.executed && typeof row.executed === 'object' ? row.executed : null
  const hash = typeof executed?.hash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(executed.hash) ? executed.hash : null
  const reasons = Array.isArray(row?.reasons)
    ? row.reasons.slice(0, 4).map(reason => safeText(reason, 180)).filter(Boolean)
    : []
  const range = row?.range && typeof row.range === 'object'
    ? { lower: finiteNumber(row.range.lower), upper: finiteNumber(row.range.upper) }
    : null
  return {
    id: `${at}-${safeText(row?.blockNumber, 40) || index}`,
    at,
    blockNumber: safeText(row?.blockNumber, 40),
    mode: safeText(row?.mode, 16) || 'UNKNOWN',
    state: safeText(row?.state, 32) || 'UNKNOWN',
    action: safeText(row?.action, 48) || 'NO_ACTION',
    tick: finiteNumber(row?.tick),
    spotPrice: finiteNumber(row?.spotPrice),
    officialPrice: finiteNumber(row?.officialPrice),
    navUsd: finiteNumber(row?.strategyNavUsd),
    range,
    reasons,
    executionError: safeText(row?.executionError),
    transaction: hash ? { hash, action: safeText(executed?.action, 48) || safeText(row?.action, 48) || 'TRANSACTION' } : null,
  }
}

export function loadRecentKeeperLogs(file, limit = 48, maximumBytes = 192 * 1024) {
  if (!existsSync(file)) return []
  let descriptor
  try {
    const size = statSync(file).size
    if (size <= 0) return []
    const bytesToRead = Math.min(size, maximumBytes)
    const start = Math.max(0, size - bytesToRead)
    const buffer = Buffer.alloc(bytesToRead)
    descriptor = openSync(file, 'r')
    const bytesRead = readSync(descriptor, buffer, 0, bytesToRead, start)
    let lines = buffer.subarray(0, bytesRead).toString('utf8').split(/\r?\n/)
    if (start > 0) lines = lines.slice(1)
    return lines
      .filter(Boolean)
      .slice(-Math.max(1, Math.min(200, limit)))
      .map((line, index) => {
        try { return mapEntry(JSON.parse(line), index) } catch { return null }
      })
      .filter(Boolean)
  } catch {
    return []
  } finally {
    if (descriptor != null) closeSync(descriptor)
  }
}
