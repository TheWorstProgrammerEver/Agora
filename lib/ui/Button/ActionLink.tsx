import { forwardRef, type ComponentProps } from 'react'
import { Link } from 'react-router-dom'
import { useComponentRoleContext } from '../ComponentRoleContext/ComponentRoleContext'
import styles from './Button.module.scss'

export type ActionLinkProps = ComponentProps<typeof Link>

const roleClassNames = {
  primary: styles.primary,
  secondary: styles.secondary,
  tertiary: styles.tertiary,
  destructive: styles.destructive
}

export const ActionLink = forwardRef<HTMLAnchorElement, ActionLinkProps>(({ className, ...props }, ref) => {
  const role = useComponentRoleContext()
  const resolvedClassName = [styles.control, roleClassNames[role], className].filter(Boolean).join(' ')

  return <Link {...props} className={resolvedClassName} ref={ref} />
})

ActionLink.displayName = 'ActionLink'
