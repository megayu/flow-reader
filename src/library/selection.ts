import type React from 'react'

export interface LibraryRangeSelectionSession {
  anchorId: string
  baseSelectedIds: Set<string>
}

export type LibraryBookSelectionEvent = React.MouseEvent<Element> | React.KeyboardEvent<Element>

export function getBookIdRange(bookIds: readonly string[], anchorId: string, targetId: string) {
  const anchorIndex = bookIds.indexOf(anchorId)
  const targetIndex = bookIds.indexOf(targetId)

  if (anchorIndex < 0 || targetIndex < 0) return [targetId]

  const start = Math.min(anchorIndex, targetIndex)
  const end = Math.max(anchorIndex, targetIndex)

  return bookIds.slice(start, end + 1)
}

export function selectBookIdRange(baseSelectedIds: ReadonlySet<string>, rangeIds: readonly string[]) {
  const next = new Set(baseSelectedIds)
  rangeIds.forEach((id) => next.add(id))
  return next
}
