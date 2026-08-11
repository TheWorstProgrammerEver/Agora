import type { ComponentProps } from 'react'
import styles from './FormGrid.module.scss'

type FormGridProps = ComponentProps<'form'> & {
  singleColumn?: boolean
}

export const FormGrid = ({ className, singleColumn = false, ...props }: FormGridProps) => (
  <form
    {...props}
    className={[styles.form, singleColumn ? styles.singleColumn : undefined, className].filter(Boolean).join(' ')}
  />
)
