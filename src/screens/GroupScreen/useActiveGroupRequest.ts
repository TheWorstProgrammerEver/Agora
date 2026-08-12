import { useCallback, useEffect, useRef } from 'react'

export const useActiveGroupRequest = (groupId: string) => {
  const activeGroupIdRef = useRef<string | undefined>(groupId)
  activeGroupIdRef.current = groupId

  useEffect(() => {
    activeGroupIdRef.current = groupId

    return () => {
      if (activeGroupIdRef.current === groupId) {
        activeGroupIdRef.current = undefined
      }
    }
  }, [groupId])

  return useCallback((requestGroupId: string) => (
    activeGroupIdRef.current === requestGroupId
  ), [])
}
