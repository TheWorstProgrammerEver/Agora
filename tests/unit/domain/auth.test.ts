import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getDefaultAuthenticationType,
  getEnabledAuthenticationTypes,
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
})
