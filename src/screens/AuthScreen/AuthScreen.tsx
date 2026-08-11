import { Navigate, useLocation } from 'react-router-dom'
import { AuthPanel } from '../../../lib/ui/AuthPanel/AuthPanel'
import { useAuthScreenViewModel } from './useAuthScreenViewModel'
import styles from './AuthScreen.module.scss'

const getReturnTo = (state: unknown) => {
  if (!state || typeof state !== 'object' || !('returnTo' in state)) {
    return '/'
  }

  const returnTo = state.returnTo

  return typeof returnTo === 'string' && returnTo.startsWith('/') ? returnTo : '/'
}

export const AuthScreen = () => {
  const location = useLocation()
  const viewModel = useAuthScreenViewModel()
  const returnTo = getReturnTo(location.state)

  if (!viewModel.authReady) {
    return <main className={styles.screen} aria-busy="true" />
  }

  if (viewModel.signedIn) {
    return <Navigate to={returnTo} replace />
  }

  return (
    <main className={styles.screen}>
      <AuthPanel
        appName={window.config?.appName ?? 'Agora'}
        busy={viewModel.authBusy}
        environment={window.config?.environment ?? 'local'}
        error={viewModel.authError}
        notice={viewModel.authNotice}
        onCreateAccount={viewModel.signUp}
        onMagicLink={viewModel.sendMagicLink}
        onOtpRequest={viewModel.requestOtp}
        onOtpVerify={viewModel.verifyOtp}
        onPasskeySignIn={viewModel.signInWithPasskey}
        onSignIn={viewModel.signIn}
        onStatusClear={viewModel.clearAuthStatus}
        publicSignup={viewModel.publicSignup}
        supportedTypes={viewModel.supportedTypes}
      />
    </main>
  )
}
