import clsx from 'clsx'
import type { ComponentProps } from 'react'

export function StateLayer({ className, ...props }: ComponentProps<'span'>) {
  return <span aria-hidden="true" className={clsx('pointer-events-none absolute inset-0', className)} {...props} />
}
