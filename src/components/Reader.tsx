import clsx from 'clsx'
import {
  BookOpenIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  ChevronsDownIcon,
  ChevronsUpIcon,
  MinusIcon,
  PanelTopIcon,
  PlusIcon,
  RotateCcwIcon,
  RotateCwIcon,
  RefreshCwIcon,
  XIcon,
} from 'lucide-react'
import React, {
  ComponentProps,
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { useSnapshot } from 'valtio'

import { RenditionSpread } from '@flow/epubjs/types/rendition'
import {
  useSetSettingsDialogOpen,
  useSetViewMode,
  useSetZenMode,
  useSetZenTypographyOverrides,
  useSettingsReady,
  useViewModeValue,
  useZenModeValue,
  type SetterOrUpdater,
  type TypographyConfiguration,
  type ViewMode,
} from '@flow/reader/state'

import { getBookDisplayTitle, getBookTooltip } from '../book'
import { db, type BookRecord } from '../db'
import { isDevtoolsShortcutEnabled, toggleDevtools } from '../devtools'
import { handleFiles } from '../file'
import { useBackground } from '../hooks/theme/useBackground'
import { useColorScheme } from '../hooks/theme/useColorScheme'
import { useAction, type Action as ReaderPanelAction } from '../hooks/useAction'
import { useEventListener } from '../hooks/useEventListener'
import { useTranslation } from '../hooks/useTranslation'
import { useTypography } from '../hooks/useTypography'
import {
  hasKeyboardCaptureLayer,
  isEditableKeyboardTarget,
  isGlobalKeyboardShortcutBlocked,
} from '../keyboard'
import {
  BookTab,
  reader,
  useReaderSnapshot,
  type ISection,
} from '../models/reader'
import { findSectionByLinkedHref, safeDecodeHref, sameHref } from '../noteLinks'
import { revealScrollbars } from '../scrollbar'
import { getShortcutChords } from '../shortcuts'
import {
  createTypographyLayoutSignature,
  createTypographyStyleSignature,
  getBodyTypographyBaseline,
  notePopoverClass,
  updateCustomStyle,
} from '../styles'

import { setClickedAnnotation, Annotations } from './Annotation'
import { BookTooltipContent } from './BookTooltipContent'
import { ShortcutChord } from './ShortcutChord'
import { Tab } from './Tab'
import { TextSelectionMenu } from './TextSelectionMenu'
import { DropZone, useDndContext } from './base/DropZone'
import { Settings } from './pages/settings'

const FONT_SIZE_MIN = 14
const FONT_SIZE_MAX = 28
const FONT_SIZE_DEFAULT = 16
const IMAGE_PREVIEW_ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 5]
const IMAGE_PREVIEW_MIN_STEP = IMAGE_PREVIEW_ZOOM_STEPS[0] ?? 0.5
const IMAGE_PREVIEW_MAX_STEP =
  IMAGE_PREVIEW_ZOOM_STEPS[IMAGE_PREVIEW_ZOOM_STEPS.length - 1] ?? 5
const IMAGE_PREVIEW_SIDE_PADDING = 64
const IMAGE_PREVIEW_VERTICAL_PADDING = 192
const IMAGE_PREVIEW_WHEEL_THRESHOLD = 6
const pageComponents = [Settings]
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

  if (isDevtoolsShortcutEnabled() && isDevtoolsShortcut(e)) {
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
  if (e.ctrlKey || e.metaKey || e.altKey) return false
  if (isReaderShortcutTargetBlocked(e)) return false

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
  return (
    isGlobalKeyboardShortcutBlocked(e) || hasKeyboardCapturingLayer(e.target)
  )
}

function isEditableTarget(target: EventTarget | null) {
  return isEditableKeyboardTarget(target)
}

function hasKeyboardCapturingLayer(target: EventTarget | null) {
  return hasKeyboardCaptureLayer(target, [
    `.${NOTE_POPOVER_CLASS}`,
    '[role="dialog"]',
    '[role="menu"]',
  ])
}

function useFrameEvent<K extends keyof WindowEventMap>(
  frames: readonly Window[],
  type: K,
  listener: (event: WindowEventMap[K]) => void,
  options?: AddEventListenerOptions,
) {
  const listenerRef = useRef(listener)

  useEffect(() => {
    listenerRef.current = listener
  }, [listener])

  useEffect(() => {
    if (!frames.length) return

    const handler = (event: WindowEventMap[K]) => {
      listenerRef.current(event)
    }

    frames.forEach((frame) => {
      frame.addEventListener(type, handler, options)
    })

    return () => {
      frames.forEach((frame) => {
        frame.removeEventListener(type, handler, options)
      })
    }
  }, [frames, options, type])
}

function preventContextMenu(e: Event) {
  e.preventDefault()
}

function getSelectedText(windows: readonly Window[]) {
  for (const win of windows) {
    try {
      const selection = win.getSelection()
      const text = selection?.toString().replace(/\s+/g, ' ').trim()
      if (
        text &&
        !selection?.isCollapsed &&
        selection?.anchorNode?.isConnected
      ) {
        return text
      }
    } catch (error) {
      // The iframe may have been detached while handling a shortcut.
    }
  }
  return ''
}

interface ReaderGridViewProps {
  content?: React.ReactNode
}

export function ReaderGridView({ content }: ReaderGridViewProps) {
  const { groups } = useReaderSnapshot()
  const [action, setAction] = useAction()
  const setViewMode = useSetViewMode()
  const viewMode = useViewModeValue()
  const zenMode = useZenModeValue()
  const setZenMode = useSetZenMode()
  const setSettingsOpen = useSetSettingsDialogOpen()
  const setZenTypographyOverrides = useSetZenTypographyOverrides()
  const enterReaderMode = useCallback(() => {
    if (viewMode !== 'reader') setViewMode('reader')
  }, [setViewMode, viewMode])

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
  const [backgroundClassName] = useBackground()
  const zenMode = useZenModeValue()
  const tabWheelDelta = useRef(0)
  const [hoveredTabIndex, setHoveredTabIndex] = useState<number | undefined>()

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

      if (Math.abs(tabWheelDelta.current) < 30) return

      reader.selectGroup(index)
      group.selectAdjacentTab(tabWheelDelta.current > 0 ? 1 : -1, true)
      onEnterReaderMode()
      tabWheelDelta.current = 0
    },
    [group, index, onEnterReaderMode],
  )

  return (
    <div
      className="ReaderGroup flex h-full min-h-0 flex-1 flex-col overflow-hidden focus:outline-none"
      onMouseDown={handleMouseDown}
    >
      <Tab.List
        className={clsx('flex', zenMode && '!hidden')}
        onWheel={handleTabWheel}
      >
        {tabs.map((tab, i) => {
          const selected = i === selectedIndex
          const focused = selected
          return (
            <ReaderTabItem
              group={group}
              groupIndex={index}
              index={i}
              key={tab.id}
              focused={focused}
              selected={selected}
              showSeparator={
                !selected &&
                i + 1 < tabs.length &&
                i + 1 !== selectedIndex &&
                hoveredTabIndex !== i &&
                hoveredTabIndex !== i + 1
              }
              tab={tab}
              onEnterReaderMode={onEnterReaderMode}
              onHoverChange={setHoveredTabIndex}
            />
          )
        })}
      </Tab.List>

      <div className="relative min-h-0 flex-1">
        <DropZone
          className={clsx(
            'h-full min-h-0',
            Boolean(content) && 'pointer-events-none opacity-0',
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
                pageComponents.find((p) => p.displayName === text) ??
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

interface ReaderTabItemProps {
  focused: boolean
  group: {
    selectTab(index: number): void
  }
  groupIndex: number
  index: number
  onEnterReaderMode: () => void
  onHoverChange: React.Dispatch<React.SetStateAction<number | undefined>>
  selected: boolean
  showSeparator: boolean
  tab: BookTab | { id: string; title: string }
}

const ReaderTabItem = React.memo(function ReaderTabItem({
  focused,
  group,
  groupIndex,
  index,
  onEnterReaderMode,
  onHoverChange,
  selected,
  showSeparator,
  tab,
}: ReaderTabItemProps) {
  const t = useTranslation()
  const label = getReaderTabLabel(tab, t)
  const handleMouseEnter = useCallback(() => {
    onHoverChange(index)
  }, [index, onHoverChange])
  const handleMouseLeave = useCallback(() => {
    onHoverChange((current) => (current === index ? undefined : current))
  }, [index, onHoverChange])
  const handleClick = useCallback(() => {
    group.selectTab(index)
    onEnterReaderMode()
  }, [group, index, onEnterReaderMode])
  const handleDelete = useCallback(() => {
    reader.removeTab(index, groupIndex)
  }, [groupIndex, index])

  return (
    <Tab
      selected={selected}
      focused={focused}
      showSeparator={showSeparator}
      title={getReaderTabTooltip(tab, t)}
      tooltipContent={getReaderTabTooltipContent(tab)}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onClick={handleClick}
      onDelete={handleDelete}
      Icon={tab instanceof BookTab ? BookOpenIcon : PanelTopIcon}
    >
      {label}
    </Tab>
  )
})

function getReaderTabTooltip(
  tab: BookTab | { title: string },
  t: (key: string) => string,
) {
  return tab instanceof BookTab
    ? getBookTooltip(tab.book)
    : getReaderTabLabel(tab, t)
}

function getReaderTabTooltipContent(tab: BookTab | { title: string }) {
  if (!(tab instanceof BookTab)) return

  const book = tab.book as unknown as BookRecord
  return <BookTooltipContent book={book} />
}

interface PaneContainerProps {
  active: boolean
  children?: React.ReactNode
}
const PaneContainer: React.FC<PaneContainerProps> = React.memo(
  function PaneContainer({ active, children }) {
    return (
      <div
        aria-hidden={!active}
        data-flow-reader-pane
        className={clsx(
          'absolute inset-0 h-full overflow-hidden',
          active
            ? 'visible z-10 opacity-100'
            : 'pointer-events-none invisible z-0 opacity-0',
        )}
      >
        {children}
      </div>
    )
  },
)

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
  typographyStyleSignature: string
  applyCustomStyle: (contents?: any) => void
  containerRef: React.RefObject<HTMLDivElement | null>
}

function getVisibleLayoutSize(el?: HTMLDivElement | null) {
  if (!el) return

  const rect = el.getBoundingClientRect()
  const width = Math.round(rect.width)
  const height = Math.round(rect.height)
  if (width <= 0 || height <= 0) return

  return { width, height, key: `${width}x${height}` }
}

function useBookRenditionLifecycle({
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

    return () => {
      observer.disconnect()
    }
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

const BookPane: React.FC<BookPaneProps> = React.memo(function BookPane({
  active,
  tab,
  onMouseDown,
}) {
  const ref = useRef<HTMLDivElement>(null)
  const chapterFindInputRef = useRef<HTMLInputElement>(null)
  const previousFindLocationKey = useRef<string | undefined>(undefined)
  const noteRequestId = useRef(0)
  const [chapterFind, setChapterFind] =
    useState<ChapterFindState>(initialChapterFind)
  const [notePopover, setNotePopover] = useState<NotePopoverState>()
  const typography = useTypography(tab)
  const currentSpread = typography.spread ?? RenditionSpread.Auto
  const typographyLayoutSignature = useMemo(
    () => createTypographyLayoutSignature(typography),
    [typography],
  )
  const typographyStyleSignature = useMemo(
    () => createTypographyStyleSignature(typography),
    [typography],
  )
  const settingsReady = useSettingsReady()
  const { dark } = useColorScheme()
  const [background] = useBackground()

  const { iframe, iframes, rendition, rendered, paginationVersion } =
    useSnapshot(tab)
  const frameWindows = useMemo(() => {
    void iframe
    void iframes.length

    return tab.iframes.length
      ? [...tab.iframes]
      : tab.iframe
        ? [tab.iframe]
        : []
  }, [iframe, iframes, tab])
  const activeFrameWindows = useMemo(
    () => (active ? frameWindows : []),
    [active, frameWindows],
  )

  useLayoutEffect(() => {
    return () => {
      tab.setActive(false)
    }
  }, [tab])

  const viewMode = useViewModeValue()
  const setViewMode = useSetViewMode()
  const zenMode = useZenModeValue()
  const setZenMode = useSetZenMode()
  const setZenTypographyOverrides = useSetZenTypographyOverrides()
  const enterReaderMode = useCallback(() => {
    if (viewMode !== 'reader') setViewMode('reader')
  }, [setViewMode, viewMode])
  const [action, setAction] = useAction()
  const setSettingsOpen = useSetSettingsDialogOpen()

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
    const selectedText = getSelectedText(activeFrameWindows)

    setNotePopover(undefined)
    setChapterFind((state) => ({
      ...state,
      open: true,
      query: selectedText || state.query,
      sectionIndex,
      activeIndex: 0,
    }))
    focusChapterFindInput()
  }, [activeFrameWindows, findScopeSectionIndex, focusChapterFindInput])

  const closeChapterFind = useCallback(() => {
    setChapterFind((state) => ({
      ...state,
      open: false,
      results: [],
      activeIndex: 0,
      searching: false,
    }))
  }, [])
  const closeChapterFindEvent = useEffectEvent(closeChapterFind)

  const handleFindShortcut = useCallback(
    (e: KeyboardEvent) => {
      if (!isFindShortcut(e)) return
      if (isReaderShortcutTargetBlocked(e)) return

      e.preventDefault()
      e.stopPropagation()
      e.stopImmediatePropagation?.()
      if (zenMode) return
      openChapterFind()
    },
    [openChapterFind, zenMode],
  )
  const handleFindShortcutEvent = useEffectEvent(handleFindShortcut)

  useEffect(() => {
    if (!active) return

    const onKeyDown = (event: KeyboardEvent) => {
      handleFindShortcutEvent(event)
    }

    document.addEventListener('keydown', onKeyDown, true)

    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [active])
  useFrameEvent(activeFrameWindows, 'keydown', handleFindShortcut, {
    capture: true,
  })

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
  const handleReturnMouseButtonEvent = useEffectEvent(handleReturnMouseButton)

  useEffect(() => {
    if (!active) return

    const onMouseButton = (event: MouseEvent) => {
      handleReturnMouseButtonEvent(event)
    }

    document.addEventListener('mousedown', onMouseButton, true)
    document.addEventListener('auxclick', onMouseButton, true)

    return () => {
      document.removeEventListener('mousedown', onMouseButton, true)
      document.removeEventListener('auxclick', onMouseButton, true)
    }
  }, [active])
  useFrameEvent(activeFrameWindows, 'mousedown', handleReturnMouseButton, {
    capture: true,
  })
  useFrameEvent(activeFrameWindows, 'auxclick', handleReturnMouseButton, {
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
    typographyStyleSignature,
    applyCustomStyle,
    containerRef: ref,
  })

  useEffect(() => {
    if (!active) return

    const updateReaderPageWidth = () => {
      const width = getCurrentReaderPageWidth(rendition, ref.current)
      if (!width) return
      const spreadWidth = getCurrentReaderSpreadWidth(rendition, ref.current)

      document.documentElement.style.setProperty(
        '--flow-reader-page-width',
        `${width}px`,
      )
      if (spreadWidth) {
        document.documentElement.style.setProperty(
          '--flow-reader-spread-width',
          `${spreadWidth}px`,
        )
      }
    }
    const scheduleReaderPageWidthUpdate = () => {
      updateReaderPageWidth()
      requestAnimationFrame(updateReaderPageWidth)
      window.setTimeout(updateReaderPageWidth, 100)
    }

    scheduleReaderPageWidthUpdate()

    const el = ref.current
    if (!el) return

    const observer = new ResizeObserver(scheduleReaderPageWidthUpdate)
    observer.observe(el)
    const mutationObserver = new MutationObserver(scheduleReaderPageWidthUpdate)
    mutationObserver.observe(el, {
      childList: true,
      subtree: true,
    })

    return () => {
      observer.disconnect()
      mutationObserver.disconnect()
    }
  }, [active, paginationVersion, rendered, rendition])

  const findOpen = chapterFind.open
  const findQuery = chapterFind.query
  const findSectionIndex = chapterFind.sectionIndex

  useEffect(() => {
    let cancelled = false
    const query = findQuery.trim()

    if (!active || !findOpen || !query || findSectionIndex === undefined) {
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
    const currentSection = section

    setChapterFind((state) => ({ ...state, searching: true }))

    async function searchSection() {
      const matches = (
        currentSection.find(query) as Array<{
          cfi?: string
          excerpt?: string
        }>
      ).flatMap((match) => (match.cfi ? [match] : []))

      const results = await Promise.all(
        matches.map(async (match): Promise<ChapterFindResult> => {
          const cfi = match.cfi!

          return {
            cfi,
            excerpt: match.excerpt ?? '',
            pageIndex: await tab.pageIndexForCfi(sectionIndex, cfi),
          }
        }),
      )

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
  }, [active, findOpen, findQuery, findSectionIndex, rendition?.manager, tab])

  useEffect(() => {
    if (
      !chapterFind.open ||
      !active ||
      !chapterFind.results.length ||
      chapterFind.sectionIndex === undefined
    ) {
      return
    }

    const locationKey = findLocationKey(tab.paginationSnapshot?.location)
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
    active,
    chapterFind.results,
    chapterFind.sectionIndex,
    paginationVersion,
    rendition?.manager,
    tab,
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

  const imagePreviewOpenKey = useRef(0)
  const [imagePreview, setImagePreview] = useState<{
    key: number
    src: string
  }>()
  const wheelDelta = useRef(0)
  const lastWheelTurn = useRef(0)

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
    (e: DragEvent) => {
      setDragEvent(e as any)
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

    const cleanups = frameWindows.map((win) => {
      const doc = win.document

      const handleClick = (e: MouseEvent) => {
        if (zenMode) {
          noteRequestId.current += 1
          setNotePopover(undefined)
          return
        }

        const anchor = getAnchorFromEvent(e)
        if (!anchor) {
          noteRequestId.current += 1
          setNotePopover(undefined)
          return
        }

        if (!isPotentialNoteLink(anchor)) {
          return
        }

        e.preventDefault()
        e.stopPropagation()
        e.stopImmediatePropagation()
        closeChapterFindEvent()
        setNotePopover(undefined)

        const requestId = (noteRequestId.current += 1)
        let note: LinkedNoteResult | undefined

        void (async () => {
          try {
            note = await getLinkedNote(tab, anchor, ref.current)
            if (!note) {
              return
            }
            if (requestId !== noteRequestId.current) {
              return
            }
            if (!anchor.isConnected) {
              return
            }

            const popover = createNotePopoverState(
              anchor,
              note.element,
              ref.current,
              rendition,
            )
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

      const handleKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Escape') setNotePopover(undefined)
      }

      doc.addEventListener('click', handleClick, true)
      doc.addEventListener('keydown', handleKeyDown, true)

      return () => {
        doc.removeEventListener('click', handleClick, true)
        doc.removeEventListener('keydown', handleKeyDown, true)
        noteRequestId.current += 1
        setNotePopover(undefined)
      }
    })

    return () => {
      cleanups.forEach((cleanup) => cleanup())
    }
  }, [active, frameWindows, rendition, tab, zenMode])

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
        if (!zenMode && el.tagName === 'IMG') {
          const imageSrc = el.currentSrc || el.src
          if (imageSrc) {
            openImagePreview(imageSrc)
            return
          }
          return
        }
        if (!zenMode && el.tagName === 'SOURCE') {
          const image = el.parentElement?.querySelector('img')
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
  useFrameEvent(activeFrameWindows, 'contextmenu', preventContextMenu)

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
  const handleRenditionWheelEvent = useEffectEvent(handleRenditionWheel)

  useEffect(() => {
    if (!active || !rendition) return

    const target = rendition as any
    const onWheel = (event: WheelEvent) => {
      handleRenditionWheelEvent(event)
    }

    target.on('wheel', onWheel)

    return () => {
      target.off?.('wheel', onWheel)
      target.removeListener?.('wheel', onWheel)
    }
  }, [active, rendition])

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
  useFrameEvent(activeFrameWindows, 'keydown', handleFrameKeyDown)

  return (
    <div className="flex h-full flex-col">
      <ReaderImagePreview
        openKey={!zenMode ? imagePreview?.key : undefined}
        src={!zenMode ? imagePreview?.src : undefined}
        onClose={() => setImagePreview(undefined)}
      />
      {!zenMode && <ReaderPaneHeader tab={tab} />}
      {!zenMode && chapterFind.open && active && (
        <ChapterFindOverlay anchorRef={ref}>
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
        </ChapterFindOverlay>
      )}
      <div
        ref={ref}
        data-flow-reader-content
        className="relative h-0 flex-1"
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
        {!zenMode && active && <TextSelectionMenu tab={tab} />}
        <Annotations active={active} tab={tab} />
        {!zenMode && (
          <NotePopover
            popover={notePopover}
            onClose={() => setNotePopover(undefined)}
          />
        )}
        {!zenMode && (
          <ChapterFindHighlights active={active} find={chapterFind} tab={tab} />
        )}
        {!zenMode && active && <ReaderEdgeNavigation tab={tab} />}
      </div>
      <ReaderPaneFooter tab={tab} />
    </div>
  )
})

interface ReaderEdgeNavigationProps {
  tab: BookTab
}

const ReaderEdgeNavigation: React.FC<ReaderEdgeNavigationProps> = ({ tab }) => {
  const t = useTranslation('shortcuts')
  const items = [
    {
      label: t('previous_chapter'),
      Icon: ChevronsUpIcon,
      onClick: () => void tab.prevSection(),
    },
    {
      label: t('previous_page'),
      Icon: ChevronUpIcon,
      onClick: () => void tab.prev(),
    },
    {
      label: t('next_page'),
      Icon: ChevronDownIcon,
      onClick: () => void tab.next(),
    },
    {
      label: t('next_chapter'),
      Icon: ChevronsDownIcon,
      onClick: () => void tab.nextSection(),
    },
  ] as const

  return (
    <div
      data-flow-reader-edge-nav
      className="group absolute top-1/2 right-0 z-30 flex w-6 -translate-y-1/2"
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <div
        data-flow-reader-edge-nav-panel
        className="text-foreground ring-foreground/10 pointer-events-none flex w-full flex-col overflow-hidden rounded-l-lg bg-black/10 opacity-0 shadow-sm ring-1 shadow-black/10 backdrop-blur-md backdrop-saturate-150 ring-inset group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100 dark:bg-white/10"
      >
        {items.map(({ label, Icon, onClick }) => (
          <button
            key={label}
            type="button"
            aria-label={label}
            className="text-muted-foreground hover:text-foreground focus-visible:ring-ring flex h-9 w-full cursor-pointer items-center justify-center border-0 bg-transparent outline-none hover:bg-[var(--flow-bg-control-hover)] focus-visible:ring-2 focus-visible:ring-inset"
            onClick={onClick}
          >
            <Icon className="size-[1.125rem]" />
          </button>
        ))}
      </div>
    </div>
  )
}

interface ReaderImagePreviewProps {
  openKey?: number
  src?: string
  onClose: () => void
}

type ReaderImagePreviewMode = 'fit' | 'zoom'
type ReaderImagePreviewRotation = 0 | 90 | 180 | 270

interface ReaderImagePreviewState {
  mode: ReaderImagePreviewMode
  naturalSize?: {
    width: number
    height: number
  }
  pan: {
    x: number
    y: number
  }
  rotation: ReaderImagePreviewRotation
  scale: number
}

function createReaderImagePreviewState(): ReaderImagePreviewState {
  return {
    mode: 'fit',
    pan: { x: 0, y: 0 },
    rotation: 0,
    scale: 1,
  }
}

const ReaderImagePreview: React.FC<ReaderImagePreviewProps> = ({
  openKey,
  src,
  onClose,
}) => {
  const t = useTranslation('image_preview')
  const previewRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 })
  const [dragging, setDragging] = useState(false)
  const [previewState, setPreviewState] = useState(
    createReaderImagePreviewState,
  )
  const { mode, naturalSize, pan, rotation, scale } = previewState
  const dragState = useRef<
    | {
        pointerId: number
        startPan: { x: number; y: number }
        startX: number
        startY: number
      }
    | undefined
  >(undefined)

  const availableSize = useMemo(
    () => ({
      height: Math.max(1, stageSize.height - IMAGE_PREVIEW_VERTICAL_PADDING),
      width: Math.max(1, stageSize.width - IMAGE_PREVIEW_SIDE_PADDING),
    }),
    [stageSize.height, stageSize.width],
  )

  const rotatedSize = useMemo(() => {
    if (!naturalSize) return undefined
    if (rotation === 90 || rotation === 270) {
      return {
        width: naturalSize.height,
        height: naturalSize.width,
      }
    }
    return naturalSize
  }, [naturalSize, rotation])

  const fitScale = useMemo(() => {
    if (!rotatedSize || !stageSize.width || !stageSize.height) return 1

    return Math.min(
      1,
      availableSize.width / rotatedSize.width,
      availableSize.height / rotatedSize.height,
    )
  }, [
    availableSize.height,
    availableSize.width,
    rotatedSize,
    stageSize.height,
    stageSize.width,
  ])

  const displayScale = mode === 'fit' ? fitScale : scale
  const previewReady =
    !!naturalSize && stageSize.width > 0 && stageSize.height > 0

  const panBounds = useMemo(() => {
    if (!rotatedSize) return { x: 0, y: 0 }

    return {
      x: Math.max(
        0,
        (rotatedSize.width * displayScale - availableSize.width) / 2,
      ),
      y: Math.max(
        0,
        (rotatedSize.height * displayScale - availableSize.height) / 2,
      ),
    }
  }, [availableSize.height, availableSize.width, displayScale, rotatedSize])

  const clampedPan = useMemo(
    () => clampImagePreviewPan(pan, panBounds),
    [pan, panBounds],
  )

  useLayoutEffect(() => {
    if (!src) return

    const stage = stageRef.current
    if (!stage) return

    const updateStageSize = () => {
      const rect = stage.getBoundingClientRect()
      setStageSize({
        width: rect.width,
        height: rect.height,
      })
    }

    updateStageSize()

    const observer = new ResizeObserver(updateStageSize)
    observer.observe(stage)
    window.addEventListener('resize', updateStageSize)

    return () => {
      observer.disconnect()
      window.removeEventListener('resize', updateStageSize)
    }
  }, [openKey, src])

  useLayoutEffect(() => {
    if (!src) return

    setPreviewState(createReaderImagePreviewState())

    requestAnimationFrame(() => {
      previewRef.current?.focus()
    })
  }, [openKey, src])

  const zoomTo = useCallback((nextScale: number) => {
    setPreviewState((current) => ({
      ...current,
      mode: 'zoom',
      pan: { x: 0, y: 0 },
      scale: clamp(nextScale, IMAGE_PREVIEW_MIN_STEP, IMAGE_PREVIEW_MAX_STEP),
    }))
  }, [])

  const zoomIn = useCallback(() => {
    const next = getNextImagePreviewZoomIn(displayScale)
    if (next === undefined) return
    setPreviewState((current) => ({
      ...current,
      mode: 'zoom',
      pan: { x: 0, y: 0 },
      scale: next,
    }))
  }, [displayScale])

  const zoomOut = useCallback(() => {
    const next = getNextImagePreviewZoomOut(displayScale)
    if (next === undefined) return
    setPreviewState((current) => ({
      ...current,
      mode: 'zoom',
      pan: { x: 0, y: 0 },
      scale: next,
    }))
  }, [displayScale])

  const resetToFit = useCallback(() => {
    setPreviewState((current) => ({
      ...current,
      mode: 'fit',
      pan: { x: 0, y: 0 },
    }))
  }, [])

  const rotateImage = useCallback((delta: -90 | 90) => {
    setPreviewState((current) => ({
      ...current,
      pan: { x: 0, y: 0 },
      rotation: normalizeImagePreviewRotation(current.rotation + delta),
    }))
  }, [])

  const handleWheel = useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      event.preventDefault()
      event.stopPropagation()

      const delta =
        Math.abs(event.deltaY) >= Math.abs(event.deltaX)
          ? event.deltaY
          : event.deltaX
      if (Math.abs(delta) < IMAGE_PREVIEW_WHEEL_THRESHOLD) return

      if (delta < 0) zoomIn()
      else zoomOut()
    },
    [zoomIn, zoomOut],
  )

  const canPan = previewReady && (panBounds.x > 0 || panBounds.y > 0)

  const handleImagePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const rect = event.currentTarget.getBoundingClientRect()
      const insideImage =
        event.clientX >= rect.left &&
        event.clientX <= rect.right &&
        event.clientY >= rect.top &&
        event.clientY <= rect.bottom

      if (!insideImage) {
        event.preventDefault()
        event.stopPropagation()
        onClose()
        return
      }

      event.preventDefault()
      event.stopPropagation()

      if (!canPan) return

      event.currentTarget.setPointerCapture(event.pointerId)
      dragState.current = {
        pointerId: event.pointerId,
        startPan: clampedPan,
        startX: event.clientX,
        startY: event.clientY,
      }
      setDragging(true)
    },
    [canPan, clampedPan, onClose],
  )

  const handleImagePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragState.current
      if (!drag || drag.pointerId !== event.pointerId) return

      event.preventDefault()
      event.stopPropagation()

      setPreviewState((current) => ({
        ...current,
        pan: clampImagePreviewPan(
          {
            x: drag.startPan.x + event.clientX - drag.startX,
            y: drag.startPan.y + event.clientY - drag.startY,
          },
          panBounds,
        ),
      }))
    },
    [panBounds],
  )

  const endImageDrag = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (dragState.current?.pointerId !== event.pointerId) return

      event.preventDefault()
      event.stopPropagation()
      dragState.current = undefined
      setDragging(false)
    },
    [],
  )

  const handlePreviewBackdropPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault()
      event.stopPropagation()
      onClose()
    },
    [onClose],
  )

  const handlePreviewKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return

    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onClose()
      return
    }

    if (event.key === '+' || event.key === '=') {
      event.preventDefault()
      event.stopPropagation()
      zoomIn()
      return
    }

    if (event.key === '-') {
      event.preventDefault()
      event.stopPropagation()
      zoomOut()
      return
    }

    if (event.key === '0') {
      event.preventDefault()
      event.stopPropagation()
      resetToFit()
      return
    }

    if (event.key === '1') {
      event.preventDefault()
      event.stopPropagation()
      zoomTo(1)
      return
    }

    if (event.key === '[') {
      event.preventDefault()
      event.stopPropagation()
      rotateImage(-90)
      return
    }

    if (event.key === ']') {
      event.preventDefault()
      event.stopPropagation()
      rotateImage(90)
    }
  })

  useEffect(() => {
    if (!src) return

    const handleKeyDown = (event: KeyboardEvent) => {
      handlePreviewKeyDown(event)
    }

    document.addEventListener('keydown', handleKeyDown, true)

    return () => {
      document.removeEventListener('keydown', handleKeyDown, true)
    }
  }, [src])

  if (!src) return null

  const zoomPercent = `${Math.round(displayScale * 100)}%`
  const canZoomOut =
    getNextImagePreviewZoomOut(displayScale) !== undefined &&
    displayScale > IMAGE_PREVIEW_MIN_STEP
  const canZoomIn =
    getNextImagePreviewZoomIn(displayScale) !== undefined &&
    displayScale < IMAGE_PREVIEW_MAX_STEP
  const isOneToOne = Math.abs(displayScale - 1) < 0.001
  const isFit = mode === 'fit'

  if (typeof document === 'undefined') return null

  return createPortal(
    <div
      ref={previewRef}
      role="dialog"
      aria-modal="true"
      aria-label={t('title')}
      data-flow-keyboard-capture="true"
      tabIndex={-1}
      className="fixed inset-0 z-[9999] overflow-hidden bg-neutral-500/45 text-white backdrop-blur-2xl backdrop-saturate-75 outline-none"
      onWheel={handleWheel}
      onPointerDown={handlePreviewBackdropPointerDown}
      onMouseDown={(event) => {
        event.preventDefault()
        event.stopPropagation()
      }}
      onClick={onClose}
    >
      <div className="pointer-events-none absolute inset-0 bg-white/8" />
      <div
        ref={stageRef}
        className="absolute inset-0 flex items-center justify-center overflow-hidden px-8 py-24"
      >
        <div
          className={clsx(
            'pointer-events-auto touch-none select-none',
            mode === 'zoom' &&
              previewReady &&
              !dragging &&
              'transition-transform duration-100 ease-out',
            previewReady ? 'opacity-100' : 'opacity-0',
            canPan
              ? dragging
                ? 'cursor-grabbing'
                : 'cursor-grab'
              : 'cursor-default',
          )}
          style={{
            width: naturalSize ? naturalSize.width : undefined,
            height: naturalSize ? naturalSize.height : undefined,
            transform: `translate3d(${clampedPan.x}px, ${clampedPan.y}px, 0) rotate(${rotation}deg) scale(${displayScale})`,
          }}
          onPointerDown={handleImagePointerDown}
          onPointerMove={handleImagePointerMove}
          onPointerUp={endImageDrag}
          onPointerCancel={endImageDrag}
          onLostPointerCapture={endImageDrag}
          onClick={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <img
            key={openKey}
            src={src}
            alt=""
            draggable={false}
            className={clsx(
              'max-w-none shadow-2xl shadow-black/35 select-none',
            )}
            style={{
              width: naturalSize ? naturalSize.width : undefined,
              height: naturalSize ? naturalSize.height : undefined,
            }}
            onLoad={(event) => {
              const image = event.currentTarget
              setPreviewState((current) => ({
                ...current,
                naturalSize: {
                  width: image.naturalWidth || image.width,
                  height: image.naturalHeight || image.height,
                },
              }))
            }}
          />
        </div>
      </div>

      <div
        className="absolute bottom-6 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full bg-black/35 px-2 py-1.5 text-white shadow-lg ring-1 ring-white/15 backdrop-blur-md"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <ReaderImagePreviewButton
          label={t('zoom_out')}
          disabled={!canZoomOut}
          onClick={zoomOut}
        >
          <MinusIcon className="size-5" />
        </ReaderImagePreviewButton>
        <div className="min-w-16 px-2 text-center text-sm font-medium tabular-nums">
          {zoomPercent}
        </div>
        <ReaderImagePreviewButton
          label={t('zoom_in')}
          disabled={!canZoomIn}
          onClick={zoomIn}
        >
          <PlusIcon className="size-5" />
        </ReaderImagePreviewButton>
        <div className="mx-1 h-5 w-px bg-white/20" />
        <ReaderImagePreviewButton
          label={t('actual_size')}
          active={isOneToOne && !isFit}
          disabled={isOneToOne && !isFit}
          onClick={() => zoomTo(1)}
        >
          <span className="text-xs font-semibold tracking-normal">1:1</span>
        </ReaderImagePreviewButton>
        <ReaderImagePreviewButton
          label={t('rotate_left')}
          onClick={() => rotateImage(-90)}
        >
          <RotateCcwIcon className="size-[1.125rem]" />
        </ReaderImagePreviewButton>
        <ReaderImagePreviewButton
          label={t('rotate_right')}
          onClick={() => rotateImage(90)}
        >
          <RotateCwIcon className="size-[1.125rem]" />
        </ReaderImagePreviewButton>
        <ReaderImagePreviewButton
          label={t('fit')}
          active={isFit}
          disabled={isFit}
          onClick={resetToFit}
        >
          <RefreshCwIcon className="size-[1.125rem]" />
        </ReaderImagePreviewButton>
        <div className="mx-1 h-5 w-px bg-white/20" />
        <ReaderImagePreviewButton label={t('close')} onClick={onClose}>
          <XIcon className="size-5" />
        </ReaderImagePreviewButton>
      </div>
    </div>,
    document.body,
  )
}

interface ReaderImagePreviewButtonProps extends ComponentProps<'button'> {
  active?: boolean
  label: string
}

function ReaderImagePreviewButton({
  active,
  children,
  className,
  disabled,
  label,
  ...props
}: ReaderImagePreviewButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      className={clsx(
        'flex size-9 items-center justify-center rounded-full border-0 bg-transparent text-white/85 transition-colors outline-none',
        active && 'bg-white/18 text-white',
        disabled
          ? 'cursor-default text-white/35'
          : 'cursor-pointer hover:bg-white/16 hover:text-white focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:ring-offset-0',
        className,
      )}
      {...props}
    >
      {children}
    </button>
  )
}

interface ChapterFindBarProps {
  find: ChapterFindState
  inputRef: React.RefObject<HTMLInputElement | null>
  onChange: (query: string) => void
  onClose: () => void
  onNext: () => void
  onPrevious: () => void
}

interface ChapterFindOverlayProps {
  anchorRef: React.RefObject<HTMLElement | null>
  children: React.ReactNode
}

const ChapterFindOverlay: React.FC<ChapterFindOverlayProps> = ({
  anchorRef,
  children,
}) => {
  const [style, setStyle] = useState<React.CSSProperties>()

  useLayoutEffect(() => {
    const anchor = anchorRef.current
    if (!anchor) return

    let frame = 0
    const update = () => {
      window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(() => {
        const rect = anchor.getBoundingClientRect()

        setStyle({
          position: 'fixed',
          right: Math.max(8, window.innerWidth - rect.right + 8),
          bottom: Math.max(8, window.innerHeight - rect.top + 8),
          zIndex: 50,
        })
      })
    }

    update()

    const observer = new ResizeObserver(update)
    observer.observe(anchor)
    window.addEventListener('resize', update)

    return () => {
      window.cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('resize', update)
    }
  }, [anchorRef])

  if (!style) return null

  return createPortal(<div style={style}>{children}</div>, document.body)
}

const ChapterFindBar: React.FC<ChapterFindBarProps> = ({
  find,
  inputRef,
  onChange,
  onClose,
  onNext,
  onPrevious,
}) => {
  const t = useTranslation('shortcuts')
  const actionT = useTranslation('action')
  const count = find.results.length
  const current = count ? find.activeIndex + 1 : 0
  const disabled = !count || find.searching

  useLayoutEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [inputRef])

  return (
    <div
      data-flow-chapter-find-bar
      data-flow-keyboard-capture="true"
      className="text-muted-foreground bg-background flex items-center gap-2 rounded-lg px-3 py-2 shadow-lg"
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <input
        ref={inputRef}
        aria-label={t('chapter_find')}
        className="text-foreground w-40 bg-transparent px-1 py-0.5 text-base outline-none"
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
      <div className="text-muted-foreground min-w-[3.5rem] text-center text-base">
        {find.searching ? '...' : `${current}/${count}`}
      </div>
      <button
        type="button"
        aria-label={t('previous_find_result')}
        className="text-muted-foreground hover:text-foreground p-1 disabled:opacity-40"
        disabled={disabled || find.activeIndex <= 0}
        onClick={onPrevious}
      >
        <ChevronUpIcon className="size-[22px]" />
      </button>
      <button
        type="button"
        aria-label={t('next_find_result')}
        className="text-muted-foreground hover:text-foreground p-1 disabled:opacity-40"
        disabled={disabled || find.activeIndex >= count - 1}
        onClick={onNext}
      >
        <ChevronDownIcon className="size-[22px]" />
      </button>
      <button
        type="button"
        aria-label={actionT('close')}
        className="text-muted-foreground hover:text-foreground p-1"
        onClick={onClose}
      >
        <XIcon className="size-[22px]" />
      </button>
    </div>
  )
}

interface ChapterFindHighlightsProps {
  active: boolean
  find: ChapterFindState
  tab: BookTab
}
const ChapterFindHighlights: React.FC<ChapterFindHighlightsProps> = ({
  active,
  find,
  tab,
}) => {
  const { rendition, paginationVersion, viewVersion } = useSnapshot(tab)
  const matches = useMemo(() => {
    if (!find.open) return []

    const seen = new Set<string>()
    return find.results.flatMap((result, index) => {
      if (!result.cfi || seen.has(result.cfi)) return []

      seen.add(result.cfi)
      return [
        {
          active: index === find.activeIndex,
          cfi: result.cfi,
        },
      ]
    })
  }, [find.activeIndex, find.open, find.results])

  useEffect(() => {
    if (!active || !matches.length) return

    const addHighlight = (cfi: string, styles: Record<string, string>) => {
      try {
        rendition?.annotations.highlight(
          cfi,
          undefined,
          () => {
            setClickedAnnotation(true)
          },
          undefined,
          styles,
        )
      } catch (error) {
        // ignore matched text in unsupported nodes
      }
    }

    for (const match of matches) {
      if (!match.active) {
        addHighlight(match.cfi, {
          fill: 'rgba(234, 179, 8, 0.3)',
          'fill-opacity': 'unset',
        })
      }
    }
    const activeMatch = matches.find((match) => match.active)
    if (activeMatch) {
      addHighlight(activeMatch.cfi, {
        fill: 'rgba(59, 130, 246, 0.46)',
        'fill-opacity': 'unset',
      })
    }

    return () => {
      matches.forEach((match) => {
        try {
          rendition?.annotations.remove(match.cfi, 'highlight')
        } catch (error) {
          // ignore removed views
        }
      })
    }
  }, [active, matches, paginationVersion, rendition?.annotations, viewVersion])

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
          whiteSpace: 'normal',
          overflowWrap: 'break-word',
          textAlign: 'justify',
          color: 'inherit',
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
          background: 'var(--flow-bg-panel)',
          borderRight: placement.placeAbove
            ? '1px solid var(--flow-border)'
            : undefined,
          borderBottom: placement.placeAbove
            ? '1px solid var(--flow-border)'
            : undefined,
          borderLeft: placement.placeAbove
            ? undefined
            : '1px solid var(--flow-border)',
          borderTop: placement.placeAbove
            ? undefined
            : '1px solid var(--flow-border)',
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
const NOTE_POPOVER_TEXT_STYLE_PROPERTIES = [
  'direction',
  'font-family',
  'font-feature-settings',
  'font-kerning',
  'font-size',
  'font-stretch',
  'font-style',
  'font-synthesis',
  'font-variant',
  'font-variant-caps',
  'font-variant-east-asian',
  'font-variant-ligatures',
  'font-variant-numeric',
  'font-weight',
  'letter-spacing',
  'line-height',
  'text-decoration-color',
  'text-decoration-line',
  'text-decoration-style',
  'text-emphasis-color',
  'text-emphasis-position',
  'text-emphasis-style',
  'text-orientation',
  'text-transform',
  'unicode-bidi',
  'vertical-align',
  'word-spacing',
  'writing-mode',
]
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
    pageRect: getVisiblePageRect(visibleRect, anchorRectInContainer, rendition),
    content: cloneNoteElement(noteElement, anchor),
  }
}

function getVisiblePageRect(
  visibleRect: RectLike,
  anchorRect: RectLike,
  rendition: unknown,
) {
  const pageWidth = getRenditionPageWidth(rendition)
  if (!pageWidth || visibleRect.width <= pageWidth * 1.25) return visibleRect

  const anchorCenter = anchorRect.left + anchorRect.width / 2
  const pageCount = Math.max(1, Math.ceil(visibleRect.width / pageWidth))
  const pageIndex = clamp(
    Math.floor((anchorCenter - visibleRect.left) / pageWidth),
    0,
    pageCount - 1,
  )
  const left = visibleRect.left + pageIndex * pageWidth
  const right = Math.min(visibleRect.left + visibleRect.width, left + pageWidth)

  return {
    left,
    top: visibleRect.top,
    width: right - left,
    height: visibleRect.height,
  }
}

function getRenditionPageWidth(rendition: unknown) {
  const pageWidth = (rendition as any)?.manager?.layout?.pageWidth
  return Number.isFinite(pageWidth) && pageWidth > 0
    ? Number(pageWidth)
    : undefined
}

function getCurrentReaderPageWidth(
  rendition: unknown,
  container?: HTMLElement | null,
) {
  const pageWidth = getRenditionPageWidth(rendition)
  if (pageWidth) return Math.round(pageWidth)

  const rect = container?.getBoundingClientRect()
  if (!rect || rect.width <= 0) return

  const divisor = getRenditionDivisor(rendition)
  return Math.round(rect.width / divisor)
}

function getCurrentReaderSpreadWidth(
  rendition: unknown,
  container?: HTMLElement | null,
) {
  const pageWidth = getRenditionPageWidth(rendition)
  const rect = container?.getBoundingClientRect()
  if (!pageWidth) return rect?.width ? Math.round(rect.width) : undefined

  const divisor = getRenditionDivisor(rendition)
  const spreadWidth = Math.round(pageWidth * divisor)
  if (!rect || rect.width <= 0) return spreadWidth

  return Math.min(Math.round(rect.width), spreadWidth)
}

function getRenditionDivisor(rendition: unknown) {
  const divisor = (rendition as any)?.manager?.layout?.divisor
  return Number.isFinite(divisor) && divisor > 1 ? Number(divisor) : 1
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
  const direct = (e.target as ClosestTarget | null)?.closest?.('a[href]') as
    | HTMLAnchorElement
    | undefined
  if (direct) return direct

  return e
    .composedPath()
    .find(
      (node): node is HTMLAnchorElement =>
        node instanceof HTMLAnchorElement && node.hasAttribute('href'),
    )
}

interface ClosestTarget {
  closest?: (selector: string) => Element | null
}

interface LinkedNoteResult {
  element: HTMLElement
  cleanup?: () => void
}

async function getLinkedNote(
  tab: BookTab,
  anchor: HTMLAnchorElement,
  container: HTMLElement | null,
): Promise<LinkedNoteResult | undefined> {
  const href = anchor.getAttribute('href')
  if (!href || href.startsWith('mailto:') || href.includes('://')) return

  const [path = '', hash = ''] = href.split('#')
  if (!hash) return

  const id = safeDecodeHref(hash)
  const target = await findLinkedElement(tab, anchor, path, id, container)
  if (!target || !isLikelyNoteLink(anchor, target.element, href, id)) {
    target?.cleanup?.()
    return
  }

  const noteElement = findNoteElement(target.element, anchor)
  return noteElement
    ? {
        element: noteElement,
        cleanup: target.cleanup,
      }
    : target
}

async function findLinkedElement(
  tab: BookTab,
  anchor: HTMLAnchorElement,
  path: string,
  id: string,
  container: HTMLElement | null,
): Promise<LinkedNoteResult | undefined> {
  const currentDocument = anchor.ownerDocument

  if (!path) {
    return wrapNoteElement(getElementByIdOrName(currentDocument, id))
  }

  const anchorSection = findRenderedSectionByDocument(tab, currentDocument)
  const baseHref = anchorSection?.href ?? tab.section?.href
  const targetSection = findSectionByLinkedHref(tab.sections, baseHref, path)

  if (targetSection && sameHref(anchorSection?.href, targetSection.href)) {
    const currentElement = getElementByIdOrName(currentDocument, id)
    if (currentElement) return wrapNoteElement(currentElement)
  }

  if (targetSection) {
    const renderedDocument = findRenderedDocumentBySection(tab, targetSection)
    const renderedElement =
      renderedDocument && getElementByIdOrName(renderedDocument, id)
    if (renderedElement) return wrapNoteElement(renderedElement)

    return renderLinkedSectionElement(tab, anchor, targetSection, id, container)
  }

  return wrapNoteElement(getElementByIdOrName(currentDocument, id))
}

function wrapNoteElement(
  element: HTMLElement | undefined,
): LinkedNoteResult | undefined {
  return element ? { element } : undefined
}

function getElementByIdOrName(doc: Document, id: string) {
  return (
    doc.getElementById(id) ??
    ([...doc.querySelectorAll('[name]')].find(
      (el) => el.getAttribute('name') === id,
    ) as HTMLElement | undefined)
  )
}

function findRenderedSectionByDocument(tab: BookTab, doc: Document) {
  const canonical = getDocumentCanonicalHref(doc)

  return tab.sections?.find(
    (section) =>
      sameHref(section.href, canonical) ||
      sameHref(section.canonical, canonical),
  )
}

function findRenderedDocumentBySection(tab: BookTab, section: ISection) {
  const windows = tab.iframes.length
    ? tab.iframes
    : tab.iframe
      ? [tab.iframe]
      : []

  return windows
    .map((win) => win.document)
    .find((doc) => {
      const canonical = getDocumentCanonicalHref(doc)

      return (
        sameHref(section.href, canonical) ||
        sameHref(section.canonical, canonical)
      )
    })
}

function getDocumentCanonicalHref(doc: Document) {
  return (
    doc
      .querySelector<HTMLLinkElement>('link[rel="canonical"]')
      ?.getAttribute('href') ?? undefined
  )
}

async function renderLinkedSectionElement(
  tab: BookTab,
  anchor: HTMLAnchorElement,
  section: ISection,
  id: string,
  container: HTMLElement | null,
): Promise<LinkedNoteResult | undefined> {
  if (!tab.epub || !container) return

  const ownerDocument = container.ownerDocument
  const iframe = ownerDocument.createElement('iframe')
  const sourceFrame = anchor.ownerDocument.defaultView?.frameElement
  const sourceFrameRect =
    sourceFrame instanceof HTMLElement
      ? sourceFrame.getBoundingClientRect()
      : undefined
  iframe.setAttribute('aria-hidden', 'true')
  iframe.setAttribute('sandbox', 'allow-same-origin')
  iframe.tabIndex = -1
  Object.assign(iframe.style, {
    position: 'fixed',
    left: '-10000px',
    top: '-10000px',
    width: `${Math.max(320, Math.ceil(sourceFrameRect?.width ?? 960))}px`,
    height: `${Math.max(320, Math.ceil(sourceFrameRect?.height ?? 960))}px`,
    border: '0',
    opacity: '0',
    pointerEvents: 'none',
  })

  const cleanup = () => iframe.remove()

  try {
    const output = stripScriptsFromNoteSectionHtml(
      await renderFreshLinkedSectionDocument(tab, section, id),
    )
    const loaded = new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(resolve, 1500)

      iframe.addEventListener(
        'load',
        () => {
          window.clearTimeout(timer)
          resolve()
        },
        { once: true },
      )
      iframe.addEventListener(
        'error',
        () => {
          window.clearTimeout(timer)
          reject(new Error(`Failed to render note section: ${section.href}`))
        },
        { once: true },
      )
    })

    iframe.srcdoc = output
    container.appendChild(iframe)
    await loaded

    const doc = iframe.contentDocument
    if (!doc) {
      cleanup()
      return
    }

    await waitForNoteDocumentStyles(doc)
    const target = getElementByIdOrName(doc, id)
    if (!target) {
      cleanup()
      return
    }
    const element = findNoteElement(target, anchor)

    return { element, cleanup }
  } catch (error) {
    cleanup()
    return
  }
}

async function renderFreshLinkedSectionDocument(
  tab: BookTab,
  section: ISection,
  id: string,
) {
  const sectionUrl = section.url
  if (!sectionUrl) {
    throw new Error(`Missing section url: ${section.href}`)
  }

  const document = (await tab.epub!.load(sectionUrl)) as Document

  await section.hooks?.content?.trigger(document, section)

  const target = getElementByIdOrName(document, id)
  if (!target) {
    throw new Error(`Missing linked note target: ${section.href}#${id}`)
  }

  return document.documentElement.outerHTML
}

async function waitForNoteDocumentStyles(doc: Document) {
  const fonts = doc.fonts
  if (fonts) {
    await Promise.race([
      fonts.ready.catch(() => undefined),
      new Promise((resolve) => window.setTimeout(resolve, 300)),
    ])
  }

  await new Promise((resolve) => window.requestAnimationFrame(resolve))
}

function isPotentialNoteLink(anchor: HTMLAnchorElement) {
  const href = anchor.getAttribute('href')
  if (!href || href.startsWith('mailto:') || href.includes('://')) return false

  const [, hash = ''] = href.split('#')
  if (!hash) return false

  const attrs = [href, safeDecodeHref(hash), getNoteAttrs(anchor)].join(' ')
  if (NOTE_CONTAINER_PATTERN.test(attrs)) return true

  return (
    !!anchor.closest('sup') ||
    !!anchor.querySelector('sup') ||
    isNoteMarkerText(anchor.textContent)
  )
}

function stripScriptsFromNoteSectionHtml(html: string) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<script\b[^>]*\/>/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(
      /\s+(href|src|xlink:href)\s*=\s*(["'])\s*javascript:[\s\S]*?\2/gi,
      '',
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

    if (!fallback && isTagName(cur, 'P', 'LI', 'BLOCKQUOTE', 'DIV')) {
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
  copyNoteTextStyles(container, wrapper)

  let node: ChildNode | null = markerChild
  while (node) {
    if (node !== markerChild && startsWithNoteMarker(node)) break

    wrapper.appendChild(cloneNoteNode(node))
    node = node.nextSibling
  }

  return wrapper.childNodes.length ? wrapper : undefined
}

function cloneNoteNode(node: ChildNode) {
  if (isElementNode(node)) {
    return cloneElementWithNoteStyles(node as HTMLElement)
  }

  return node.cloneNode(true)
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
    isTagName(el, 'A') &&
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
  return isTagName(el, 'ASIDE') || NOTE_CONTAINER_PATTERN.test(getNoteAttrs(el))
}

function isTagName(el: Element, ...names: string[]) {
  const tagName = el.tagName.toUpperCase()
  return names.some((name) => tagName === name)
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

function startsWithNoteMarkerText(text: string | null | undefined) {
  const marker = (text ?? '').trim()
  if (!marker) return false
  if (isNoteMarkerText(marker)) return true

  const firstToken = marker.split(/\s+/)[0]
  if (isNoteMarkerText(firstToken)) return true

  const firstChar = Array.from(marker)[0]
  if (isNoteMarkerText(firstChar)) return true

  return /^[0-9一二三四五六七八九十]+[.．、]/.test(marker)
}

function cloneNoteElement(el: HTMLElement, anchor: HTMLAnchorElement) {
  const clone = cloneNoteContentElement(el)

  clone.querySelectorAll('script, style').forEach((node) => node.remove())
  clone.querySelectorAll('a[href]').forEach((node) => {
    if (isBacklink(node as HTMLAnchorElement, anchor)) {
      unwrapBacklink(node as HTMLAnchorElement)
    }
  })
  normalizeNotePopoverContent(clone)

  return clone
}

function cloneNoteContentElement(el: HTMLElement) {
  const source = getFlattenedNoteContentSource(el)
  if (!shouldFlattenNoteRoot(source)) {
    return cloneElementWithNoteStyles(source)
  }

  const wrapper = source.ownerDocument.createElement('div')
  copyNoteTextStyles(source, wrapper)
  Array.from(source.childNodes).forEach((node) => {
    wrapper.appendChild(cloneNoteNode(node))
  })

  return wrapper
}

function getFlattenedNoteContentSource(el: HTMLElement) {
  let current = el
  let child = getFlattenableNoteChild(current)

  while (child) {
    current = child
    child = getFlattenableNoteChild(current)
  }

  return current
}

function getFlattenableNoteChild(el: HTMLElement) {
  const child = getSingleElementChild(el)
  if (!child || hasMeaningfulOwnText(el)) return

  if (isTagName(el, 'LI') && isTagName(child, 'P', 'DIV', 'BLOCKQUOTE')) {
    return child
  }

  if (isTagName(el, 'P', 'DIV') && isTagName(child, 'SPAN')) {
    return child
  }
}

function getSingleElementChild(el: HTMLElement) {
  const children = Array.from(el.children) as HTMLElement[]
  return children.length === 1 ? children[0] : undefined
}

function hasMeaningfulOwnText(el: HTMLElement) {
  return Array.from(el.childNodes).some(
    (node) => node.nodeType === 3 && !!node.textContent?.trim(),
  )
}

function shouldFlattenNoteRoot(el: HTMLElement) {
  if (!isTagName(el, 'P', 'DIV', 'LI')) return false
  if (isNoteContainer(el)) return false

  return !Array.from(el.children).some((child) =>
    isTagName(
      child,
      'P',
      'DIV',
      'OL',
      'UL',
      'LI',
      'TABLE',
      'BLOCKQUOTE',
      'FIGURE',
      'SECTION',
      'ASIDE',
    ),
  )
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

  listNodes.forEach((node) => {
    node.style.setProperty('list-style', 'none', 'important')
    node.style.setProperty('list-style-type', 'none', 'important')
  })
  for (const node of listNodes) {
    if (!isTagName(node, 'OL', 'UL')) continue

    node.style.setProperty('padding', '0', 'important')
    node.style.setProperty('padding-left', '0', 'important')
  }
  blockNodes.forEach((node) => {
    node.style.setProperty('margin', '0', 'important')
    node.style.setProperty('padding', '0', 'important')
  })
}

function cloneElementWithNoteStyles(el: HTMLElement) {
  const clone = el.cloneNode(true) as HTMLElement
  copyNoteStyleTree(el, clone)

  return clone
}

function copyNoteStyleTree(source: HTMLElement, target: HTMLElement) {
  target.removeAttribute('style')
  copyNoteTextStyles(source, target)
  copyResolvedResourceAttributes(source, target)

  const sourceElements = Array.from(source.querySelectorAll<HTMLElement>('*'))
  const targetElements = Array.from(target.querySelectorAll<HTMLElement>('*'))

  sourceElements.forEach((sourceElement, index) => {
    const targetElement = targetElements[index]
    if (!targetElement) return

    targetElement.removeAttribute('style')
    copyNoteTextStyles(sourceElement, targetElement)
    copyResolvedResourceAttributes(sourceElement, targetElement)
  })
}

function copyNoteTextStyles(source: HTMLElement, target: HTMLElement) {
  const win = source.ownerDocument.defaultView
  if (!win) return

  const style = win.getComputedStyle(source)
  NOTE_POPOVER_TEXT_STYLE_PROPERTIES.forEach((property) => {
    const value = style.getPropertyValue(property)
    if (!value || value === 'normal' || value === 'auto') return

    target.style.setProperty(
      property,
      value,
      style.getPropertyPriority(property),
    )
  })
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
  link.replaceWith(...Array.from(link.childNodes))
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

function clampImagePreviewPan(
  pan: { x: number; y: number },
  bounds: { x: number; y: number },
) {
  return {
    x: clamp(pan.x, -bounds.x, bounds.x),
    y: clamp(pan.y, -bounds.y, bounds.y),
  }
}

function normalizeImagePreviewRotation(
  value: number,
): ReaderImagePreviewRotation {
  const normalized = ((value % 360) + 360) % 360
  if (
    normalized === 0 ||
    normalized === 90 ||
    normalized === 180 ||
    normalized === 270
  ) {
    return normalized
  }
  return 0
}

function getNextImagePreviewZoomIn(current: number) {
  return IMAGE_PREVIEW_ZOOM_STEPS.find((step) => step > current + 0.001)
}

function getNextImagePreviewZoomOut(current: number) {
  for (let index = IMAGE_PREVIEW_ZOOM_STEPS.length - 1; index >= 0; index--) {
    const step = IMAGE_PREVIEW_ZOOM_STEPS[index]
    if (step !== undefined && step < current - 0.001) return step
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
  const anchorLooksLikeNote =
    !!anchor.closest('sup') ||
    !!anchor.querySelector('sup') ||
    startsWithNoteMarkerText(anchor.textContent)

  if (NOTE_CONTAINER_PATTERN.test(attrs)) return true
  if (anchorLooksLikeNote && startsWithNoteMarkerText(target.textContent)) {
    return true
  }
  if (anchorLooksLikeNote && (noteContainer || target.closest('aside'))) {
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
  const { paginationSnapshot } = useSnapshot(tab)
  const navPath = paginationSnapshot?.headerPath ?? []

  return (
    <Bar>
      <div className="scroll-h flex">
        {navPath.map((item, i) => (
          <button
            key={item.id ?? item.href ?? item.label}
            type="button"
            className="hover:text-foreground flex shrink-0 items-center"
          >
            {item.label}
            {i !== navPath.length - 1 && (
              <ChevronRightIcon className="size-5" />
            )}
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
  const { locationsToReturn, paginationSnapshot } = useSnapshot(tab)
  const t = useTranslation('reader')
  const locationToReturn = locationsToReturn[locationsToReturn.length - 1]
  const location = paginationSnapshot?.location
  const divisor = paginationSnapshot?.spreadDivisor ?? 1
  const spread = divisor > 1
  const percentage =
    typeof paginationSnapshot?.percentage === 'number'
      ? `${(paginationSnapshot.percentage * 100).toFixed(2)}%`
      : ''
  const startDisplayed = location?.start.displayed
  const endDisplayed = location?.end.displayed
  const singleVisiblePageOnRight =
    spread && !!startDisplayed && startDisplayed.slot === 'right'
  const hasTwoVisiblePages =
    !!location &&
    (location.start.href !== location.end.href ||
      location.start.displayed.page !== location.end.displayed.page)
  const returnStartShortcut = getShortcutChords('returnStart')[0]
  const returnPreviousShortcut = getShortcutChords('returnPrevious')[0]
  const dismissReturnShortcut = getShortcutChords('dismissReturn')[0]

  return (
    <>
      {locationToReturn ? (
        <Bar>
          <div className="flex min-w-0 items-center gap-2">
            <button
              type="button"
              className={returnActionClass}
              aria-label={t('return_to_start')}
              onClick={() => {
                tab.returnToFirstLocation()
              }}
            >
              <span>{t('return_to_start')}</span>
              {returnStartShortcut && (
                <ShortcutChord compact shortcut={returnStartShortcut} />
              )}
            </button>
            <button
              type="button"
              className={clsx(returnActionClass, 'truncate')}
              aria-label={t('return_to_previous')}
              onClick={() => {
                tab.returnToPreviousLocation()
              }}
            >
              <span>{t('return_to_previous')}</span>
              {returnPreviousShortcut && (
                <ShortcutChord compact shortcut={returnPreviousShortcut} />
              )}
            </button>
          </div>
          <button
            type="button"
            className={returnActionClass}
            aria-label={t('dismiss_return')}
            onClick={() => {
              tab.hidePrevLocation()
            }}
          >
            <span>{t('dismiss_return')}</span>
            {dismissReturnShortcut && (
              <ShortcutChord compact shortcut={dismissReturnShortcut} />
            )}
          </button>
        </Bar>
      ) : spread ? (
        <div className="text-muted-foreground grid h-6 grid-cols-2 items-center px-2 text-center text-base">
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
        <div className="text-muted-foreground flex h-6 items-center justify-center px-2 text-base">
          {startDisplayed && formatFooterPage(startDisplayed, percentage)}
        </div>
      )}
    </>
  )
}

const returnActionClass =
  'inline-flex items-center gap-1.5 rounded px-1 hover:bg-muted hover:text-foreground'

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
        'text-muted-foreground flex h-6 items-center justify-between gap-2 px-2 text-base',
        className,
      )}
      {...props}
    ></div>
  )
}
