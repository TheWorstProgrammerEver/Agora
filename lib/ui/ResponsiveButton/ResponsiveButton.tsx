import { forwardRef, type ReactNode } from 'react'
import { Button, type ButtonProps } from '../Button/Button'
import { IconAndLabel, IconOnly } from '../ResponsiveContent/IconContent'
import { ResponsiveContent } from '../ResponsiveContent/ResponsiveContent'

type ResponsiveButtonProps = Omit<ButtonProps, 'children'> & {
  children?: ReactNode
  icon: ReactNode
  label: string
}

export const ResponsiveButton = forwardRef<HTMLButtonElement, ResponsiveButtonProps>(({
  children,
  icon,
  label,
  ...props
}, ref) => (
  <Button {...props} ref={ref}>
    <ResponsiveContent
      compact={<IconOnly icon={icon} label={label} />}
      nonCompact={(
        <IconAndLabel icon={icon} label={label}>
          {children ?? label}
        </IconAndLabel>
      )}
    />
  </Button>
))

ResponsiveButton.displayName = 'ResponsiveButton'
