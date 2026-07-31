import type { ComponentProps } from 'react'

import { cn } from '@/utils'

interface ColorValueButtonProps extends Omit<ComponentProps<'button'>, 'children'> {
  swatchClassName?: string
  value: string
}

export function ColorValueButton({ className, swatchClassName, value, ...props }: ColorValueButtonProps) {
  return (
    <button
      type="button"
      className={cn(
        'border-input text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 dark:bg-input/30 flex h-8 min-w-36 items-center gap-2 rounded-lg border bg-transparent px-2.5 text-left text-base leading-none transition-colors outline-none focus-visible:ring-3',
        className,
      )}
      {...props}
    >
      <span
        className={cn('ring-border h-5 w-8 shrink-0 rounded-md ring-1 ring-inset', swatchClassName)}
        style={{ backgroundColor: value }}
      />
      <span className="font-mono text-base">{value}</span>
    </button>
  )
}
