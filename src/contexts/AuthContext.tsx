import { createContext, type ReactNode, useContext } from 'react'
import { type AppAuth, useAppAuth } from '../state/useAppAuth'

const AuthContext = createContext<AppAuth | undefined>(undefined)

type AuthContextProviderProps = {
  children: ReactNode
}

export const AuthContextProvider = ({ children }: AuthContextProviderProps) => {
  const auth = useAppAuth()

  return (
    <AuthContext.Provider value={auth}>
      {children}
    </AuthContext.Provider>
  )
}

export const useAuthContext = () => {
  const context = useContext(AuthContext)

  if (!context) {
    throw new Error('useAuthContext must be used inside AuthContextProvider')
  }

  return context
}
