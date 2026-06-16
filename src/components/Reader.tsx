import { useEventListener } from '@literal-ui/hooks'
import clsx from 'clsx'
import React, {
  ComponentProps,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { MdChevronRight, MdWebAsset } from 'react-icons/md'
import { RiBookLine } from 'react-icons/ri'
import { PhotoSlider } from 'react-photo-view'
import { useSetRecoilState } from 'recoil'
import useTilg from 'tilg'
import { useSnapshot } from 'valtio'

import { RenditionSpread } from '@flow/epubjs/types/rendition'
import { navbarState } from '@flow/reader/state'

import { db } from '../db'
import { handleFiles } from '../file'
import {
  hasSelection,
  useBackground,
  useColorScheme,
  useMobile,
  useTranslation,
  useTypography,
} from '../hooks'
import { BookTab, reader, useReaderSnapshot } from '../models'
import { isTouchScreen } from '../platform'
import { notePopoverClass, updateCustomStyle } from '../styles'

import {
  getClickedAnnotation,
  setClickedAnnotation,
  Annotations,
} from './Annotation'
import { Tab } from './Tab'
import { TextSelectionMenu } from './TextSelectionMenu'
import { DropZone, SplitView, useDndContext, useSplitViewItem } from './base'
import * as pages from './pages'

function handleKeyDown(tab?: BookTab) {
  return (e: KeyboardEvent) => {
    try {
      switch (e.code) {
        case 'ArrowLeft':
        case 'ArrowUp':
          tab?.prev()
          break
        case 'ArrowRight':
        case 'ArrowDown':
          tab?.next()
          break
        case 'Space':
          e.shiftKey ? tab?.prev() : tab?.next()
      }
    } catch (error) {
      // ignore `rendition is undefined` error
    }
  }
}

function useFrameEvent<K extends keyof WindowEventMap>(
  frames: readonly Window[],
  type: K,
  listener: (event: WindowEventMap[K]) => void,
  options?: AddEventListenerOptions,
) {
  useEffect(() => {
    if (!frames.length) return

    frames.forEach((frame) => {
      frame.addEventListener(type, listener, options)
    })

    return () => {
      frames.forEach((frame) => {
        frame.removeEventListener(type, listener, options)
      })
    }
  }, [frames, listener, options, type])
}

export function ReaderGridView() {
  const { groups } = useReaderSnapshot()

  useEventListener('keydown', handleKeyDown(reader.focusedBookTab))

  if (!groups.length) return null
  return (
    <SplitView className={clsx('ReaderGridView')}>
      {groups.map(({ id }, i) => (
        <ReaderGroup key={id} index={i} />
      ))}
    </SplitView>
  )
}

interface ReaderGroupProps {
  index: number
}
function ReaderGroup({ index }: ReaderGroupProps) {
  const group = reader.groups[index]!
  const { focusedIndex } = useReaderSnapshot()
  const { tabs, selectedIndex } = useSnapshot(group)
  const t = useTranslation()

  const { size } = useSplitViewItem(`${ReaderGroup.name}.${index}`, {
    // to disable sash resize
    visible: false,
  })

  const handleMouseDown = useCallback(() => {
    reader.selectGroup(index)
  }, [index])

  return (
    <div
      className="ReaderGroup flex flex-1 flex-col overflow-hidden focus:outline-none"
      onMouseDown={handleMouseDown}
      style={{ width: size }}
    >
      <Tab.List
        className="hidden sm:flex"
        onDelete={() => reader.removeGroup(index)}
      >
        {tabs.map((tab, i) => {
          const selected = i === selectedIndex
          const focused = index === focusedIndex && selected
          return (
            <Tab
              key={tab.id}
              selected={selected}
              focused={focused}
              onClick={() => group.selectTab(i)}
              onDelete={() => reader.removeTab(i, index)}
              Icon={tab instanceof BookTab ? RiBookLine : MdWebAsset}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData('text/plain', `${index},${i}`)
              }}
            >
              {tab.isBook ? tab.title : t(`${tab.title}.title`)}
            </Tab>
          )
        })}
      </Tab.List>

      <DropZone
        className={clsx('flex-1', isTouchScreen || 'h-0')}
        split
        onDrop={async (e, position) => {
          // read `e.dataTransfer` first to avoid get empty value after `await`
          const files = e.dataTransfer.files
          let tabs = []

          if (files.length) {
            tabs = await handleFiles(files)
          } else {
            const text = e.dataTransfer.getData('text/plain')
            const fromTab = text.includes(',')

            if (fromTab) {
              const indexes = text.split(',')
              const groupIdx = Number(indexes[0])

              if (index === groupIdx) {
                if (group.tabs.length === 1) return
                if (position === 'universe') return
              }

              const tabIdx = Number(indexes[1])
              const tab = reader.removeTab(tabIdx, groupIdx)
              if (tab) tabs.push(tab)
            } else {
              const id = text
              const tabParam =
                Object.values(pages).find((p) => p.displayName === id) ??
                (await db?.books.get(id))
              if (tabParam) tabs.push(tabParam)
            }
          }

          if (tabs.length) {
            switch (position) {
              case 'left':
                reader.addGroup(tabs, index)
                break
              case 'right':
                reader.addGroup(tabs, index + 1)
                break
              default:
                tabs.forEach((t) => reader.addTab(t, index))
            }
          }
        }}
      >
        {group.tabs.map((tab, i) => (
          <PaneContainer active={i === selectedIndex} key={tab.id}>
            {tab instanceof BookTab ? (
              <BookPane tab={tab} onMouseDown={handleMouseDown} />
            ) : (
              <tab.Component />
            )}
          </PaneContainer>
        ))}
      </DropZone>
    </div>
  )
}

interface PaneContainerProps {
  active: boolean
}
const PaneContainer: React.FC<PaneContainerProps> = ({ active, children }) => {
  return <div className={clsx('h-full', active || 'hidden')}>{children}</div>
}

interface BookPaneProps {
  tab: BookTab
  onMouseDown: () => void
}

function BookPane({ tab, onMouseDown }: BookPaneProps) {
  const ref = useRef<HTMLDivElement>(null)
  const prevSize = useRef(0)
  const typography = useTypography(tab)
  const { dark } = useColorScheme()
  const [background] = useBackground()

  const { iframe, iframes, rendition, rendered, container } = useSnapshot(tab)
  const frameWindows = useMemo(
    () => (iframes.length ? [...iframes] : iframe ? [iframe] : []),
    [iframe, iframes],
  )

  useTilg()

  useEffect(() => {
    const el = ref.current
    if (!el) return

    const observer = new ResizeObserver(([e]) => {
      const size = e?.contentRect.width ?? 0
      // `display: hidden` will lead `rect` to 0
      if (size !== 0 && prevSize.current !== 0) {
        reader.resize()
      }
      prevSize.current = size
    })

    observer.observe(el)

    return () => {
      observer.disconnect()
    }
  }, [])

  const setNavbar = useSetRecoilState(navbarState)
  const mobile = useMobile()

  const applyCustomStyle = useCallback(
    (contents?: any) => {
      if (contents) {
        updateCustomStyle(contents, typography)
        return
      }

      rendition
        ?.getContents()
        .forEach((contents: any) => updateCustomStyle(contents, typography))
    },
    [rendition, typography],
  )

  useEffect(() => {
    tab.onRender = applyCustomStyle
  }, [applyCustomStyle, tab])

  useEffect(() => {
    if (ref.current) tab.render(ref.current)
  }, [tab])

  useEffect(() => {
    /**
     * when `spread` changes, we should call `spread()` to re-layout,
     * then call {@link updateCustomStyle} to update custom style
     * according to the latest layout
     */
    rendition?.spread(typography.spread ?? RenditionSpread.Auto)
  }, [typography.spread, rendition])

  useEffect(() => applyCustomStyle(), [applyCustomStyle])

  useEffect(() => {
    if (dark === undefined) return
    // set `!important` when in dark mode
    rendition?.themes.override('color', dark ? '#bfc8ca' : '#3f484a', dark)
  }, [rendition, dark])

  const [src, setSrc] = useState<string>()
  const wheelDelta = useRef(0)
  const lastWheelTurn = useRef(0)

  useEffect(() => {
    if (src) {
      if (document.activeElement instanceof HTMLElement)
        document.activeElement?.blur()
    }
  }, [src])

  const { setDragEvent } = useDndContext()

  // `dragenter` not fired in iframe when the count of times is even, so use `dragover`
  const handleFrameDragOver = useCallback(
    (e: DragEvent) => {
      console.log('drag enter in iframe')
      setDragEvent(e as any)
    },
    [setDragEvent],
  )
  useFrameEvent(frameWindows, 'dragover', handleFrameDragOver)

  const handleFrameMouseDown = useCallback(() => {
    onMouseDown()
  }, [onMouseDown])
  useFrameEvent(frameWindows, 'mousedown', handleFrameMouseDown)

  useEffect(() => {
    const cleanups = frameWindows.map((win) => {
      const doc = win.document

      const handleClick = (e: MouseEvent) => {
        const target = e.target as ClosestTarget | null
        if (target?.closest?.(`.${NOTE_POPOVER_CLASS}`)) {
          e.stopPropagation()
          return
        }

        const anchor = getAnchorFromEvent(e)
        if (!anchor) {
          closeNotePopover(doc)
          return
        }

        const noteElement = getLinkedNote(tab, anchor)
        if (!noteElement) return

        e.preventDefault()
        e.stopPropagation()
        e.stopImmediatePropagation()
        showNotePopover(anchor, noteElement)
      }

      const handleKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Escape') closeNotePopover(doc)
      }

      doc.addEventListener('click', handleClick, true)
      doc.addEventListener('keydown', handleKeyDown, true)

      return () => {
        doc.removeEventListener('click', handleClick, true)
        doc.removeEventListener('keydown', handleKeyDown, true)
        closeNotePopover(doc)
      }
    })

    return () => {
      cleanups.forEach((cleanup) => cleanup())
    }
  }, [frameWindows, tab])

  const handleFrameClick = useCallback(
    (e: MouseEvent) => {
      // https://developer.chrome.com/blog/tap-to-search
      e.preventDefault()

      for (const el of e.composedPath() as any) {
        // `instanceof` may not work in iframe
        if (el.tagName === 'A' && el.href) {
          tab.showPrevLocation()
          return
        }
        if (
          mobile === false &&
          el.tagName === 'IMG' &&
          el.src.startsWith('blob:')
        ) {
          setSrc(el.src)
          return
        }
      }

      if (isTouchScreen && container) {
        if (getClickedAnnotation()) {
          setClickedAnnotation(false)
          return
        }

        const w = container.clientWidth
        const x = e.clientX % w
        const threshold = 0.3
        const side = w * threshold

        if (x < side) {
          tab.prev()
        } else if (w - x < side) {
          tab.next()
        } else if (mobile) {
          setNavbar((a) => !a)
        }
      }
    },
    [container, mobile, setNavbar, tab],
  )
  useFrameEvent(frameWindows, 'click', handleFrameClick)

  const handleRenditionWheel = useCallback(
    (e: WheelEvent) => {
      e.preventDefault()

      const delta =
        Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX
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

  useEffect(() => {
    if (!rendition) return

    const target = rendition as any
    target.on('wheel', handleRenditionWheel)

    return () => {
      target.off?.('wheel', handleRenditionWheel)
      target.removeListener?.('wheel', handleRenditionWheel)
    }
  }, [handleRenditionWheel, rendition])

  const handleFrameKeyDown = useMemo(() => handleKeyDown(tab), [tab])
  useFrameEvent(frameWindows, 'keydown', handleFrameKeyDown)

  const handleFrameTouchStart = useCallback(
    (e: TouchEvent) => {
      const x0 = e.targetTouches[0]?.clientX ?? 0
      const y0 = e.targetTouches[0]?.clientY ?? 0
      const t0 = Date.now()
      const win = e.currentTarget as Window | null

      if (!win) return

      // When selecting text with long tap, `touchend` is not fired,
      // so instead of use `addEventlistener`, we should use `on*`
      // to remove the previous listener.
      win.ontouchend = function handleTouchEnd(e: TouchEvent) {
        win.ontouchend = null
        const selection = win.getSelection()
        if (hasSelection(selection)) return

        const x1 = e.changedTouches[0]?.clientX ?? 0
        const y1 = e.changedTouches[0]?.clientY ?? 0
        const t1 = Date.now()

        const deltaX = x1 - x0
        const deltaY = y1 - y0
        const deltaT = t1 - t0

        const absX = Math.abs(deltaX)
        const absY = Math.abs(deltaY)

        if (absX < 10) return

        if (absY / absX > 2) {
          if (deltaT > 100 || absX < 30) {
            return
          }
        }

        if (deltaX > 0) {
          tab.prev()
        }

        if (deltaX < 0) {
          tab.next()
        }
      }
    },
    [tab],
  )
  useFrameEvent(frameWindows, 'touchstart', handleFrameTouchStart)

  useEffect(() => {
    const cleanups = frameWindows.map((win) => {
      const handleTouchMove = (event: TouchEvent) => {
        event.preventDefault()
      }

      win.document.addEventListener('touchmove', handleTouchMove, {
        passive: false,
      })

      return () => {
        win.document.removeEventListener('touchmove', handleTouchMove)
      }
    })

    return () => {
      cleanups.forEach((cleanup) => cleanup())
    }
  }, [frameWindows])

  return (
    <div className={clsx('flex h-full flex-col', mobile && 'py-[3vw]')}>
      <PhotoSlider
        images={[{ src, key: 0 }]}
        visible={!!src}
        onClose={() => setSrc(undefined)}
        maskOpacity={0.6}
        bannerVisible={false}
      />
      <ReaderPaneHeader tab={tab} />
      <div
        ref={ref}
        className={clsx('relative flex-1', isTouchScreen || 'h-0')}
        // `color-scheme: dark` will make iframe background white
        style={{ colorScheme: 'auto' }}
      >
        <div
          className={clsx(
            'absolute inset-0',
            // do not cover `sash`
            'z-20',
            rendered && 'hidden',
            background,
          )}
        />
        <TextSelectionMenu tab={tab} />
        <Annotations tab={tab} />
      </div>
      <ReaderPaneFooter tab={tab} />
    </div>
  )
}

const NOTE_POPOVER_CLASS = notePopoverClass
const NOTE_POPOVER_MARGIN = 18
const NOTE_POPOVER_PADDING_X = 14
const NOTE_POPOVER_PADDING_Y = 10
const NOTE_POPOVER_MAX_RATIO = 3.6
const NOTE_POPOVER_MIN_WIDTH = 180

function getAnchorFromEvent(e: MouseEvent) {
  return (e.target as ClosestTarget | null)?.closest?.('a[href]') as
    | HTMLAnchorElement
    | undefined
}

interface ClosestTarget {
  closest?: (selector: string) => Element | null
}

function getLinkedNote(tab: BookTab, anchor: HTMLAnchorElement) {
  const href = anchor.getAttribute('href')
  if (!href || href.startsWith('mailto:') || href.includes('://')) return

  const [path = '', hash = ''] = href.split('#')
  if (!hash) return

  const id = safeDecode(hash)
  const target = findLinkedElement(tab, anchor, path, id)
  if (!target || !isLikelyNoteLink(anchor, target, href, id)) return

  return findNoteElement(target)
}

function findLinkedElement(
  tab: BookTab,
  anchor: HTMLAnchorElement,
  path: string,
  id: string,
) {
  const currentDocument = anchor.ownerDocument

  if (!path) {
    return getElementByIdOrName(currentDocument, id)
  }

  if (sameHref(tab.section?.href, path)) {
    const currentElement = getElementByIdOrName(currentDocument, id)
    if (currentElement) return currentElement
  }

  const section = tab.sections?.find((s) => sameHref(s.href, path))
  return section && getElementByIdOrName(section.document, id)
}

function getElementByIdOrName(doc: Document, id: string) {
  return (
    doc.getElementById(id) ??
    ([...doc.querySelectorAll('[name]')].find(
      (el) => el.getAttribute('name') === id,
    ) as HTMLElement | undefined)
  )
}

function findNoteElement(el: HTMLElement) {
  let cur: HTMLElement | null = el
  let fallback: HTMLElement | undefined

  while (cur && cur !== cur.ownerDocument.body) {
    const type = cur.getAttribute('epub:type') ?? cur.getAttribute('type') ?? ''
    const role = cur.getAttribute('role') ?? ''

    if (
      /(?:footnote|endnote|note)/i.test(type) ||
      /(?:doc-footnote|doc-endnote|note)/i.test(role) ||
      cur.tagName === 'ASIDE'
    ) {
      return cur
    }

    if (
      !fallback &&
      (cur.tagName === 'P' ||
        cur.tagName === 'LI' ||
        cur.tagName === 'BLOCKQUOTE' ||
        cur.tagName === 'DIV')
    ) {
      fallback = cur
    }

    cur = cur.parentElement
  }

  return fallback ?? el
}

function cloneNoteElement(el: HTMLElement, anchor: HTMLAnchorElement) {
  const clone = cloneNoteElementWithContext(el)

  clone.querySelectorAll('script, style').forEach((node) => node.remove())
  clone.querySelectorAll('a[href]').forEach((node) => {
    if (isBacklink(node as HTMLAnchorElement, anchor)) {
      unwrapBacklink(node as HTMLAnchorElement)
    }
  })

  return clone
}

function cloneNoteElementWithContext(el: HTMLElement) {
  const ancestors = getNoteContextAncestors(el)
  let root = el.cloneNode(true) as HTMLElement

  ancestors.forEach((ancestor) => {
    const wrapper = ancestor.cloneNode(false) as HTMLElement
    wrapper.style.setProperty('display', 'contents', 'important')
    wrapper.appendChild(root)
    root = wrapper
  })

  return root
}

function getNoteContextAncestors(el: HTMLElement) {
  const ancestors: HTMLElement[] = []
  let cur = el.parentElement

  while (cur && cur !== cur.ownerDocument.body) {
    ancestors.push(cur)
    cur = cur.parentElement
  }

  return ancestors
}

function isBacklink(link: HTMLAnchorElement, anchor: HTMLAnchorElement) {
  const href = link.getAttribute('href') ?? ''
  const text = link.textContent?.trim() ?? ''
  const role = link.getAttribute('role') ?? ''
  const type = link.getAttribute('epub:type') ?? ''
  const anchorId = anchor.id || anchor.closest('[id]')?.id

  return (
    /(?:doc-backlink|backlink)/i.test(`${role} ${type}`) ||
    /^[↩←↑返回back]+$/i.test(text) ||
    !!(anchorId && href.endsWith(`#${anchorId}`))
  )
}

function unwrapBacklink(link: HTMLAnchorElement) {
  const span = link.ownerDocument.createElement('span')

  span.append(...Array.from(link.childNodes))
  link.replaceWith(span)
}

function showNotePopover(anchor: HTMLAnchorElement, noteElement: HTMLElement) {
  const doc = anchor.ownerDocument
  const win = doc.defaultView
  if (!win) return

  closeNotePopover(doc)

  const popover = doc.createElement('div')
  const content = doc.createElement('div')
  const arrow = doc.createElement('div')

  popover.className = NOTE_POPOVER_CLASS
  arrow.className = `${NOTE_POPOVER_CLASS}-arrow`

  content.appendChild(cloneNoteElement(noteElement, anchor))
  popover.append(content, arrow)
  doc.body.appendChild(popover)

  Object.assign(popover.style, {
    position: 'fixed',
    zIndex: '2147483647',
    boxSizing: 'border-box',
    minWidth: '0',
    maxWidth: `${getNotePopoverMaxWidth(win)}px`,
    overflow: 'visible',
    padding: `${NOTE_POPOVER_PADDING_Y}px ${NOTE_POPOVER_PADDING_X}px`,
    borderRadius: '10px',
    background: '#fff',
    boxShadow: '0 10px 26px rgba(0, 0, 0, 0.18)',
    visibility: 'hidden',
    left: '0px',
    top: '0px',
    width: 'max-content',
    columnWidth: 'auto',
    columnCount: 'auto',
    columnGap: 'normal',
    pageBreakInside: 'avoid',
    breakInside: 'avoid',
  })
  popover.style.setProperty('column-span', 'all')
  popover.style.setProperty('-webkit-column-span', 'all')

  Object.assign(content.style, {
    margin: '0',
    maxWidth: '100%',
  })

  Object.assign(arrow.style, {
    position: 'absolute',
    width: '12px',
    height: '12px',
    background: '#fff',
    transform: 'rotate(45deg)',
  })

  fitNotePopoverToContent(popover, win)

  positionNotePopover(anchor, popover, arrow)
  popover.style.visibility = 'visible'
}

function fitNotePopoverToContent(popover: HTMLElement, win: Window) {
  const viewport = getNoteViewport(win)
  const maxWidth = getNotePopoverMaxWidth(win)
  const minWidth = Math.min(NOTE_POPOVER_MIN_WIDTH, maxWidth)
  const maxHeight = viewport.height - NOTE_POPOVER_MARGIN * 2

  popover.style.width = 'max-content'
  popover.style.maxWidth = `${maxWidth}px`

  const naturalWidth = Math.ceil(popover.getBoundingClientRect().width)
  let width = Math.min(naturalWidth, maxWidth)

  popover.style.width = `${width}px`

  for (let i = 0; i < 6; i++) {
    const rect = popover.getBoundingClientRect()
    if (!rect.height || rect.width / rect.height <= NOTE_POPOVER_MAX_RATIO) {
      return
    }

    const nextWidth = Math.max(minWidth, Math.floor(width * 0.86))
    if (nextWidth === width) return

    width = nextWidth
    popover.style.width = `${width}px`
  }

  if (popover.getBoundingClientRect().height > maxHeight) {
    popover.style.width = `${maxWidth}px`
  }
}

function getNotePopoverMaxWidth(win: Window) {
  return Math.max(240, getNoteViewport(win).width - NOTE_POPOVER_MARGIN * 2)
}

function closeNotePopover(doc: Document) {
  doc
    .querySelectorAll(`.${NOTE_POPOVER_CLASS}`)
    .forEach((node) => node.remove())
}

function positionNotePopover(
  anchor: HTMLAnchorElement,
  popover: HTMLElement,
  arrow: HTMLElement,
) {
  const win = anchor.ownerDocument.defaultView
  if (!win) return

  const margin = NOTE_POPOVER_MARGIN
  const gap = 10
  const anchorRect = anchor.getBoundingClientRect()
  const rect = popover.getBoundingClientRect()
  const center = anchorRect.left + anchorRect.width / 2
  const viewport = getNoteViewport(win)
  const viewportRight = viewport.left + viewport.width
  const viewportBottom = viewport.top + viewport.height
  const left = clamp(
    center - rect.width / 2,
    viewport.left + margin,
    viewportRight - rect.width - margin,
  )
  const topAbove = anchorRect.top - rect.height - gap
  const topBelow = anchorRect.bottom + gap
  const roomAbove = anchorRect.top - viewport.top - margin - gap
  const roomBelow = viewportBottom - anchorRect.bottom - margin - gap
  const placeAbove = roomAbove >= rect.height || roomAbove >= roomBelow
  const top = placeAbove
    ? clamp(
        topAbove,
        viewport.top + margin,
        viewportBottom - rect.height - margin,
      )
    : clamp(
        topBelow,
        viewport.top + margin,
        viewportBottom - rect.height - margin,
      )
  const arrowLeft = clamp(center - left - 6, 18, rect.width - 18)

  popover.style.left = `${left}px`
  popover.style.top = `${top}px`
  arrow.style.left = `${arrowLeft}px`

  if (placeAbove) {
    arrow.style.bottom = '-6px'
    arrow.style.top = ''
  } else {
    arrow.style.top = '-6px'
    arrow.style.bottom = ''
  }
}

function clamp(value: number, min: number, max: number) {
  if (max < min) return min
  return Math.min(Math.max(value, min), max)
}

function getNoteViewport(win: Window) {
  const frame = win.frameElement
  const parentWin = frame?.ownerDocument.defaultView

  if (frame instanceof HTMLElement && parentWin) {
    const frameRect = frame.getBoundingClientRect()
    const parentViewport = getWindowViewport(parentWin)
    const left = clamp(parentViewport.left - frameRect.left, 0, frameRect.width)
    const top = clamp(parentViewport.top - frameRect.top, 0, frameRect.height)
    const right = clamp(
      parentViewport.left + parentViewport.width - frameRect.left,
      0,
      frameRect.width,
    )
    const bottom = clamp(
      parentViewport.top + parentViewport.height - frameRect.top,
      0,
      frameRect.height,
    )

    if (right > left && bottom > top) {
      return {
        left,
        top,
        width: right - left,
        height: bottom - top,
      }
    }
  }

  return getWindowViewport(win)
}

function getWindowViewport(win: Window) {
  const visualViewport = win.visualViewport
  const docEl = win.document.documentElement

  return {
    left: visualViewport?.offsetLeft ?? 0,
    top: visualViewport?.offsetTop ?? 0,
    width: visualViewport?.width ?? docEl.clientWidth ?? win.innerWidth,
    height: visualViewport?.height ?? docEl.clientHeight ?? win.innerHeight,
  }
}

function sameHref(a: string | undefined, b: string | undefined) {
  if (!a || !b) return false

  const normalize = (href: string) =>
    safeDecode(href)
      .split('#')[0]!
      .replace(/\\/g, '/')
      .replace(/^\.\//, '')
      .replace(/^(?:\.\.\/)+/, '')

  const na = normalize(a)
  const nb = normalize(b)

  return na === nb || na.endsWith(`/${nb}`) || nb.endsWith(`/${na}`)
}

function safeDecode(text: string) {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}

function isLikelyNoteLink(
  anchor: HTMLAnchorElement,
  target: HTMLElement,
  href: string,
  id: string,
) {
  const attrs = [
    href,
    id,
    anchor.id,
    anchor.className,
    anchor.getAttribute('epub:type'),
    anchor.getAttribute('role'),
    target.id,
    target.className,
    target.getAttribute('epub:type'),
    target.getAttribute('role'),
  ].join(' ')

  if (/(?:footnote|endnote|noteref|note|fn|ftn)/i.test(attrs)) return true
  if (anchor.closest('sup')) return true
  if (target.closest('aside')) return true

  const item = target.closest('li')
  return item?.parentElement?.tagName === 'OL'
}

interface ReaderPaneHeaderProps {
  tab: BookTab
}
const ReaderPaneHeader: React.FC<ReaderPaneHeaderProps> = ({ tab }) => {
  const { location } = useSnapshot(tab)
  const navPath = tab.getHeaderPath()

  useEffect(() => {
    navPath.forEach((i) => (i.expanded = true))
  }, [location, navPath])

  return (
    <Bar>
      <div className="scroll-h flex">
        {navPath.map((item, i) => (
          <button
            key={i}
            className="flex shrink-0 items-center hover:text-on-surface"
          >
            {item.label}
            {i !== navPath.length - 1 && <MdChevronRight size={20} />}
          </button>
        ))}
      </div>
    </Bar>
  )
}

interface FooterProps {
  tab: BookTab
}
const ReaderPaneFooter: React.FC<FooterProps> = ({ tab }) => {
  const { locationToReturn, location, book, rendition } = useSnapshot(tab)
  const divisor = rendition?.manager?.layout?.divisor ?? 1
  const spread = divisor > 1
  const percentage = `${((book.percentage ?? 0) * 100).toFixed(2)}%`
  const startDisplayed = location?.start.displayed
  const endDisplayed = location?.end.displayed
  const hasTwoVisiblePages =
    !!location &&
    (location.start.href !== location.end.href ||
      location.start.displayed.page !== location.end.displayed.page)

  return (
    <>
      {locationToReturn ? (
        <Bar>
          <button
            className={clsx(locationToReturn || 'invisible')}
            onClick={() => {
              tab.hidePrevLocation()
              tab.display(locationToReturn.end.cfi, false)
            }}
          >
            Return to {locationToReturn.end.cfi}
          </button>
          <button
            onClick={() => {
              tab.hidePrevLocation()
            }}
          >
            Stay
          </button>
        </Bar>
      ) : spread ? (
        <div className="grid h-6 grid-cols-2 items-center px-[4vw] text-center text-outline typescale-body-small sm:px-2">
          <div>
            {startDisplayed &&
              formatFooterPage(
                startDisplayed,
                hasTwoVisiblePages ? '' : percentage,
              )}
          </div>
          <div>
            {hasTwoVisiblePages &&
              endDisplayed &&
              formatFooterPage(endDisplayed, percentage)}
          </div>
        </div>
      ) : (
        <div className="flex h-6 items-center justify-center px-[4vw] text-outline typescale-body-small sm:px-2">
          {startDisplayed && formatFooterPage(startDisplayed, percentage)}
        </div>
      )}
    </>
  )
}

function formatFooterPage(
  displayed: { page: number; total: number },
  percentage?: string,
) {
  return `${displayed.page} · ${displayed.total}${
    percentage ? ` (${percentage})` : ''
  }`
}

interface LineProps extends ComponentProps<'div'> {}
const Bar: React.FC<LineProps> = ({ className, ...props }) => {
  return (
    <div
      className={clsx(
        'flex h-6 items-center justify-between gap-2 px-[4vw] text-outline typescale-body-small sm:px-2',
        className,
      )}
      {...props}
    ></div>
  )
}
