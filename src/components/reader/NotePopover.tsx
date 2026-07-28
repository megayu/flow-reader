import clsx from 'clsx'
import type React from 'react'
import { useLayoutEffect, useRef, useState } from 'react'

import { notePopoverClass } from '../../styles'

import type { NotePopoverState } from './noteContent'
import {
  getNoteOverlayPlacement,
  NOTE_POPOVER_MARGIN,
  NOTE_POPOVER_MIN_WIDTH,
  NOTE_POPOVER_PADDING,
} from './noteGeometry'

export {
  createNotePopoverState,
  getAnchorFromEvent,
  getBookLinkDisplayTarget,
  getLinkedNote,
  isInternalBookHashLink,
  type LinkedNoteResult,
  type NotePopoverState,
  type NotePopoverTypography,
  type RectLike,
} from './noteContent'

export interface NotePopoverProps {
  popover?: NotePopoverState
  onClose: () => void
}

export const NotePopover: React.FC<NotePopoverProps> = ({ popover, onClose }) => {
  const popoverRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [scrollable, setScrollable] = useState(false)

  useLayoutEffect(() => {
    const content = contentRef.current
    if (!content || !popover) return

    content.replaceChildren(popover.content)

    const updateSize = () => {
      const rect = popoverRef.current?.getBoundingClientRect()
      setSize({
        width: Math.ceil(rect?.width ?? 0),
        height: Math.ceil(rect?.height ?? 0),
      })
      setScrollable(
        popover.writingMode === 'vertical-rl'
          ? content.scrollWidth > content.clientWidth + 1
          : content.scrollHeight > popover.pageRect.height - NOTE_POPOVER_MARGIN * 2 + 1,
      )
    }

    updateSize()
    popoverRef.current?.focus()

    const observer = new ResizeObserver(updateSize)
    if (popoverRef.current) observer.observe(popoverRef.current)

    return () => observer.disconnect()
  }, [popover])

  if (!popover) return null

  const vertical = popover.writingMode === 'vertical-rl'
  const maxWidth = vertical
    ? Math.max(NOTE_POPOVER_MIN_WIDTH, Math.min(320, popover.pageRect.width / 2 - NOTE_POPOVER_MARGIN * 2))
    : Math.max(NOTE_POPOVER_MIN_WIDTH, popover.pageRect.width - NOTE_POPOVER_MARGIN * 2)
  const placement = getNoteOverlayPlacement(
    popover.anchorRect,
    popover.pageRect,
    {
      width: size.width || maxWidth,
      height: size.height,
    },
    popover.writingMode,
  )

  return (
    <div
      data-flow-keyboard-capture="true"
      ref={popoverRef}
      className={clsx(notePopoverClass, 'focus:outline-none')}
      tabIndex={-1}
      style={{
        position: 'absolute',
        zIndex: 40,
        boxSizing: 'border-box',
        left: placement.left,
        top: placement.top,
        width: 'max-content',
        maxWidth,
        overflow: 'visible',
        padding: NOTE_POPOVER_PADDING,
        borderRadius: 10,
        color: 'var(--flow-text)',
        background: 'var(--flow-bg-panel)',
        border: '1px solid var(--flow-border)',
        boxShadow: '0 12px 28px rgba(0, 0, 0, 0.22)',
        visibility: size.width ? 'visible' : 'hidden',
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Escape') {
          e.preventDefault()
          onClose()
        }
      }}
    >
      <div
        ref={contentRef}
        style={{
          margin: 0,
          maxWidth: '100%',
          maxHeight: popover.pageRect.height - NOTE_POPOVER_MARGIN * 2,
          overflowX: popover.writingMode === 'vertical-rl' ? (scrollable ? 'auto' : 'visible') : 'clip',
          overflowY: popover.writingMode === 'vertical-rl' ? 'clip' : scrollable ? 'auto' : 'visible',
          whiteSpace: 'normal',
          overflowWrap: 'break-word',
          textAlign: 'justify',
          writingMode: popover.writingMode === 'vertical-rl' ? 'vertical-rl' : undefined,
          textOrientation: popover.writingMode === 'vertical-rl' ? 'mixed' : undefined,
          color: 'inherit',
        }}
      />
      <div
        style={{
          position: 'absolute',
          left: placement.side === 'right' ? -6 : placement.side === 'left' ? undefined : placement.arrowLeft,
          right: placement.side === 'left' ? -6 : undefined,
          top: placement.side ? placement.arrowTop : placement.placeAbove ? undefined : -6,
          bottom: placement.side || !placement.placeAbove ? undefined : -6,
          width: 12,
          height: 12,
          background: 'var(--flow-bg-panel)',
          borderRight:
            placement.side === 'left' || (!placement.side && placement.placeAbove)
              ? '1px solid var(--flow-border)'
              : undefined,
          borderBottom:
            placement.side === 'left' || (!placement.side && placement.placeAbove)
              ? '1px solid var(--flow-border)'
              : undefined,
          borderLeft:
            placement.side === 'right' || (!placement.side && !placement.placeAbove)
              ? '1px solid var(--flow-border)'
              : undefined,
          borderTop:
            placement.side === 'right' || (!placement.side && !placement.placeAbove)
              ? '1px solid var(--flow-border)'
              : undefined,
          transform: 'rotate(45deg)',
        }}
      />
    </div>
  )
}
