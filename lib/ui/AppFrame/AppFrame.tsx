import { type ReactNode, useId, useState } from 'react'
import { Menu, X } from 'lucide-react'
import { Button } from '../Button/Button'
import { ComponentRoleContext } from '../ComponentRoleContext/ComponentRoleContext'
import styles from './AppFrame.module.scss'

type AppFrameProps = {
  accountMenu: ReactNode
  appName: ReactNode
  children: ReactNode
  environment: ReactNode
  navigation: ReactNode
  navigationLabel?: string
}

const shouldShowNavigation = () => (
  typeof window === 'undefined' || window.matchMedia('(min-width: 761px)').matches
)

export const AppFrame = ({
  accountMenu,
  appName,
  children,
  environment,
  navigation,
  navigationLabel = 'Primary navigation'
}: AppFrameProps) => {
  const navigationId = useId()
  const [navigationOpen, setNavigationOpen] = useState(shouldShowNavigation)
  const frameClassName = navigationOpen
    ? `${styles.frame} ${styles.navigationOpen}`
    : `${styles.frame} ${styles.navigationClosed}`

  const closeNavigationOnCompact = () => {
    if (window.matchMedia('(max-width: 760px)').matches) {
      setNavigationOpen(false)
    }
  }

  return (
    <div className={frameClassName}>
      <header className={styles.header}>
        <ComponentRoleContext role="secondary">
          <Button
            className={styles.menuButton}
            type="button"
            aria-controls={navigationId}
            aria-expanded={navigationOpen}
            aria-label={navigationOpen ? 'Hide navigation' : 'Show navigation'}
            onClick={() => setNavigationOpen((isOpen) => !isOpen)}
          >
            {navigationOpen ? <X aria-hidden="true" /> : <Menu aria-hidden="true" />}
          </Button>
        </ComponentRoleContext>

        <div className={styles.brand}>
          <p>{environment}</p>
          <h1>{appName}</h1>
        </div>

        <div className={styles.accountMenu}>
          {accountMenu}
        </div>
      </header>

      {navigationOpen && (
        <button
          className={styles.backdrop}
          type="button"
          aria-label="Close navigation"
          onClick={() => setNavigationOpen(false)}
        />
      )}

      <aside
        className={styles.sidebar}
        id={navigationId}
        aria-label={navigationLabel}
        aria-hidden={!navigationOpen}
        inert={navigationOpen ? undefined : true}
        onClick={(event) => {
          if (event.target instanceof Element && event.target.closest('a, button')) {
            closeNavigationOnCompact()
          }
        }}
      >
        {navigation}
      </aside>

      <main className={styles.main}>
        {children}
      </main>
    </div>
  )
}
