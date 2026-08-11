import { getSupportedAuthenticationTypes } from '../../domain/auth'
import { useAuthContext } from '../../contexts/AuthContext'

export const useAuthScreenViewModel = () => {
  const {
    authBusy,
    authError,
    authNotice,
    authReady,
    clearAuthStatus,
    currentAccount,
    requestOtp,
    sendMagicLink,
    signIn,
    signInWithPasskey,
    signUp,
    verifyOtp
  } = useAuthContext()

  return {
    authBusy,
    authError,
    authNotice,
    authReady,
    clearAuthStatus,
    requestOtp,
    sendMagicLink,
    signIn,
    signInWithPasskey,
    signUp,
    signedIn: Boolean(currentAccount),
    supportedTypes: getSupportedAuthenticationTypes(),
    verifyOtp
  }
}
