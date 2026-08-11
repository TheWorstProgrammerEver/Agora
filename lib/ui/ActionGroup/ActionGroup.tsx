import type { ComponentProps } from 'react'
import styles from './ActionGroup.module.scss'

type ActionGroupProps = ComponentProps<'span'> & {
  ariaLabel?: string
}

export const ActionGroup = ({ ariaLabel, className, ...props }: ActionGroupProps) => (
  <span
    {...props}
    className={[styles.actions, className].filter(Boolean).join(' ')}
    role={ariaLabel ? 'group' : undefined}
    aria-label={ariaLabel}
  />
)
