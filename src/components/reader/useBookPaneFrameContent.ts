import {
  type Dispatch,
  type RefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from 'react'

import { isSupportedExternalUrl, openSupportedExternalUrl } from '../../externalLink'
import { installProductionReloadShortcutGuard } from '../../keyboard'
import type { BookTab } from '../../models/reader'
import { getNoteIndex } from '../../noteIndex'
import { useDndContext } from '../base/dropZoneContext'

import type { ExternalLinkPreview } from './ExternalLinkPopover'
import {
  createNotePopoverState,
  getAnchorFromEvent,
  getBookLinkDisplayTarget,
  getLinkedNote,
  isInternalBookHashLink,
  type LinkedNoteResult,
  type NotePopoverState,
  type NotePopoverTypography,
} from './noteContent'
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
    const frame = anchor.ownerDocument.defaultView?.frameElement
    if (frame) {
      const frameRect = frame.getBoundingClientRect()
      const rect = new DOMRect(frameRect.left + event.clientX, frameRect.top + event.clientY, 0, 0)
      setPreview({ href, getBoundingClientRect: () => rect })
    }
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
  frameWindows: readonly Window[]
  rendition: unknown
  setNotePopover: Dispatch<SetStateAction<NotePopoverState | undefined>>
  tab: BookTab
  typography: NotePopoverTypography
  zenMode: boolean
}

export function useBookPaneFrameContent({
  active,
  activeFrameWindows,
  closeChapterFind,
  containerRef,
  frameWindows,
  rendition,
  setNotePopover,
  tab,
  typography,
  zenMode,
}: BookPaneFrameContentOptions) {
  const noteRequestId = useRef(0)
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
    const cleanups = frameWindows.map((frame) => installProductionReloadShortcutGuard(frame.document))
    return () => cleanups.forEach((cleanup) => cleanup())
  }, [active, frameWindows])

  useEffect(() => {
    if (!active) return

    const cleanups = frameWindows.map((frame) => {
      const document = frame.document

      const handleClick = (event: MouseEvent) => {
        setExternalLink(undefined)
        const anchor = getAnchorFromEvent(event)
        if (!anchor) {
          noteRequestId.current += 1
          setNotePopover(undefined)
          return
        }

        if (consumeExternalLinkClick(event, anchor, setExternalLink)) {
          noteRequestId.current += 1
          setNotePopover(undefined)
          return
        }

        if (zenMode) {
          const target = getBookLinkDisplayTarget(tab, anchor)
          if (target) {
            event.preventDefault()
            event.stopPropagation()
            event.stopImmediatePropagation()
            tab.displayBookLink(target).catch(console.error)
          }
          noteRequestId.current += 1
          setNotePopover(undefined)
          return
        }

        if (!isInternalBookHashLink(anchor)) {
          const target = getBookLinkDisplayTarget(tab, anchor)
          if (target) {
            event.preventDefault()
            event.stopPropagation()
            event.stopImmediatePropagation()
            closeChapterFindEvent()
            noteRequestId.current += 1
            setNotePopover(undefined)
            tab.displayBookLink(target).catch(console.error)
          }

          return
        }

        event.preventDefault()
        event.stopPropagation()
        event.stopImmediatePropagation()
        closeChapterFindEvent()
        setNotePopover(undefined)

        const displayTarget = getBookLinkDisplayTarget(tab, anchor)
        if (getNoteIndex(anchor.ownerDocument).getItemForAnchor(anchor)) {
          noteRequestId.current += 1
          if (displayTarget) tab.displayBookLink(displayTarget).catch(console.error)
          return
        }

        const requestId = (noteRequestId.current += 1)
        let note: LinkedNoteResult | undefined

        void (async () => {
          try {
            note = await getLinkedNote(tab, anchor, containerRef.current)
            if (!note) {
              if (displayTarget) await tab.displayBookLink(displayTarget)
              return
            }
            if (requestId !== noteRequestId.current) {
              return
            }
            if (!anchor.isConnected) {
              return
            }

            const popover = createNotePopoverState(anchor, note.element, containerRef.current, rendition, {
              fontSize: typography.fontSize,
              lineHeight: typography.lineHeight,
            })
            if (!popover) {
              return
            }
            if (requestId !== noteRequestId.current) {
              return
            }

            setNotePopover(popover)
          } finally {
            note?.cleanup?.()
          }
        })()
      }

      const handleKeyDown = (event: KeyboardEvent) => {
        if (event.key === 'Escape') setNotePopover(undefined)
      }

      document.addEventListener('click', handleClick, true)
      document.addEventListener('keydown', handleKeyDown, true)

      return () => {
        document.removeEventListener('click', handleClick, true)
        document.removeEventListener('keydown', handleKeyDown, true)
        noteRequestId.current += 1
        setNotePopover(undefined)
        setExternalLink(undefined)
      }
    })

    return () => {
      cleanups.forEach((cleanup) => cleanup())
    }
  }, [
    active,
    containerRef,
    frameWindows,
    rendition,
    setNotePopover,
    tab,
    typography.fontSize,
    typography.lineHeight,
    zenMode,
  ])

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
    closeExternalLink,
    closeImagePreview: () => setImagePreview(undefined),
    imagePreview,
  }
}
