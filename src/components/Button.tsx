import { type LucideIcon } from 'lucide-react'
import { ComponentProps } from 'react'

import { cn } from '@/lib/utils'

import type { ShortcutChordValue } from '../shortcuts'

import { AppTooltip } from './AppTooltip'
import { Button as ShadcnButton } from './ui/button'

interface IconButtonProps extends Omit<
  ComponentProps<'button'>,
  'size' | 'title'
> {
  Icon: LucideIcon
  shortcut?: ShortcutChordValue
  size?: number
  title?: string
}
export function IconButton({
  'aria-label': ariaLabel,
  className,
  Icon,
  shortcut,
  size = 16,
  title,
  ...props
}: IconButtonProps) {
  const button = (
    <ShadcnButton
      aria-label={ariaLabel ?? title}
      variant="ghost"
      size="icon-sm"
      className={cn('h-auto w-auto rounded-sm p-0.5', className)}
      {...props}
    >
      <Icon size={size} />
    </ShadcnButton>
  )

  return title ? (
    <AppTooltip disabled={props.disabled} label={title} shortcut={shortcut}>
      {button}
    </AppTooltip>
  ) : (
    button
  )
}

const variantMap = {
  primary: 'default',
  secondary: 'secondary',
  destructive: 'destructive',
} as const

const compactClassMap = {
  true: 'h-auto px-2 py-1',
  false: 'h-auto px-3 py-1.5',
}

export interface ButtonProps extends Omit<ComponentProps<'button'>, 'title'> {
  variant?: keyof typeof variantMap
  compact?: boolean
  shortcut?: ShortcutChordValue
  title?: string
}
export const Button: React.FC<ButtonProps> = ({
  'aria-label': ariaLabel,
  variant = 'primary',
  compact = false,
  className,
  shortcut,
  title,
  ...props
}) => {
  const button = (
    <ShadcnButton
      aria-label={ariaLabel ?? title}
      variant={variantMap[variant]}
      className={cn(compactClassMap[`${compact}`], className)}
      {...props}
    />
  )

  return title ? (
    <AppTooltip disabled={props.disabled} label={title} shortcut={shortcut}>
      {button}
    </AppTooltip>
  ) : (
    button
  )
}
