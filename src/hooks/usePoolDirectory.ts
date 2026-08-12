import { useCallback, useEffect, useRef, useState } from 'react'
import { APP_CONFIG } from '../config'
import type { PoolDirectoryResponse } from '../types'

export function usePoolDirectory() {
  const [data, setData] = useState<PoolDirectoryResponse>()
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string>()
  const requestId = useRef(0)
  const controller = useRef<AbortController | undefined>(undefined)
  const dataRef = useRef<PoolDirectoryResponse | undefined>(undefined)

  const refresh = useCallback(async (force = false) => {
    const id = ++requestId.current
    controller.current?.abort()
    const nextController = new AbortController()
    controller.current = nextController
    if (dataRef.current) setRefreshing(true)
    else setLoading(true)
    setError(undefined)
    try {
      const suffix = force ? '?refresh=1' : ''
      const response = await fetch(`${APP_CONFIG.apiBaseUrl}/api/pools/directory${suffix}`, {
        signal: nextController.signal,
        headers: { accept: 'application/json' },
      })
      if (!response.ok) throw new Error(`풀 디렉터리 HTTP ${response.status}`)
      const value = await response.json() as PoolDirectoryResponse
      if (id === requestId.current) {
        dataRef.current = value
        setData(value)
      }
    } catch (cause) {
      if (nextController.signal.aborted) return
      if (id === requestId.current) setError(cause instanceof Error ? cause.message : '풀 목록을 불러오지 못했습니다.')
    } finally {
      if (id === requestId.current) {
        setLoading(false)
        setRefreshing(false)
      }
    }
  }, [])

  useEffect(() => {
    void refresh(false)
    const interval = window.setInterval(() => void refresh(false), 5 * 60_000)
    return () => {
      window.clearInterval(interval)
      controller.current?.abort()
    }
  }, [refresh])

  return {
    data,
    entries: data?.items || [],
    loading,
    refreshing,
    error,
    refresh: () => refresh(true),
  }
}
