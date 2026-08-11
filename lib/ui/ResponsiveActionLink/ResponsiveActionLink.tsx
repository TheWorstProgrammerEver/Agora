import { forwardRef, type ReactNode } from 'react'
import { ActionLink, type ActionLinkProps } from '../Button/ActionLink'
import { IconAndLabel, IconOnly } from '../ResponsiveContent/IconContent'
import { ResponsiveContent } from '../ResponsiveContent/ResponsiveContent'

type ResponsiveActionLinkProps = Omit<ActionLinkProps, 'children'> & {
  children?: ReactNode
  icon: ReactNode
  label: string
}

export const ResponsiveActionLink = forwardRef<HTMLAnchorElement, ResponsiveActionLinkProps>(({
  children,
  icon,
  label,
  ...props
}, ref) => (
  <ActionLink {...props} ref={ref}>
    <ResponsiveContent
      compact={<IconOnly icon={icon} label={label} />}
      nonCompact={(
        <IconAndLabel icon={icon} label={label}>
          {children ?? label}
        </IconAndLabel>
      )}
    />
  </ActionLink>
))

ResponsiveActionLink.displayName = 'ResponsiveActionLink'
