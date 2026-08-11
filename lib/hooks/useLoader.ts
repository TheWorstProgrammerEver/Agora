import { useCallback, useMemo, useRef, useState } from 'react'

export type LoaderState = {
  busy: boolean
  clearError: () => void
  error?: string
  settled: boolean
}

type UseLoaderOptions = {
  getErrorMessage?: (error: unknown) => string
}

const defaultErrorMessage = (error: unknown) => (
  error instanceof Error ? error.message : 'Something went wrong.'
)

export const useLoader = ({ getErrorMessage = defaultErrorMessage }: UseLoaderOptions = {}) => {
  const [error, setError] = useState<string>()
  const [pendingCount, setPendingCount] = useState(0)
  const [settled, setSettled] = useState(false)
  const latestExecutionId = useRef(0)
  const busy = pendingCount > 0

  const clearError = useCallback(() => {
    setError(undefined)
  }, [])

  const execute = useCallback(async <TResult,>(action: () => TResult | Promise<TResult>) => {
    const executionId = latestExecutionId.current + 1
    latestExecutionId.current = executionId
    setPendingCount((count) => count + 1)
    setError(undefined)
    setSettled(false)

    try {
      return await action()
    } catch (nextError) {
      if (latestExecutionId.current === executionId) {
        setError(getErrorMessage(nextError))
      }

      throw nextError
    } finally {
      setPendingCount((count) => {
        const nextCount = Math.max(0, count - 1)

        if (nextCount === 0) {
          setSettled(true)
        }

        return nextCount
      })
    }
  }, [getErrorMessage])

  return useMemo(() => ({
    busy,
    clearError,
    error,
    execute,
    settled,
    setError
  }), [busy, clearError, error, execute, settled])
}
