import { useCallback, useEffect, useRef, type RefObject } from 'react'

import { RenditionSpread } from '@flow/epubjs/rendition'

import { BookTab } from '../../models/reader'

interface BookRenditionLifecycleOptions {
  active: boolean
  settingsReady: boolean
  tab: BookTab
  rendition: any
  currentSpread: RenditionSpread
  typographyLayoutSignature: string
  typographyStyleSignature: string
  applyCustomStyle: (contents?: any, view?: any) => void
  containerRef: RefObject<HTMLDivElement | null>
}

function getVisibleLayoutSize(el?: HTMLDivElement | null) {
  if (!el) return

  const rect = el.getBoundingClientRect()
  const width = Math.round(rect.width)
  const height = Math.round(rect.height)
  if (width <= 0 || height <= 0) return

  return { width, height, key: `${width}x${height}` }
}

export function useBookRenditionLifecycle({
  active,
  settingsReady,
  tab,
  rendition,
  currentSpread,
  typographyLayoutSignature,
  typographyStyleSignature,
  applyCustomStyle,
  containerRef,
}: BookRenditionLifecycleOptions) {
  const prevSize = useRef<string | undefined>(undefined)
  const previousSpread = useRef<string | undefined>(undefined)
  const previousTypographyLayoutSignature = useRef<string | undefined>(
    undefined,
  )
  const previousTypographyStyleSignature = useRef<string | undefined>(undefined)
  const layoutFrame = useRef<number | undefined>(undefined)
  const applyCustomStyleRef = useRef(applyCustomStyle)
  const currentSpreadRef = useRef(currentSpread)

  applyCustomStyleRef.current = applyCustomStyle
  currentSpreadRef.current = currentSpread

  const cancelVisibleSizeSync = useCallback(() => {
    const frame = layoutFrame.current
    if (frame !== undefined) cancelAnimationFrame(frame)
    layoutFrame.current = undefined
  }, [])

  const renderIfReady = useCallback(() => {
    if (!active || !settingsReady || rendition) return

    const size = getVisibleLayoutSize(containerRef.current)
    if (!size) return

    const beforeLayout = applyCustomStyleRef.current
    if (!beforeLayout) return

    prevSize.current = size.key
    previousTypographyLayoutSignature.current = typographyLayoutSignature
    previousTypographyStyleSignature.current = typographyStyleSignature
    tab.render(
      containerRef.current!,
      currentSpreadRef.current,
      beforeLayout,
      typographyLayoutSignature,
    )
  }, [
    active,
    containerRef,
    rendition,
    settingsReady,
    tab,
    typographyLayoutSignature,
    typographyStyleSignature,
  ])

  const syncVisibleSize = useCallback(() => {
    if (!active || !settingsReady) return

    const size = getVisibleLayoutSize(containerRef.current)
    if (!size) return

    if (!rendition) {
      renderIfReady()
      return
    }

    if (prevSize.current === size.key) return
    prevSize.current = size.key

    try {
      tab.markLayoutChanged()
      tab.resizeRendition(size.width, size.height)
    } catch (error) {
      console.error(error)
    }
  }, [active, containerRef, rendition, renderIfReady, settingsReady, tab])

  const scheduleVisibleSizeSync = useCallback(() => {
    cancelVisibleSizeSync()

    layoutFrame.current = requestAnimationFrame(() => {
      layoutFrame.current = undefined
      syncVisibleSize()
    })
  }, [cancelVisibleSizeSync, syncVisibleSize])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const observer = new ResizeObserver(scheduleVisibleSizeSync)
    observer.observe(el)

    return () => observer.disconnect()
  }, [containerRef, scheduleVisibleSizeSync])

  useEffect(() => {
    tab.setBeforeLayout(applyCustomStyle, typographyLayoutSignature)
  }, [applyCustomStyle, rendition, tab, typographyLayoutSignature])

  useEffect(() => {
    return () => {
      tab.destroy()
    }
  }, [tab])

  useEffect(() => {
    renderIfReady()
  }, [renderIfReady])

  useEffect(() => {
    scheduleVisibleSizeSync()
    return cancelVisibleSizeSync
  }, [cancelVisibleSizeSync, scheduleVisibleSizeSync])

  useEffect(() => {
    if (!active || !rendition) return

    if (previousSpread.current === undefined) {
      previousSpread.current = currentSpread
      return
    }
    if (previousSpread.current === currentSpread) return

    previousSpread.current = currentSpread
    rendition.spread(currentSpread)
    void tab.relayoutCurrentView()
  }, [active, currentSpread, rendition, tab])

  useEffect(() => {
    if (!active || !rendition) return
    tab.setBeforeLayout(applyCustomStyle, typographyLayoutSignature)

    if (previousTypographyLayoutSignature.current === typographyLayoutSignature)
      return
    previousTypographyLayoutSignature.current = typographyLayoutSignature

    void tab.relayoutCurrentView()
  }, [active, applyCustomStyle, rendition, tab, typographyLayoutSignature])

  useEffect(() => {
    if (!active || !rendition) return

    if (previousTypographyStyleSignature.current === typographyStyleSignature)
      return
    previousTypographyStyleSignature.current = typographyStyleSignature

    applyCustomStyle()
  }, [active, applyCustomStyle, rendition, typographyStyleSignature])
}
