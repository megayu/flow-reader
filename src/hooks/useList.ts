import { useVirtualizer } from '@tanstack/react-virtual'
import { useCallback, useLayoutEffect, useMemo, useRef } from 'react'

export const LIST_ITEM_SIZE = 24

interface ScrollToItemOptions {
  align?: 'auto' | 'center' | 'end' | 'start'
  index: number
  smooth?: boolean
}

export function useList(array: Readonly<any[]> = []) {
  const outerRef = useRef<HTMLDivElement | null>(null)
  const innerElementRef = useRef<HTMLDivElement | null>(null)
  // React Compiler cannot memoize TanStack Virtual's mutable virtualizer API.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: array.length,
    estimateSize: () => LIST_ITEM_SIZE,
    getScrollElement: () => outerRef.current,
    overscan: 8,
  })
  const virtualItems = virtualizer.getVirtualItems()

  const innerRef = useCallback((node: HTMLDivElement | null) => {
    innerElementRef.current = node
  }, [])

  useLayoutEffect(() => {
    const inner = innerElementRef.current
    if (!inner) return

    const first = virtualItems[0]
    const last = virtualItems[virtualItems.length - 1]
    const totalSize = virtualizer.getTotalSize()
    const paddingTop = first?.start ?? 0
    const paddingBottom = last ? Math.max(0, totalSize - last.end) : 0

    inner.style.paddingTop = `${paddingTop}px`
    inner.style.paddingBottom = `${paddingBottom}px`
  }, [virtualItems, virtualizer])

  const items = useMemo(
    () =>
      virtualItems.map((item) => ({
        ...item,
        measureRef: virtualizer.measureElement,
      })),
    [virtualItems, virtualizer.measureElement],
  )

  const scrollToItem = useCallback(
    (options: number | ScrollToItemOptions) => {
      const index = typeof options === 'number' ? options : options.index
      const align = typeof options === 'number' ? undefined : options.align
      const behavior =
        typeof options === 'number' || !options.smooth ? 'auto' : 'smooth'

      virtualizer.scrollToIndex(index, { align, behavior })
    },
    [virtualizer],
  )

  return { outerRef, innerRef, items, scrollToItem }
}
