import { useEventListener } from '@literal-ui/hooks'
import clsx from 'clsx'
import dynamic from 'next/dynamic'
import React, {
  ComponentProps,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  MdChevronRight,
  MdClose,
  MdKeyboardArrowDown,
  MdKeyboardArrowUp,
  MdWebAsset,
} from 'react-icons/md'
import { RiBookLine } from 'react-icons/ri'
import type { IPhotoSliderProps } from 'react-photo-view/dist/PhotoSlider'
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
import { revealScrollbars } from '../scrollbar'
import {
  getBodyTypographyBaseline,
  notePopoverClass,
  updateCustomStyle,
} from '../styles'

import {
  getClickedAnnotation,
  setClickedAnnotation,
  Annotations,
} from './Annotation'
import { Tab } from './Tab'
import { TextSelectionMenu } from './TextSelectionMenu'
import { DropZone, useDndContext } from './base'
import * as pages from './pages'

const PhotoSlider = dynamic<IPhotoSliderProps>(
  () =>
    import('react-photo-view').then(
      (mod) => mod.PhotoSlider as React.ComponentType<IPhotoSliderProps>,
    ),
  { ssr: false },
)

const FONT_SIZE_MIN = 14
const FONT_SIZE_MAX = 28
const FONT_SIZE_DEFAULT = 16

function handleKeyDown(tab?: BookTab) {
  return (e: KeyboardEvent) => {
    try {
      if (handleCommandShortcut(e)) return
      if (handleReturnShortcut(e, tab)) return
      if (handleChapterShortcut(e, tab)) return

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

function handleCommandShortcut(e: KeyboardEvent) {
  if (!hasCommandModifier(e) || e.altKey) return false

  if (!e.shiftKey && e.key.toLowerCase() === 'w') {
    e.preventDefault()
    e.stopPropagation()
    e.stopImmediatePropagation?.()
    reader.closeFocusedTab()
    return true
  }

  const fontSizeReset = isFontSizeResetShortcut(e)
  const fontSizeDelta = getFontSizeShortcutDelta(e)
  if (!fontSizeReset && !fontSizeDelta) return false

  e.preventDefault()
  e.stopPropagation()
  e.stopImmediatePropagation?.()

  if (!isReaderShortcutTargetBlocked(e)) {
    const tab = reader.focusedBookTab
    if (tab) {
      if (fontSizeReset) {
        clearBookFontSize(tab)
      } else {
        updateBookFontSize(tab, fontSizeDelta)
      }
    }
  }
  return true
}

function hasCommandModifier(e: KeyboardEvent) {
  return e.metaKey || e.ctrlKey
}

function getFontSizeShortcutDelta(e: KeyboardEvent) {
  if (
    e.code === 'Equal' ||
    e.code === 'NumpadAdd' ||
    e.key === '+' ||
    e.key === '='
  ) {
    return 1
  }
  if (
    e.code === 'Minus' ||
    e.code === 'NumpadSubtract' ||
    e.key === '-' ||
    e.key === '_'
  ) {
    return -1
  }

  return 0
}

function isFontSizeResetShortcut(e: KeyboardEvent) {
  return !e.shiftKey && (e.code === 'Digit0' || e.code === 'Numpad0')
}

function updateBookFontSize(tab: BookTab, delta: number) {
  const fontSize =
    parseFontSize(tab.book.configuration?.typography?.fontSize) ??
    getCurrentBodyFontSize(tab) ??
    FONT_SIZE_DEFAULT
  const next = clamp(fontSize + delta, FONT_SIZE_MIN, FONT_SIZE_MAX)

  tab.updateBook({
    configuration: {
      ...tab.book.configuration,
      typography: {
        ...tab.book.configuration?.typography,
        fontSize: `${next}px`,
      },
    },
  })
}

function clearBookFontSize(tab: BookTab) {
  const typography = {
    ...tab.book.configuration?.typography,
  }
  delete typography.fontSize

  tab.updateBook({
    configuration: {
      ...tab.book.configuration,
      typography,
    },
  })
}

function getCurrentBodyFontSize(tab: BookTab) {
  return getBodyTypographyBaseline(tab.view?.contents, tab.bodyTextCache)
    .fontSize
}

function parseFontSize(value: string | undefined) {
  if (!value) return

  const size = parseInt(value, 10)
  return Number.isFinite(size) ? size : undefined
}

function handleChapterShortcut(e: KeyboardEvent, tab?: BookTab) {
  if (!tab) return false

  const direction =
    e.code === 'BracketLeft' || e.key === '['
      ? -1
      : e.code === 'BracketRight' || e.key === ']'
      ? 1
      : 0
  if (!direction) return false
  if (shouldIgnoreReaderShortcut(e)) return false

  e.preventDefault()
  e.stopPropagation()
  e.stopImmediatePropagation?.()

  void (direction < 0 ? tab.prevSection() : tab.nextSection())
  return true
}

function handleReturnShortcut(e: KeyboardEvent, tab?: BookTab) {
  if (!tab?.locationToReturn) return false

  const key = e.key.toLowerCase()
  if (key !== 'b' && key !== 'r' && key !== 's') return false
  if (shouldIgnoreReaderShortcut(e)) return false

  e.preventDefault()
  e.stopPropagation()
  e.stopImmediatePropagation?.()

  if (key === 'b') {
    return tab.returnToPreviousLocation()
  }
  if (key === 'r') {
    return tab.returnToFirstLocation()
  }

  tab.hidePrevLocation()
  return true
}

function shouldIgnoreReaderShortcut(e: KeyboardEvent) {
  if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return true
  return isReaderShortcutTargetBlocked(e)
}

function isReaderShortcutTargetBlocked(e: KeyboardEvent) {
  if (isEditableTarget(e.target)) return true
  return hasKeyboardCapturingLayer(e.target)
}

function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof Element)) return false

  const el = target as HTMLElement
  return !!el.closest('input, textarea, select, [contenteditable="true"]')
}

function hasKeyboardCapturingLayer(target: EventTarget | null) {
  const doc =
    target instanceof Node && target.ownerDocument
      ? target.ownerDocument
      : document
  const parentDoc = doc.defaultView?.frameElement?.ownerDocument
  const docs = new Set<Document>()

  ;[doc, parentDoc, document].forEach((candidate) => {
    if (candidate) docs.add(candidate)
  })
  ;[...docs].forEach((candidate) => {
    candidate.querySelectorAll('iframe').forEach((frame) => {
      try {
        if (frame.contentDocument) docs.add(frame.contentDocument)
      } catch (error) {
        // ignore cross-origin frames
      }
    })
  })

  return [...docs].some((candidate) =>
    candidate.querySelector(
      [
        '[data-flow-keyboard-capture="true"]',
        `.${NOTE_POPOVER_CLASS}`,
        '[role="dialog"]',
      ].join(','),
    ),
  )
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

function preventContextMenu(e: Event) {
  e.preventDefault()
}

export function ReaderGridView() {
  const { groups } = useReaderSnapshot()

  useEventListener('keydown', handleKeyDown(reader.focusedBookTab))
  useEventListener('contextmenu', preventContextMenu)

  if (!groups.length) return null
  const preferredIndex = reader.focusedIndex > -1 ? reader.focusedIndex : 0
  const index = groups[preferredIndex] ? preferredIndex : 0
  const group = groups[index]
  if (!group) return null

  return (
    <div className="ReaderGridView relative flex h-full min-h-0">
      <ReaderGroup key={group.id} index={index} />
    </div>
  )
}

interface ReaderGroupProps {
  index: number
}
function ReaderGroup({ index }: ReaderGroupProps) {
  const group = reader.groups[index]!
  const { tabs, selectedIndex } = useSnapshot(group)
  const t = useTranslation()

  const handleMouseDown = useCallback(() => {
    reader.selectGroup(index)
  }, [index])

  return (
    <div
      className="ReaderGroup flex h-full min-h-0 flex-1 flex-col overflow-hidden focus:outline-none"
      onMouseDown={handleMouseDown}
    >
      <Tab.List className="hidden sm:flex">
        {tabs.map((tab, i) => {
          const selected = i === selectedIndex
          const focused = selected
          return (
            <Tab
              key={tab.id}
              selected={selected}
              focused={focused}
              onClick={() => group.selectTab(i)}
              onDelete={() => reader.removeTab(i, index)}
              Icon={tab instanceof BookTab ? RiBookLine : MdWebAsset}
            >
              {tab.isBook ? tab.title : t(`${tab.title}.title`)}
            </Tab>
          )
        })}
      </Tab.List>

      <DropZone
        className={clsx('min-h-0 flex-1', isTouchScreen || 'h-0')}
        onDrop={async (e) => {
          // read `e.dataTransfer` first to avoid get empty value after `await`
          const files = e.dataTransfer.files
          let tabs = []

          if (files.length) {
            tabs = await handleFiles(files)
          } else {
            const text = e.dataTransfer.getData('text/plain')
            const tabParam =
              Object.values(pages).find((p) => p.displayName === text) ??
              (await db?.books.get(text))
            if (tabParam) tabs.push(tabParam)
          }

          if (tabs.length) {
            tabs.forEach((t) => reader.addTab(t, index))
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
  children?: React.ReactNode
}
const PaneContainer: React.FC<PaneContainerProps> = ({ active, children }) => {
  return <div className={clsx('h-full', active || 'hidden')}>{children}</div>
}

interface BookPaneProps {
  tab: BookTab
  onMouseDown: () => void
}

interface ReflowableManager {
  reflowablePageCountCache?: Record<string, number>
  currentReflowableSpread?: ReflowableSpread
  viewSettings?: {
    beforeLayout?: (contents: unknown) => void
  }
}

interface ReflowablePageAddress {
  section?: {
    index: number
  }
  pageIndex: number
}

interface ReflowableSpread {
  left?: ReflowablePageAddress
  right?: ReflowablePageAddress
}

interface ChapterFindResult {
  cfi: string
  excerpt: string
  pageIndex: number
}

interface ChapterFindState {
  open: boolean
  query: string
  sectionIndex?: number
  results: ChapterFindResult[]
  activeIndex: number
  searching: boolean
}

const initialChapterFind: ChapterFindState = {
  open: false,
  query: '',
  results: [],
  activeIndex: 0,
  searching: false,
}

function BookPane({ tab, onMouseDown }: BookPaneProps) {
  const ref = useRef<HTMLDivElement>(null)
  const prevSize = useRef(0)
  const previousTypographyLayoutSignature = useRef<string>()
  const chapterFindInputRef = useRef<HTMLInputElement>(null)
  const ignoreNextFindLocationSync = useRef(false)
  const previousFindLocationKey = useRef<string>()
  const [chapterFind, setChapterFind] =
    useState<ChapterFindState>(initialChapterFind)
  const typography = useTypography(tab)
  const { dark } = useColorScheme()
  const [background] = useBackground()

  const { iframe, iframes, rendition, rendered, container, currentLocation } =
    useSnapshot(tab)
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

  const findScopeSectionIndex = useCallback(() => {
    const manager = rendition?.manager as ReflowableManager | undefined
    const spread = manager?.currentReflowableSpread
    const rightIndex = spread?.right?.section?.index
    const leftIndex = spread?.left?.section?.index

    return rightIndex ?? leftIndex ?? tab.currentSection?.index
  }, [rendition?.manager, tab])

  const focusChapterFindInput = useCallback(() => {
    window.setTimeout(() => {
      chapterFindInputRef.current?.focus()
      chapterFindInputRef.current?.select()
    })
  }, [])

  const openChapterFind = useCallback(() => {
    const sectionIndex = findScopeSectionIndex()

    setChapterFind((state) => ({
      ...state,
      open: true,
      sectionIndex,
      activeIndex: 0,
    }))
    focusChapterFindInput()
  }, [findScopeSectionIndex, focusChapterFindInput])

  const closeChapterFind = useCallback(() => {
    setChapterFind((state) => ({
      ...state,
      open: false,
      results: [],
      activeIndex: 0,
      searching: false,
    }))
  }, [])

  const handleFindShortcut = useCallback(
    (e: KeyboardEvent) => {
      if (!isFindShortcut(e)) return

      e.preventDefault()
      e.stopPropagation()
      e.stopImmediatePropagation?.()
      openChapterFind()
    },
    [openChapterFind],
  )

  useEffect(() => {
    document.addEventListener('keydown', handleFindShortcut, true)

    return () => {
      document.removeEventListener('keydown', handleFindShortcut, true)
    }
  }, [handleFindShortcut])
  useFrameEvent(frameWindows, 'keydown', handleFindShortcut, { capture: true })

  const handleReturnMouseButton = useCallback(
    (e: MouseEvent) => {
      if (e.button !== 3) return
      if (reader.focusedBookTab !== tab) return
      if (!tab.locationToReturn) return
      if (isEditableTarget(e.target) || hasKeyboardCapturingLayer(e.target)) {
        return
      }

      e.preventDefault()
      e.stopPropagation()
      e.stopImmediatePropagation?.()
      tab.returnToPreviousLocation()
    },
    [tab],
  )

  useEffect(() => {
    document.addEventListener('mousedown', handleReturnMouseButton, true)
    document.addEventListener('auxclick', handleReturnMouseButton, true)

    return () => {
      document.removeEventListener('mousedown', handleReturnMouseButton, true)
      document.removeEventListener('auxclick', handleReturnMouseButton, true)
    }
  }, [handleReturnMouseButton])
  useFrameEvent(frameWindows, 'mousedown', handleReturnMouseButton, {
    capture: true,
  })
  useFrameEvent(frameWindows, 'auxclick', handleReturnMouseButton, {
    capture: true,
  })

  const applyCustomStyle = useCallback(
    (contents?: any) => {
      if (contents) {
        updateCustomStyle(contents, typography, tab.bodyTextCache)
        return
      }

      rendition
        ?.getContents()
        .forEach((contents: any) =>
          updateCustomStyle(contents, typography, tab.bodyTextCache),
        )
    },
    [rendition, tab.bodyTextCache, typography],
  )

  useEffect(() => {
    const manager = rendition?.manager as ReflowableManager | undefined
    if (!manager) {
      tab.onBeforeLayout = applyCustomStyle
      return
    }

    tab.onBeforeLayout = applyCustomStyle
    manager.viewSettings ??= {}
    manager.viewSettings.beforeLayout = (contents) => {
      tab.onBeforeLayout?.(contents)
    }
  }, [applyCustomStyle, rendition, tab])

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
    const manager = rendition?.manager as ReflowableManager | undefined
    if (!rendition || !manager) return

    manager.reflowablePageCountCache = {}
    manager.currentReflowableSpread = undefined

    const signature = [
      typography.fontFamily,
      typography.fontSize,
      typography.fontWeight,
      typography.lineHeight,
      typography.textAlign,
      typography.textIndent,
    ].join('|')

    if (previousTypographyLayoutSignature.current === undefined) {
      previousTypographyLayoutSignature.current = signature
      return
    }

    if (previousTypographyLayoutSignature.current === signature) return
    previousTypographyLayoutSignature.current = signature

    const target = tab.location?.start.cfi ?? tab.book.cfi
    if (target) {
      void rendition.display(target)
    }
  }, [
    rendition,
    tab,
    typography.fontFamily,
    typography.fontSize,
    typography.fontWeight,
    typography.lineHeight,
    typography.textAlign,
    typography.textIndent,
  ])

  const findOpen = chapterFind.open
  const findQuery = chapterFind.query
  const findSectionIndex = chapterFind.sectionIndex

  useEffect(() => {
    let cancelled = false
    const query = findQuery.trim()

    if (!findOpen || !query || findSectionIndex === undefined) {
      setChapterFind((state) => ({
        ...state,
        results: [],
        activeIndex: 0,
        searching: false,
      }))
      return
    }

    const sectionIndex = findSectionIndex
    const section = tab.sections?.find((s) => s.index === sectionIndex)
    if (!section) return

    setChapterFind((state) => ({ ...state, searching: true }))

    async function searchSection() {
      const matches = (
        section!.find(query) as Array<{
          cfi?: string
          excerpt?: string
        }>
      ).filter((match) => !!match.cfi)

      const results: ChapterFindResult[] = []
      for (const match of matches) {
        if (cancelled) return
        results.push({
          cfi: match.cfi!,
          excerpt: match.excerpt ?? '',
          pageIndex: await tab.pageIndexForCfi(sectionIndex, match.cfi!),
        })
      }

      if (cancelled) return

      const visibleIndex = firstVisibleFindResultIndex(
        results,
        sectionIndex,
        rendition?.manager as ReflowableManager | undefined,
      )

      setChapterFind((state) => ({
        ...state,
        results,
        activeIndex: visibleIndex > -1 ? visibleIndex : 0,
        searching: false,
      }))
    }

    void searchSection()

    return () => {
      cancelled = true
    }
  }, [findOpen, findQuery, findSectionIndex, rendition?.manager, tab])

  useEffect(() => {
    if (
      !chapterFind.open ||
      !chapterFind.results.length ||
      chapterFind.sectionIndex === undefined
    ) {
      return
    }

    const locationKey = findLocationKey(currentLocation)
    if (locationKey === previousFindLocationKey.current) return
    previousFindLocationKey.current = locationKey

    if (ignoreNextFindLocationSync.current) {
      ignoreNextFindLocationSync.current = false
      return
    }

    const visibleIndex = firstVisibleFindResultIndex(
      chapterFind.results,
      chapterFind.sectionIndex,
      rendition?.manager as ReflowableManager | undefined,
    )
    if (visibleIndex < 0) return

    setChapterFind((state) =>
      state.activeIndex === visibleIndex
        ? state
        : {
            ...state,
            activeIndex: visibleIndex,
          },
    )
  }, [
    chapterFind.open,
    chapterFind.results,
    chapterFind.sectionIndex,
    currentLocation,
    rendition?.manager,
  ])

  const goToFindResult = useCallback(
    (index: number) => {
      if (
        chapterFind.sectionIndex === undefined ||
        !chapterFind.results.length
      ) {
        return
      }

      const nextIndex = clamp(index, 0, chapterFind.results.length - 1)
      const result = chapterFind.results[nextIndex]
      if (!result) return

      setChapterFind((state) => ({
        ...state,
        activeIndex: nextIndex,
      }))

      if (
        !isFindResultVisible(
          result,
          chapterFind.sectionIndex,
          rendition?.manager as ReflowableManager | undefined,
        )
      ) {
        ignoreNextFindLocationSync.current = true
        void tab
          .displayReflowableTarget(chapterFind.sectionIndex, result.cfi)
          .finally(() => {
            window.setTimeout(() => {
              ignoreNextFindLocationSync.current = false
            })
          })
      }
    },
    [chapterFind.results, chapterFind.sectionIndex, rendition?.manager, tab],
  )

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
  useFrameEvent(frameWindows, 'contextmenu', preventContextMenu)

  const handleRenditionWheel = useCallback(
    (e: WheelEvent) => {
      e.preventDefault()
      revealScrollbars()

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
        <ChapterFindHighlights find={chapterFind} tab={tab} />
        {chapterFind.open && (
          <ChapterFindBar
            find={chapterFind}
            inputRef={chapterFindInputRef}
            onChange={(query) =>
              setChapterFind((state) => ({
                ...state,
                query,
                activeIndex: 0,
              }))
            }
            onClose={closeChapterFind}
            onNext={() => goToFindResult(chapterFind.activeIndex + 1)}
            onPrevious={() => goToFindResult(chapterFind.activeIndex - 1)}
          />
        )}
      </div>
      <ReaderPaneFooter tab={tab} />
    </div>
  )
}

interface ChapterFindBarProps {
  find: ChapterFindState
  inputRef: React.RefObject<HTMLInputElement>
  onChange: (query: string) => void
  onClose: () => void
  onNext: () => void
  onPrevious: () => void
}
const ChapterFindBar: React.FC<ChapterFindBarProps> = ({
  find,
  inputRef,
  onChange,
  onClose,
  onNext,
  onPrevious,
}) => {
  const count = find.results.length
  const current = count ? find.activeIndex + 1 : 0
  const disabled = !count || find.searching

  return (
    <div
      data-flow-keyboard-capture="true"
      className="bg-default absolute top-4 right-4 z-30 flex items-center gap-2 rounded-lg px-3 py-2 text-on-surface-variant shadow-lg"
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <input
        ref={inputRef}
        className="w-40 bg-transparent px-1 py-0.5 text-on-surface outline-none typescale-body-medium"
        value={find.query}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') {
            e.preventDefault()
            e.shiftKey ? onPrevious() : onNext()
          }
          if (e.key === 'Escape') {
            e.preventDefault()
            onClose()
          }
        }}
      />
      <div className="min-w-[3.5rem] text-center text-outline typescale-body-small">
        {find.searching ? '...' : `${current}/${count}`}
      </div>
      <button
        className="p-1 text-outline hover:text-on-surface disabled:opacity-40"
        disabled={disabled || find.activeIndex <= 0}
        onClick={onPrevious}
      >
        <MdKeyboardArrowUp size={22} />
      </button>
      <button
        className="p-1 text-outline hover:text-on-surface disabled:opacity-40"
        disabled={disabled || find.activeIndex >= count - 1}
        onClick={onNext}
      >
        <MdKeyboardArrowDown size={22} />
      </button>
      <button
        className="p-1 text-outline hover:text-on-surface"
        onClick={onClose}
      >
        <MdClose size={22} />
      </button>
    </div>
  )
}

interface ChapterFindHighlightsProps {
  find: ChapterFindState
  tab: BookTab
}
const ChapterFindHighlights: React.FC<ChapterFindHighlightsProps> = ({
  find,
  tab,
}) => {
  const { rendition } = useSnapshot(tab)
  const active = find.open ? find.results[find.activeIndex] : undefined

  useEffect(() => {
    if (!active?.cfi) return

    try {
      rendition?.annotations.highlight(
        active.cfi,
        undefined,
        () => {
          setClickedAnnotation(true)
        },
        undefined,
        {
          fill: 'rgba(59, 130, 246, 0.38)',
          'fill-opacity': 'unset',
        },
      )
    } catch (error) {
      // ignore matched text in unsupported nodes
    }

    return () => {
      try {
        rendition?.annotations.remove(active.cfi, 'highlight')
      } catch (error) {
        // ignore removed views
      }
    }
  }, [active?.cfi, rendition?.annotations])

  return null
}

function isFindShortcut(e: KeyboardEvent) {
  return (
    (e.ctrlKey || e.metaKey) &&
    !e.altKey &&
    (e.key.toLowerCase() === 'f' || e.code === 'KeyF')
  )
}

function visibleFindPageIndexes(
  sectionIndex: number,
  manager: ReflowableManager | undefined,
) {
  const spread = manager?.currentReflowableSpread
  const pages = new Set<number>()

  if (spread?.left?.section?.index === sectionIndex) {
    pages.add(spread.left.pageIndex)
  }
  if (spread?.right?.section?.index === sectionIndex) {
    pages.add(spread.right.pageIndex)
  }

  return pages
}

function firstVisibleFindResultIndex(
  results: ChapterFindResult[],
  sectionIndex: number,
  manager: ReflowableManager | undefined,
) {
  const pages = visibleFindPageIndexes(sectionIndex, manager)
  if (!pages.size) return -1

  return results.findIndex((result) => pages.has(result.pageIndex))
}

function isFindResultVisible(
  result: ChapterFindResult,
  sectionIndex: number,
  manager: ReflowableManager | undefined,
) {
  return visibleFindPageIndexes(sectionIndex, manager).has(result.pageIndex)
}

function findLocationKey(location: unknown) {
  const loc = location as
    | {
        start?: {
          href?: string
          displayed?: {
            page?: number
            total?: number
            slot?: string
          }
        }
        end?: {
          href?: string
          displayed?: {
            page?: number
            total?: number
            slot?: string
          }
        }
      }
    | undefined

  return [
    loc?.start?.href,
    loc?.start?.displayed?.page,
    loc?.start?.displayed?.total,
    loc?.start?.displayed?.slot,
    loc?.end?.href,
    loc?.end?.displayed?.page,
    loc?.end?.displayed?.total,
    loc?.end?.displayed?.slot,
  ].join('|')
}

const NOTE_POPOVER_CLASS = notePopoverClass
const NOTE_POPOVER_MARGIN = 18
const NOTE_POPOVER_PADDING = 10
const NOTE_POPOVER_MAX_RATIO = 3.6
const NOTE_POPOVER_MIN_WIDTH = 180
const NOTE_CONTAINER_PATTERN =
  /(?:footnote|endnote|noteref|note|annotation|comment|reference|fn|ftn)/i
const NOTE_CIRCLED_MARKER_PATTERN = /^[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳]$/
const NOTE_NUMBER_MARKER_PATTERN = /^[0-9一二三四五六七八九十]+$/
const NOTE_MARKER_OPENERS = '([〔［（【'
const NOTE_MARKER_CLOSERS = ')]〕］）】'

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

  return findNoteElement(target, anchor)
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

function findNoteElement(el: HTMLElement, anchor: HTMLAnchorElement) {
  const segmentedNote = createSegmentedNoteElement(el, anchor)
  if (segmentedNote) return segmentedNote

  let cur: HTMLElement | null = el
  let fallback: HTMLElement | undefined

  while (cur && cur !== cur.ownerDocument.body) {
    if (isNoteContainer(cur)) {
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

function createSegmentedNoteElement(
  target: HTMLElement,
  anchor: HTMLAnchorElement,
) {
  const container = findNoteContainer(target)
  const marker = target.closest('a[href]') as HTMLAnchorElement | null
  if (!container || !marker || !isBacklink(marker, anchor)) return

  const markerChild = getDirectChild(container, marker)
  if (!markerChild || !hasMultipleNoteMarkers(container)) return

  const doc = target.ownerDocument
  const wrapper = doc.createElement('div')

  wrapper.className = container.className
  if (container.id) wrapper.dataset.noteContainerId = container.id

  let node: ChildNode | null = markerChild
  while (node) {
    if (node !== markerChild && startsWithNoteMarker(node)) break

    wrapper.appendChild(node.cloneNode(true))
    node = node.nextSibling
  }

  return wrapper.childNodes.length ? wrapper : undefined
}

function getDirectChild(parent: HTMLElement, child: HTMLElement) {
  let cur: HTMLElement = child

  while (cur.parentElement && cur.parentElement !== parent) {
    cur = cur.parentElement
  }

  return cur.parentElement === parent ? cur : undefined
}

function hasMultipleNoteMarkers(container: HTMLElement) {
  return (
    Array.from(container.childNodes).filter(startsWithNoteMarker).length > 1
  )
}

function startsWithNoteMarker(node: ChildNode) {
  if (!isElementNode(node)) return false
  const el = node as HTMLElement

  if (isNoteMarkerAnchor(el)) return true

  const firstElement = Array.from(el.childNodes).find(
    (child) =>
      isElementNode(child) || (child.textContent?.trim()?.length ?? 0) > 0,
  )

  return (
    isElementNode(firstElement) &&
    isNoteMarkerAnchor(firstElement as HTMLElement)
  )
}

function isNoteMarkerAnchor(el: HTMLElement) {
  return (
    el.tagName === 'A' &&
    el.hasAttribute('href') &&
    isNoteMarkerText(el.textContent)
  )
}

function isElementNode(node: ChildNode | undefined) {
  return (
    node?.nodeType === 1 && typeof (node as HTMLElement).tagName === 'string'
  )
}

function findNoteContainer(el: HTMLElement) {
  let cur: HTMLElement | null = el

  while (cur && cur !== cur.ownerDocument.body) {
    if (isNoteContainer(cur)) return cur
    cur = cur.parentElement
  }
}

function isNoteContainer(el: HTMLElement) {
  return el.tagName === 'ASIDE' || NOTE_CONTAINER_PATTERN.test(getNoteAttrs(el))
}

function getNoteAttrs(el: HTMLElement) {
  return [
    el.id,
    el.className,
    el.getAttribute('epub:type'),
    el.getAttribute('type'),
    el.getAttribute('role'),
  ].join(' ')
}

function isNoteMarkerText(text: string | null | undefined) {
  const marker = (text ?? '').trim()
  if (!marker) return false
  if (/^[*＊]+$/.test(marker)) return true
  if (NOTE_CIRCLED_MARKER_PATTERN.test(marker)) return true

  const normalized = stripNoteMarkerWrapper(marker)
  return NOTE_NUMBER_MARKER_PATTERN.test(normalized)
}

function stripNoteMarkerWrapper(text: string) {
  let marker = text.trim()

  if (NOTE_MARKER_OPENERS.includes(marker[0] ?? '')) {
    marker = marker.slice(1)
  }
  if (NOTE_MARKER_CLOSERS.includes(marker[marker.length - 1] ?? '')) {
    marker = marker.slice(0, -1)
  }

  return marker.trim()
}

function cloneNoteElement(el: HTMLElement, anchor: HTMLAnchorElement) {
  const clone = cloneNoteElementWithContext(el)

  clone.querySelectorAll('script, style').forEach((node) => node.remove())
  clone.querySelectorAll('a[href]').forEach((node) => {
    if (isBacklink(node as HTMLAnchorElement, anchor)) {
      unwrapBacklink(node as HTMLAnchorElement)
    }
  })
  normalizeNotePopoverContent(clone)

  return clone
}

function normalizeNotePopoverContent(root: HTMLElement) {
  const listNodes = [
    ...(root.matches('ol, ul, li') ? [root] : []),
    ...Array.from(root.querySelectorAll<HTMLElement>('ol, ul, li')),
  ]
  const blockNodes = [
    ...(root.matches('p, ol, ul, li, blockquote') ? [root] : []),
    ...Array.from(
      root.querySelectorAll<HTMLElement>('p, ol, ul, li, blockquote'),
    ),
  ]
  const textNodes = [
    ...(root.matches('p, li, blockquote, div') ? [root] : []),
    ...Array.from(root.querySelectorAll<HTMLElement>('p, li, blockquote, div')),
  ]

  listNodes.forEach((node) => {
    node.style.setProperty('list-style', 'none', 'important')
    node.style.setProperty('list-style-type', 'none', 'important')
  })
  listNodes
    .filter((node) => node.tagName === 'OL' || node.tagName === 'UL')
    .forEach((node) => {
      node.style.setProperty('padding', '0', 'important')
      node.style.setProperty('padding-left', '0', 'important')
    })
  blockNodes.forEach((node) => {
    node.style.setProperty('margin', '0', 'important')
  })
  textNodes.forEach((node) => {
    node.style.setProperty('text-align', 'justify', 'important')
  })
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
    padding: `${NOTE_POPOVER_PADDING}px`,
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
    textAlign: 'justify',
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
  const noteContainer = findNoteContainer(target)
  const item = target.closest('li')
  const attrs = [
    href,
    id,
    getNoteAttrs(anchor),
    getNoteAttrs(target),
    noteContainer && getNoteAttrs(noteContainer),
  ].join(' ')

  if (NOTE_CONTAINER_PATTERN.test(attrs)) return true
  if (
    (anchor.closest('sup') || anchor.querySelector('sup')) &&
    (noteContainer ||
      target.closest('aside') ||
      item?.parentElement?.tagName === 'OL')
  ) {
    return true
  }
  if (isNoteMarkerText(anchor.textContent) && noteContainer) {
    return true
  }
  if (target.closest('aside')) return true

  return item?.parentElement?.tagName === 'OL'
}

interface ReaderPaneHeaderProps {
  tab: BookTab
}
const ReaderPaneHeader: React.FC<ReaderPaneHeaderProps> = ({ tab }) => {
  const { location, section } = useSnapshot(tab)
  void location
  void section

  const navPath = tab.getHeaderPath()

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
  const { locationsToReturn, location, book, rendition } = useSnapshot(tab)
  const locationToReturn = locationsToReturn[locationsToReturn.length - 1]
  const divisor = rendition?.manager?.layout?.divisor ?? 1
  const spread = divisor > 1
  const percentage = `${((book.percentage ?? 0) * 100).toFixed(2)}%`
  const startDisplayed = location?.start.displayed
  const endDisplayed = location?.end.displayed
  const singleVisiblePageOnRight =
    spread && !!startDisplayed && startDisplayed.slot === 'right'
  const hasTwoVisiblePages =
    !!location &&
    (location.start.href !== location.end.href ||
      location.start.displayed.page !== location.end.displayed.page)

  return (
    <>
      {locationToReturn ? (
        <Bar>
          <div className="flex min-w-0 items-center gap-2">
            <button
              className={returnActionClass}
              onClick={() => {
                tab.returnToFirstLocation()
              }}
            >
              Return to start
            </button>
            <button
              className={clsx(returnActionClass, 'truncate')}
              onClick={() => {
                tab.returnToPreviousLocation()
              }}
            >
              Return to {locationToReturn.end.cfi}
            </button>
          </div>
          <button
            className={returnActionClass}
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
            {!singleVisiblePageOnRight &&
              startDisplayed &&
              formatFooterPage(
                startDisplayed,
                hasTwoVisiblePages ? '' : percentage,
              )}
          </div>
          <div>
            {singleVisiblePageOnRight
              ? formatFooterPage(startDisplayed, percentage)
              : hasTwoVisiblePages &&
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

const returnActionClass =
  'rounded px-1 hover:bg-outline/10 hover:text-on-surface'

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
