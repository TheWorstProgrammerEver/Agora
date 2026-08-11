import type { ReactNode } from 'react'
import { ActionGroup } from '../ActionGroup/ActionGroup'
import styles from './List.module.scss'

type ListProps = {
  ariaLabel?: string
  children: ReactNode
}

type ListItemProps = {
  actions?: ReactNode
  actionsLabel?: string
  details: ReactNode
  leading?: ReactNode
}

export const List = ({ ariaLabel, children }: ListProps) => (
  <ul className={styles.list} aria-label={ariaLabel}>
    {children}
  </ul>
)

export const ListItem = ({ actions, actionsLabel, details, leading }: ListItemProps) => (
  <li className={leading ? styles.withLeading : styles.item}>
    {leading && (
      <span className={styles.leading}>
        {leading}
      </span>
    )}

    <span className={styles.details}>
      {details}
    </span>

    {actions && (
      <ActionGroup ariaLabel={actionsLabel} className={styles.actions}>
        {actions}
      </ActionGroup>
    )}
  </li>
)
