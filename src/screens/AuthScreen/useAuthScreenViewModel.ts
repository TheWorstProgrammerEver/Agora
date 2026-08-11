import { useAuthContext } from '../../contexts/AuthContext'

export const useAuthScreenViewModel = () => {
  const {
    authBusy,
    authError,
    authNotice,
    authReady,
    clearAuthStatus,
    currentAccount,
    publicSignup,
    requestOtp,
    sendMagicLink,
    signIn,
    signInWithPasskey,
    signUp,
    supportedTypes,
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
    publicSignup,
    supportedTypes,
    verifyOtp
  }
}
