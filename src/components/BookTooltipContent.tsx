import { Archive, Book, BookDashed, BookLock, FileText, UserRound } from 'lucide-react'

import { type BookTooltipLineKind, getBookTooltipLines } from '@/book'
import type { BookRecord } from '@/storage'

function getTooltipIcon(book: BookRecord, kind: BookTooltipLineKind) {
  switch (kind) {
    case 'creator':
      return UserRound
    case 'file':
      return FileText
    case 'title':
      if (book.scope === 'external') return BookDashed
      if (book.archive) return Archive
      return book.editable ? Book : BookLock
  }
}

interface BookTooltipContentProps {
  book: BookRecord
}

export function BookTooltipContent({ book }: BookTooltipContentProps) {
  const lines = getBookTooltipLines(book)

  return (
    <span className="flex min-w-0 flex-col gap-1 text-base leading-tight">
      {lines.map((line) => {
        const Icon = getTooltipIcon(book, line.kind)

        return (
          <span key={`${line.kind}:${line.text}`} className="flex min-w-0 items-start gap-2">
            <Icon aria-hidden className="mt-0.5 size-[1em] shrink-0 text-current opacity-75" strokeWidth={1.8} />
            <span className="min-w-0 wrap-break-word">{line.text}</span>
          </span>
        )
      })}
    </span>
  )
}
