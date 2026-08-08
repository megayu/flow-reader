import { type RefObject, useCallback, useEffect, useLayoutEffect, useState } from 'react'

export interface OverlayScrollbarMetrics {
  scrollRef: RefObject<HTMLDivElement | null>
  scrollTop: number
  totalSize: number
  viewportHeight: number
}

export function useOverlayScrollbarMetrics(
  scrollRef: RefObject<HTMLDivElement | null>,
  contentRef: RefObject<HTMLElement | null>,
  active = true,
): OverlayScrollbarMetrics {
  const [metrics, setMetrics] = useState({ scrollTop: 0, totalSize: 0, viewportHeight: 0 })
  const updateMetrics = useCallback(() => {
    const scroll = scrollRef.current
    if (!scroll) return

    const next = {
      scrollTop: scroll.scrollTop,
      totalSize: scroll.scrollHeight,
      viewportHeight: scroll.clientHeight,
    }
    setMetrics((current) =>
      current.scrollTop === next.scrollTop &&
      current.totalSize === next.totalSize &&
      current.viewportHeight === next.viewportHeight
        ? current
        : next,
    )
  }, [scrollRef])

  useLayoutEffect(() => {
    if (active) updateMetrics()
  })

  useEffect(() => {
    if (!active) return

    const scroll = scrollRef.current
    const content = contentRef.current
    if (!scroll || !content) return

    scroll.addEventListener('scroll', updateMetrics, { passive: true })
    if (typeof ResizeObserver === 'undefined') {
      return () => scroll.removeEventListener('scroll', updateMetrics)
    }

    const observer = new ResizeObserver(updateMetrics)
    observer.observe(scroll)
    observer.observe(content)

    return () => {
      scroll.removeEventListener('scroll', updateMetrics)
      observer.disconnect()
    }
  }, [active, contentRef, scrollRef, updateMetrics])

  return { scrollRef, ...metrics }
}
