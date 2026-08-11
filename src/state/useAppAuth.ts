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
import type { Account } from '../types/auth'

export type AppAuth = {
  authBusy: boolean
  authError?: string
  authNotice?: string
  authReady: boolean
  clearAuthStatus: () => void
  currentAccount?: Account
  requestOtp: (email: string, name: string) => Promise<void>
  sendMagicLink: (email: string, name: string) => Promise<void>
  signIn: (email: string, password: string) => Promise<void>
  signInWithPasskey: () => Promise<void>
  signOut: () => Promise<void>
  signUp: (email: string, name: string, password: string) => Promise<void>
  verifyOtp: (email: string, name: string, token: string) => Promise<void>
}

const errorMessage = (error: unknown) => (
  error instanceof Error ? error.message : 'Something went wrong with authentication.'
)

export const useAppAuth = (): AppAuth => {
  const [authNotice, setAuthNotice] = useState<string>()
  const [authReady, setAuthReady] = useState(false)
  const [currentAccount, setCurrentAccount] = useState<Account>()
  const authLoader = useLoader({ getErrorMessage: errorMessage })
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
          setAuthError(errorMessage(error))
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
          setAuthError(errorMessage(error))
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
      () => signUpWithPassword({ email, name, password }),
      (account) => {
        setCurrentAccount(account)
        setAuthNotice('Account created.')
      }
    )
  ), [runAuthAction])

  const requestOtp = useCallback((email: string, name: string) => (
    runAuthAction(
      () => requestOneTimePassword({ email, name }),
      () => {
        setAuthNotice('Check your email for the one-time code.')
      }
    )
  ), [runAuthAction])

  const verifyOtp = useCallback((email: string, name: string, token: string) => (
    runAuthAction(
      () => verifyOneTimePassword({ email, name, token }),
      setCurrentAccount
    )
  ), [runAuthAction])

  const sendMagicLinkToEmail = useCallback((email: string, name: string) => (
    runAuthAction(
      () => sendMagicLink({ email, name }),
      () => {
        setAuthNotice('Check your email for the magic link.')
      }
    )
  ), [runAuthAction])

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
    requestOtp,
    sendMagicLink: sendMagicLinkToEmail,
    signIn,
    signInWithPasskey: signInWithRegisteredPasskey,
    signOut,
    signUp,
    verifyOtp
  }), [
    authBusy,
    authError,
    authNotice,
    authReady,
    clearAuthStatus,
    currentAccount,
    requestOtp,
    sendMagicLinkToEmail,
    signIn,
    signInWithRegisteredPasskey,
    signOut,
    signUp,
    verifyOtp
  ])
}
