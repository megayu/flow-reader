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
import type { BookTab } from '../../models/reader'
import { getNoteIndex } from '../../noteIndex'
import { useDndContext } from '../base/DropZone'

import {
  createNotePopoverState,
  getAnchorFromEvent,
  getBookLinkDisplayTarget,
  getLinkedNote,
  isInternalBookHashLink,
  type LinkedNoteResult,
  type NotePopoverState,
  type NotePopoverTypography,
} from './NotePopover'
import { useFrameEvent } from './useFrameEvent'

function consumeExternalLinkClick(event: MouseEvent, anchor: HTMLAnchorElement) {
  const href = anchor.getAttribute('href')?.trim()
  if (!href || !isSupportedExternalUrl(href)) return false

  event.preventDefault()
  event.stopPropagation()
  event.stopImmediatePropagation()
  if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey) {
    void openSupportedExternalUrl(href).catch((error) => {
      console.error(error)
    })
  }
  return true
}

function preventFrameContextMenu(event: Event) {
  event.preventDefault()
}

interface BookPaneFrameContentOptions {
  active: boolean
  activeFrameWindows: readonly Window[]
  closeChapterFind: () => void
  containerRef: RefObject<HTMLDivElement | null>
  frameWindows: readonly Window[]
  onMouseDown: () => void
  rendition: any
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
  onMouseDown,
  rendition,
  setNotePopover,
  tab,
  typography,
  zenMode,
}: BookPaneFrameContentOptions) {
  const noteRequestId = useRef(0)
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
      setDragEvent(event as any)
    },
    [setDragEvent],
  )
  useFrameEvent(activeFrameWindows, 'dragover', handleFrameDragOver)

  const handleFrameMouseDown = useCallback(() => {
    onMouseDown()
  }, [onMouseDown])
  useFrameEvent(activeFrameWindows, 'mousedown', handleFrameMouseDown)

  useEffect(() => {
    if (!active) return

    const cleanups = frameWindows.map((frame) => {
      const document = frame.document

      const handleClick = (event: MouseEvent) => {
        if (zenMode) {
          noteRequestId.current += 1
          setNotePopover(undefined)
          return
        }

        const anchor = getAnchorFromEvent(event)
        if (!anchor) {
          noteRequestId.current += 1
          setNotePopover(undefined)
          return
        }

        if (consumeExternalLinkClick(event, anchor)) {
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
            tab.display(target)
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
          if (displayTarget) tab.display(displayTarget)
          return
        }

        const requestId = (noteRequestId.current += 1)
        let note: LinkedNoteResult | undefined

        void (async () => {
          try {
            note = await getLinkedNote(tab, anchor, containerRef.current)
            if (!note) {
              if (displayTarget) tab.display(displayTarget)
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

      for (const element of event.composedPath() as any) {
        // `instanceof` may not work in iframe
        if (element.tagName === 'A' && element.href) {
          if (consumeExternalLinkClick(event, element)) return

          tab.showPrevLocation()
          return
        }
        if (!zenMode && element.tagName === 'IMG') {
          const imageSrc = element.currentSrc || element.src
          if (imageSrc) {
            openImagePreview(imageSrc)
            return
          }
          return
        }
        if (!zenMode && element.tagName === 'SOURCE') {
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
    closeImagePreview: () => setImagePreview(undefined),
    imagePreview,
  }
}
