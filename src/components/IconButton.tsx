import type { LucideIcon } from 'lucide-react'
import type { ComponentProps } from 'react'

import type { ShortcutChordValue } from '@/shortcuts'
import { cn } from '@/utils'

import { AppTooltip } from './AppTooltip'
import { Button } from './ui/button'

interface IconButtonProps extends Omit<ComponentProps<'button'>, 'size' | 'title'> {
  Icon: LucideIcon
  iconClassName?: string
  shortcut?: ShortcutChordValue
  size?: number
  title?: string
}

export function IconButton({
  'aria-label': ariaLabel,
  className,
  Icon,
  iconClassName,
  shortcut,
  size = 16,
  title,
  ...props
}: IconButtonProps) {
  const button = (
    <Button
      aria-label={ariaLabel ?? title}
      variant="ghost"
      size="icon-sm"
      className={cn('rounded-sm', className)}
      {...props}
    >
      <Icon size={size} className={iconClassName} />
    </Button>
  )

  return title ? (
    <AppTooltip disabled={props.disabled} label={title} shortcut={shortcut}>
      {button}
    </AppTooltip>
  ) : (
    button
  )
}
