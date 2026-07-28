import { BookOpenText, FileText, UserRound } from 'lucide-react'

import { getBookTooltipLines, type BookTooltipLineKind } from '@/book'
import type { BookRecord } from '@/storage'

const iconMap = {
  creator: UserRound,
  file: FileText,
  title: BookOpenText,
} satisfies Record<BookTooltipLineKind, typeof BookOpenText>

interface BookTooltipContentProps {
  book: BookRecord
}

export function BookTooltipContent({ book }: BookTooltipContentProps) {
  const lines = getBookTooltipLines(book)

  return (
    <span className="flex min-w-0 flex-col gap-1 text-base leading-tight">
      {lines.map((line) => {
        const Icon = iconMap[line.kind]

        return (
          <span
            key={`${line.kind}:${line.text}`}
            className="flex min-w-0 items-start gap-2"
          >
            <Icon
              aria-hidden
              className="mt-0.5 size-[1em] shrink-0 text-current opacity-75"
              strokeWidth={1.8}
            />
            <span className="min-w-0 break-words">{line.text}</span>
          </span>
        )
      })}
    </span>
  )
}
