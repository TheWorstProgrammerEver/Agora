import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { useComponentRoleContext } from '../ComponentRoleContext/ComponentRoleContext'
import styles from './Button.module.scss'

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement>

const roleClassNames = {
  primary: styles.primary,
  secondary: styles.secondary,
  tertiary: styles.tertiary,
  destructive: styles.destructive
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(({ className, ...props }, ref) => {
  const role = useComponentRoleContext()

  return (
    <button
      {...props}
      className={[styles.control, roleClassNames[role], className].filter(Boolean).join(' ')}
      ref={ref}
    />
  )
})

Button.displayName = 'Button'
