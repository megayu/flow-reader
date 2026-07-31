import type * as React from 'react'

import { cn } from '@/utils'

import { Input } from './input'

type InputGroupVariant = 'default' | 'ghost'

function InputGroup({
  className,
  variant = 'default',
  ...props
}: React.ComponentProps<'div'> & {
  variant?: InputGroupVariant
}) {
  return (
    <div
      data-slot="input-group"
      data-variant={variant}
      className={cn(
        'flex h-8 items-center rounded-lg transition-colors',
        variant === 'default'
          ? 'border-input bg-background focus-within:border-ring focus-within:ring-ring/50 border focus-within:ring-3 dark:bg-input/30'
          : 'bg-background focus-within:shadow-[inset_0_0_0_1px_var(--ring)]',
        className,
      )}
      {...props}
    />
  )
}

function InputGroupInput({ className, ...props }: React.ComponentProps<typeof Input>) {
  return (
    <Input
      data-slot="input-group-input"
      className={cn(
        'h-full min-w-0 flex-1 rounded-none border-0 bg-transparent px-2.5 py-0 leading-none focus-visible:border-transparent focus-visible:ring-0',
        className,
      )}
      {...props}
    />
  )
}

function InputGroupActions({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="input-group-actions"
      className={cn('flex shrink-0 items-center gap-0.5 pr-1', className)}
      {...props}
    />
  )
}

export { InputGroup, InputGroupActions, InputGroupInput }
