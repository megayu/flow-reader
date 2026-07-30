import type { ComponentProps } from 'react'

import type { ShortcutChordValue } from '@/shortcuts'

import { AppTooltip } from './AppTooltip'
import { Button } from './ui/button'

interface TooltipButtonProps extends Omit<ComponentProps<typeof Button>, 'title'> {
  shortcut?: ShortcutChordValue
  title: string
}

export function TooltipButton({ 'aria-label': ariaLabel, children, shortcut, title, ...props }: TooltipButtonProps) {
  return (
    <AppTooltip disabled={props.disabled} label={title} shortcut={shortcut}>
      <Button aria-label={ariaLabel ?? title} {...props}>
        {children}
      </Button>
    </AppTooltip>
  )
}
