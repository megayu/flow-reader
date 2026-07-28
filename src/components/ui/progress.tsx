import type * as React from 'react'

import { cn } from '@/utils'

function Progress({
  className,
  max = 100,
  value = 0,
  ...props
}: React.ComponentProps<'div'> & {
  max?: number
  value?: number
}) {
  const percent = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0

  return (
    <div
      data-slot="progress"
      className={cn('bg-muted relative h-2 w-full overflow-hidden rounded-full', className)}
      role="progressbar"
      aria-valuemax={max}
      aria-valuemin={0}
      aria-valuenow={value}
      {...props}
    >
      <div
        className="h-full rounded-full bg-(--flow-accent) transition-[width] duration-200 ease-out"
        style={{ width: `${percent}%` }}
      />
    </div>
  )
}

export { Progress }
