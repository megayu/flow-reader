import type * as React from 'react'

import { cn } from '@/utils'

import { Button } from './button'

function SegmentedControl({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="segmented-control"
      className={cn(
        'text-muted-foreground ring-border inline-flex h-8 items-center overflow-hidden rounded-lg bg-(--flow-bg-control) p-0.5 ring-1 ring-inset',
        className,
      )}
      {...props}
    />
  )
}

function SegmentedControlItem({
  className,
  inherited = false,
  selected = false,
  ...props
}: Omit<React.ComponentProps<typeof Button>, 'size' | 'variant'> & {
  inherited?: boolean
  selected?: boolean
}) {
  return (
    <Button
      data-slot="segmented-control-item"
      type="button"
      aria-pressed={selected}
      variant={selected ? 'default' : 'ghost'}
      size="sm"
      className={cn(
        'h-full rounded-lg text-base',
        !selected && 'text-muted-foreground',
        inherited && !selected && 'bg-muted ring-border ring-1 ring-inset',
        className,
      )}
      {...props}
    />
  )
}

export { SegmentedControl, SegmentedControlItem }
