import type { ComponentProps } from 'react'

import { cn } from '@/utils'

function TruncatedLabel({ className, onPointerEnter, ...props }: ComponentProps<'span'>) {
  return (
    <span
      {...props}
      className={cn('min-w-0 truncate leading-6', className)}
      onPointerEnter={(event) => {
        const label = event.currentTarget
        label.title = label.scrollWidth > label.clientWidth ? (label.textContent ?? '') : ''
        onPointerEnter?.(event)
      }}
    />
  )
}

export { TruncatedLabel }
