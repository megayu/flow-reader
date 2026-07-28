import React, { useCallback, useState } from 'react'

export interface LibraryRangeSelectionSession {
  anchorId: string
  baseSelectedIds: Set<string>
}

export type LibraryBookSelectionEvent =
  | React.MouseEvent<Element>
  | React.KeyboardEvent<Element>

export function getBookIdRange(
  bookIds: readonly string[],
  anchorId: string,
  targetId: string,
) {
  const anchorIndex = bookIds.indexOf(anchorId)
  const targetIndex = bookIds.indexOf(targetId)

  if (anchorIndex < 0 || targetIndex < 0) return [targetId]

  const start = Math.min(anchorIndex, targetIndex)
  const end = Math.max(anchorIndex, targetIndex)

  return bookIds.slice(start, end + 1)
}

export function selectBookIdRange(
  baseSelectedIds: ReadonlySet<string>,
  rangeIds: readonly string[],
) {
  const next = new Set(baseSelectedIds)
  rangeIds.forEach((id) => next.add(id))
  return next
}

export function useStringSet() {
  const [values, setValues] = useState(() => new Set<string>())

  const add = useCallback((value: string) => {
    setValues((current) => {
      if (current.has(value)) return current
      const next = new Set(current)
      next.add(value)
      return next
    })
  }, [])

  const has = useCallback((value: string) => values.has(value), [values])

  const toggle = useCallback((value: string) => {
    setValues((current) => {
      const next = new Set(current)
      if (next.has(value)) {
        next.delete(value)
      } else {
        next.add(value)
      }
      return next
    })
  }, [])

  const replace = useCallback((nextValues: Iterable<string>) => {
    setValues(new Set(nextValues))
  }, [])

  const reset = useCallback(() => {
    setValues((current) => (current.size ? new Set() : current))
  }, [])

  return [values, { add, has, toggle, replace, reset }] as const
}
