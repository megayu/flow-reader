import clsx from 'clsx'
import type { FC } from 'react'

import type { ShortcutChordValue } from '../shortcuts'

interface ShortcutChordProps {
  className?: string
  compact?: boolean
  shortcut: ShortcutChordValue
  variant?: 'default' | 'tooltip'
}

export const ShortcutChord: FC<ShortcutChordProps> = ({ className, compact = false, shortcut }) => {
  const textSizeClass = 'text-base'

  return (
    <span className={clsx('inline-flex items-center gap-1', className)}>
      {shortcut.map((key, index) => (
        <span className="inline-flex items-center gap-1" key={key}>
          {index > 0 && <span className={clsx('text-muted-foreground', textSizeClass)}>+</span>}
          <kbd
            data-slot="kbd"
            className={clsx(
              'bg-muted text-muted-foreground ring-border inline-flex min-w-[1.55rem] items-center justify-center rounded-sm px-1.5 py-0.5 text-center font-mono leading-5 ring-1 ring-inset',
              textSizeClass,
              compact && 'min-w-0 px-1 py-px leading-4',
            )}
          >
            {key}
          </kbd>
        </span>
      ))}
    </span>
  )
}
