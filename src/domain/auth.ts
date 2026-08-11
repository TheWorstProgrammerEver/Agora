import {
  getDefaultAuthenticationType,
  getEnabledAuthenticationTypes,
  type SupportedAuthenticationTypes
} from '../../lib/auth/authenticationTypes'

export {
  getDefaultAuthenticationType,
  getEnabledAuthenticationTypes,
  type AuthenticationType,
  type SupportedAuthenticationTypes
} from '../../lib/auth/authenticationTypes'

const defaultSupportedAuthenticationTypes: SupportedAuthenticationTypes = {
  emailPassword: true,
  magicLink: false,
  otp: false,
  passkey: false
}

export const getSupportedAuthenticationTypes = (): SupportedAuthenticationTypes => {
  const configured = typeof window === 'undefined'
    ? undefined
    : window.config?.auth?.supportedTypes
  const supportedTypes = {
    ...defaultSupportedAuthenticationTypes,
    ...configured
  }

  if (getEnabledAuthenticationTypes(supportedTypes).length > 0) {
    return supportedTypes
  }

  return defaultSupportedAuthenticationTypes
}
