import type { ReactNode } from 'react'
import { ActionGroup } from '../ActionGroup/ActionGroup'
import styles from './HeaderWithActions.module.scss'

type HeaderWithActionsProps = {
  header: ReactNode
  actions: ReactNode
  className?: string
}

export const HeaderWithActions = ({ header, actions, className }: HeaderWithActionsProps) => (
  <div className={[styles.header, className].filter(Boolean).join(' ')}>
    <div className={styles.title}>{header}</div>
    <ActionGroup className={styles.actions}>{actions}</ActionGroup>
  </div>
)
