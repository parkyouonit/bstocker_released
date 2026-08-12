import { useCallback, useEffect, useRef, useState } from 'react'
import type { Address } from 'viem'
import type { PoolSummary, Position, RewardsData } from '../types'
import { loadRewardsData } from '../lib/rewardAdapter'

export function useRewardsData(summary?: PoolSummary, owner?: Address, positions: Position[] = []) {
  const [data, setData] = useState<RewardsData>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const requestId = useRef(0)
  const controller = useRef<AbortController | undefined>(undefined)

  const refresh = useCallback(async () => {
    if (!summary || summary.mode !== 'live') {
      setData(undefined)
      return
    }
    const id = ++requestId.current
    controller.current?.abort()
    const nextController = new AbortController()
    controller.current = nextController
    setLoading(true)
    setError(undefined)
    try {
      const next = await loadRewardsData(summary, owner, positions, nextController.signal)
      if (id === requestId.current) setData(next)
    } catch (cause) {
      if (!nextController.signal.aborted && id === requestId.current) setError(cause instanceof Error ? cause.message : '보상 상태를 불러오지 못했습니다.')
    } finally {
      if (id === requestId.current) setLoading(false)
    }
  }, [summary, owner, positions])

  useEffect(() => {
    void refresh()
    const interval = window.setInterval(() => void refresh(), 30_000)
    return () => {
      window.clearInterval(interval)
      controller.current?.abort()
    }
  }, [refresh])

  return { data, loading, error, refresh }
}
