import { useCallback, useLayoutEffect, useMemo } from 'react'

import { useScrollViewport } from './useScrollViewport'

export const LIST_ITEM_SIZE = 24
const LIST_OVERSCAN = 4

interface ScrollToItemOptions {
  align?: 'auto' | 'center' | 'end' | 'start'
  index: number
}

export function useList(array: Readonly<any[]> = []) {
  return useListSize(array.length)
}

export function useListSize(count = 0) {
  const { outerRef, updateViewport, viewport } = useScrollViewport()
  const totalSize = count * LIST_ITEM_SIZE

  useLayoutEffect(() => {
    updateViewport()
  }, [count, updateViewport])

  const items = useMemo(() => {
    if (!count) return []

    const startIndex = Math.min(count - 1, Math.max(0, Math.floor(viewport.scrollTop / LIST_ITEM_SIZE) - LIST_OVERSCAN))
    const endIndex = Math.max(
      startIndex,
      Math.min(count - 1, Math.ceil((viewport.scrollTop + viewport.height) / LIST_ITEM_SIZE) + LIST_OVERSCAN),
    )

    return Array.from({ length: endIndex - startIndex + 1 }, (_, offset) => {
      const index = startIndex + offset
      return {
        index,
        key: index,
        size: LIST_ITEM_SIZE,
        start: index * LIST_ITEM_SIZE,
      }
    })
  }, [count, viewport.height, viewport.scrollTop])

  const scrollToItem = useCallback(
    (options: number | ScrollToItemOptions) => {
      const index = typeof options === 'number' ? options : options.index
      const align = typeof options === 'number' ? undefined : options.align
      const el = outerRef.current
      if (!el || !count) return

      const viewportHeight = el.clientHeight
      const maxScrollTop = Math.max(0, totalSize - viewportHeight)
      const clampedIndex = Math.max(0, Math.min(count - 1, index))
      const start = clampedIndex * LIST_ITEM_SIZE
      const end = start + LIST_ITEM_SIZE
      const currentStart = el.scrollTop
      const currentEnd = currentStart + viewportHeight
      let nextScrollTop = currentStart

      if (align === 'center') {
        nextScrollTop = start - (viewportHeight - LIST_ITEM_SIZE) / 2
      } else if (align === 'end') {
        nextScrollTop = end - viewportHeight
      } else if (align === 'start') {
        nextScrollTop = start
      } else if (start < currentStart) {
        nextScrollTop = start
      } else if (end > currentEnd) {
        nextScrollTop = end - viewportHeight
      }

      nextScrollTop = Math.max(0, Math.min(maxScrollTop, nextScrollTop))
      if (Math.abs(nextScrollTop - currentStart) < 1) return

      el.scrollTo({ top: nextScrollTop, behavior: 'auto' })
    },
    [count, outerRef, totalSize],
  )

  return {
    outerRef,
    items,
    scrollbar: {
      scrollTop: viewport.scrollTop,
      totalSize,
      viewportHeight: viewport.height,
    },
    scrollToItem,
    totalSize,
  }
}
