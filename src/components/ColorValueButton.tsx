import type { ComponentProps } from 'react'

import { Button } from '@/components/ui/button'
import { cn } from '@/utils'

interface ColorValueButtonProps extends Omit<ComponentProps<'button'>, 'children'> {
  swatchClassName?: string
  value: string
}

export function ColorValueButton({ className, swatchClassName, value, ...props }: ColorValueButtonProps) {
  return (
    <Button
      variant="outline"
      type="button"
      className={cn(
        'border-input text-muted-foreground dark:bg-input/30 min-w-36 justify-start gap-2 text-left font-normal leading-none',
        className,
      )}
      {...props}
    >
      <span
        className={cn('ring-border h-5 w-8 shrink-0 rounded-md ring-1 ring-inset', swatchClassName)}
        style={{ backgroundColor: value }}
      />
      <span className="font-mono text-base">{value}</span>
    </Button>
  )
}
