import { type RefObject, useCallback, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react'

import { notePopoverClass } from '../../bodyText'
import { isSupportedExternalUrl, openSupportedExternalUrl } from '../../externalLink'
import { installReloadShortcut } from '../../keyboard'
import type { BookTab } from '../../models/reader'
import { getNoteIndex } from '../../noteIndex'
import { isExplicitNoteLink, isNoteBacklink } from '../../noteSemantics'
import { reloadCurrentView } from '../../reader/reload'
import { useDndContext } from '../base/dropZoneContext'

import { createBookLinkHighlight } from './bookLinkHighlight'
import type { ExternalLinkPreview } from './ExternalLinkPopover'
import { getAnchorFromEvent, getBookLinkDisplayTarget, getInternalBookHref, getLinkedNote } from './noteContent'
import { showNotePopover } from './notePopover'
import { useFrameEvent } from './useFrameEvent'

function consumeExternalLinkClick(
  event: MouseEvent,
  anchor: HTMLAnchorElement,
  setPreview: (preview: ExternalLinkPreview | undefined) => void,
) {
  const href = anchor.getAttribute('href')?.trim()
  if (!href || !isSupportedExternalUrl(href)) return false

  event.preventDefault()
  event.stopPropagation()
  event.stopImmediatePropagation()
  setPreview(undefined)
  if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey) {
    void openSupportedExternalUrl(href).catch((error) => {
      console.error(error)
    })
  } else if (event.button === 0 && !event.altKey && !event.shiftKey && !event.metaKey && !event.ctrlKey) {
    const frameRect = anchor.ownerDocument.defaultView?.frameElement?.getBoundingClientRect()
    const rect = new DOMRect((frameRect?.left ?? 0) + event.clientX, (frameRect?.top ?? 0) + event.clientY, 0, 0)
    setPreview({ href, getBoundingClientRect: () => rect })
  }
  return true
}

function preventFrameContextMenu(event: Event) {
  event.preventDefault()
}

function isFrameAnchor(target: EventTarget): target is HTMLAnchorElement {
  return 'tagName' in target && target.tagName === 'A' && 'href' in target
}

function isFrameImage(target: EventTarget): target is HTMLImageElement {
  return 'tagName' in target && target.tagName === 'IMG' && 'src' in target
}

function isFrameSource(target: EventTarget): target is HTMLSourceElement {
  return 'tagName' in target && target.tagName === 'SOURCE' && 'parentElement' in target
}

interface BookPaneFrameContentOptions {
  active: boolean
  activeFrameWindows: readonly Window[]
  closeChapterFind: () => void
  containerRef: RefObject<HTMLDivElement | null>
  linkHighlightRef: RefObject<HTMLDivElement | null>
  linkHighlightEnabled: boolean
  frameWindows: readonly Window[]
  hideEndnotes?: boolean
  rendition: unknown
  tab: BookTab
  zenMode: boolean
}

export function useBookPaneFrameContent({
  active,
  activeFrameWindows,
  closeChapterFind,
  containerRef,
  linkHighlightRef,
  linkHighlightEnabled,
  frameWindows,
  hideEndnotes,
  rendition,
  tab,
  zenMode,
}: BookPaneFrameContentOptions) {
  const noteRequestId = useRef(0)
  const notePopover = useRef<(() => void) | undefined>(undefined)
  const closeNotePopover = useCallback(() => {
    noteRequestId.current += 1
    notePopover.current?.()
    notePopover.current = undefined
  }, [])
  const linkHighlight = useRef<ReturnType<typeof createBookLinkHighlight> | undefined>(undefined)
  useLayoutEffect(() => {
    if (!active || !linkHighlightEnabled || !containerRef.current || !linkHighlightRef.current) return
    const controller = createBookLinkHighlight(tab, containerRef.current, linkHighlightRef.current)
    linkHighlight.current = controller
    return () => {
      controller.dispose()
      linkHighlight.current = undefined
    }
  }, [active, containerRef, linkHighlightEnabled, linkHighlightRef, tab])

  const displayBookLink = useCallback(
    async (target: string) => {
      const show = linkHighlight.current?.begin()
      await tab.displayBookLink(target)
      show?.(target)
    },
    [tab],
  )
  const [externalLink, setExternalLink] = useState<ExternalLinkPreview>()
  const closeExternalLink = useCallback(() => setExternalLink(undefined), [])
  const imagePreviewOpenKey = useRef(0)
  const [imagePreview, setImagePreview] = useState<{
    key: number
    src: string
  }>()
  const closeChapterFindEvent = useEffectEvent(closeChapterFind)

  const openImagePreview = useCallback((src: string) => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur()
    }
    setImagePreview({
      key: (imagePreviewOpenKey.current += 1),
      src,
    })
  }, [])

  useEffect(() => {
    if (zenMode) setImagePreview(undefined)
  }, [zenMode])

  const { setDragEvent } = useDndContext()

  // `dragenter` not fired in iframe when the count of times is even, so use `dragover`
  const handleFrameDragOver = useCallback(
    (event: DragEvent) => {
      setDragEvent(event)
    },
    [setDragEvent],
  )
  useFrameEvent(activeFrameWindows, 'dragover', handleFrameDragOver)

  useEffect(() => {
    if (!active) return
    const cleanups = frameWindows.map((frame) => installReloadShortcut(frame.document, reloadCurrentView))
    return () => cleanups.forEach((cleanup) => cleanup())
  }, [active, frameWindows])

  useLayoutEffect(() => {
    if (!active) return
    const currentRendition = tab.rendition
    const handleClick = (event: MouseEvent) => {
      const insideNote = (event.target as Element | null)?.closest?.(`.${notePopoverClass}`)
      const anchor = getAnchorFromEvent(event)
      if (insideNote && !anchor) {
        event.stopImmediatePropagation()
        return
      }
      closeNotePopover()
      setExternalLink(undefined)
      if (!anchor) return
      linkHighlight.current?.clear()
      if (consumeExternalLinkClick(event, anchor, setExternalLink)) return

      const href = getInternalBookHref(anchor)
      if (!href) return
      const target = insideNote ? href : getBookLinkDisplayTarget(tab, anchor)
      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
      closeChapterFindEvent()
      const navigate = async () => {
        if (!target) {
          tab.reportNavigationError(new Error(`No Section Found: ${href}`))
          return
        }
        return displayBookLink(target)
      }
      if (
        insideNote ||
        zenMode ||
        !href.includes('#') ||
        isNoteBacklink(anchor) ||
        (!isExplicitNoteLink(anchor) && getNoteIndex(anchor.ownerDocument).getItemForAnchor(anchor))
      ) {
        void navigate().catch((error) => tab.reportNavigationError(error))
        return
      }

      const requestId = noteRequestId.current
      void getLinkedNote(tab, anchor, hideEndnotes)
        .then((content) => {
          if (requestId !== noteRequestId.current || !anchor.isConnected) return
          if (!content || !containerRef.current) {
            return navigate()
          }
          notePopover.current = showNotePopover(anchor, content, containerRef.current, rendition)
        })
        .catch((error) => {
          if (requestId === noteRequestId.current && anchor.isConnected) tab.reportNavigationError(error)
        })
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!notePopover.current || event.key !== 'Escape') return
      event.preventDefault()
      event.stopImmediatePropagation()
      closeNotePopover()
    }
    for (const frame of frameWindows) {
      frame.document.addEventListener('click', handleClick, true)
      frame.addEventListener('keydown', handleKeyDown, true)
    }
    document.addEventListener('pointerdown', closeNotePopover, true)
    document.addEventListener('keydown', handleKeyDown, true)
    window.addEventListener('resize', closeNotePopover)
    currentRendition?.on('relocated', closeNotePopover)
    return () => {
      for (const frame of frameWindows) {
        frame.document.removeEventListener('click', handleClick, true)
        frame.removeEventListener('keydown', handleKeyDown, true)
      }
      document.removeEventListener('pointerdown', closeNotePopover, true)
      document.removeEventListener('keydown', handleKeyDown, true)
      window.removeEventListener('resize', closeNotePopover)
      currentRendition?.off('relocated', closeNotePopover)
      closeNotePopover()
      setExternalLink(undefined)
    }
  }, [active, closeNotePopover, containerRef, displayBookLink, frameWindows, hideEndnotes, rendition, tab, zenMode])

  const handleFrameClick = useCallback(
    (event: MouseEvent) => {
      // https://developer.chrome.com/blog/tap-to-search
      event.preventDefault()

      for (const element of event.composedPath()) {
        // `instanceof` may not work in iframe
        if (isFrameAnchor(element) && element.href) {
          return
        }
        if (!zenMode && isFrameImage(element)) {
          const imageSrc = element.currentSrc || element.src
          if (imageSrc) {
            openImagePreview(imageSrc)
            return
          }
          return
        }
        if (!zenMode && isFrameSource(element)) {
          const image = element.parentElement?.querySelector('img')
          const imageSrc = image?.currentSrc || image?.src
          if (imageSrc) {
            openImagePreview(imageSrc)
            return
          }
          return
        }
      }
    },
    [openImagePreview, tab, zenMode],
  )
  useFrameEvent(activeFrameWindows, 'click', handleFrameClick)
  useFrameEvent(activeFrameWindows, 'contextmenu', preventFrameContextMenu)

  return {
    externalLink,
    closeNotePopover,
    closeExternalLink,
    closeImagePreview: () => setImagePreview(undefined),
    imagePreview,
  }
}
