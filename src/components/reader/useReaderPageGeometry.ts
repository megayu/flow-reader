import { useEffect, type RefObject } from 'react'

import {
  getCurrentReaderPageWidth,
  getCurrentReaderSpreadWidth,
  getFiniteLayoutValue,
  getRenditionDivisor,
  getRenditionLayout,
} from '../../reader/layoutGeometry'

interface ReaderPageGeometryOptions {
  active: boolean
  containerRef: RefObject<HTMLDivElement | null>
  paginationVersion: number
  rendered: boolean
  rendition: any
}

export function useReaderPageGeometry({
  active,
  containerRef,
  paginationVersion,
  rendered,
  rendition,
}: ReaderPageGeometryOptions) {
  useEffect(() => {
    if (!active) return

    const updateReaderPageWidth = () => {
      const width = getCurrentReaderPageWidth(rendition, containerRef.current)
      if (!width) return
      const spreadWidth = getCurrentReaderSpreadWidth(
        rendition,
        containerRef.current,
      )
      const layout = getRenditionLayout(rendition)
      const container = containerRef.current

      document.documentElement.style.setProperty(
        '--flow-reader-page-width',
        `${width}px`,
      )
      if (spreadWidth) {
        document.documentElement.style.setProperty(
          '--flow-reader-spread-width',
          `${spreadWidth}px`,
        )
      }
      if (container) {
        const divisor = getRenditionDivisor(rendition)
        const gap = getFiniteLayoutValue(layout?.gap, 0)
        const columnWidth = getFiniteLayoutValue(
          layout?.columnWidth,
          divisor > 1 ? Math.max((container.clientWidth - gap) / 2, 0) : width,
        )

        container.dataset.flowReaderSpread = divisor > 1 ? 'double' : 'single'
        container.style.setProperty(
          '--flow-reader-column-width',
          `${columnWidth}px`,
        )
        container.style.setProperty('--flow-reader-page-gap', `${gap}px`)
        container.style.setProperty(
          '--flow-reader-page-half-gap',
          `${gap / 2}px`,
        )
      }
    }
    const scheduleReaderPageWidthUpdate = () => {
      updateReaderPageWidth()
      requestAnimationFrame(updateReaderPageWidth)
      window.setTimeout(updateReaderPageWidth, 100)
    }

    scheduleReaderPageWidthUpdate()

    const element = containerRef.current
    if (!element) return

    const observer = new ResizeObserver(scheduleReaderPageWidthUpdate)
    observer.observe(element)
    const mutationObserver = new MutationObserver(scheduleReaderPageWidthUpdate)
    mutationObserver.observe(element, {
      childList: true,
      subtree: true,
    })

    return () => {
      observer.disconnect()
      mutationObserver.disconnect()
    }
  }, [active, containerRef, paginationVersion, rendered, rendition])
}
