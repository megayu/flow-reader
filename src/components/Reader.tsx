import { useEventListener } from '@literal-ui/hooks'
import clsx from 'clsx'
import dynamic from 'next/dynamic'
import React, {
  ComponentProps,
  useCallback,
  useEffect,
  useLayoutEffect,
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
import { useRecoilValue, useSetRecoilState, type SetterOrUpdater } from 'recoil'
import useTilg from 'tilg'
import { useSnapshot } from 'valtio'

import { RenditionSpread } from '@flow/epubjs/types/rendition'
import {
  navbarState,
  settingsDialogOpenState,
  useSettingsReady,
  viewModeState,
  zenModeState,
  zenTypographyOverridesState,
  type TypographyConfiguration,
  type ViewMode,
} from '@flow/reader/state'

import { getBookDisplayTitle, getBookTooltip } from '../book'
import { db } from '../db'
import { handleFiles } from '../file'
import {
  hasSelection,
  type Action as ReaderPanelAction,
  useBackground,
  useAction,
  useColorScheme,
  useMobile,
  useTranslation,
  useTypography,
} from '../hooks'
import { BookTab, reader, useReaderSnapshot } from '../models'
import { isTouchScreen } from '../platform'
import { revealScrollbars } from '../scrollbar'
import {
  createTypographyLayoutSignature,
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
type ZenTypographyOverridesSetter = SetterOrUpdater<
  Record<string, TypographyConfiguration>
>
type ReaderPanelActionSetter = SetterOrUpdater<ReaderPanelAction | undefined>
type SettingsOpenSetter = SetterOrUpdater<boolean>

interface ReaderShortcutContext {
  action?: ReaderPanelAction
  setAction: ReaderPanelActionSetter
  setViewMode: SetterOrUpdater<ViewMode>
  setSettingsOpen: SettingsOpenSetter
}

function handleKeyDown(
  tab: BookTab | undefined,
  viewMode: ViewMode,
  enterReaderMode: () => void,
  zenMode: boolean,
  setZenMode: (value: boolean) => void,
  setZenTypographyOverrides: ZenTypographyOverridesSetter,
  shortcuts: ReaderShortcutContext,
) {
  return (e: KeyboardEvent) => {
    try {
      if (e.key === 'Escape') {
        if (zenMode) {
          e.preventDefault()
          e.stopPropagation()
          e.stopImmediatePropagation?.()
          setZenMode(false)
          return
        }

        void exitFullscreenIfActive()
      }

      if (handleZenEnterShortcut(e, tab, viewMode, setZenMode)) return
      if (zenMode) {
        handleZenShortcut(e, tab, viewMode, setZenTypographyOverrides)
        return
      }

      if (handleCommandShortcut(e, viewMode, enterReaderMode, shortcuts)) return
      if (handleAppShortcut(e, tab, viewMode, setZenMode, shortcuts)) return
      if (viewMode === 'library') return
      if (handleReturnShortcut(e, tab)) return
      if (handleChapterShortcut(e, tab)) return
      handlePageTurnShortcut(e, tab)
    } catch (error) {
      // ignore `rendition is undefined` error
    }
  }
}

async function exitFullscreenIfActive() {
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    const win = getCurrentWindow()

    if (await win.isFullscreen()) {
      await win.setFullscreen(false)
    }
  } catch {
    // Not running in Tauri.
  }
}

async function toggleFullscreenIfAvailable() {
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    const win = getCurrentWindow()
    await win.setFullscreen(!(await win.isFullscreen()))
  } catch {
    // Not running in Tauri.
  }
}

async function toggleDevtools() {
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('toggle_devtools')
  } catch {
    // Not running in Tauri.
  }
}

function isSettingsShortcut(e: KeyboardEvent) {
  return !e.shiftKey && (e.key === ',' || e.code === 'Comma')
}

function isDevtoolsShortcut(e: KeyboardEvent) {
  return (
    e.shiftKey &&
    !e.altKey &&
    (e.code === 'KeyI' || e.key.toLowerCase() === 'i')
  )
}

function handleCommandShortcut(
  e: KeyboardEvent,
  viewMode: ViewMode,
  enterReaderMode: () => void,
  shortcuts: ReaderShortcutContext,
) {
  if (!hasCommandModifier(e) || e.altKey) return false

  if (isSettingsShortcut(e)) {
    e.preventDefault()
    e.stopPropagation()
    e.stopImmediatePropagation?.()

    if (!hasKeyboardCapturingLayer(e.target)) {
      shortcuts.setSettingsOpen(true)
    }
    return true
  }

  if (isDevtoolsShortcut(e)) {
    e.preventDefault()
    e.stopPropagation()
    e.stopImmediatePropagation?.()

    void toggleDevtools()
    return true
  }

  if (e.key.toLowerCase() === 'w') {
    e.preventDefault()
    e.stopPropagation()
    e.stopImmediatePropagation?.()

    if (!isReaderShortcutTargetBlocked(e)) {
      if (e.shiftKey) {
        reader.closeAllTabs()
      } else {
        reader.closeFocusedTab()
      }
    }
    return true
  }

  if (handleTabSwitchShortcut(e, enterReaderMode)) return true

  return handleFontSizeShortcut(e, viewMode)
}

function handleAppShortcut(
  e: KeyboardEvent,
  tab: BookTab | undefined,
  viewMode: ViewMode,
  setZenMode: (value: boolean) => void,
  shortcuts: ReaderShortcutContext,
) {
  if (shouldIgnoreReaderShortcut(e)) return false

  const key = e.key.toLowerCase()

  if (key === 'f') {
    e.preventDefault()
    e.stopPropagation()
    e.stopImmediatePropagation?.()
    void toggleFullscreenIfAvailable()
    return true
  }

  if (key === 'l') {
    e.preventDefault()
    e.stopPropagation()
    e.stopImmediatePropagation?.()
    if (viewMode === 'library') {
      if (tab) shortcuts.setViewMode('reader')
    } else {
      shortcuts.setViewMode('library')
    }
    return true
  }

  if (viewMode === 'library' || !tab) return false

  if (key === 'z') {
    e.preventDefault()
    e.stopPropagation()
    e.stopImmediatePropagation?.()
    setZenMode(true)
    return true
  }

  const panel = getPanelShortcutAction(e)
  if (!panel) return false

  e.preventDefault()
  e.stopPropagation()
  e.stopImmediatePropagation?.()
  shortcuts.setAction(shortcuts.action === panel ? undefined : panel)
  return true
}

function getPanelShortcutAction(
  e: KeyboardEvent,
): ReaderPanelAction | undefined {
  const key = e.key.toLowerCase()
  if (key === 't') return 'toc'
  if (e.key === '/') return 'search'
  if (key === 'a') return 'annotation'
  if (key === 'i') return 'image'
  if (key === 'p') return 'typography'
}

function handleFontSizeShortcut(e: KeyboardEvent, viewMode: ViewMode) {
  if (!hasCommandModifier(e) || e.altKey) return false

  const fontSizeReset = isFontSizeResetShortcut(e)
  const fontSizeDelta = getFontSizeShortcutDelta(e)
  if (!fontSizeReset && !fontSizeDelta) return false

  e.preventDefault()
  e.stopPropagation()
  e.stopImmediatePropagation?.()

  if (viewMode === 'library') return true

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

function handleZenEnterShortcut(
  e: KeyboardEvent,
  tab: BookTab | undefined,
  viewMode: ViewMode,
  setZenMode: (value: boolean) => void,
) {
  if (viewMode === 'library' || !tab) return false
  if (e.key.toLowerCase() !== 'z') return false
  if (shouldIgnoreReaderShortcut(e)) return false

  e.preventDefault()
  e.stopPropagation()
  e.stopImmediatePropagation?.()
  setZenMode(true)
  return true
}

function handleZenShortcut(
  e: KeyboardEvent,
  tab: BookTab | undefined,
  viewMode: ViewMode,
  setZenTypographyOverrides: ZenTypographyOverridesSetter,
) {
  if (handleZenFontSizeShortcut(e, tab, viewMode, setZenTypographyOverrides)) {
    return true
  }
  if (handleChapterShortcut(e, tab)) return true
  if (!e.ctrlKey && !e.metaKey && !e.altKey) {
    if (handlePageTurnShortcut(e, tab)) return true
  }

  if (hasCommandModifier(e) && !isReaderShortcutTargetBlocked(e)) {
    e.preventDefault()
    e.stopPropagation()
    e.stopImmediatePropagation?.()
    return true
  }

  return false
}

function handleZenFontSizeShortcut(
  e: KeyboardEvent,
  tab: BookTab | undefined,
  viewMode: ViewMode,
  setZenTypographyOverrides: ZenTypographyOverridesSetter,
) {
  if (!hasCommandModifier(e) || e.altKey) return false

  const fontSizeReset = isFontSizeResetShortcut(e)
  const fontSizeDelta = getFontSizeShortcutDelta(e)
  if (!fontSizeReset && !fontSizeDelta) return false

  e.preventDefault()
  e.stopPropagation()
  e.stopImmediatePropagation?.()

  if (viewMode === 'library' || !tab || isReaderShortcutTargetBlocked(e)) {
    return true
  }

  if (fontSizeReset) {
    clearZenBookFontSize(tab, setZenTypographyOverrides)
  } else {
    updateZenBookFontSize(tab, fontSizeDelta, setZenTypographyOverrides)
  }
  return true
}

function handleTabSwitchShortcut(
  e: KeyboardEvent,
  enterReaderMode: () => void,
) {
  if (e.shiftKey) return false

  const index = getCommandTabIndex(e)
  const direction = getCommandTabDirection(e)
  if (index === undefined && direction === 0) return false

  e.preventDefault()
  e.stopPropagation()
  e.stopImmediatePropagation?.()

  if (!isReaderShortcutTargetBlocked(e)) {
    const group = reader.focusedGroup
    const hasTarget =
      index === 8
        ? !!group?.tabs.length
        : index !== undefined
        ? !!group?.tabs[index]
        : !!group?.tabs.length
    if (!hasTarget) return true

    if (index === 8) {
      reader.selectLastFocusedTab()
    } else if (index !== undefined) {
      reader.selectFocusedTab(index)
    } else if (direction) {
      reader.selectAdjacentFocusedTab(direction)
    }
    enterReaderMode()
  }
  return true
}

function getCommandTabIndex(e: KeyboardEvent) {
  const match = /^(?:Digit|Numpad)([1-9])$/.exec(e.code)
  if (match) return Number(match[1]) - 1

  if (/^[1-9]$/.test(e.key)) return Number(e.key) - 1
}

function getCommandTabDirection(e: KeyboardEvent): -1 | 0 | 1 {
  if (e.code === 'ArrowLeft') return -1
  if (e.code === 'ArrowRight') return 1
  return 0
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

function updateZenBookFontSize(
  tab: BookTab,
  delta: number,
  setZenTypographyOverrides: ZenTypographyOverridesSetter,
) {
  setZenTypographyOverrides((overrides) => {
    const bookId = tab.book.id
    const typography = overrides[bookId] ?? {}
    const fontSize =
      parseFontSize(typography.fontSize) ??
      parseFontSize(tab.book.configuration?.typography?.fontSize) ??
      getCurrentBodyFontSize(tab) ??
      FONT_SIZE_DEFAULT
    const next = clamp(fontSize + delta, FONT_SIZE_MIN, FONT_SIZE_MAX)

    return {
      ...overrides,
      [bookId]: {
        ...typography,
        fontSize: `${next}px`,
      },
    }
  })
}

function clearZenBookFontSize(
  tab: BookTab,
  setZenTypographyOverrides: ZenTypographyOverridesSetter,
) {
  setZenTypographyOverrides((overrides) => {
    const bookId = tab.book.id
    const typography = {
      ...overrides[bookId],
    }

    delete typography.fontSize

    if (!Object.keys(typography).length) {
      const next = { ...overrides }
      delete next[bookId]
      return next
    }

    return {
      ...overrides,
      [bookId]: typography,
    }
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

function handlePageTurnShortcut(e: KeyboardEvent, tab?: BookTab) {
  if (!tab) return false

  switch (e.code) {
    case 'ArrowLeft':
    case 'ArrowUp':
      tab.prev()
      return true
    case 'ArrowRight':
    case 'ArrowDown':
      tab.next()
      return true
    case 'Space':
      e.shiftKey ? tab.prev() : tab.next()
      return true
    default:
      return false
  }
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

interface ReaderGridViewProps {
  content?: React.ReactNode
}

export function ReaderGridView({ content }: ReaderGridViewProps) {
  const { groups } = useReaderSnapshot()
  const [action, setAction] = useAction()
  const setViewMode = useSetRecoilState(viewModeState)
  const viewMode = useRecoilValue(viewModeState)
  const zenMode = useRecoilValue(zenModeState)
  const setZenMode = useSetRecoilState(zenModeState)
  const setSettingsOpen = useSetRecoilState(settingsDialogOpenState)
  const setZenTypographyOverrides = useSetRecoilState(
    zenTypographyOverridesState,
  )
  const enterReaderMode = useCallback(
    () => setViewMode('reader'),
    [setViewMode],
  )

  useEventListener(
    'keydown',
    handleKeyDown(
      reader.focusedBookTab,
      viewMode,
      enterReaderMode,
      zenMode,
      setZenMode,
      setZenTypographyOverrides,
      {
        action,
        setAction,
        setViewMode,
        setSettingsOpen,
      },
    ),
  )
  useEventListener('contextmenu', preventContextMenu)

  if (!groups.length) return null
  const preferredIndex = reader.focusedIndex > -1 ? reader.focusedIndex : 0
  const index = groups[preferredIndex] ? preferredIndex : 0
  const group = groups[index]
  if (!group) return null

  return (
    <div className="ReaderGridView relative flex h-full min-h-0">
      <ReaderGroup
        key={group.id}
        index={index}
        content={content}
        onEnterReaderMode={enterReaderMode}
      />
    </div>
  )
}

interface ReaderGroupProps {
  index: number
  content?: React.ReactNode
  onEnterReaderMode: () => void
}
function ReaderGroup({ index, content, onEnterReaderMode }: ReaderGroupProps) {
  const group = reader.groups[index]!
  const { tabs, selectedIndex } = useSnapshot(group)
  const t = useTranslation()
  const [backgroundClassName] = useBackground()
  const zenMode = useRecoilValue(zenModeState)
  const tabWheelDelta = useRef(0)
  const lastTabWheelSwitch = useRef(0)

  const handleMouseDown = useCallback(() => {
    reader.selectGroup(index)
  }, [index])

  const handleTabWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault()
      e.stopPropagation()

      const delta =
        Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX
      if (!delta) return

      tabWheelDelta.current += delta

      const now = Date.now()
      if (now - lastTabWheelSwitch.current < 180) return
      if (Math.abs(tabWheelDelta.current) < 30) return

      reader.selectGroup(index)
      group.selectAdjacentTab(tabWheelDelta.current > 0 ? 1 : -1, true)
      onEnterReaderMode()
      tabWheelDelta.current = 0
      lastTabWheelSwitch.current = now
    },
    [group, index, onEnterReaderMode],
  )

  return (
    <div
      className="ReaderGroup flex h-full min-h-0 flex-1 flex-col overflow-hidden focus:outline-none"
      onMouseDown={handleMouseDown}
    >
      <Tab.List
        className={clsx('hidden sm:flex', zenMode && '!hidden')}
        onWheel={handleTabWheel}
      >
        {tabs.map((tab, i) => {
          const selected = i === selectedIndex
          const focused = selected
          const label = getReaderTabLabel(tab, t)
          return (
            <Tab
              key={tab.id}
              selected={selected}
              focused={focused}
              title={getReaderTabTooltip(tab, t)}
              onClick={() => {
                group.selectTab(i)
                onEnterReaderMode()
              }}
              onDelete={() => reader.removeTab(i, index)}
              Icon={tab instanceof BookTab ? RiBookLine : MdWebAsset}
            >
              {label}
            </Tab>
          )
        })}
      </Tab.List>

      <div className="relative min-h-0 flex-1">
        <DropZone
          className={clsx(
            'h-full min-h-0',
            content && 'pointer-events-none opacity-0',
          )}
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
                (await db.books.get(text))
              if (tabParam) tabs.push(tabParam)
            }

            if (tabs.length) {
              tabs.forEach((t) => reader.addTab(t, index))
              onEnterReaderMode()
            }
          }}
        >
          {group.tabs.map((tab, i) => (
            <PaneContainer active={i === selectedIndex} key={tab.id}>
              {tab instanceof BookTab ? (
                <BookPane
                  active={i === selectedIndex}
                  tab={tab}
                  onMouseDown={handleMouseDown}
                />
              ) : (
                <tab.Component />
              )}
            </PaneContainer>
          ))}
        </DropZone>
        {content && (
          <div
            className={clsx(
              'absolute inset-0 z-10 min-h-0 overflow-hidden',
              backgroundClassName,
            )}
          >
            {content}
          </div>
        )}
      </div>
    </div>
  )
}

function getReaderTabLabel(
  tab: BookTab | { title: string },
  t: (key: string) => string,
) {
  return tab instanceof BookTab
    ? getBookDisplayTitle(tab.book)
    : t(`${tab.title}.title`)
}

function getReaderTabTooltip(
  tab: BookTab | { title: string },
  t: (key: string) => string,
) {
  return tab instanceof BookTab
    ? getBookTooltip(tab.book)
    : getReaderTabLabel(tab, t)
}

interface PaneContainerProps {
  active: boolean
  children?: React.ReactNode
}
const PaneContainer: React.FC<PaneContainerProps> = ({ active, children }) => {
  return <div className={clsx('h-full', active || 'hidden')}>{children}</div>
}

interface BookPaneProps {
  active: boolean
  tab: BookTab
  onMouseDown: () => void
}

interface ReflowableManager {
  reflowablePageCountCache?: Record<string, number>
  currentReflowableSpread?: ReflowableSpread
  viewSettings?: {
    beforeLayout?: (contents: unknown) => void
    layoutStyleSignature?: string
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

interface RectLike {
  left: number
  top: number
  width: number
  height: number
}

interface NotePopoverState {
  anchorRect: RectLike
  pageRect: RectLike
  content: HTMLElement
}

const initialChapterFind: ChapterFindState = {
  open: false,
  query: '',
  results: [],
  activeIndex: 0,
  searching: false,
}

interface BookRenditionLifecycleOptions {
  active: boolean
  settingsReady: boolean
  tab: BookTab
  rendition: any
  currentSpread: RenditionSpread
  typographyLayoutSignature: string
  applyCustomStyle: (contents?: any) => void
  containerRef: React.RefObject<HTMLDivElement>
}

function useBookRenditionLifecycle({
  active,
  settingsReady,
  tab,
  rendition,
  currentSpread,
  typographyLayoutSignature,
  applyCustomStyle,
  containerRef,
}: BookRenditionLifecycleOptions) {
  const prevSize = useRef(0)
  const previousSpread = useRef<string>()
  const previousTypographyLayoutSignature = useRef<string>()
  const applyCustomStyleRef = useRef(applyCustomStyle)
  const currentSpreadRef = useRef(currentSpread)

  applyCustomStyleRef.current = applyCustomStyle
  currentSpreadRef.current = currentSpread

  const renderIfReady = useCallback(() => {
    if (!active || !settingsReady || rendition) return

    const el = containerRef.current
    if (!el || el.getBoundingClientRect().width === 0) return

    const beforeLayout = applyCustomStyleRef.current
    if (!beforeLayout) return

    previousTypographyLayoutSignature.current = typographyLayoutSignature
    tab.render(
      el,
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
  ])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const observer = new ResizeObserver(([entry]) => {
      const size = entry?.contentRect.width ?? 0
      // `display: hidden` will lead `rect` to 0
      if (size !== 0 && size !== prevSize.current) {
        requestAnimationFrame(() => {
          if (!rendition) {
            renderIfReady()
            return
          }

          reader.resize()
        })
      }
      prevSize.current = size
    })

    observer.observe(el)

    return () => {
      observer.disconnect()
    }
  }, [containerRef, rendition, renderIfReady])

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
    /**
     * when `spread` changes, we should call `spread()` to re-layout,
     * then call {@link updateCustomStyle} to update custom style
     * according to the latest layout
     */
    if (!rendition) return

    if (previousSpread.current === undefined) {
      previousSpread.current = currentSpread
      return
    }
    if (previousSpread.current === currentSpread) return

    previousSpread.current = currentSpread
    rendition.spread(currentSpread)
  }, [currentSpread, rendition])

  useEffect(() => {
    if (!rendition) return
    tab.setBeforeLayout(applyCustomStyle, typographyLayoutSignature)

    if (previousTypographyLayoutSignature.current === typographyLayoutSignature)
      return
    previousTypographyLayoutSignature.current = typographyLayoutSignature

    tab.resetLayoutPageState()

    const target = tab.location?.start.cfi ?? tab.book.cfi
    if (target) {
      void rendition.display(target)
    }
  }, [applyCustomStyle, rendition, tab, typographyLayoutSignature])
}

function BookPane({ active, tab, onMouseDown }: BookPaneProps) {
  const ref = useRef<HTMLDivElement>(null)
  const chapterFindInputRef = useRef<HTMLInputElement>(null)
  const previousFindLocationKey = useRef<string>()
  const [chapterFind, setChapterFind] =
    useState<ChapterFindState>(initialChapterFind)
  const [notePopover, setNotePopover] = useState<NotePopoverState>()
  const typography = useTypography(tab)
  const currentSpread = typography.spread ?? RenditionSpread.Auto
  const typographyLayoutSignature = useMemo(
    () => createTypographyLayoutSignature(typography),
    [typography],
  )
  const settingsReady = useSettingsReady()
  const { dark } = useColorScheme()
  const [background] = useBackground()

  const { iframe, iframes, rendition, rendered, container, currentLocation } =
    useSnapshot(tab)
  const frameWindows = useMemo(
    () => (iframes.length ? [...iframes] : iframe ? [iframe] : []),
    [iframe, iframes],
  )

  useTilg()

  const setNavbar = useSetRecoilState(navbarState)
  const viewMode = useRecoilValue(viewModeState)
  const setViewMode = useSetRecoilState(viewModeState)
  const zenMode = useRecoilValue(zenModeState)
  const setZenMode = useSetRecoilState(zenModeState)
  const setZenTypographyOverrides = useSetRecoilState(
    zenTypographyOverridesState,
  )
  const enterReaderMode = useCallback(
    () => setViewMode('reader'),
    [setViewMode],
  )
  const mobile = useMobile()
  const [action, setAction] = useAction()
  const setSettingsOpen = useSetRecoilState(settingsDialogOpenState)

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

    setNotePopover(undefined)
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
      if (zenMode) return
      openChapterFind()
    },
    [openChapterFind, zenMode],
  )

  useEffect(() => {
    document.addEventListener('keydown', handleFindShortcut, true)

    return () => {
      document.removeEventListener('keydown', handleFindShortcut, true)
    }
  }, [handleFindShortcut])
  useFrameEvent(frameWindows, 'keydown', handleFindShortcut, { capture: true })

  useEffect(() => {
    if (!zenMode) return

    closeChapterFind()
    setNotePopover(undefined)
    if (tab.annotationRange) tab.annotationRange = undefined
    if (tab.annotationCfi) tab.annotationCfi = undefined
  }, [closeChapterFind, tab, zenMode])

  const handleReturnMouseButton = useCallback(
    (e: MouseEvent) => {
      if (zenMode) return
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
    [tab, zenMode],
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

  useBookRenditionLifecycle({
    active,
    settingsReady,
    tab,
    rendition,
    currentSpread,
    typographyLayoutSignature,
    applyCustomStyle,
    containerRef: ref,
  })

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

    const manager = rendition?.manager as ReflowableManager | undefined
    setChapterFind((state) => {
      const visibleIndex = nearestVisibleFindResultIndex(
        state.results,
        state.sectionIndex,
        manager,
        state.activeIndex,
      )
      if (visibleIndex < 0 || state.activeIndex === visibleIndex) return state

      return {
        ...state,
        activeIndex: visibleIndex,
      }
    })
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
        void tab.displayReflowableTarget(chapterFind.sectionIndex, result.cfi)
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
    if (zenMode) setSrc(undefined)
  }, [zenMode])

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
        if (zenMode) {
          setNotePopover(undefined)
          return
        }

        const anchor = getAnchorFromEvent(e)
        if (!anchor) {
          setNotePopover(undefined)
          return
        }

        const noteElement = getLinkedNote(tab, anchor)
        if (!noteElement) return

        e.preventDefault()
        e.stopPropagation()
        e.stopImmediatePropagation()

        const popover = createNotePopoverState(
          anchor,
          noteElement,
          ref.current,
          rendition,
        )
        if (!popover) return

        closeChapterFind()
        setNotePopover(popover)
      }

      const handleKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Escape') setNotePopover(undefined)
      }

      doc.addEventListener('click', handleClick, true)
      doc.addEventListener('keydown', handleKeyDown, true)

      return () => {
        doc.removeEventListener('click', handleClick, true)
        doc.removeEventListener('keydown', handleKeyDown, true)
        setNotePopover(undefined)
      }
    })

    return () => {
      cleanups.forEach((cleanup) => cleanup())
    }
  }, [closeChapterFind, frameWindows, rendition, tab, zenMode])

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
          !zenMode &&
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
    [container, mobile, setNavbar, tab, zenMode],
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

  const handleFrameKeyDown = useMemo(
    () =>
      handleKeyDown(
        tab,
        viewMode,
        enterReaderMode,
        zenMode,
        setZenMode,
        setZenTypographyOverrides,
        {
          action,
          setAction,
          setViewMode,
          setSettingsOpen,
        },
      ),
    [
      action,
      enterReaderMode,
      setAction,
      setZenMode,
      setZenTypographyOverrides,
      setSettingsOpen,
      setViewMode,
      tab,
      viewMode,
      zenMode,
    ],
  )
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
        visible={!zenMode && !!src}
        onClose={() => setSrc(undefined)}
        maskOpacity={0.6}
        bannerVisible={false}
      />
      {!zenMode && <ReaderPaneHeader tab={tab} />}
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
        {!zenMode && <TextSelectionMenu tab={tab} />}
        <Annotations tab={tab} />
        {!zenMode && (
          <NotePopover
            popover={notePopover}
            onClose={() => setNotePopover(undefined)}
          />
        )}
        {!zenMode && <ChapterFindHighlights find={chapterFind} tab={tab} />}
        {!zenMode && chapterFind.open && (
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
      className="bg-default absolute -top-12 right-4 z-30 flex items-center gap-2 rounded-lg px-3 py-2 text-on-surface-variant shadow-lg"
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

interface NotePopoverProps {
  popover?: NotePopoverState
  onClose: () => void
}

const NotePopover: React.FC<NotePopoverProps> = ({ popover, onClose }) => {
  const popoverRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })

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
    }

    updateSize()
    popoverRef.current?.focus()

    const observer = new ResizeObserver(updateSize)
    if (popoverRef.current) observer.observe(popoverRef.current)

    return () => {
      observer.disconnect()
    }
  }, [popover])

  if (!popover) return null

  const maxWidth = Math.max(
    NOTE_POPOVER_MIN_WIDTH,
    popover.pageRect.width - NOTE_POPOVER_MARGIN * 2,
  )
  const placement = getNoteOverlayPlacement(
    popover.anchorRect,
    popover.pageRect,
    {
      width: size.width || maxWidth,
      height: size.height,
    },
  )

  return (
    <div
      data-flow-keyboard-capture="true"
      ref={popoverRef}
      className={clsx(NOTE_POPOVER_CLASS, 'focus:outline-none')}
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
        background: '#fff',
        boxShadow: '0 10px 26px rgba(0, 0, 0, 0.18)',
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
          textAlign: 'justify',
        }}
      />
      <div
        style={{
          position: 'absolute',
          left: placement.arrowLeft,
          top: placement.placeAbove ? undefined : -6,
          bottom: placement.placeAbove ? -6 : undefined,
          width: 12,
          height: 12,
          background: '#fff',
          transform: 'rotate(45deg)',
        }}
      />
    </div>
  )
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

function nearestVisibleFindResultIndex(
  results: ChapterFindResult[],
  sectionIndex: number | undefined,
  manager: ReflowableManager | undefined,
  activeIndex: number,
) {
  if (sectionIndex === undefined) return -1

  const pages = visibleFindPageIndexes(sectionIndex, manager)
  if (!pages.size) return -1

  let nearestIndex = -1
  let nearestDistance = Number.POSITIVE_INFINITY
  results.forEach((result, index) => {
    if (!pages.has(result.pageIndex)) return

    const distance = Math.abs(index - activeIndex)
    if (distance >= nearestDistance) return

    nearestIndex = index
    nearestDistance = distance
  })

  return nearestIndex
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
const NOTE_POPOVER_MIN_WIDTH = 180
const NOTE_POPOVER_ARROW_EDGE_OFFSET = 24
const NOTE_INLINE_STYLE_EXCLUDE_PATTERN =
  /^(?:position|inset|left|right|top|bottom|z-index|transform|translate|scale|rotate|width|height|min-width|max-width|min-height|max-height|overflow|overflow-x|overflow-y|column-|break-|page-break-)/
const NOTE_CONTAINER_PATTERN =
  /(?:footnote|endnote|noteref|note|annotation|comment|reference|fn|ftn)/i
const NOTE_CIRCLED_MARKER_PATTERN = /^[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳]$/
const NOTE_NUMBER_MARKER_PATTERN = /^[0-9一二三四五六七八九十]+$/
const NOTE_MARKER_OPENERS = '([〔［（【'
const NOTE_MARKER_CLOSERS = ')]〕］）】'

function createNotePopoverState(
  anchor: HTMLAnchorElement,
  noteElement: HTMLElement,
  container: HTMLElement | null,
  rendition: unknown,
): NotePopoverState | undefined {
  const win = anchor.ownerDocument.defaultView
  const frame = win?.frameElement
  if (!win || !(frame instanceof HTMLElement) || !container) return

  const containerRect = container.getBoundingClientRect()
  const frameRect = frame.getBoundingClientRect()
  const anchorRect = anchor.getBoundingClientRect()
  const anchorRectInContainer = rectFromDomRect({
    left: frameRect.left + anchorRect.left - containerRect.left,
    top: frameRect.top + anchorRect.top - containerRect.top,
    width: anchorRect.width,
    height: anchorRect.height,
  })
  const visibleRect = intersectRects(
    {
      left: frameRect.left - containerRect.left,
      top: frameRect.top - containerRect.top,
      width: frameRect.width,
      height: frameRect.height,
    },
    {
      left: 0,
      top: 0,
      width: containerRect.width,
      height: containerRect.height,
    },
  )

  if (!visibleRect) return

  return {
    anchorRect: anchorRectInContainer,
    pageRect: getVisiblePageRect(
      visibleRect,
      anchorRectInContainer,
      getRenditionDivisor(rendition),
    ),
    content: cloneNoteElement(noteElement, anchor),
  }
}

function getRenditionDivisor(rendition: unknown) {
  const divisor = (rendition as any)?.manager?.layout?.divisor
  return Number.isFinite(divisor) && divisor > 1 ? Math.floor(divisor) : 1
}

function getVisiblePageRect(
  visibleRect: RectLike,
  anchorRect: RectLike,
  divisor: number,
) {
  if (divisor < 2) return visibleRect

  const pageWidth = visibleRect.width / divisor
  const anchorCenter = anchorRect.left + anchorRect.width / 2
  const pageIndex = clamp(
    Math.floor((anchorCenter - visibleRect.left) / pageWidth),
    0,
    divisor - 1,
  )

  return {
    left: visibleRect.left + pageIndex * pageWidth,
    top: visibleRect.top,
    width: pageWidth,
    height: visibleRect.height,
  }
}

function getNoteOverlayPlacement(
  anchorRect: RectLike,
  pageRect: RectLike,
  size: { width: number; height: number },
) {
  const margin = NOTE_POPOVER_MARGIN
  const gap = 10
  const pageRight = pageRect.left + pageRect.width
  const pageBottom = pageRect.top + pageRect.height
  const anchorCenter = anchorRect.left + anchorRect.width / 2
  const minLeft = pageRect.left + margin
  const maxLeft = pageRight - size.width - margin
  const left = getNotePopoverLeft(anchorCenter, size.width, minLeft, maxLeft)
  const roomAbove = anchorRect.top - pageRect.top - margin - gap
  const roomBelow =
    pageBottom - (anchorRect.top + anchorRect.height) - margin - gap
  const placeAbove = roomAbove >= size.height || roomAbove >= roomBelow
  const topAbove = anchorRect.top - size.height - gap
  const topBelow = anchorRect.top + anchorRect.height + gap
  const top = placeAbove
    ? clamp(topAbove, pageRect.top + margin, pageBottom - size.height - margin)
    : clamp(topBelow, pageRect.top + margin, pageBottom - size.height - margin)

  return {
    left,
    top,
    placeAbove,
    arrowLeft: clamp(anchorCenter - left - 6, 18, size.width - 18),
  }
}

function rectFromDomRect(rect: RectLike): RectLike {
  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
  }
}

function intersectRects(a: RectLike, b: RectLike): RectLike | undefined {
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
  let root = cloneElementWithInlineStyles(el)

  ancestors.forEach((ancestor) => {
    const wrapper = ancestor.cloneNode(false) as HTMLElement
    copyComputedStyles(ancestor, wrapper)
    wrapper.style.setProperty('display', 'contents', 'important')
    wrapper.appendChild(root)
    root = wrapper
  })

  return root
}

function cloneElementWithInlineStyles(el: HTMLElement) {
  const clone = el.cloneNode(true) as HTMLElement
  copyComputedStyleTree(el, clone)

  return clone
}

function copyComputedStyleTree(source: HTMLElement, target: HTMLElement) {
  copyComputedStyles(source, target)
  copyResolvedResourceAttributes(source, target)

  const sourceElements = Array.from(source.querySelectorAll<HTMLElement>('*'))
  const targetElements = Array.from(target.querySelectorAll<HTMLElement>('*'))

  sourceElements.forEach((sourceElement, index) => {
    const targetElement = targetElements[index]
    if (!targetElement) return

    copyComputedStyles(sourceElement, targetElement)
    copyResolvedResourceAttributes(sourceElement, targetElement)
  })
}

function copyComputedStyles(source: HTMLElement, target: HTMLElement) {
  const win = source.ownerDocument.defaultView
  if (!win) return

  const style = win.getComputedStyle(source)
  for (let i = 0; i < style.length; i++) {
    const property = style[i]
    if (!property || NOTE_INLINE_STYLE_EXCLUDE_PATTERN.test(property)) continue

    const value = style.getPropertyValue(property)
    if (!value) continue
    if (property === 'display' && value === 'none') continue
    if (property === 'visibility' && value === 'hidden') continue

    target.style.setProperty(
      property,
      value,
      style.getPropertyPriority(property),
    )
  }
}

function copyResolvedResourceAttributes(
  source: HTMLElement,
  target: HTMLElement,
) {
  if (source.tagName === 'IMG' && target.tagName === 'IMG') {
    target.setAttribute('src', (source as HTMLImageElement).src)
  }
  if (source.tagName === 'A' && target.tagName === 'A') {
    target.setAttribute('href', (source as HTMLAnchorElement).href)
  }
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

function getNotePopoverLeft(
  anchorCenter: number,
  width: number,
  minLeft: number,
  maxLeft: number,
) {
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
  if (max < min) return min
  return Math.min(Math.max(value, min), max)
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
  const t = useTranslation('reader')
  const locationToReturn = locationsToReturn[locationsToReturn.length - 1]
  const divisor = rendition?.manager?.layout?.divisor ?? 1
  const spread = divisor > 1
  const percentage =
    typeof book.percentage === 'number'
      ? `${(book.percentage * 100).toFixed(2)}%`
      : ''
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
              title={t('return_to_start')}
              onClick={() => {
                tab.returnToFirstLocation()
              }}
            >
              {t('return_to_start')}
            </button>
            <button
              className={clsx(returnActionClass, 'truncate')}
              title={`${t('return_to_previous')}: ${locationToReturn.end.cfi}`}
              onClick={() => {
                tab.returnToPreviousLocation()
              }}
            >
              {t('return_to_previous')}
            </button>
          </div>
          <button
            className={returnActionClass}
            title={t('dismiss_return')}
            onClick={() => {
              tab.hidePrevLocation()
            }}
          >
            {t('dismiss_return')}
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
