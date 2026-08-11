import type { ReactNode } from 'react'
import { HeaderWithActions } from '../HeaderWithActions/HeaderWithActions'
import styles from './Section.module.scss'

type SectionProps = {
  ariaLabel?: string
  actions?: ReactNode
  children: ReactNode
  title?: string
  titleId?: string
}

export const Section = ({ actions, ariaLabel, children, title, titleId }: SectionProps) => (
  <section className={styles.section} aria-label={title ? undefined : ariaLabel} aria-labelledby={title ? titleId : undefined}>
    {(title || actions) && (
      <HeaderWithActions
        header={title && <h2 id={titleId}>{title}</h2>}
        actions={actions}
      />
    )}

    <div className={styles.body}>
      {children}
    </div>
  </section>
)
