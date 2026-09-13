import { Children, type ComponentProps } from 'react'

import { cn } from '@/utils'

import { Button } from './button'
import { TruncatedLabel } from './truncated-label'

function SegmentedControl({ className, ...props }: ComponentProps<'div'>) {
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
  children,
  className,
  inherited = false,
  selected = false,
  ...props
}: Omit<ComponentProps<typeof Button>, 'size' | 'variant'> & {
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
        'h-full min-w-0 shrink rounded-lg text-base',
        !selected && 'text-muted-foreground',
        inherited && !selected && 'bg-muted ring-border ring-1 ring-inset',
        className,
      )}
      {...props}
    >
      {Children.map(children, (child) =>
        typeof child === 'string' || typeof child === 'number' ? (
          <TruncatedLabel className="leading-6.5">{child}</TruncatedLabel>
        ) : (
          child
        ),
      )}
    </Button>
  )
}

export { SegmentedControl, SegmentedControlItem }
