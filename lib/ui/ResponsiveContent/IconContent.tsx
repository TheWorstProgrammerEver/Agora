import type { ReactNode } from 'react'
import styles from './IconContent.module.scss'

type IconAndLabelProps = {
  children: ReactNode
  icon: ReactNode
  label?: string
}

type IconOnlyProps = {
  icon: ReactNode
  label: string
}

export const IconAndLabel = ({ children, icon, label }: IconAndLabelProps) => (
  <span className={styles.content}>
    <span className={styles.icon} aria-hidden="true">
      {icon}
    </span>
    <span className={styles.label} aria-hidden={label ? true : undefined}>
      {children}
    </span>
    {label && <span className={styles.accessibleLabel}>{label}</span>}
  </span>
)

export const IconOnly = ({ icon, label }: IconOnlyProps) => (
  <span className={styles.content}>
    <span className={styles.icon} aria-hidden="true">
      {icon}
    </span>
    <span className={styles.accessibleLabel}>{label}</span>
  </span>
)
