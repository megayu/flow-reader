import { layoutBesideRect } from '../../reader/contextViewLayout'
import { getRenditionPageWidth } from '../../reader/layoutGeometry'

export interface RectLike {
  left: number
  top: number
  width: number
  height: number
}

export const NOTE_POPOVER_MARGIN = 18
export const NOTE_POPOVER_PADDING = 10
export const NOTE_POPOVER_MIN_WIDTH = 180
const NOTE_POPOVER_ARROW_EDGE_OFFSET = 24

export function getVisiblePageRect(visibleRect: RectLike, anchorRect: RectLike, rendition: unknown) {
  const pageWidth = getRenditionPageWidth(rendition)
  if (!pageWidth || visibleRect.width <= pageWidth * 1.25) return visibleRect

  const anchorCenter = anchorRect.left + anchorRect.width / 2
  const pageCount = Math.max(1, Math.ceil(visibleRect.width / pageWidth))
  const pageIndex = clamp(Math.floor((anchorCenter - visibleRect.left) / pageWidth), 0, pageCount - 1)
  const left = visibleRect.left + pageIndex * pageWidth
  const right = Math.min(visibleRect.left + visibleRect.width, left + pageWidth)

  return {
    left,
    top: visibleRect.top,
    width: right - left,
    height: visibleRect.height,
  }
}

export function getNoteOverlayPlacement(
  anchorRect: RectLike,
  pageRect: RectLike,
  size: { width: number; height: number },
  writingMode = 'horizontal-tb',
) {
  const margin = NOTE_POPOVER_MARGIN
  const gap = 10
  if (writingMode === 'vertical-rl') {
    const placement = layoutBesideRect(pageRect, anchorRect, size, {
      preferredSide: 'left',
      gap,
      margin,
    })

    return {
      ...placement,
      placeAbove: false,
      arrowLeft: 0,
      arrowTop: clamp(anchorRect.top + anchorRect.height / 2 - placement.top - 6, 18, Math.max(18, size.height - 18)),
    }
  }

  const pageRight = pageRect.left + pageRect.width
  const pageBottom = pageRect.top + pageRect.height
  const anchorCenter = anchorRect.left + anchorRect.width / 2
  const minLeft = pageRect.left + margin
  const maxLeft = pageRight - size.width - margin
  const left = getNotePopoverLeft(anchorCenter, size.width, minLeft, maxLeft)
  const roomAbove = anchorRect.top - pageRect.top - margin - gap
  const roomBelow = pageBottom - (anchorRect.top + anchorRect.height) - margin - gap
  const placeAbove = roomAbove >= size.height || roomAbove >= roomBelow
  const topAbove = anchorRect.top - size.height - gap
  const topBelow = anchorRect.top + anchorRect.height + gap
  const top = placeAbove
    ? clamp(topAbove, pageRect.top + margin, pageBottom - size.height - margin)
    : clamp(topBelow, pageRect.top + margin, pageBottom - size.height - margin)

  return {
    left,
    top,
    side: undefined,
    placeAbove,
    arrowLeft: clamp(anchorCenter - left - 6, 18, size.width - 18),
    arrowTop: 0,
  }
}

export function rectFromDomRect(rect: RectLike): RectLike {
  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
  }
}

export function intersectRects(a: RectLike, b: RectLike): RectLike | undefined {
  const left = Math.max(a.left, b.left)
  const top = Math.max(a.top, b.top)
  const right = Math.min(a.left + a.width, b.left + b.width)
  const bottom = Math.min(a.top + a.height, b.top + b.height)

  if (right <= left || bottom <= top) return

  return {
    left,
    top,
    width: right - left,
    height: bottom - top,
  }
}

function getNotePopoverLeft(anchorCenter: number, width: number, minLeft: number, maxLeft: number) {
  const centeredLeft = anchorCenter - width / 2
  const leftEdgeAligned = anchorCenter - NOTE_POPOVER_ARROW_EDGE_OFFSET
  const rightEdgeAligned = anchorCenter - width + NOTE_POPOVER_ARROW_EDGE_OFFSET
  const leftRoom = anchorCenter - minLeft
  const rightRoom = maxLeft + width - anchorCenter
  const centeredRoom = width / 2

  if (leftRoom < centeredRoom && rightRoom > leftRoom) {
    return clamp(leftEdgeAligned, minLeft, maxLeft)
  }

  if (rightRoom < centeredRoom && leftRoom > rightRoom) {
    return clamp(rightEdgeAligned, minLeft, maxLeft)
  }

  return clamp(centeredLeft, minLeft, maxLeft)
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}
