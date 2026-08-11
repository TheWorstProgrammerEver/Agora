import { useCallback } from 'react'

export const useConfirmation = (message: string) => (
  useCallback((action: () => void) => {
    if (window.confirm(message)) {
      action()
    }
  }, [message])
)
