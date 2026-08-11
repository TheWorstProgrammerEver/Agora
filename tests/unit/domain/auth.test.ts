import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getDefaultAuthenticationType,
  getEnabledAuthenticationTypes,
  getAuthenticationCapabilities,
  getAuthenticationErrorMessage,
  getSupportedAuthenticationTypes
} from '../../../src/domain/auth'

describe('auth config helpers', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('defaults to email password auth', () => {
    expect(getSupportedAuthenticationTypes()).toEqual({
      emailPassword: true,
      magicLink: false,
      otp: false,
      passkey: false
    })
  })

  it('keeps a stable enabled method order', () => {
    vi.stubGlobal('window', {
      config: {
        auth: {
          supportedTypes: {
            emailPassword: false,
            magicLink: true,
            otp: true,
            passkey: true
          }
        }
      }
    })

    const supportedTypes = getSupportedAuthenticationTypes()

    expect(getEnabledAuthenticationTypes(supportedTypes)).toEqual(['passkey', 'otp', 'magicLink'])
    expect(getDefaultAuthenticationType(supportedTypes)).toBe('passkey')
  })

  it('respects explicitly disabled authentication and signup capabilities', () => {
    vi.stubGlobal('window', {
      config: {
        auth: {
          publicSignup: false,
          supportedTypes: {
            emailPassword: false,
            magicLink: false,
            otp: false,
            passkey: false
          }
        }
      }
    })

    expect(getAuthenticationCapabilities()).toEqual({
      publicSignup: false,
      supportedTypes: {
        emailPassword: false,
        magicLink: false,
        otp: false,
        passkey: false
      }
    })
  })

  it('keeps defaults for omitted capabilities', () => {
    vi.stubGlobal('window', {
      config: {
        auth: {
          supportedTypes: { otp: true }
        }
      }
    })

    expect(getAuthenticationCapabilities()).toEqual({
      publicSignup: true,
      supportedTypes: {
        emailPassword: true,
        magicLink: false,
        otp: true,
        passkey: false
      }
    })
  })

  it('projects backend-disabled signup errors cleanly', () => {
    const error = Object.assign(new Error('Signups not allowed for this instance'), {
      code: 'signup_disabled'
    })

    expect(getAuthenticationErrorMessage(error)).toBe('Account creation is disabled.')
    expect(getAuthenticationErrorMessage(new Error('Invalid login'))).toBe('Invalid login')
  })
})
