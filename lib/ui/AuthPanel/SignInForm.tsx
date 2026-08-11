import { useRef, useState } from 'react'
import { EmailField, OneTimeCodeField, PasswordField } from './AuthFields'
import { AuthDivider } from './AuthDivider'
import { AuthMethodPicker, type AuthMethodOption } from './AuthMethodPicker'
import { AuthStatus } from './AuthStatus'
import type { AuthFormProps } from './AuthPanelTypes'
import styles from './AuthPanel.module.scss'

type SignInMethod = 'magicLink' | 'otp' | 'password'

const passwordlessDisplayName = ''

const getSignInMethods = (supportedTypes: AuthFormProps['supportedTypes']): AuthMethodOption<SignInMethod>[] => [
  supportedTypes.emailPassword && {
    description: 'Use your email and password.',
    id: 'password',
    label: 'Password'
  },
  supportedTypes.magicLink && {
    description: 'Send a sign-in link to your inbox.',
    id: 'magicLink',
    label: 'Magic link'
  },
  supportedTypes.otp && {
    description: 'Send a short code to your inbox.',
    id: 'otp',
    label: 'One-time code'
  }
].filter((method): method is AuthMethodOption<SignInMethod> => Boolean(method))

const getDefaultSignInMethod = (methods: AuthMethodOption<SignInMethod>[]) => (
  methods[0]?.id ?? 'password'
)

const getSubmitLabel = (method: SignInMethod, otpSent: boolean) => {
  if (method === 'magicLink') {
    return 'Send magic link'
  }

  if (method === 'otp') {
    return otpSent ? 'Verify code' : 'Send code'
  }

  return 'Sign in'
}

const reportEmailValidity = (form: HTMLFormElement | null) => {
  const emailControl = form?.elements.namedItem('email')

  return emailControl instanceof HTMLInputElement
    ? emailControl.reportValidity()
    : Boolean(form?.reportValidity())
}

export const SignInForm = ({
  busy = false,
  error,
  notice,
  onMagicLink,
  onOtpRequest,
  onOtpVerify,
  onPasskeySignIn,
  onSignIn,
  onStatusClear,
  supportedTypes
}: AuthFormProps) => {
  const formRef = useRef<HTMLFormElement>(null)
  const methods = getSignInMethods(supportedTypes)
  const [method, setMethod] = useState<SignInMethod>(() => getDefaultSignInMethod(methods))
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [otpSent, setOtpSent] = useState(false)
  const [otpToken, setOtpToken] = useState('')
  const showEmailSignIn = methods.length > 0
  const showDivider = supportedTypes.passkey && showEmailSignIn

  const selectMethod = (nextMethod: SignInMethod) => {
    setMethod(nextMethod)
    setOtpSent(false)
    setOtpToken('')
    onStatusClear()
  }

  const requestOtp = () => {
    if (!reportEmailValidity(formRef.current)) {
      return
    }

    setOtpSent(true)
    setOtpToken('')
    onStatusClear()
    void onOtpRequest(email, passwordlessDisplayName)
  }

  const submit = () => {
    if (!formRef.current?.reportValidity()) {
      return
    }

    onStatusClear()

    if (method === 'magicLink') {
      void onMagicLink(email, passwordlessDisplayName)
      return
    }

    if (method === 'otp') {
      if (otpSent) {
        void onOtpVerify(email, passwordlessDisplayName, otpToken)
        return
      }

      requestOtp()
      return
    }

    void onSignIn(email, password)
  }

  return (
    <div className={styles.formStack}>
      <AuthStatus error={error} notice={notice} />

      {supportedTypes.passkey && (
        <button
          className={styles.passkeyButton}
          type="button"
          disabled={busy}
          onClick={() => {
            onStatusClear()
            void onPasskeySignIn()
          }}
        >
          Sign in with passkey
        </button>
      )}

      {showDivider && <AuthDivider />}

      {methods.length > 0 && (
        <form ref={formRef} className={styles.authForm} onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}>
          {methods.length > 1 && (
            <AuthMethodPicker busy={busy} method={method} methods={methods} onMethodChange={selectMethod} />
          )}

          <EmailField value={email} onChange={setEmail} />

          {method === 'password' && (
            <PasswordField autoComplete="current-password" value={password} onChange={setPassword} />
          )}

          {method === 'otp' && otpSent && (
            <OneTimeCodeField value={otpToken} onChange={setOtpToken} />
          )}

          <button type="submit" disabled={busy}>{getSubmitLabel(method, otpSent)}</button>

          {method === 'otp' && otpSent && (
            <div className={styles.secondaryActions}>
              <button type="button" disabled={busy} onClick={requestOtp}>Send new code</button>
            </div>
          )}
        </form>
      )}
    </div>
  )
}
