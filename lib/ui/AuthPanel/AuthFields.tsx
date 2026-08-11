type EmailFieldProps = {
  value: string
  onChange: (value: string) => void
}

type NameFieldProps = {
  required?: boolean
  value: string
  onChange: (value: string) => void
}

type PasswordFieldProps = {
  autoComplete: 'current-password' | 'new-password'
  value: string
  onChange: (value: string) => void
}

type OneTimeCodeFieldProps = {
  value: string
  onChange: (value: string) => void
}

export const EmailField = ({ value, onChange }: EmailFieldProps) => (
  <label>
    Email
    <input
      autoComplete="email"
      inputMode="email"
      name="email"
      required
      type="email"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  </label>
)

export const NameField = ({ required = false, value, onChange }: NameFieldProps) => (
  <label>
    Name
    <input
      autoComplete="name"
      name="name"
      required={required}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  </label>
)

export const PasswordField = ({ autoComplete, value, onChange }: PasswordFieldProps) => (
  <label>
    Password
    <input
      autoComplete={autoComplete}
      minLength={6}
      name="password"
      required
      type="password"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  </label>
)

export const OneTimeCodeField = ({ value, onChange }: OneTimeCodeFieldProps) => (
  <label>
    One-time code
    <input
      autoComplete="one-time-code"
      inputMode="numeric"
      name="one-time-code"
      required
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  </label>
)
