import { useCallback, useLayoutEffect, useRef, useState } from 'react'

export interface ScrollViewport {
  height: number
  scrollTop: number
}

export function useScrollViewport<T extends HTMLElement = HTMLDivElement>() {
  const outerRef = useRef<T | null>(null)
  const [viewport, setViewport] = useState<ScrollViewport>({
    height: 0,
    scrollTop: 0,
  })

  const updateViewport = useCallback(() => {
    const element = outerRef.current
    if (!element) return

    const next = {
      height: Math.ceil(element.clientHeight),
      scrollTop: Math.max(0, element.scrollTop),
    }

    setViewport((current) => (current.height === next.height && current.scrollTop === next.scrollTop ? current : next))
  }, [])

  useLayoutEffect(() => {
    const element = outerRef.current
    if (!element) return

    let frame = 0
    const scheduleUpdate = () => {
      if (frame) return

      frame = window.requestAnimationFrame(() => {
        frame = 0
        updateViewport()
      })
    }

    updateViewport()
    element.addEventListener('scroll', scheduleUpdate, { passive: true })

    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(scheduleUpdate)
    if (observer) observer.observe(element)
    else window.addEventListener('resize', scheduleUpdate)

    return () => {
      element.removeEventListener('scroll', scheduleUpdate)
      observer?.disconnect()
      window.removeEventListener('resize', scheduleUpdate)
      if (frame) window.cancelAnimationFrame(frame)
    }
  }, [updateViewport])

  return { outerRef, updateViewport, viewport }
}
