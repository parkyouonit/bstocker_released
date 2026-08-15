const MINUTE_MS = 60_000

const FAILURE_RULES = Object.freeze([
  {
    code: 'SAFETY_EXIT_NOT_CONFIRMED',
    matches: message => /CrashNotConfirmed|0x8f18c3b5/i.test(message),
    baseDelayMs: 2 * MINUTE_MS,
    maxDelayMs: 15 * MINUTE_MS,
    publicMessage: '온체인 안전 종료 가격 조건이 아직 확인되지 않아 실행을 보류했습니다.',
  },
  {
    code: 'SAFETY_EXIT_PRICE_GUARD',
    matches: message => /PriceGuardFailed|0x606c3286/i.test(message),
    baseDelayMs: 5 * MINUTE_MS,
    maxDelayMs: 30 * MINUTE_MS,
    publicMessage: 'DEX 매도가가 Chainlink 안전 범위보다 낮아 USDG 전환을 보류했습니다.',
  },
  {
    code: 'LIQUIDITY_SLIPPAGE',
    matches: message => /too little received/i.test(message),
    baseDelayMs: 15 * MINUTE_MS,
    maxDelayMs: 60 * MINUTE_MS,
    publicMessage: '현재 풀 유동성으로는 최소 수령량을 만족하지 못해 재배치를 보류했습니다.',
  },
  {
    code: 'BALANCE_CONVERGENCE',
    matches: message => /\bPSC\b/i.test(message),
    baseDelayMs: 10 * MINUTE_MS,
    maxDelayMs: 60 * MINUTE_MS,
    publicMessage: '민트 비율 검사가 통과되지 않아 재배치를 보류했습니다.',
  },
  {
    code: 'RATE_LIMITED',
    matches: message => /RateLimited|rate limit/i.test(message),
    baseDelayMs: 2 * MINUTE_MS,
    maxDelayMs: 15 * MINUTE_MS,
    publicMessage: '재배치 횟수 제한이 풀릴 때까지 실행을 대기합니다.',
  },
  {
    code: 'RPC_UNAVAILABLE',
    matches: message => /HTTP 429|HTTP 5\d\d|fetch failed|timeout|timed out|socket/i.test(message),
    baseDelayMs: 30_000,
    maxDelayMs: 5 * MINUTE_MS,
    publicMessage: 'RPC 연결이 안정될 때까지 실행을 잠시 대기합니다.',
  },
])

function errorText(error) {
  return error instanceof Error ? error.message : String(error || 'Unknown execution failure')
}

export function classifyExecutionFailure(error) {
  const message = errorText(error)
  const rule = FAILURE_RULES.find(candidate => candidate.matches(message))
  return rule || {
    code: 'EXECUTION_SIMULATION_FAILED',
    baseDelayMs: 2 * MINUTE_MS,
    maxDelayMs: 15 * MINUTE_MS,
    publicMessage: '전체 트랜잭션 사전검증이 실패해 실행을 잠시 보류했습니다.',
  }
}

export function scheduleExecutionBackoff(previous, error, {
  now = Date.now(),
  executorAddress,
  action,
} = {}) {
  const rule = classifyExecutionFailure(error)
  const sameFailure = previous
    && previous.code === rule.code
    && previous.action === action
    && String(previous.executorAddress || '').toLowerCase() === String(executorAddress || '').toLowerCase()
  const attempts = sameFailure ? Math.min(8, Number(previous.attempts || 0) + 1) : 1
  const delayMs = Math.min(rule.maxDelayMs, rule.baseDelayMs * 2 ** (attempts - 1))
  return {
    code: rule.code,
    executorAddress: executorAddress || null,
    action: action || null,
    attempts,
    blockedAt: now,
    nextRetryAt: now + delayMs,
    delayMs,
    publicMessage: rule.publicMessage,
    lastError: errorText(error).replace(/[\r\n\t]+/g, ' ').slice(0, 280),
  }
}

export function activeExecutionBackoff(backoff, {
  now = Date.now(),
  executorAddress,
  action,
} = {}) {
  if (!backoff || Number(backoff.nextRetryAt) <= now) return null
  if (backoff.action !== action) return null
  if (String(backoff.executorAddress || '').toLowerCase() !== String(executorAddress || '').toLowerCase()) return null
  return backoff
}

export function executionBackoffReason(backoff, now = Date.now()) {
  const seconds = Math.max(1, Math.ceil((Number(backoff?.nextRetryAt || now) - now) / 1000))
  const minutes = Math.ceil(seconds / 60)
  return `${backoff.publicMessage} 다음 사전검증까지 약 ${minutes}분 남았습니다.`
}
