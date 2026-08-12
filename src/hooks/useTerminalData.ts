import { useCallback, useEffect, useRef, useState } from 'react'
import type { Address } from 'viem'
import { loadTerminalData } from '../lib/chainAdapter'
import type { TerminalData } from '../types'
import type { PoolPreset } from '../pools'

export function useTerminalData(walletAddress?: Address, poolPreset?: PoolPreset, timeframe = '1d') {
  const [data, setData] = useState<TerminalData | undefined>()
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string>()
  const requestId = useRef(0)
  const controller = useRef<AbortController | undefined>(undefined)

  const refresh = useCallback(async (initial = false) => {
    const id = ++requestId.current
    controller.current?.abort()
    const nextController = new AbortController()
    controller.current = nextController
    if (initial) setLoading(true)
    else setRefreshing(true)
    setError(undefined)
    try {
      const value = await loadTerminalData(walletAddress, poolPreset, timeframe, nextController.signal)
      if (id === requestId.current) setData(value)
    } catch (cause) {
      if (!nextController.signal.aborted && id === requestId.current) {
        setError(cause instanceof Error ? cause.message : '데이터를 불러오지 못했습니다.')
      }
    } finally {
      if (id === requestId.current) {
        setLoading(false)
        setRefreshing(false)
      }
    }
  }, [walletAddress, poolPreset, timeframe])

  useEffect(() => {
    void refresh(true)
    const interval = window.setInterval(() => void refresh(false), 15_000)
    return () => {
      window.clearInterval(interval)
      controller.current?.abort()
    }
  }, [refresh])

  return { data, loading, refreshing, error, refresh: () => refresh(false) }
}
