import { notePopoverClass } from '../../bodyText'

import {
  getNoteOverlayPlacement,
  getVisiblePageRect,
  intersectRects,
  NOTE_POPOVER_MARGIN,
  NOTE_POPOVER_MIN_WIDTH,
  NOTE_POPOVER_PADDING,
} from './noteGeometry'

export function showNotePopover(anchor: HTMLElement, content: HTMLElement, container: HTMLElement, rendition: unknown) {
  const doc = anchor.ownerDocument
  const frame = doc.defaultView?.frameElement
  if (!frame) return
  const frameRect = frame.getBoundingClientRect()
  const visible = intersectRects(frameRect, container.getBoundingClientRect())
  if (!visible) return
  const anchorRect = anchor.getBoundingClientRect()
  const page = getVisiblePageRect(
    visible,
    {
      left: frameRect.left + anchorRect.left,
      top: frameRect.top + anchorRect.top,
      width: anchorRect.width,
      height: anchorRect.height,
    },
    rendition,
  )
  page.left -= frameRect.left
  page.top -= frameRect.top

  const writingMode = doc.defaultView!.getComputedStyle(anchor).writingMode
  const vertical = writingMode === 'vertical-rl'
  const margin = NOTE_POPOVER_MARGIN * 2
  const inset = (NOTE_POPOVER_PADDING + 1) * 2
  const maxWidth = Math.max(
    NOTE_POPOVER_MIN_WIDTH,
    vertical ? Math.min(320, page.width / 2 - margin) : page.width - margin,
  )
  const maxHeight = Math.max(1, page.height - margin - inset)
  const popover = doc.createElement('div')
  popover.className = notePopoverClass
  popover.popover = 'manual'
  popover.tabIndex = -1
  popover.dataset.flowKeyboardCapture = 'true'
  const theme = getComputedStyle(container)
  popover.style.cssText = `
    position:fixed; inset:auto; margin:0; box-sizing:border-box; width:max-content;
    max-width:${maxWidth}px; padding:${NOTE_POPOVER_PADDING}px; border-radius:10px; overflow:visible;
    border:1px solid ${theme.getPropertyValue('--flow-border')};
    background:${theme.getPropertyValue('--flow-bg-panel')};
    color:${theme.getPropertyValue('--flow-text')}; font:inherit;
    writing-mode:${writingMode}; text-align:justify;
    box-shadow:0 12px 28px rgba(0,0,0,.22); outline:none;
  `
  const scroll = doc.createElement('div')
  scroll.style.cssText = `
    display:${vertical ? 'inline-block' : 'block'}; max-width:${maxWidth - inset}px;
    max-height:${maxHeight}px;
    overflow-x:clip; overflow-y:visible; overflow-wrap:break-word;
    user-select:text; -webkit-user-select:text; overscroll-behavior:contain;
  `
  scroll.appendChild(content)
  const styles = doc.createElement('style')
  styles.textContent = `
    .${notePopoverClass} > div > :first-child { margin:0 !important; padding:0 !important; }
    .${notePopoverClass} img { max-width:100%; max-height:${maxHeight}px; }
    .${notePopoverClass}::backdrop { pointer-events:none; }
  `
  const arrow = doc.createElement('div')
  arrow.setAttribute('aria-hidden', 'true')
  arrow.style.cssText =
    'position:absolute; width:12px; height:12px; background:inherit; transform:rotate(45deg); pointer-events:none;'
  popover.append(scroll, styles, arrow)
  doc.body.appendChild(popover)
  popover.showPopover()
  const update = () => {
    scroll.style.overflowX =
      vertical && scroll.scrollWidth > scroll.clientWidth + 1 ? 'auto' : vertical ? 'visible' : 'clip'
    scroll.style.overflowY = vertical ? 'clip' : scroll.scrollHeight > maxHeight ? 'auto' : 'visible'
    const rect = popover.getBoundingClientRect()
    const placement = getNoteOverlayPlacement(anchorRect, page, rect, writingMode)
    popover.style.left = `${placement.left}px`
    popover.style.top = `${placement.top}px`
    Object.assign(arrow.style, {
      left: placement.side === 'left' ? 'auto' : placement.side === 'right' ? '-6px' : `${placement.arrowLeft}px`,
      right: placement.side === 'left' ? '-6px' : 'auto',
      top: placement.side ? `${placement.arrowTop}px` : placement.placeAbove ? 'auto' : '-6px',
      bottom: !placement.side && placement.placeAbove ? '-6px' : 'auto',
      border: `1px solid ${theme.getPropertyValue('--flow-border')}`,
      borderWidth:
        placement.side === 'left'
          ? '1px 1px 0 0'
          : placement.side === 'right'
            ? '0 0 1px 1px'
            : placement.placeAbove
              ? '0 1px 1px 0'
              : '1px 0 0 1px',
    })
  }
  update()
  popover.focus({ preventScroll: true })
  const observer = new ResizeObserver(update)
  observer.observe(scroll)
  scroll.addEventListener('load', update, true)
  popover.addEventListener('wheel', (event) => event.stopPropagation(), { passive: true })
  // Selection in the copy must not open the reader's annotation/edit menu.
  for (const type of ['mousedown', 'mouseup', 'contextmenu']) {
    popover.addEventListener(type, (event) => {
      event.stopPropagation()
      if (type === 'contextmenu') event.preventDefault()
    })
  }
  popover.addEventListener('dragstart', (event) => event.preventDefault())
  popover.addEventListener('auxclick', (event) => {
    event.preventDefault()
    event.stopPropagation()
  })
  return () => {
    observer.disconnect()
    if (popover.contains(doc.activeElement) && anchor.isConnected) anchor.focus({ preventScroll: true })
    popover.remove()
  }
}
