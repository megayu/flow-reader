import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'

export const LIST_ITEM_SIZE = 24
const LIST_OVERSCAN = 8

interface ScrollToItemOptions {
  align?: 'auto' | 'center' | 'end' | 'start'
  index: number
  smooth?: boolean
}

interface ListViewport {
  height: number
  scrollTop: number
}

export function useList(array: Readonly<any[]> = []) {
  const outerRef = useRef<HTMLDivElement | null>(null)
  const [viewport, setViewport] = useState<ListViewport>({
    height: 0,
    scrollTop: 0,
  })
  const totalSize = array.length * LIST_ITEM_SIZE

  const updateViewport = useCallback(() => {
    const el = outerRef.current
    if (!el) return

    const next = {
      height: Math.ceil(el.clientHeight),
      scrollTop: Math.max(0, el.scrollTop),
    }

    setViewport((current) =>
      current.height === next.height && current.scrollTop === next.scrollTop
        ? current
        : next,
    )
  }, [])

  useLayoutEffect(() => {
    const el = outerRef.current
    if (!el) return

    let frame = 0
    const scheduleUpdate = () => {
      if (frame) return

      frame = window.requestAnimationFrame(() => {
        frame = 0
        updateViewport()
      })
    }

    updateViewport()
    el.addEventListener('scroll', updateViewport, { passive: true })

    const observer =
      typeof ResizeObserver === 'undefined'
        ? undefined
        : new ResizeObserver(scheduleUpdate)

    if (observer) {
      observer.observe(el)
    } else {
      window.addEventListener('resize', scheduleUpdate)
    }

    return () => {
      el.removeEventListener('scroll', updateViewport)
      observer?.disconnect()
      window.removeEventListener('resize', scheduleUpdate)
      if (frame) window.cancelAnimationFrame(frame)
    }
  }, [updateViewport])

  useLayoutEffect(() => {
    updateViewport()
  }, [array.length, updateViewport])

  const items = useMemo(() => {
    const count = array.length
    if (!count) return []

    const startIndex = Math.min(
      count - 1,
      Math.max(
        0,
        Math.floor(viewport.scrollTop / LIST_ITEM_SIZE) - LIST_OVERSCAN,
      ),
    )
    const endIndex = Math.max(
      startIndex,
      Math.min(
        count - 1,
        Math.ceil((viewport.scrollTop + viewport.height) / LIST_ITEM_SIZE) +
          LIST_OVERSCAN,
      ),
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
  }, [array.length, viewport.height, viewport.scrollTop])

  const scrollToItem = useCallback(
    (options: number | ScrollToItemOptions) => {
      const index = typeof options === 'number' ? options : options.index
      const align = typeof options === 'number' ? undefined : options.align
      const behavior =
        typeof options === 'number' || !options.smooth ? 'auto' : 'smooth'
      const el = outerRef.current
      if (!el || !array.length) return

      const viewportHeight = el.clientHeight
      const maxScrollTop = Math.max(0, totalSize - viewportHeight)
      const clampedIndex = Math.max(0, Math.min(array.length - 1, index))
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

      el.scrollTo({ top: nextScrollTop, behavior })
    },
    [array.length, totalSize],
  )

  return { outerRef, items, scrollToItem, totalSize }
}
