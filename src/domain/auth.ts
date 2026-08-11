import {
  getDefaultAuthenticationType,
  getEnabledAuthenticationTypes,
  type AuthenticationCapabilities,
  type SupportedAuthenticationTypes
} from '../../lib/auth/authenticationTypes'

export {
  getDefaultAuthenticationType,
  getEnabledAuthenticationTypes,
  type AuthenticationCapabilities,
  type AuthenticationType,
  type SupportedAuthenticationTypes
} from '../../lib/auth/authenticationTypes'

const defaultSupportedAuthenticationTypes: SupportedAuthenticationTypes = {
  emailPassword: true,
  magicLink: false,
  otp: false,
  passkey: false
}

export const getAuthenticationCapabilities = (): AuthenticationCapabilities => {
  const configured = typeof window === 'undefined' ? undefined : window.config?.auth

  return {
    publicSignup: configured?.publicSignup ?? true,
    supportedTypes: {
      ...defaultSupportedAuthenticationTypes,
      ...configured?.supportedTypes
    }
  }
}

export const getSupportedAuthenticationTypes = () => getAuthenticationCapabilities().supportedTypes

export const getAuthenticationErrorMessage = (error: unknown) => {
  const code = typeof error === 'object' && error && 'code' in error ? error.code : undefined

  if (code === 'signup_disabled') {
    return 'Account creation is disabled.'
  }

  return error instanceof Error ? error.message : 'Something went wrong with authentication.'
}
