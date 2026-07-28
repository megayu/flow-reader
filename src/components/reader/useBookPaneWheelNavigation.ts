import { useCallback, useEffect, useEffectEvent, useRef } from 'react'

import type { BookTab } from '../../models/reader'
import { revealScrollbars } from '../../scrollbar'

interface BookPaneWheelNavigationOptions {
  active: boolean
  isScrolledDocument: boolean
  rendered: boolean
  rendition: any
  tab: BookTab
}

export function useBookPaneWheelNavigation({
  active,
  isScrolledDocument,
  rendered,
  rendition,
  tab,
}: BookPaneWheelNavigationOptions) {
  const wheelDelta = useRef(0)
  const lastWheelTurn = useRef(0)

  const handleRenditionWheel = useCallback(
    (event: WheelEvent) => {
      event.preventDefault()
      revealScrollbars()

      const delta =
        Math.abs(event.deltaY) >= Math.abs(event.deltaX)
          ? event.deltaY
          : event.deltaX

      if (tab.isScrolledDocument && tab.container) {
        const container = tab.container
        const manager = (tab.rendition as any)?.manager
        const horizontal = manager?.settings?.axis === 'horizontal'
        const scale =
          event.deltaMode === WheelEvent.DOM_DELTA_LINE
            ? 16
            : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
              ? horizontal
                ? container.clientWidth
                : container.clientHeight
              : 1
        const scrollDelta = delta * scale

        if (horizontal) {
          if (manager.scrollHorizontalByReadingDirection?.(scrollDelta, true)) {
            wheelDelta.current = 0
            return
          }
        } else {
          const maxScrollTop = Math.max(
            0,
            container.scrollHeight - container.clientHeight,
          )
          const canScrollBackward = delta < 0 && container.scrollTop > 1
          const canScrollForward =
            delta > 0 && container.scrollTop < maxScrollTop - 1

          if (canScrollBackward || canScrollForward) {
            container.scrollTop = Math.max(
              0,
              Math.min(maxScrollTop, container.scrollTop + scrollDelta),
            )
            wheelDelta.current = 0
            return
          }
        }
      }

      wheelDelta.current += delta

      const now = Date.now()
      if (now - lastWheelTurn.current < 180) return
      if (Math.abs(wheelDelta.current) < 30) return

      if (wheelDelta.current < 0) {
        tab.prev()
      } else {
        tab.next()
      }

      wheelDelta.current = 0
      lastWheelTurn.current = now
    },
    [tab],
  )
  const handleRenditionWheelEvent = useEffectEvent(handleRenditionWheel)

  useEffect(() => {
    if (!active || !rendition) return

    const target = rendition as any
    const onWheel = (event: WheelEvent) => {
      handleRenditionWheelEvent(event)
    }

    target.on('wheel', onWheel)

    return () => {
      target.off?.('wheel', onWheel)
      target.removeListener?.('wheel', onWheel)
    }
  }, [active, rendition])

  useEffect(() => {
    if (!active || !isScrolledDocument || !rendered) return

    const container = tab.container
    if (!container) return

    const onWheel = (event: WheelEvent) => {
      const hasVerticalOverflow =
        container.scrollHeight - container.clientHeight > 1
      if (hasVerticalOverflow || event.target instanceof HTMLIFrameElement) {
        return
      }

      handleRenditionWheelEvent(event)
    }

    container.addEventListener('wheel', onWheel, { passive: false })

    return () => {
      container.removeEventListener('wheel', onWheel)
    }
  }, [active, isScrolledDocument, rendered, tab])
}
