import clsx from 'clsx'
import type { FC } from 'react'

import type { ShortcutChordValue } from '../shortcuts'

interface ShortcutChordProps {
  className?: string
  compact?: boolean
  shortcut: ShortcutChordValue
}

export const ShortcutChord: FC<ShortcutChordProps> = ({ className, compact = false, shortcut }) => {
  const textSizeClass = 'text-base'

  return (
    <span
      className={clsx(
        'bg-muted text-muted-foreground ring-border inline-flex shrink-0 items-stretch overflow-hidden rounded-sm whitespace-nowrap ring-1 ring-inset',
        className,
      )}
    >
      {shortcut.map((key, index) => (
        <kbd
          data-slot="kbd"
          className={clsx(
            'inline-flex min-w-[1.55rem] items-center justify-center px-1.5 py-0.5 text-center font-mono leading-5',
            index > 0 && 'border-border border-l',
            textSizeClass,
            compact && 'min-w-0 px-1 py-px leading-4',
          )}
          key={`${key}-${index}`}
        >
          {key}
        </kbd>
      ))}
    </span>
  )
}
