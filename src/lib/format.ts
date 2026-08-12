export function formatMoney(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  if (Math.abs(value) >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`
  if (Math.abs(value) >= 1_000) return `$${(value / 1_000).toFixed(2)}K`
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`
}

export function formatNumber(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}

export function formatToken(value: number | null | undefined, symbol: string, digits = 6): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return `— ${symbol}`
  const max = Math.abs(value) >= 100 ? 2 : digits
  return `${value.toLocaleString('en-US', { maximumFractionDigits: max })} ${symbol}`
}

export function formatPercent(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return `${value.toFixed(digits)}%`
}

export function shortAddress(address?: string, head = 6, tail = 4): string {
  if (!address) return '—'
  return `${address.slice(0, head)}…${address.slice(-tail)}`
}

export function relativeTime(timestamp: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000))
  if (seconds < 5) return '방금 전'
  if (seconds < 60) return `${seconds}초 전`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}분 전`
  return `${Math.floor(seconds / 3600)}시간 전`
}

export function formatFeeTier(fee: number): string {
  return `${(fee / 10000).toFixed(fee % 10000 === 0 ? 0 : 2)}%`
}
