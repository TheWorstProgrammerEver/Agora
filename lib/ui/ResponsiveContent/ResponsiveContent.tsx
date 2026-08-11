import type { ReactNode } from 'react'
import styles from './ResponsiveContent.module.scss'

type ResponsiveContentProps = {
  compact: ReactNode
  nonCompact: ReactNode
}

export const ResponsiveContent = ({ compact, nonCompact }: ResponsiveContentProps) => (
  <>
    <span className={styles.compact}>{compact}</span>
    <span className={styles.nonCompact}>{nonCompact}</span>
  </>
)
