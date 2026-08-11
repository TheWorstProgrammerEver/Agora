import type { ReactNode } from 'react'
import type { SupportedAuthenticationTypes } from '../../auth/authenticationTypes'

export type AuthPanelProps = {
  appName: ReactNode
  busy?: boolean
  environment: ReactNode
  error?: string
  notice?: string
  onCreateAccount: (email: string, name: string, password: string) => void | Promise<void>
  onMagicLink: (email: string, name: string) => void | Promise<void>
  onOtpRequest: (email: string, name: string) => void | Promise<void>
  onOtpVerify: (email: string, name: string, token: string) => void | Promise<void>
  onPasskeySignIn: () => void | Promise<void>
  onSignIn: (email: string, password: string) => void | Promise<void>
  onStatusClear: () => void
  supportedTypes: SupportedAuthenticationTypes
}

export type AuthFormProps = Omit<AuthPanelProps, 'appName' | 'environment'>
