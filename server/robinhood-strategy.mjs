export const ROBINHOOD_GUARD_STATES = Object.freeze({
  WARMING: 'WARMING',
  LIVE: 'LIVE',
  SOFT_PAUSE: 'SOFT_PAUSE',
  WITHDRAW_ONLY: 'WITHDRAW_ONLY',
  USDG_EXIT_PENDING: 'USDG_EXIT_PENDING',
})

export const ROBINHOOD_GUARD_POLICY_VERSION = 2

export const ROBINHOOD_ADAPTIVE_POLICY_VERSION = 1

export const ROBINHOOD_ADAPTIVE_MODES = Object.freeze({
  NORMAL: 'NORMAL',
  DEFENSIVE: 'DEFENSIVE',
  USDG_WAIT: 'USDG_WAIT',
})

export const DEFAULT_ROBINHOOD_GUARD_CONFIG = Object.freeze({
  widthIntervals: 5,
  expectedTickTolerance: 10,
  transactionDeadlineSec: 30,
  spotToTwap30MaxPercent: 0.35,
  twap30ToTwap300MaxPercent: 0.75,
  dexToOfficialMaxPercent: 1.5,
  softDrop1mPercent: -1.5,
  withdrawDrop5mPercent: -3,
  exitDrop5mPercent: -3,
  officialExitDrop5mPercent: -2.5,
  exitConfirmationSec: 30,
  softPauseSec: 300,
  rapidBandCrossingSec: 10,
  rapidBandCrossingTicks: 30,
  minRebalanceIntervalSec: 30,
  maxRebalances10m: 3,
  maxRebalances1h: 10,
  rateLimitPauseSec: 1800,
  officialMaxAgeSec: 90_000,
  closedMarketMaxAgeSec: 72 * 60 * 60,
  closedQuoteMaxAgeSec: 120,
  closedQuoteTolerancePercent: 0.5,
  warmupSec: 300,
  maxExitPriceImpactPercent: 1,
  pilotCapitalUsd: 350,
  adaptiveSlowDrop15mPercent: -0.5,
  adaptiveSlowDrop30mPercent: -0.75,
  adaptiveSlowConfirmSec: 180,
  adaptiveDefensiveIntervalsBelow: 4,
  adaptiveDefenseExitTicks: 20,
  adaptiveDefensiveMinSec: 1800,
  adaptiveUsdgWaitMinSec: 3600,
  adaptiveRecovery15mPercent: 0.35,
  adaptiveRecovery30mPercent: 0.15,
  adaptiveRecovery60mPercent: 0,
  adaptiveRecoveryConfirmSec: 600,
})

const finite = value => {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

export function floorTickToSpacing(tick, spacing) {
  if (!Number.isInteger(tick) || !Number.isInteger(spacing) || spacing <= 0) throw new Error('tick과 spacing이 올바르지 않습니다.')
  return Math.floor(tick / spacing) * spacing
}

export function strategyRange(tick, spacing = 10, widthIntervals = DEFAULT_ROBINHOOD_GUARD_CONFIG.widthIntervals) {
  if (!Number.isInteger(widthIntervals) || widthIntervals < 3 || widthIntervals % 2 === 0) throw new Error('범위 간격 수는 3 이상의 홀수여야 합니다.')
  const anchor = floorTickToSpacing(tick, spacing)
  const intervalsBelow = Math.floor(widthIntervals / 2)
  const lower = anchor - spacing * intervalsBelow
  return { lower, upper: lower + spacing * widthIntervals, anchor, width: spacing * widthIntervals }
}

export function defensiveStrategyRange(tick, spacing = 10, widthIntervals = DEFAULT_ROBINHOOD_GUARD_CONFIG.widthIntervals, intervalsBelow = DEFAULT_ROBINHOOD_GUARD_CONFIG.adaptiveDefensiveIntervalsBelow) {
  if (!Number.isInteger(widthIntervals) || widthIntervals < 3 || widthIntervals % 2 === 0) throw new Error('범위 간격 수는 3 이상의 홀수여야 합니다.')
  if (!Number.isInteger(intervalsBelow) || intervalsBelow < 1 || intervalsBelow >= widthIntervals) throw new Error('방어 범위 위치가 올바르지 않습니다.')
  const anchor = floorTickToSpacing(tick, spacing)
  const lower = anchor - spacing * intervalsBelow
  return { lower, upper: lower + spacing * widthIntervals, anchor, width: spacing * widthIntervals }
}

export function rangeAnchor(lower, upper, spacing = 10) {
  const widthIntervals = Math.round((Number(upper) - Number(lower)) / spacing)
  return Number(lower) + Math.floor(widthIntervals / 2) * spacing
}

export function tickToPrice(tick, token0Decimals = 18, token1Decimals = 18) {
  const price = Math.pow(1.0001, tick) * Math.pow(10, token0Decimals - token1Decimals)
  return Number.isFinite(price) ? price : 0
}

export function percentChange(current, previous) {
  const a = finite(current)
  const b = finite(previous)
  if (a == null || b == null || b <= 0) return null
  return (a / b - 1) * 100
}

export function percentDistance(a, b) {
  const left = finite(a)
  const right = finite(b)
  if (left == null || right == null || right <= 0) return null
  return Math.abs(left / right - 1) * 100
}

export function expectedUsMarketClosure(at) {
  const date = new Date(Number(at))
  if (!Number.isFinite(date.getTime())) return false
  const day = date.getUTCDay()
  const minute = date.getUTCHours() * 60 + date.getUTCMinutes()
  return day === 6 || day === 0 || (day === 5 && minute >= 20 * 60) || (day === 1 && minute < 15 * 60)
}

export function evaluateOracleGuard(snapshot, config = DEFAULT_ROBINHOOD_GUARD_CONFIG) {
  const limits = { ...DEFAULT_ROBINHOOD_GUARD_CONFIG, ...config }
  const now = finite(snapshot?.at) || Date.now()
  const officialPrice = finite(snapshot?.official?.tokenPrice)
  const officialGeneratedAt = snapshot?.official?.generatedAt ? Date.parse(snapshot.official.generatedAt) : NaN
  const officialTimestampValid = Number.isFinite(officialGeneratedAt) && officialGeneratedAt <= now + 60_000
  const officialAgeSec = officialTimestampValid ? Math.max(0, (now - officialGeneratedAt) / 1000) : null
  const officialMaxAgeSec = finite(snapshot?.official?.priceFeedMaxAgeSec) || limits.officialMaxAgeSec
  const primaryFresh = officialPrice != null && officialPrice > 0
    && officialAgeSec != null && officialAgeSec <= officialMaxAgeSec

  const quoteGeneratedAt = snapshot?.official?.quoteGeneratedAt ? Date.parse(snapshot.official.quoteGeneratedAt) : NaN
  const quoteTimestampValid = Number.isFinite(quoteGeneratedAt) && quoteGeneratedAt <= now + 60_000
  const quoteAgeSec = quoteTimestampValid ? Math.max(0, (now - quoteGeneratedAt) / 1000) : null
  const quoteFresh = quoteAgeSec != null && quoteAgeSec <= limits.closedQuoteMaxAgeSec
  const bid = finite(snapshot?.official?.bid)
  const ask = finite(snapshot?.official?.ask)
  const multiplier = finite(snapshot?.official?.multiplier)
  const usdgUsd = finite(snapshot?.official?.usdgFeed?.priceUsd)
  const quoteScale = multiplier != null && multiplier > 0 ? multiplier / (usdgUsd != null && usdgUsd > 0 ? usdgUsd : 1) : null
  const quoteBidUsdg = bid != null && bid > 0 && quoteScale != null ? bid * quoteScale : null
  const quoteAskUsdg = ask != null && ask > 0 && quoteScale != null ? ask * quoteScale : null
  const quoteLow = quoteBidUsdg == null || quoteAskUsdg == null ? null : Math.min(quoteBidUsdg, quoteAskUsdg)
  const quoteHigh = quoteBidUsdg == null || quoteAskUsdg == null ? null : Math.max(quoteBidUsdg, quoteAskUsdg)

  const spotPrice = finite(snapshot?.spotPrice)
  const twap30Price = finite(snapshot?.twap30Price)
  const twap300Price = finite(snapshot?.twap300Price)
  const onchainTwapReady = twap30Price != null && twap30Price > 0
    && twap300Price != null && twap300Price > 0
    && Number(snapshot?.observationCardinality || 0) > 1
  const spotTwap30DeviationPercent = percentDistance(spotPrice, twap30Price)
  const twapDivergencePercent = percentDistance(twap30Price, twap300Price)
  const dexOfficialDeviationPercent = percentDistance(twap300Price, officialPrice)
  const poolStable = onchainTwapReady
    && spotTwap30DeviationPercent != null && spotTwap30DeviationPercent <= limits.spotToTwap30MaxPercent
    && twapDivergencePercent != null && twapDivergencePercent <= limits.twap30ToTwap300MaxPercent
  const quoteTolerance = limits.closedQuoteTolerancePercent / 100
  const dexInsideOfficialQuote = twap300Price != null && quoteLow != null && quoteHigh != null
    && twap300Price >= quoteLow * (1 - quoteTolerance)
    && twap300Price <= quoteHigh * (1 + quoteTolerance)
  const expectedMarketClosed = expectedUsMarketClosure(now)
  const stockHealthy = !snapshot?.official?.isTradingHalt
    && !snapshot?.stock?.paused
    && !snapshot?.stock?.oraclePaused
    && snapshot?.official?.assetStatus === 'ASSET_STATUS_ACTIVE'
  const closedMarketConsensus = !primaryFresh
    && expectedMarketClosed
    && officialPrice != null && officialPrice > 0
    && officialAgeSec != null && officialAgeSec <= limits.closedMarketMaxAgeSec
    && quoteFresh
    && stockHealthy
    && poolStable
    && dexOfficialDeviationPercent != null && dexOfficialDeviationPercent <= limits.dexToOfficialMaxPercent
    && dexInsideOfficialQuote
  const mode = primaryFresh ? 'CHAINLINK_FRESH' : closedMarketConsensus ? 'MARKET_CLOSED_QUORUM' : 'FAIL_CLOSED'
  const valuationPrice = primaryFresh ? officialPrice : closedMarketConsensus ? twap300Price : null

  return {
    mode,
    operational: primaryFresh || closedMarketConsensus,
    primaryFresh,
    closedMarketConsensus,
    expectedMarketClosed,
    valuationPrice,
    officialAgeSec,
    officialMaxAgeSec,
    closedMarketMaxAgeSec: limits.closedMarketMaxAgeSec,
    quoteAgeSec,
    quoteFresh,
    quoteBidUsdg,
    quoteAskUsdg,
    dexInsideOfficialQuote,
    poolStable,
    spotTwap30DeviationPercent,
    twapDivergencePercent,
    dexOfficialDeviationPercent,
  }
}

function sampleAtOrBefore(samples, cutoff) {
  for (let index = samples.length - 1; index >= 0; index -= 1) {
    if (samples[index].at <= cutoff) return samples[index]
  }
  return undefined
}

function sampleNearOrBefore(samples, cutoff, maxLagMs = 60_000) {
  const sample = sampleAtOrBefore(samples, cutoff)
  return sample && cutoff - sample.at <= maxLagMs ? sample : undefined
}

function rangeContains(range, tick) {
  return Boolean(range && tick >= range.lower && tick < range.upper)
}

function rangeIsValid(range) {
  const lower = finite(range?.lower)
  const upper = finite(range?.upper)
  return lower != null && upper != null && upper > lower
}

function normalizeSamples(samples, now) {
  if (!Array.isArray(samples)) return []
  return samples
    .filter(sample => finite(sample?.at) != null && sample.at >= now - 60 * 60_000)
    .map(sample => ({
      at: Number(sample.at),
      tick: Number(sample.tick),
      spotPrice: Number(sample.spotPrice),
      officialPrice: finite(sample.officialPrice),
    }))
    .filter(sample => Number.isFinite(sample.tick) && Number.isFinite(sample.spotPrice) && sample.spotPrice > 0)
}

function normalizeAdaptiveSamples(samples, now) {
  if (!Array.isArray(samples)) return []
  return samples
    .filter(sample => finite(sample?.at) != null && sample.at >= now - 2 * 60 * 60_000)
    .map(sample => ({
      at: Number(sample.at),
      tick: Number(sample.tick),
      spotPrice: Number(sample.spotPrice),
    }))
    .filter(sample => Number.isFinite(sample.tick) && Number.isFinite(sample.spotPrice) && sample.spotPrice > 0)
}

export class AdaptiveShadowEngine {
  constructor(config = {}, persisted = {}) {
    this.config = { ...DEFAULT_ROBINHOOD_GUARD_CONFIG, ...config }
    const now = Date.now()
    const policyMatches = Number(persisted.adaptivePolicyVersion) === ROBINHOOD_ADAPTIVE_POLICY_VERSION
    this.samples = normalizeAdaptiveSamples(persisted.samples, now)
    this.mode = policyMatches && Object.values(ROBINHOOD_ADAPTIVE_MODES).includes(persisted.mode)
      ? persisted.mode
      : ROBINHOOD_ADAPTIVE_MODES.NORMAL
    this.modeSince = policyMatches ? finite(persisted.modeSince) || now : now
    this.slowSignalSince = policyMatches ? finite(persisted.slowSignalSince) : null
    this.recoverySince = policyMatches ? finite(persisted.recoverySince) : null
    this.defenseAnchor = policyMatches ? finite(persisted.defenseAnchor) : null
    this.range = policyMatches && rangeIsValid(persisted.range) ? persisted.range : null
    this.events = Array.isArray(persisted.events) ? persisted.events.slice(-100) : []
    if (!policyMatches && Object.keys(persisted).length > 0) this.#event(now, 'ADAPTIVE_POLICY_MIGRATED', '3상태 하락 방어 shadow 정책을 초기화했습니다.')
  }

  ingest(snapshot) {
    const now = finite(snapshot?.at) || Date.now()
    const tick = finite(snapshot?.tick)
    const spotPrice = finite(snapshot?.spotPrice)
    const spacing = finite(snapshot?.tickSpacing)
    if (tick == null || spotPrice == null || spotPrice <= 0 || spacing == null || spacing <= 0) {
      return this.#decision(now, 'NO_ACTION', ['풀 가격 또는 tick 데이터가 유효하지 않아 adaptive 판단을 보류합니다.'], {})
    }

    const last = this.samples[this.samples.length - 1]
    if (!last || last.at !== now || last.tick !== tick) this.samples.push({ at: now, tick, spotPrice })
    this.samples = this.samples.filter(item => item.at >= now - 2 * 60 * 60_000)

    const fiveMinute = sampleNearOrBefore(this.samples, now - 5 * 60_000)
    const fifteenMinute = sampleNearOrBefore(this.samples, now - 15 * 60_000)
    const thirtyMinute = sampleNearOrBefore(this.samples, now - 30 * 60_000)
    const sixtyMinute = sampleNearOrBefore(this.samples, now - 60 * 60_000)
    const fiveMinuteChangePercent = percentChange(spotPrice, fiveMinute?.spotPrice)
    const fifteenMinuteChangePercent = percentChange(spotPrice, fifteenMinute?.spotPrice)
    const thirtyMinuteChangePercent = percentChange(spotPrice, thirtyMinute?.spotPrice)
    const sixtyMinuteChangePercent = percentChange(spotPrice, sixtyMinute?.spotPrice)
    const historyReady = fifteenMinuteChangePercent != null && thirtyMinuteChangePercent != null && sixtyMinuteChangePercent != null
    const slowDowntrend = historyReady
      && fifteenMinuteChangePercent <= this.config.adaptiveSlowDrop15mPercent
      && thirtyMinuteChangePercent <= this.config.adaptiveSlowDrop30mPercent
    const rapidCrash = fiveMinuteChangePercent != null && fiveMinuteChangePercent <= this.config.exitDrop5mPercent
    const recoveryTrend = historyReady
      && fifteenMinuteChangePercent >= this.config.adaptiveRecovery15mPercent
      && thirtyMinuteChangePercent >= this.config.adaptiveRecovery30mPercent
      && sixtyMinuteChangePercent >= this.config.adaptiveRecovery60mPercent
    const additionalDefenseDrop = this.mode === ROBINHOOD_ADAPTIVE_MODES.DEFENSIVE
      && this.defenseAnchor != null
      && tick <= this.defenseAnchor - this.config.adaptiveDefenseExitTicks

    const previousMode = this.mode
    let action = 'NO_ACTION'
    const reasons = []

    if (this.mode === ROBINHOOD_ADAPTIVE_MODES.NORMAL) {
      this.recoverySince = null
      if (rapidCrash) {
        this.#setMode(now, ROBINHOOD_ADAPTIVE_MODES.USDG_WAIT)
        this.range = null
        this.defenseAnchor = null
        this.slowSignalSince = null
        action = 'SHADOW_PARK_IN_USDG'
        reasons.push(`5분 가격 변화 ${fiveMinuteChangePercent.toFixed(2)}%로 급락 대기를 가정합니다.`)
      } else if (slowDowntrend) {
        if (this.slowSignalSince == null) this.slowSignalSince = now
        const confirmedSec = Math.max(0, (now - this.slowSignalSince) / 1000)
        if (confirmedSec >= this.config.adaptiveSlowConfirmSec) {
          this.#setMode(now, ROBINHOOD_ADAPTIVE_MODES.DEFENSIVE)
          this.range = defensiveStrategyRange(tick, spacing, this.config.widthIntervals, this.config.adaptiveDefensiveIntervalsBelow)
          this.defenseAnchor = this.range.anchor
          this.slowSignalSince = null
          action = 'SHADOW_ENTER_DEFENSIVE'
          reasons.push(`15분 ${fifteenMinuteChangePercent.toFixed(2)}%·30분 ${thirtyMinuteChangePercent.toFixed(2)}% 하락이 ${this.config.adaptiveSlowConfirmSec}초 지속됐습니다.`)
        } else {
          reasons.push(`느린 하락 확인 ${Math.floor(confirmedSec)} / ${this.config.adaptiveSlowConfirmSec}초`)
        }
      } else {
        this.slowSignalSince = null
      }
    } else if (this.mode === ROBINHOOD_ADAPTIVE_MODES.DEFENSIVE) {
      this.slowSignalSince = null
      if (rapidCrash || additionalDefenseDrop) {
        this.#setMode(now, ROBINHOOD_ADAPTIVE_MODES.USDG_WAIT)
        this.range = null
        this.recoverySince = null
        action = 'SHADOW_PARK_IN_USDG'
        reasons.push(rapidCrash
          ? `5분 가격 변화 ${fiveMinuteChangePercent.toFixed(2)}%로 급락 대기를 가정합니다.`
          : `방어 기준 ${this.defenseAnchor}에서 ${this.config.adaptiveDefenseExitTicks}틱 추가 하락했습니다.`)
      } else if (now - this.modeSince >= this.config.adaptiveDefensiveMinSec * 1000 && recoveryTrend) {
        if (this.recoverySince == null) this.recoverySince = now
        const confirmedSec = Math.max(0, (now - this.recoverySince) / 1000)
        if (confirmedSec >= this.config.adaptiveRecoveryConfirmSec) {
          this.#setMode(now, ROBINHOOD_ADAPTIVE_MODES.NORMAL)
          this.range = strategyRange(tick, spacing, this.config.widthIntervals)
          this.defenseAnchor = null
          this.recoverySince = null
          action = 'SHADOW_RESUME_NORMAL'
          reasons.push('회복 추세가 지속되어 중앙 5틱 복귀를 가정합니다.')
        } else reasons.push(`회복 확인 ${Math.floor(confirmedSec)} / ${this.config.adaptiveRecoveryConfirmSec}초`)
      } else {
        this.recoverySince = null
      }
    } else {
      this.slowSignalSince = null
      if (now - this.modeSince >= this.config.adaptiveUsdgWaitMinSec * 1000 && recoveryTrend) {
        if (this.recoverySince == null) this.recoverySince = now
        const confirmedSec = Math.max(0, (now - this.recoverySince) / 1000)
        if (confirmedSec >= this.config.adaptiveRecoveryConfirmSec) {
          this.#setMode(now, ROBINHOOD_ADAPTIVE_MODES.NORMAL)
          this.range = strategyRange(tick, spacing, this.config.widthIntervals)
          this.defenseAnchor = null
          this.recoverySince = null
          action = 'SHADOW_RESUME_NORMAL'
          reasons.push('USDG 최소 대기와 회복 추세 확인을 마쳐 중앙 5틱 복귀를 가정합니다.')
        } else reasons.push(`USDG 대기 후 회복 확인 ${Math.floor(confirmedSec)} / ${this.config.adaptiveRecoveryConfirmSec}초`)
      } else {
        this.recoverySince = null
      }
    }

    if (!historyReady) reasons.push('15·30·60분 연속 이력을 수집하는 중입니다.')
    if (previousMode !== this.mode) this.#event(now, action, `${previousMode} → ${this.mode}`)
    return this.#decision(now, action, reasons, {
      fiveMinuteChangePercent,
      fifteenMinuteChangePercent,
      thirtyMinuteChangePercent,
      sixtyMinuteChangePercent,
      historyReady,
      slowDowntrend,
      rapidCrash,
      recoveryTrend,
      additionalDefenseDrop,
      modeAgeSec: Math.max(0, (now - this.modeSince) / 1000),
      signalAgeSec: this.slowSignalSince == null ? 0 : Math.max(0, (now - this.slowSignalSince) / 1000),
      recoveryAgeSec: this.recoverySince == null ? 0 : Math.max(0, (now - this.recoverySince) / 1000),
    })
  }

  syncConfirmedState(confirmed = {}, now = Date.now()) {
    const mode = confirmed.mode
    if (!Object.values(ROBINHOOD_ADAPTIVE_MODES).includes(mode)) return false
    const confirmedAt = finite(confirmed.modeSince) || finite(now) || Date.now()
    const changed = this.mode !== mode
    if (changed) {
      const previousMode = this.mode
      this.mode = mode
      this.modeSince = confirmedAt
      this.slowSignalSince = null
      this.recoverySince = null
      this.#event(confirmedAt, 'ADAPTIVE_ONCHAIN_SYNC', `${previousMode} → ${mode}`)
    } else if (finite(confirmed.modeSince) != null) {
      this.modeSince = confirmedAt
    }
    this.defenseAnchor = mode === ROBINHOOD_ADAPTIVE_MODES.DEFENSIVE
      ? finite(confirmed.defenseAnchor)
      : null
    this.range = mode === ROBINHOOD_ADAPTIVE_MODES.USDG_WAIT
      ? null
      : rangeIsValid(confirmed.range) ? confirmed.range : this.range
    return changed
  }

  serialize() {
    return {
      adaptivePolicyVersion: ROBINHOOD_ADAPTIVE_POLICY_VERSION,
      mode: this.mode,
      modeSince: this.modeSince,
      slowSignalSince: this.slowSignalSince,
      recoverySince: this.recoverySince,
      defenseAnchor: this.defenseAnchor,
      range: this.range,
      events: this.events.slice(-100),
      samples: this.samples,
    }
  }

  #setMode(at, mode) {
    this.mode = mode
    this.modeSince = at
  }

  #event(at, type, message) {
    this.events.push({ at, type, message })
    this.events = this.events.slice(-100)
  }

  #decision(at, action, reasons, metrics) {
    return {
      at,
      policyVersion: ROBINHOOD_ADAPTIVE_POLICY_VERSION,
      mode: this.mode,
      modeSince: this.modeSince,
      action,
      reasons,
      metrics,
      range: this.range,
      defenseAnchor: this.defenseAnchor,
      config: this.config,
      events: this.events.slice(-30).reverse(),
      shadowOnly: true,
    }
  }
}

export class ShadowGuardEngine {
  constructor(config = {}, persisted = {}, runtime = {}) {
    this.config = { ...DEFAULT_ROBINHOOD_GUARD_CONFIG, ...config }
    this.executionMode = runtime.executionMode === 'LIVE' ? 'LIVE' : 'SHADOW'
    const now = Date.now()
    const persistedPolicyMatches = Number(persisted.guardPolicyVersion) === ROBINHOOD_GUARD_POLICY_VERSION
    this.samples = normalizeSamples(persisted.samples, now)
    this.state = persistedPolicyMatches && Object.values(ROBINHOOD_GUARD_STATES).includes(persisted.state)
      ? persisted.state
      : ROBINHOOD_GUARD_STATES.WARMING
    this.virtualRange = persisted.virtualRange || null
    this.lastInRangeAt = finite(persisted.lastInRangeAt)
    this.softPauseUntil = persistedPolicyMatches ? finite(persisted.softPauseUntil) || 0 : 0
    this.hardStateSince = persistedPolicyMatches ? finite(persisted.hardStateSince) : null
    this.rebalances = Array.isArray(persisted.rebalances)
      ? persisted.rebalances.filter(value => Number(value) >= now - 60 * 60_000).map(Number)
      : []
    this.events = Array.isArray(persisted.events) ? persisted.events.slice(-100) : []
    if (!persistedPolicyMatches && Object.keys(persisted).length > 0) {
      this.#event(now, 'POLICY_MIGRATED', 'NAV 평가손실 정지 정책을 제거하고 가격 급락 안전가드 정책으로 전환했습니다.')
    }
  }

  ingest(snapshot) {
    const now = finite(snapshot?.at) || Date.now()
    const tick = finite(snapshot?.tick)
    const spotPrice = finite(snapshot?.spotPrice)
    const spacing = finite(snapshot?.tickSpacing)
    if (tick == null || spotPrice == null || spotPrice <= 0 || spacing == null || spacing <= 0) {
      return this.#decision(now, ROBINHOOD_GUARD_STATES.SOFT_PAUSE, ['풀 가격 또는 tick 데이터가 유효하지 않습니다.'], 'NO_ACTION', {})
    }

    const officialPrice = finite(snapshot.official?.tokenPrice)
    const sample = { at: now, tick, spotPrice, officialPrice }
    const last = this.samples[this.samples.length - 1]
    if (!last || last.at !== now || last.tick !== tick) this.samples.push(sample)
    this.samples = this.samples.filter(item => item.at >= now - 60 * 60_000)
    this.rebalances = this.rebalances.filter(value => value >= now - 60 * 60_000)

    const oneMinute = sampleAtOrBefore(this.samples, now - 60_000)
    const fiveMinute = sampleAtOrBefore(this.samples, now - 300_000)
    const oneMinuteChangePercent = percentChange(spotPrice, oneMinute?.spotPrice)
    const fiveMinuteChangePercent = percentChange(spotPrice, fiveMinute?.spotPrice)
    const officialFiveMinuteChangePercent = percentChange(officialPrice, fiveMinute?.officialPrice)
    const spotTwap30DeviationPercent = percentDistance(spotPrice, snapshot.twap30Price)
    const twapDivergencePercent = percentDistance(snapshot.twap30Price, snapshot.twap300Price)
    const dexOfficialDeviationPercent = percentDistance(spotPrice, officialPrice)
    const oracleGuard = snapshot.oracleGuard || evaluateOracleGuard(snapshot, this.config)
    const officialAgeSec = oracleGuard.officialAgeSec
    const officialMaxAgeSec = oracleGuard.officialMaxAgeSec
    const officialFresh = oracleGuard.primaryFresh
    const officialOperational = oracleGuard.operational
    const strategyNavChangePercent = percentChange(snapshot.strategyNavUsd, snapshot.strategyPrincipalUsd)
    const warmed = Boolean(fiveMinute)
    const onchainTwapReady = finite(snapshot.twap30Price) != null
      && finite(snapshot.twap300Price) != null
      && Number(snapshot.observationCardinality || 0) > 1

    if (snapshot.managedRange && rangeIsValid(snapshot.managedRange)) {
      const managedRange = {
        lower: Number(snapshot.managedRange.lower),
        upper: Number(snapshot.managedRange.upper),
        anchor: Number(snapshot.managedRange.anchor ?? rangeAnchor(snapshot.managedRange.lower, snapshot.managedRange.upper, spacing)),
        width: Number(snapshot.managedRange.upper) - Number(snapshot.managedRange.lower),
      }
      if (!this.virtualRange || this.virtualRange.lower !== managedRange.lower || this.virtualRange.upper !== managedRange.upper) {
        this.virtualRange = managedRange
        this.#event(now, 'RANGE_SYNCED', `온체인 포지션 범위 ${managedRange.lower} → ${managedRange.upper}`)
      }
    } else if (!this.virtualRange) {
      this.virtualRange = strategyRange(tick, spacing, this.config.widthIntervals)
      this.lastInRangeAt = now
      this.#event(now, 'RANGE_INITIALIZED', `가상 ${this.config.widthIntervals}틱 범위 ${this.virtualRange.lower} — ${this.virtualRange.upper}`)
    }

    const wasInRange = rangeContains(this.virtualRange, tick)
    if (wasInRange) this.lastInRangeAt = now
    const rapidBandExit = !wasInRange
      && this.lastInRangeAt != null
      && now - this.lastInRangeAt <= this.config.rapidBandCrossingSec * 1000
      && last != null
      && Math.abs(tick - last.tick) >= this.config.rapidBandCrossingTicks
    const reasons = []
    let nextState = ROBINHOOD_GUARD_STATES.LIVE
    const unsafeForSwap = !snapshot.contractsVerified
      || Boolean(snapshot.official?.isTradingHalt)
      || Boolean(snapshot.stock?.paused || snapshot.stock?.oraclePaused)

    if (!snapshot.contractsVerified) {
      nextState = ROBINHOOD_GUARD_STATES.WITHDRAW_ONLY
      reasons.push('Pool·Gauge·Position Manager 주소 검증에 실패했습니다.')
    }
    if (snapshot.official?.isTradingHalt) {
      nextState = ROBINHOOD_GUARD_STATES.WITHDRAW_ONLY
      reasons.push('Robinhood 공식 가격원이 거래정지 상태를 보고했습니다.')
    }
    if (snapshot.stock?.paused || snapshot.stock?.oraclePaused) {
      nextState = ROBINHOOD_GUARD_STATES.WITHDRAW_ONLY
      reasons.push('SPCX 토큰 또는 multiplier oracle이 일시정지 상태입니다.')
    }

    const hardExitConfirmed = warmed
      && officialFresh
      && fiveMinuteChangePercent != null
      && officialFiveMinuteChangePercent != null
      && fiveMinuteChangePercent <= this.config.exitDrop5mPercent
      && officialFiveMinuteChangePercent <= this.config.officialExitDrop5mPercent
      && dexOfficialDeviationPercent != null
      && dexOfficialDeviationPercent <= this.config.dexToOfficialMaxPercent

    if (hardExitConfirmed) {
      if (this.hardStateSince == null) this.hardStateSince = now
      if (now - this.hardStateSince >= this.config.exitConfirmationSec * 1000) {
        nextState = ROBINHOOD_GUARD_STATES.USDG_EXIT_PENDING
        reasons.push(`DEX와 공식 가격이 5분 급락을 함께 확인했습니다 (${fiveMinuteChangePercent.toFixed(2)}%).`)
      } else {
        nextState = ROBINHOOD_GUARD_STATES.WITHDRAW_ONLY
        reasons.push('급락 확인 대기 중이며 우선 원물 회수 단계입니다.')
      }
    } else {
      this.hardStateSince = null
      if (fiveMinuteChangePercent != null && fiveMinuteChangePercent <= this.config.withdrawDrop5mPercent) {
        nextState = ROBINHOOD_GUARD_STATES.WITHDRAW_ONLY
        reasons.push(`5분 가격 변화가 ${fiveMinuteChangePercent.toFixed(2)}%로 원물 회수 기준을 넘었습니다.`)
      }
    }

    const softReasons = []
    if (!onchainTwapReady) {
      const capacity = Number(snapshot.observationCardinalityNext || snapshot.observationCardinality || 0)
      softReasons.push(capacity >= 64
        ? '오라클 용량은 준비됐지만 30초·5분 관찰 이력이 아직 부족합니다.'
        : '풀 오라클 저장 용량이 부족해 30초·5분 온체인 TWAP을 계산할 수 없습니다.')
    }
    if (!officialOperational) {
      softReasons.push(`온체인 SPCX Chainlink 가격이 없거나 ${Math.round(officialMaxAgeSec / 3600)}시간보다 오래되었고 휴장 합의 검증도 통과하지 못했습니다.`)
    }
    if (oneMinuteChangePercent != null && oneMinuteChangePercent <= this.config.softDrop1mPercent) softReasons.push(`1분 가격 변화 ${oneMinuteChangePercent.toFixed(2)}%`)
    if (rapidBandExit) softReasons.push(`10초 이내 ${this.config.rapidBandCrossingTicks}틱 이상 급변하며 밴드를 이탈했습니다.`)
    if (spotTwap30DeviationPercent != null && spotTwap30DeviationPercent > this.config.spotToTwap30MaxPercent) softReasons.push(`spot/30초 TWAP 괴리 ${spotTwap30DeviationPercent.toFixed(3)}%`)
    if (twapDivergencePercent != null && twapDivergencePercent > this.config.twap30ToTwap300MaxPercent) softReasons.push(`30초/5분 TWAP 괴리 ${twapDivergencePercent.toFixed(3)}%`)
    if (dexOfficialDeviationPercent != null && dexOfficialDeviationPercent > this.config.dexToOfficialMaxPercent) softReasons.push(`DEX/공식 가격 괴리 ${dexOfficialDeviationPercent.toFixed(3)}%`)

    if (nextState === ROBINHOOD_GUARD_STATES.LIVE && softReasons.length) {
      nextState = ROBINHOOD_GUARD_STATES.SOFT_PAUSE
      this.softPauseUntil = Math.max(this.softPauseUntil, now + this.config.softPauseSec * 1000)
      reasons.push(...softReasons)
    }
    if (nextState === ROBINHOOD_GUARD_STATES.LIVE && this.softPauseUntil > now) {
      nextState = ROBINHOOD_GUARD_STATES.SOFT_PAUSE
      reasons.push(`안정화 대기 ${Math.ceil((this.softPauseUntil - now) / 1000)}초`)
    }
    if (nextState === ROBINHOOD_GUARD_STATES.LIVE && !warmed) {
      nextState = ROBINHOOD_GUARD_STATES.WARMING
      reasons.push('5분 관찰 이력을 수집하는 중입니다.')
    }

    if ([ROBINHOOD_GUARD_STATES.WITHDRAW_ONLY, ROBINHOOD_GUARD_STATES.USDG_EXIT_PENDING].includes(this.state)
      && ![ROBINHOOD_GUARD_STATES.WITHDRAW_ONLY, ROBINHOOD_GUARD_STATES.USDG_EXIT_PENDING].includes(nextState)) {
      nextState = this.state
      reasons.push('자본보호 상태는 소유자가 수동으로 해제하기 전까지 유지됩니다.')
    }

    const recent10m = this.rebalances.filter(value => value >= now - 600_000).length
    const recent1h = this.rebalances.length
    let action = 'NO_ACTION'
    if (!wasInRange && nextState === ROBINHOOD_GUARD_STATES.LIVE) {
      const tooSoon = this.rebalances.length > 0 && now - this.rebalances[this.rebalances.length - 1] < this.config.minRebalanceIntervalSec * 1000
      if (tooSoon || recent10m >= this.config.maxRebalances10m || recent1h >= this.config.maxRebalances1h) {
        nextState = ROBINHOOD_GUARD_STATES.SOFT_PAUSE
        this.softPauseUntil = Math.max(this.softPauseUntil, now + this.config.rateLimitPauseSec * 1000)
        reasons.push('재배치 횟수 제한에 도달해 30분 정지합니다.')
        action = 'RATE_LIMITED'
      } else if (this.executionMode === 'LIVE') {
        action = 'REBALANCE_REQUIRED'
      } else {
        const previous = this.virtualRange
        this.virtualRange = strategyRange(tick, spacing, this.config.widthIntervals)
        this.rebalances.push(now)
        this.lastInRangeAt = now
        action = 'SHADOW_REBALANCE'
        this.#event(now, action, `${previous.lower} — ${previous.upper} → ${this.virtualRange.lower} — ${this.virtualRange.upper}`)
      }
    } else if (!wasInRange && nextState === ROBINHOOD_GUARD_STATES.SOFT_PAUSE) action = 'FREEZE_REBALANCE'
    else if (nextState === ROBINHOOD_GUARD_STATES.WITHDRAW_ONLY) action = 'WITHDRAW_TO_IDLE_REQUIRED'
    else if (nextState === ROBINHOOD_GUARD_STATES.USDG_EXIT_PENDING) action = 'USDG_EXIT_REQUIRED'

    if (nextState !== this.state) this.#event(now, 'STATE_CHANGED', `${this.state} → ${nextState}`)
    this.state = nextState
    return this.#decision(now, nextState, reasons, action, {
      oneMinuteChangePercent,
      fiveMinuteChangePercent,
      officialFiveMinuteChangePercent,
      spotTwap30DeviationPercent,
      twapDivergencePercent,
      dexOfficialDeviationPercent,
      officialAgeSec,
      officialMaxAgeSec,
      officialFresh,
      oracleMode: oracleGuard.mode,
      closedMarketConsensus: oracleGuard.closedMarketConsensus,
      expectedMarketClosed: oracleGuard.expectedMarketClosed,
      closedMarketMaxAgeSec: oracleGuard.closedMarketMaxAgeSec,
      quoteAgeSec: oracleGuard.quoteAgeSec,
      quoteFresh: oracleGuard.quoteFresh,
      quoteBidUsdg: oracleGuard.quoteBidUsdg,
      quoteAskUsdg: oracleGuard.quoteAskUsdg,
      dexInsideOfficialQuote: oracleGuard.dexInsideOfficialQuote,
      valuationPrice: oracleGuard.valuationPrice,
      strategyNavChangePercent,
      warmed,
      onchainTwapReady,
      rapidBandExit,
      inRange: rangeContains(this.virtualRange, tick),
      rebalances10m: this.rebalances.filter(value => value >= now - 600_000).length,
      rebalances1h: this.rebalances.length,
    })
  }

  serialize() {
    return {
      guardPolicyVersion: ROBINHOOD_GUARD_POLICY_VERSION,
      state: this.state,
      virtualRange: this.virtualRange,
      lastInRangeAt: this.lastInRangeAt,
      softPauseUntil: this.softPauseUntil,
      hardStateSince: this.hardStateSince,
      rebalances: this.rebalances,
      events: this.events.slice(-100),
      samples: this.samples,
    }
  }

  setExecutionMode(mode) {
    this.executionMode = mode === 'LIVE' ? 'LIVE' : 'SHADOW'
  }

  recordConfirmedRebalance(at, range) {
    const timestamp = finite(at) || Date.now()
    this.rebalances.push(timestamp)
    this.rebalances = this.rebalances.filter(value => value >= timestamp - 60 * 60_000)
    if (rangeIsValid(range)) {
      this.virtualRange = {
        lower: Number(range.lower),
        upper: Number(range.upper),
        anchor: Number(range.anchor ?? rangeAnchor(range.lower, range.upper)),
        width: Number(range.upper) - Number(range.lower),
      }
    }
    this.lastInRangeAt = timestamp
    this.#event(timestamp, 'LIVE_REBALANCE_CONFIRMED', `${this.virtualRange?.lower ?? '—'} → ${this.virtualRange?.upper ?? '—'}`)
  }

  #event(at, type, message) {
    this.events.push({ at, type, message })
    this.events = this.events.slice(-100)
  }

  #decision(at, state, reasons, action, metrics) {
    const range = this.virtualRange
    return {
      at,
      mode: this.executionMode,
      state,
      reasons,
      action,
      metrics,
      range,
      config: this.config,
      events: this.events.slice(-30).reverse(),
      liveWritesEnabled: this.executionMode === 'LIVE',
    }
  }
}
