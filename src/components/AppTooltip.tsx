import type {
  ComponentProps,
  CSSProperties,
  ReactElement,
  ReactNode,
} from 'react'

import type { ShortcutChordValue } from '../shortcuts'

import { ShortcutChord } from './ShortcutChord'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

interface AppTooltipProps {
  children: ReactElement
  content?: ReactNode
  description?: string
  disabled?: boolean
  disabledReason?: string
  label: string
  shortcut?: ShortcutChordValue
  side?: ComponentProps<typeof TooltipContent>['side']
  align?: ComponentProps<typeof TooltipContent>['align']
  contentStyle?: CSSProperties
}

export const readerPageTooltipContentStyle = {
  maxWidth: 'min(var(--flow-reader-page-width, 24rem), calc(100vw - 2rem))',
} satisfies CSSProperties

export function AppTooltip({
  align = 'center',
  children,
  content,
  contentStyle,
  description,
  disabled = false,
  disabledReason,
  label,
  shortcut,
  side,
}: AppTooltipProps) {
  if (disabled && !disabledReason) return children

  const contentLabel = disabled ? disabledReason : label

  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent
        align={align}
        side={side}
        sideOffset={6}
        style={contentStyle}
      >
        {content ?? (
          <>
            <span className="min-w-0 text-base font-medium break-words">
              {contentLabel}
            </span>
            {description && (
              <span className="text-muted-foreground min-w-0 text-base break-words">
                {description}
              </span>
            )}
            {!disabled && shortcut && (
              <ShortcutChord
                className="ml-1.5"
                compact
                shortcut={shortcut}
                variant="tooltip"
              />
            )}
          </>
        )}
      </TooltipContent>
    </Tooltip>
  )
}
