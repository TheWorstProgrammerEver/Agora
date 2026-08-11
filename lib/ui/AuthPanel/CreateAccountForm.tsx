import { useRef, useState } from 'react'
import { EmailField, OneTimeCodeField, PasswordField } from './AuthFields'
import { AuthMethodPicker, type AuthMethodOption } from './AuthMethodPicker'
import { AuthStatus } from './AuthStatus'
import type { AuthFormProps } from './AuthPanelTypes'
import styles from './AuthPanel.module.scss'

type CreateAccountMethod = 'magicLink' | 'otp' | 'password'

const accountDisplayName = ''

const getCreateAccountMethods = (supportedTypes: AuthFormProps['supportedTypes']): AuthMethodOption<CreateAccountMethod>[] => [
  supportedTypes.emailPassword && {
    description: 'Create a password for this account.',
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
].filter((method): method is AuthMethodOption<CreateAccountMethod> => Boolean(method))

const getDefaultCreateAccountMethod = (methods: AuthMethodOption<CreateAccountMethod>[]) => (
  methods[0]?.id ?? 'password'
)

const getSubmitLabel = (method: CreateAccountMethod, otpSent: boolean) => {
  if (method === 'magicLink') {
    return 'Send magic link'
  }

  if (method === 'otp') {
    return otpSent ? 'Verify code' : 'Send code'
  }

  return 'Create account'
}

export const CreateAccountForm = ({
  busy = false,
  error,
  notice,
  onCreateAccount,
  onMagicLink,
  onOtpRequest,
  onOtpVerify,
  onStatusClear,
  supportedTypes
}: AuthFormProps) => {
  const formRef = useRef<HTMLFormElement>(null)
  const methods = getCreateAccountMethods(supportedTypes)
  const [method, setMethod] = useState<CreateAccountMethod>(() => getDefaultCreateAccountMethod(methods))
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [otpSent, setOtpSent] = useState(false)
  const [otpToken, setOtpToken] = useState('')

  const selectMethod = (nextMethod: CreateAccountMethod) => {
    setMethod(nextMethod)
    setOtpSent(false)
    setOtpToken('')
    onStatusClear()
  }

  const submit = () => {
    if (!formRef.current?.reportValidity()) {
      return
    }

    onStatusClear()

    if (method === 'magicLink') {
      void onMagicLink(email, accountDisplayName)
      return
    }

    if (method === 'otp') {
      if (otpSent) {
        void onOtpVerify(email, accountDisplayName, otpToken)
        return
      }

      setOtpSent(true)
      void onOtpRequest(email, accountDisplayName)
      return
    }

    void onCreateAccount(email, accountDisplayName, password)
  }

  return (
    <div className={styles.formStack}>
      <AuthStatus error={error} notice={notice} />

      {methods.length ? (
        <form ref={formRef} className={styles.authForm} onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}>
          <EmailField value={email} onChange={setEmail} />
          <AuthMethodPicker busy={busy} method={method} methods={methods} onMethodChange={selectMethod} />

          {method === 'password' && (
            <PasswordField autoComplete="new-password" value={password} onChange={setPassword} />
          )}

          {method === 'otp' && otpSent && (
            <OneTimeCodeField value={otpToken} onChange={setOtpToken} />
          )}

          <button type="submit" disabled={busy}>{getSubmitLabel(method, otpSent)}</button>
        </form>
      ) : (
        <p className={styles.notice} role="status">
          Account creation is currently unavailable.
        </p>
      )}
    </div>
  )
}
