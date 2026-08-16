import { useCallback, useEffect, useRef, useState } from 'react'
import type { Address } from 'viem'
import { fetchRobinhoodStrategy, type RobinhoodStrategyStatus } from '../lib/robinhoodStrategy'

export function useRobinhoodStrategy(wallet?: Address, active = true) {
  const [data, setData] = useState<RobinhoodStrategyStatus>()
  const [loading, setLoading] = useState(active)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string>()
  const sequence = useRef(0)
  const controller = useRef<AbortController | null>(null)
  const inFlight = useRef<Promise<void> | null>(null)

  const refresh = useCallback(async (initial = false) => {
    if (!active) return
    if (inFlight.current) return inFlight.current
    const id = ++sequence.current
    const requestController = new AbortController()
    controller.current = requestController
    if (initial) setLoading(true)
    else setRefreshing(true)
    const request = (async () => {
      try {
        const value = await fetchRobinhoodStrategy(wallet, requestController.signal)
        if (id === sequence.current) {
          setData(value)
          setError(undefined)
        }
      } catch (cause) {
        if (!requestController.signal.aborted && id === sequence.current) {
          setError(cause instanceof Error ? cause.message : 'Robinhood 전략 데이터를 불러오지 못했습니다.')
        }
      } finally {
        if (id === sequence.current) {
          setLoading(false)
          setRefreshing(false)
        }
      }
    })()
    inFlight.current = request
    try {
      await request
    } finally {
      if (inFlight.current === request) inFlight.current = null
      if (controller.current === requestController) controller.current = null
    }
  }, [active, wallet])

  useEffect(() => {
    if (!active) {
      setLoading(false)
      return
    }
    let stopped = false
    let timer: number | undefined
    const poll = async (initial = false) => {
      await refresh(initial)
      if (!stopped) timer = window.setTimeout(() => void poll(false), 15_000)
    }
    void poll(true)
    return () => {
      stopped = true
      if (timer !== undefined) window.clearTimeout(timer)
      controller.current?.abort()
      controller.current = null
      inFlight.current = null
      sequence.current += 1
    }
  }, [active, refresh])

  return { data, loading, refreshing, error, refresh: () => refresh(false) }
}
