import { Section } from '../../../lib/ui/Section/Section'
import { useAuthContext } from '../../contexts/AuthContext'
import styles from './HomeScreen.module.scss'

export const HomeScreen = () => {
  const { currentAccount } = useAuthContext()

  return (
    <section className={styles.screen} aria-labelledby="home-title">
      <header className={styles.header}>
        <p>{currentAccount?.email}</p>
        <h2 id="home-title">Welcome to Agora</h2>
      </header>

      <Section title="Journey">
        <p className={styles.copy}>
          Your account is ready.
        </p>
      </Section>
    </section>
  )
}
