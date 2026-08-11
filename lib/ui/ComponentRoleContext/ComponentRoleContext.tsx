import { createContext, useContext, type ReactNode } from 'react'

export type ComponentRole = 'primary' | 'secondary' | 'tertiary' | 'destructive'

const RoleContext = createContext<ComponentRole>('secondary')

type ComponentRoleContextProps = {
  children: ReactNode
  role: ComponentRole
}

export const ComponentRoleContext = ({ children, role }: ComponentRoleContextProps) => (
  <RoleContext.Provider value={role}>
    {children}
  </RoleContext.Provider>
)

export const useComponentRoleContext = () => useContext(RoleContext)
