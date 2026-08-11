import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import {
  getAccountForUser,
  getCurrentSession,
  onAuthSessionChange,
  requestOneTimePassword,
  sendMagicLink,
  signInWithPasskey,
  signInWithPassword,
  signOutOfSupabase,
  signUpWithPassword,
  verifyOneTimePassword
} from '../data/supabaseAuthRepository'
import { useLoader } from '../../lib/hooks/useLoader'
import { getAuthenticationCapabilities, getAuthenticationErrorMessage } from '../domain/auth'
import type { Account } from '../types/auth'

export type AppAuth = {
  authBusy: boolean
  authError?: string
  authNotice?: string
  authReady: boolean
  clearAuthStatus: () => void
  currentAccount?: Account
  publicSignup: boolean
  requestOtp: (email: string, name: string, shouldCreateUser?: boolean) => Promise<void>
  sendMagicLink: (email: string, name: string, shouldCreateUser?: boolean) => Promise<void>
  signIn: (email: string, password: string) => Promise<void>
  signInWithPasskey: () => Promise<void>
  signOut: () => Promise<void>
  signUp: (email: string, name: string, password: string) => Promise<void>
  supportedTypes: ReturnType<typeof getAuthenticationCapabilities>['supportedTypes']
  verifyOtp: (email: string, name: string, token: string) => Promise<void>
}

export const useAppAuth = (): AppAuth => {
  const capabilities = useMemo(getAuthenticationCapabilities, [])
  const [authNotice, setAuthNotice] = useState<string>()
  const [authReady, setAuthReady] = useState(false)
  const [currentAccount, setCurrentAccount] = useState<Account>()
  const authLoader = useLoader({ getErrorMessage: getAuthenticationErrorMessage })
  const {
    busy: authBusy,
    clearError: clearAuthError,
    error: authError,
    execute: executeAuthAction,
    setError: setAuthError
  } = authLoader

  useEffect(() => {
    let active = true

    const applySession = async (session: Session | null = null) => {
      try {
        if (!session?.user) {
          if (active) {
            setCurrentAccount(undefined)
          }

          return
        }

        const account = await getAccountForUser(session.user)

        if (active) {
          setCurrentAccount(account)
        }
      } catch (error) {
        if (active) {
          setAuthError(getAuthenticationErrorMessage(error))
          setCurrentAccount(undefined)
        }
      } finally {
        if (active) {
          setAuthReady(true)
        }
      }
    }

    void getCurrentSession()
      .then((session) => applySession(session))
      .catch((error) => {
        if (active) {
          setAuthError(getAuthenticationErrorMessage(error))
          setCurrentAccount(undefined)
          setAuthReady(true)
        }
      })

    const unsubscribe = onAuthSessionChange((session) => {
      void applySession(session)
    })

    return () => {
      active = false
      unsubscribe()
    }
  }, [setAuthError])

  const clearAuthStatus = useCallback(() => {
    clearAuthError()
    setAuthNotice(undefined)
  }, [clearAuthError])

  const runAuthAction = useCallback(async <TResult,>(
    action: () => Promise<TResult>,
    onSuccess?: (result: TResult) => void
  ) => {
    setAuthNotice(undefined)

    try {
      const result = await executeAuthAction(action)
      onSuccess?.(result)
    } catch {
      // The loader has already captured the error for the UI.
    }
  }, [executeAuthAction])

  const requirePublicSignup = useCallback(() => {
    if (!capabilities.publicSignup) {
      throw Object.assign(new Error('Account creation is disabled.'), { code: 'signup_disabled' })
    }
  }, [capabilities.publicSignup])

  const signIn = useCallback((email: string, password: string) => (
    runAuthAction(
      () => signInWithPassword({ email, password }),
      setCurrentAccount
    )
  ), [runAuthAction])

  const signInWithRegisteredPasskey = useCallback(() => (
    runAuthAction(
      () => signInWithPasskey(),
      setCurrentAccount
    )
  ), [runAuthAction])

  const signUp = useCallback((email: string, name: string, password: string) => (
    runAuthAction(
      () => {
        requirePublicSignup()

        return signUpWithPassword({ email, name, password })
      },
      (account) => {
        if (account) {
          setCurrentAccount(account)
          setAuthNotice('Account created.')
        } else {
          setAuthNotice('Check your email to finish creating your account.')
        }
      }
    )
  ), [requirePublicSignup, runAuthAction])

  const requestOtp = useCallback((email: string, name: string, shouldCreateUser = false) => (
    runAuthAction(
      () => {
        if (shouldCreateUser) {
          requirePublicSignup()
        }

        return requestOneTimePassword({ email, name, shouldCreateUser })
      },
      () => {
        setAuthNotice('Check your email for the one-time code.')
      }
    )
  ), [requirePublicSignup, runAuthAction])

  const verifyOtp = useCallback((email: string, name: string, token: string) => (
    runAuthAction(
      () => verifyOneTimePassword({ email, name, token }),
      setCurrentAccount
    )
  ), [runAuthAction])

  const sendMagicLinkToEmail = useCallback((email: string, name: string, shouldCreateUser = false) => (
    runAuthAction(
      () => {
        if (shouldCreateUser) {
          requirePublicSignup()
        }

        return sendMagicLink({ email, name, shouldCreateUser })
      },
      () => {
        setAuthNotice('Check your email for the magic link.')
      }
    )
  ), [requirePublicSignup, runAuthAction])

  const signOut = useCallback(() => (
    runAuthAction(
      () => signOutOfSupabase(),
      () => {
        setCurrentAccount(undefined)
      }
    )
  ), [runAuthAction])

  return useMemo(() => ({
    authBusy,
    authError,
    authNotice,
    authReady,
    clearAuthStatus,
    currentAccount,
    publicSignup: capabilities.publicSignup,
    requestOtp,
    sendMagicLink: sendMagicLinkToEmail,
    signIn,
    signInWithPasskey: signInWithRegisteredPasskey,
    signOut,
    signUp,
    verifyOtp,
    supportedTypes: capabilities.supportedTypes
  }), [
    authBusy,
    authError,
    authNotice,
    authReady,
    clearAuthStatus,
    currentAccount,
    capabilities,
    requestOtp,
    sendMagicLinkToEmail,
    signIn,
    signInWithRegisteredPasskey,
    signOut,
    signUp,
    verifyOtp
  ])
}
