import clsx from 'clsx'
import { ComponentProps } from 'react'

export function Overlay({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      aria-hidden="true"
      className={clsx('fixed inset-0 z-40 bg-black/20', className)}
      {...props}
    />
  )
}
