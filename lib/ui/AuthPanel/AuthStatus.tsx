import styles from './AuthPanel.module.scss'

type AuthStatusProps = {
  error?: string
  notice?: string
}

export const AuthStatus = ({ error, notice }: AuthStatusProps) => (
  <>
    {error && <p className={styles.error} role="alert">{error}</p>}
    {notice && <p className={styles.notice} role="status">{notice}</p>}
  </>
)
