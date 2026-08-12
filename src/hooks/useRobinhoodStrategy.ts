import { useCallback, useEffect, useRef, useState } from 'react'
import type { Address } from 'viem'
import { fetchRobinhoodStrategy, type RobinhoodStrategyStatus } from '../lib/robinhoodStrategy'

export function useRobinhoodStrategy(wallet?: Address, active = true) {
  const [data, setData] = useState<RobinhoodStrategyStatus>()
  const [loading, setLoading] = useState(active)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string>()
  const sequence = useRef(0)

  const refresh = useCallback(async (initial = false) => {
    if (!active) return
    const id = ++sequence.current
    const controller = new AbortController()
    if (initial) setLoading(true)
    else setRefreshing(true)
    try {
      const value = await fetchRobinhoodStrategy(wallet, controller.signal)
      if (id === sequence.current) {
        setData(value)
        setError(undefined)
      }
    } catch (cause) {
      if (id === sequence.current) setError(cause instanceof Error ? cause.message : 'Robinhood 전략 데이터를 불러오지 못했습니다.')
    } finally {
      if (id === sequence.current) {
        setLoading(false)
        setRefreshing(false)
      }
    }
    return () => controller.abort()
  }, [active, wallet])

  useEffect(() => {
    if (!active) return
    void refresh(true)
    const interval = window.setInterval(() => void refresh(false), 5_000)
    return () => {
      window.clearInterval(interval)
      sequence.current += 1
    }
  }, [active, refresh])

  return { data, loading, refreshing, error, refresh: () => refresh(false) }
}
