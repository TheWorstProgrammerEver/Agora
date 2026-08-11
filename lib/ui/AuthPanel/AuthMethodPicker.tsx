import styles from './AuthPanel.module.scss'

export type AuthMethodOption<TMethod extends string> = {
  description: string
  id: TMethod
  label: string
}

type AuthMethodPickerProps<TMethod extends string> = {
  busy?: boolean
  legend?: string
  method: TMethod
  methods: AuthMethodOption<TMethod>[]
  onMethodChange: (method: TMethod) => void
}

export const AuthMethodPicker = <TMethod extends string,>({
  busy = false,
  legend = 'Sign in method',
  method,
  methods,
  onMethodChange
}: AuthMethodPickerProps<TMethod>) => (
  <fieldset className={styles.methodPicker}>
    <legend>{legend}</legend>

    <div className={styles.methodChoices}>
      {methods.map((option) => (
        <button
          className={method === option.id ? styles.selectedMethod : undefined}
          type="button"
          aria-pressed={method === option.id}
          disabled={busy}
          key={option.id}
          onClick={() => onMethodChange(option.id)}
        >
          <span>{option.label}</span>
          <small>{option.description}</small>
        </button>
      ))}
    </div>
  </fieldset>
)
