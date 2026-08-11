export type AuthenticationType = 'emailPassword' | 'magicLink' | 'otp' | 'passkey'

export type SupportedAuthenticationTypes = Record<AuthenticationType, boolean>

const authenticationTypeOrder: AuthenticationType[] = ['emailPassword', 'passkey', 'otp', 'magicLink']

export const getEnabledAuthenticationTypes = (supportedTypes: SupportedAuthenticationTypes) => (
  authenticationTypeOrder.filter((type) => supportedTypes[type])
)

export const getDefaultAuthenticationType = (supportedTypes: SupportedAuthenticationTypes) => (
  getEnabledAuthenticationTypes(supportedTypes)[0] ?? 'emailPassword'
)
