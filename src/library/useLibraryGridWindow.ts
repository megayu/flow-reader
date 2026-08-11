import { type RefObject, useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react'

import type { OverlayScrollbarMetrics } from '../hooks/useOverlayScrollbarMetrics'

import { getLibraryGridColumnCount, getLibraryGridWindow, type LibraryGridWindow } from './libraryGridWindow'

interface LibraryGridLayout {
  cardHeight: number
  gridTop: number
  gridWidth: number
  scrollTop: number
  viewportHeight: number
}

interface UseLibraryGridWindowInput {
  cardWidth: number
  enabled: boolean
  endInset: number
  gridRef: RefObject<HTMLUListElement | null>
  initialScrollTop: number
  layoutKey: string
  overscanRows?: number
  resetKey: string
  rowGap: number
  scrollRef: RefObject<HTMLDivElement | null>
  totalCount: number
}

export interface UseLibraryGridWindowResult extends LibraryGridWindow {
  columnCount: number
  scrollbar: OverlayScrollbarMetrics
  topWindowCount: number
}

const defaultOverscanRows = 2
const bookCardInlinePadding = 8
const bookCardFixedBlockSize = 40

function estimateBookCardHeight(cardWidth: number) {
  const coverWidth = Math.max(1, cardWidth - bookCardInlinePadding)
  return (coverWidth * 4) / 3 + bookCardFixedBlockSize
}

export function useLibraryGridWindow({
  cardWidth,
  enabled,
  endInset,
  gridRef,
  initialScrollTop,
  layoutKey,
  overscanRows = defaultOverscanRows,
  resetKey,
  rowGap,
  scrollRef,
  totalCount,
}: UseLibraryGridWindowInput): UseLibraryGridWindowResult {
  const [layout, setLayout] = useState<LibraryGridLayout>(() => ({
    cardHeight: estimateBookCardHeight(cardWidth),
    gridTop: 0,
    gridWidth: cardWidth,
    scrollTop: Math.max(0, initialScrollTop),
    viewportHeight: 0,
  }))
  const measureLayout = useCallback(() => {
    const scroll = scrollRef.current
    const grid = gridRef.current
    if (!scroll || !grid) return

    const firstCard = grid.querySelector<HTMLElement>('[data-flow-library-book-card]')
    const measuredCardHeight = firstCard?.getBoundingClientRect().height
    const scrollRect = scroll.getBoundingClientRect()
    const gridRect = grid.getBoundingClientRect()
    const next: LibraryGridLayout = {
      cardHeight: measuredCardHeight && measuredCardHeight > 0 ? measuredCardHeight : estimateBookCardHeight(cardWidth),
      gridTop: gridRect.top - scrollRect.top + scroll.scrollTop,
      gridWidth: grid.clientWidth,
      scrollTop: scroll.scrollTop,
      viewportHeight: scroll.clientHeight,
    }
    setLayout((current) =>
      current.cardHeight === next.cardHeight &&
      current.gridTop === next.gridTop &&
      current.gridWidth === next.gridWidth &&
      current.scrollTop === next.scrollTop &&
      current.viewportHeight === next.viewportHeight
        ? current
        : next,
    )
  }, [cardWidth, gridRef, scrollRef])

  useLayoutEffect(() => {
    const scroll = scrollRef.current
    if (!scroll || scroll.scrollTop === 0) return

    scroll.scrollTop = 0
    setLayout((current) => (current.scrollTop === 0 ? current : { ...current, scrollTop: 0 }))
  }, [resetKey, scrollRef])

  useLayoutEffect(() => {
    const scroll = scrollRef.current
    const requestedScrollTop = Math.max(0, initialScrollTop)
    if (!scroll || requestedScrollTop === 0) return

    scroll.scrollTop = requestedScrollTop
  }, [initialScrollTop, scrollRef])

  useLayoutEffect(() => {
    measureLayout()
  }, [layoutKey, measureLayout])

  useEffect(() => {
    const scroll = scrollRef.current
    const grid = gridRef.current
    if (!scroll || !grid || typeof ResizeObserver === 'undefined') return

    const observer = new ResizeObserver(measureLayout)
    observer.observe(grid)
    if (enabled) observer.observe(scroll)
    return () => observer.disconnect()
  }, [enabled, gridRef, measureLayout, scrollRef])

  useEffect(() => {
    if (!enabled) return
    const scroll = scrollRef.current
    if (!scroll) return

    let frame = 0
    const updateScrollTop = () => {
      frame = 0
      const scrollTop = scroll.scrollTop
      setLayout((current) => (current.scrollTop === scrollTop ? current : { ...current, scrollTop }))
    }
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(updateScrollTop)
    }
    scroll.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      scroll.removeEventListener('scroll', onScroll)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [enabled, scrollRef])

  const columnCount = getLibraryGridColumnCount(layout.gridWidth, cardWidth, rowGap)
  const window = useMemo(
    () =>
      getLibraryGridWindow({
        cardHeight: layout.cardHeight,
        columnCount,
        gridTop: layout.gridTop,
        overscanRows,
        rowGap,
        scrollTop: layout.scrollTop,
        totalCount,
        viewportHeight: layout.viewportHeight,
      }),
    [columnCount, layout, overscanRows, rowGap, totalCount],
  )
  const topWindowCount = useMemo(
    () =>
      layout.viewportHeight > 0
        ? getLibraryGridWindow({
            cardHeight: layout.cardHeight,
            columnCount,
            gridTop: layout.gridTop,
            overscanRows,
            rowGap,
            scrollTop: 0,
            totalCount,
            viewportHeight: layout.viewportHeight,
          }).endIndex
        : 0,
    [columnCount, layout.cardHeight, layout.gridTop, layout.viewportHeight, overscanRows, rowGap, totalCount],
  )
  const totalSize = Math.max(layout.viewportHeight, layout.gridTop + window.totalGridHeight + Math.max(0, endInset))

  if (!enabled) {
    return {
      columnCount,
      endIndex: totalCount,
      paddingBottom: 0,
      paddingTop: 0,
      scrollbar: {
        scrollRef,
        scrollTop: 0,
        totalSize: 0,
        viewportHeight: 0,
      },
      startIndex: 0,
      topWindowCount: totalCount,
      totalGridHeight: 0,
    }
  }

  return {
    ...window,
    columnCount,
    scrollbar: {
      scrollRef,
      scrollTop: layout.scrollTop,
      totalSize,
      viewportHeight: layout.viewportHeight,
    },
    topWindowCount,
  }
}
