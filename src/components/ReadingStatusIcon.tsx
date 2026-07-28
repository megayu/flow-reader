import clsx from 'clsx'
import { BookCheck, BookMarked, BookOpen, BookPlus, Circle, CircleX } from 'lucide-react'

import type { ReadingStatus } from '../storage'

interface ReadingStatusIconProps {
  className?: string
  intent?: 'status' | 'edit' | 'remove'
  status?: ReadingStatus | null
  size?: number
  tone?: 'status' | 'current'
}

const iconMap = {
  toRead: BookMarked,
  reading: BookOpen,
  read: BookCheck,
} as const

export const readingStatusIconClassName: Record<ReadingStatus, string> = {
  toRead: 'text-amber-500',
  reading: 'text-sky-500',
  read: 'text-emerald-500',
}

export function ReadingStatusIcon({
  className,
  intent = 'status',
  status,
  size = 17,
  tone = 'status',
}: ReadingStatusIconProps) {
  const Icon = status ? iconMap[status] : intent === 'remove' ? CircleX : intent === 'edit' ? BookPlus : Circle

  return (
    <Icon
      size={size}
      strokeWidth={2.2}
      className={clsx(
        'shrink-0',
        tone === 'status' &&
          (status
            ? readingStatusIconClassName[status]
            : intent === 'remove'
              ? 'text-destructive'
              : 'text-muted-foreground'),
        className,
      )}
    />
  )
}
