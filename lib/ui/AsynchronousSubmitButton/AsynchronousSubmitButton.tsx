import { useId, type ButtonHTMLAttributes, type ReactNode } from 'react'
import type { LoaderState } from '../../hooks/useLoader'
import { Button } from '../Button/Button'
import styles from './AsynchronousSubmitButton.module.scss'

type AsynchronousSubmitButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> & {
  children: ReactNode
  loader: LoaderState
  statusLabel?: string
}

export const AsynchronousSubmitButton = ({
  children,
  disabled,
  loader,
  statusLabel = 'Submitting...',
  ...buttonProps
}: AsynchronousSubmitButtonProps) => {
  const statusId = useId()

  return (
    <>
      <Button
        {...buttonProps}
        type="submit"
        aria-busy={loader.busy}
        aria-describedby={loader.busy ? statusId : undefined}
        disabled={disabled || loader.busy}
      >
        {children}
      </Button>

      {loader.busy && (
        <span className={styles.status} id={statusId} role="status">
          {statusLabel}
        </span>
      )}
    </>
  )
}
