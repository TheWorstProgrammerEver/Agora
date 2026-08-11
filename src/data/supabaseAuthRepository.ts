import type { Session, User } from '@supabase/supabase-js'
import { nameFromEmail, normalizeEmail } from '../domain/people'
import type { Account } from '../types/auth'
import { supabase } from './supabaseClient'

type AuthCredentials = {
  email: string
  password: string
}

type SignUpCredentials = AuthCredentials & {
  name: string
}

type EmailCredentials = {
  email: string
  name: string
}

type EmailOnlyCredentials = EmailCredentials & {
  shouldCreateUser: boolean
}

type OtpCredentials = EmailCredentials & {
  token: string
}

export type AccountPasskey = {
  id: string
  createdAt: string
  friendlyName?: string
  lastUsedAt?: string
}

const passkeyFromSupabase = (passkey: {
  id: string
  created_at: string
  friendly_name?: string
  last_used_at?: string
}): AccountPasskey => ({
  id: passkey.id,
  createdAt: passkey.created_at,
  friendlyName: passkey.friendly_name,
  lastUsedAt: passkey.last_used_at
})

type HumanPrincipalRow = {
  created_at: string
  display_name: string
  id: string
}

const accountFromPrincipal = (user: User, principal: HumanPrincipalRow): Account => ({
  id: principal.id,
  email: normalizeEmail(user.email ?? ''),
  name: principal.display_name,
  createdDate: principal.created_at.slice(0, 10)
})

export const getCurrentSession = async () => {
  const { data, error } = await supabase.auth.getSession()

  if (error) {
    throw error
  }

  return data.session
}

export const onAuthSessionChange = (onChange: (session: Session | null) => void) => {
  const { data } = supabase.auth.onAuthStateChange((_event, session) => onChange(session))

  return () => data.subscription.unsubscribe()
}

export const getAccountForUser = async (user: User): Promise<Account> => {
  const { data, error } = await supabase
    .from('principals')
    .select('id, display_name, created_at')
    .eq('kind', 'human')
    .eq('auth_user_id', user.id)
    .single<HumanPrincipalRow>()

  if (error) {
    throw error
  }

  return accountFromPrincipal(user, data)
}

export const signInWithPassword = async ({ email, password }: AuthCredentials) => {
  const { data, error } = await supabase.auth.signInWithPassword({
    email: normalizeEmail(email),
    password
  })

  if (error) {
    throw error
  }

  if (!data.user) {
    throw new Error('Supabase did not return a signed-in user.')
  }

  return getAccountForUser(data.user)
}

export const signInWithPasskey = async () => {
  const { data, error } = await supabase.auth.signInWithPasskey()

  if (error) {
    throw error
  }

  if (!data.user) {
    throw new Error('Supabase did not return a signed-in user.')
  }

  return getAccountForUser(data.user)
}

export const signUpWithPassword = async ({ email, name, password }: SignUpCredentials) => {
  const normalizedEmail = normalizeEmail(email)
  const displayName = name.trim() || nameFromEmail(normalizedEmail)
  const { data, error } = await supabase.auth.signUp({
    email: normalizedEmail,
    password,
    options: {
      data: {
        display_name: displayName
      },
      emailRedirectTo: window.location.origin
    }
  })

  if (error) {
    throw error
  }

  if (!data.user) {
    throw new Error('Supabase did not return a created user.')
  }

  return data.session ? getAccountForUser(data.user) : undefined
}

export const requestOneTimePassword = async ({ email, name, shouldCreateUser }: EmailOnlyCredentials) => {
  const normalizedEmail = normalizeEmail(email)
  const displayName = name.trim() || nameFromEmail(normalizedEmail)
  const { error } = await supabase.auth.signInWithOtp({
    email: normalizedEmail,
    options: {
      data: {
        display_name: displayName
      },
      shouldCreateUser
    }
  })

  if (error) {
    throw error
  }
}

export const verifyOneTimePassword = async ({ email, token }: OtpCredentials) => {
  const normalizedEmail = normalizeEmail(email)
  const { data, error } = await supabase.auth.verifyOtp({
    email: normalizedEmail,
    token: token.trim(),
    type: 'email'
  })

  if (error) {
    throw error
  }

  if (!data.user) {
    throw new Error('Supabase did not return a signed-in user.')
  }

  return getAccountForUser(data.user)
}

export const sendMagicLink = async ({ email, name, shouldCreateUser }: EmailOnlyCredentials) => {
  const normalizedEmail = normalizeEmail(email)
  const displayName = name.trim() || nameFromEmail(normalizedEmail)
  const { error } = await supabase.auth.signInWithOtp({
    email: normalizedEmail,
    options: {
      data: {
        display_name: displayName
      },
      emailRedirectTo: window.location.origin,
      shouldCreateUser
    }
  })

  if (error) {
    throw error
  }
}

export const listPasskeys = async () => {
  const { data, error } = await supabase.auth.passkey.list()

  if (error) {
    throw error
  }

  return (data ?? []).map(passkeyFromSupabase)
}

export const registerPasskey = async () => {
  const { data, error } = await supabase.auth.registerPasskey()

  if (error) {
    throw error
  }

  if (!data) {
    throw new Error('Supabase did not return the registered passkey.')
  }

  return passkeyFromSupabase(data)
}

export const renamePasskey = async (passkeyId: string, friendlyName: string) => {
  const { data, error } = await supabase.auth.passkey.update({
    friendlyName: friendlyName.trim(),
    passkeyId
  })

  if (error) {
    throw error
  }

  if (!data) {
    throw new Error('Supabase did not return the updated passkey.')
  }

  return passkeyFromSupabase(data)
}

export const deletePasskey = async (passkeyId: string) => {
  const { error } = await supabase.auth.passkey.delete({ passkeyId })

  if (error) {
    throw error
  }
}

export const signOutOfSupabase = async () => {
  const { error } = await supabase.auth.signOut()

  if (error) {
    throw error
  }
}
