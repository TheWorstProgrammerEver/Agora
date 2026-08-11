import { useEffect, type ReactNode } from 'react'
import type { LoaderState } from '../../hooks/useLoader'
import styles from './LoaderContainer.module.scss'

type LoaderContainerProps = {
  children: ReactNode
  className?: string
  loader: LoaderState
  loadingLabel?: string
  showErrorAsAlert?: boolean
}

export const LoaderContainer = ({
  children,
  className,
  loader,
  loadingLabel = 'Loading...',
  showErrorAsAlert = false
}: LoaderContainerProps) => {
  const { clearError, error } = loader

  useEffect(() => {
    if (showErrorAsAlert && error) {
      window.alert(error)
      clearError()
    }
  }, [clearError, error, showErrorAsAlert])

  return (
    <div
      className={[styles.container, loader.busy ? styles.busy : undefined, className].filter(Boolean).join(' ')}
      aria-busy={loader.busy}
    >
      <div className={styles.content}>
        {children}
      </div>

      {loader.busy && (
        <div className={styles.pending} aria-hidden="true">
          <span>{loadingLabel}</span>
        </div>
      )}
    </div>
  )
}
