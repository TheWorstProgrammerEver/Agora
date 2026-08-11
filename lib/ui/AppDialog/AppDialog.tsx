import { type ReactNode, useEffect, useId, useRef } from 'react'
import { X } from 'lucide-react'
import { ComponentRoleContext } from '../ComponentRoleContext/ComponentRoleContext'
import { ResponsiveButton } from '../ResponsiveButton/ResponsiveButton'
import styles from './AppDialog.module.scss'

type AppDialogProps = {
  children: ReactNode
  footer?: ReactNode
  open: boolean
  title: string
  onClose: () => void
}

type DialogFooterActionsProps = {
  children: ReactNode
}

export const DialogFooterActions = ({ children }: DialogFooterActionsProps) => (
  <div className={styles.footerActions}>{children}</div>
)

export const AppDialog = ({ children, footer, open, title, onClose }: AppDialogProps) => {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const titleId = useId()

  useEffect(() => {
    const dialog = dialogRef.current

    if (!dialog) {
      return
    }

    if (open && !dialog.open) {
      dialog.showModal()
    }

    if (!open && dialog.open) {
      dialog.close()
    }
  }, [open])

  return (
    <dialog
      aria-labelledby={titleId}
      className={styles.dialog}
      ref={dialogRef}
      onCancel={onClose}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose()
        }
      }}
    >
      {open && (
        <article className={styles.panel}>
          <header className={styles.header}>
            <h2 id={titleId}>{title}</h2>
            <ComponentRoleContext role="tertiary">
              <ResponsiveButton type="button" icon={<X />} label="Close" onClick={onClose} />
            </ComponentRoleContext>
          </header>

          <div className={styles.content}>
            {children}
          </div>

          {footer && (
            <footer className={styles.footer}>
              {footer}
            </footer>
          )}
        </article>
      )}
    </dialog>
  )
}
