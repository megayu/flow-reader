import { isDevtoolsShortcutEnabled, toggleDevtools } from '../devtools'
import { hasKeyboardCaptureLayer, isEditableKeyboardTarget, isGlobalKeyboardShortcutBlocked } from '../keyboard'
import { type BookTab, reader } from '../models/reader'
import type { SetterOrUpdater, TypographyConfiguration, ViewMode } from '../state'
import { getBodyTypographyBaseline, notePopoverClass } from '../styles'

const FONT_SIZE_MIN = 14
const FONT_SIZE_MAX = 28
const FONT_SIZE_DEFAULT = 16

type ZenTypographyOverridesSetter = SetterOrUpdater<Record<string, TypographyConfiguration>>
type ReaderPanelAction = 'toc' | 'search' | 'annotation' | 'image' | 'typography'
type ReaderPanelActionSetter = SetterOrUpdater<ReaderPanelAction | undefined>
type SettingsOpenSetter = SetterOrUpdater<boolean>

export interface ReaderShortcutContext {
  action?: ReaderPanelAction
  setAction: ReaderPanelActionSetter
  setViewMode: SetterOrUpdater<ViewMode>
  setSettingsOpen: SettingsOpenSetter
}

export function createReaderKeyDownHandler(
  tab: BookTab | undefined,
  viewMode: ViewMode,
  enterReaderMode: () => void,
  zenMode: boolean,
  setZenMode: (value: boolean) => void,
  setZenTypographyOverrides: ZenTypographyOverridesSetter,
  shortcuts: ReaderShortcutContext,
) {
  return (event: KeyboardEvent) => {
    try {
      if (event.key === 'Escape') {
        if (zenMode) {
          consumeShortcut(event)
          setZenMode(false)
          return
        }

        void exitFullscreenIfActive()
      }

      if (handleZenEnterShortcut(event, tab, viewMode, setZenMode)) return
      if (zenMode) {
        handleZenShortcut(event, tab, viewMode, setZenTypographyOverrides)
        return
      }

      if (handleCommandShortcut(event, viewMode, enterReaderMode, shortcuts)) {
        return
      }
      if (handleAppShortcut(event, tab, viewMode, setZenMode, shortcuts)) {
        return
      }
      if (viewMode === 'library') return
      if (handleReturnShortcut(event, tab)) return
      if (handleChapterShortcut(event, tab)) return
      handlePageTurnShortcut(event, tab)
    } catch {
      // Rendition shortcuts are ignored while the reader is not ready.
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

function handleCommandShortcut(
  event: KeyboardEvent,
  viewMode: ViewMode,
  enterReaderMode: () => void,
  shortcuts: ReaderShortcutContext,
) {
  if (!hasCommandModifier(event) || event.altKey) return false

  if (!event.shiftKey && (event.key === ',' || event.code === 'Comma')) {
    consumeShortcut(event)
    if (!hasKeyboardCapturingLayer(event.target)) {
      shortcuts.setSettingsOpen(true)
    }
    return true
  }

  if (
    isDevtoolsShortcutEnabled() &&
    event.shiftKey &&
    !event.altKey &&
    (event.code === 'KeyI' || event.key.toLowerCase() === 'i')
  ) {
    consumeShortcut(event)
    void toggleDevtools()
    return true
  }

  if (event.key.toLowerCase() === 'w') {
    consumeShortcut(event)
    if (!isReaderShortcutTargetBlocked(event)) {
      if (event.shiftKey) {
        reader.closeAllTabs()
      } else {
        reader.closeFocusedTab()
      }
    }
    return true
  }

  if (handleTabMoveShortcut(event, enterReaderMode)) return true
  if (handleTabSwitchShortcut(event, enterReaderMode)) return true
  return handleFontSizeShortcut(event, viewMode)
}

function handleAppShortcut(
  event: KeyboardEvent,
  tab: BookTab | undefined,
  viewMode: ViewMode,
  setZenMode: (value: boolean) => void,
  shortcuts: ReaderShortcutContext,
) {
  if (shouldIgnoreReaderShortcut(event)) return false

  const key = event.key.toLowerCase()
  if (key === 'f') {
    consumeShortcut(event)
    void toggleFullscreenIfAvailable()
    return true
  }

  if (key === 'c') {
    consumeShortcut(event)
    if (viewMode === 'library') {
      if (tab) shortcuts.setViewMode('reader')
    } else {
      shortcuts.setViewMode('library')
    }
    return true
  }

  if (viewMode === 'library' || !tab) return false
  if (key === 'z') {
    consumeShortcut(event)
    setZenMode(true)
    return true
  }

  const panel = getPanelShortcutAction(event)
  if (!panel) return false

  consumeShortcut(event)
  shortcuts.setAction(shortcuts.action === panel ? undefined : panel)
  return true
}

function getPanelShortcutAction(event: KeyboardEvent): ReaderPanelAction | undefined {
  const key = event.key.toLowerCase()
  if (key === 't') return 'toc'
  if (key === 's') return 'search'
  if (key === 'a') return 'annotation'
  if (key === 'g') return 'image'
  if (key === 'v') return 'typography'
}

function handleFontSizeShortcut(event: KeyboardEvent, viewMode: ViewMode) {
  if (!hasCommandModifier(event) || event.altKey) return false

  const reset = isFontSizeResetShortcut(event)
  const delta = getFontSizeShortcutDelta(event)
  if (!reset && !delta) return false

  consumeShortcut(event)
  if (viewMode === 'library') return true

  if (!isReaderShortcutTargetBlocked(event)) {
    const tab = reader.focusedBookTab
    if (tab) {
      if (reset) {
        clearBookFontSize(tab)
      } else {
        updateBookFontSize(tab, delta)
      }
    }
  }
  return true
}

function handleZenEnterShortcut(
  event: KeyboardEvent,
  tab: BookTab | undefined,
  viewMode: ViewMode,
  setZenMode: (value: boolean) => void,
) {
  if (viewMode === 'library' || !tab) return false
  if (event.key.toLowerCase() !== 'z') return false
  if (shouldIgnoreReaderShortcut(event)) return false

  consumeShortcut(event)
  setZenMode(true)
  return true
}

function handleZenShortcut(
  event: KeyboardEvent,
  tab: BookTab | undefined,
  viewMode: ViewMode,
  setZenTypographyOverrides: ZenTypographyOverridesSetter,
) {
  if (handleZenFontSizeShortcut(event, tab, viewMode, setZenTypographyOverrides)) {
    return true
  }
  if (handleChapterShortcut(event, tab)) return true
  if (!event.ctrlKey && !event.metaKey && !event.altKey) {
    if (handlePageTurnShortcut(event, tab)) return true
  }

  if (hasCommandModifier(event) && !isReaderShortcutTargetBlocked(event)) {
    consumeShortcut(event)
    return true
  }
  return false
}

function handleZenFontSizeShortcut(
  event: KeyboardEvent,
  tab: BookTab | undefined,
  viewMode: ViewMode,
  setZenTypographyOverrides: ZenTypographyOverridesSetter,
) {
  if (!hasCommandModifier(event) || event.altKey) return false

  const reset = isFontSizeResetShortcut(event)
  const delta = getFontSizeShortcutDelta(event)
  if (!reset && !delta) return false

  consumeShortcut(event)
  if (viewMode === 'library' || !tab || isReaderShortcutTargetBlocked(event)) {
    return true
  }

  if (reset) {
    clearZenBookFontSize(tab, setZenTypographyOverrides)
  } else {
    updateZenBookFontSize(tab, delta, setZenTypographyOverrides)
  }
  return true
}

function handleTabMoveShortcut(event: KeyboardEvent, enterReaderMode: () => void) {
  if (!event.shiftKey) return false

  const direction = getCommandTabDirection(event)
  if (!direction) return false

  consumeShortcut(event)
  if (!isReaderShortcutTargetBlocked(event)) {
    reader.moveFocusedTab(direction)
    enterReaderMode()
  }
  return true
}

function handleTabSwitchShortcut(event: KeyboardEvent, enterReaderMode: () => void) {
  if (event.shiftKey) return false

  const index = getCommandTabIndex(event)
  const direction = getCommandTabDirection(event)
  if (index === undefined && direction === 0) return false

  consumeShortcut(event)
  if (!isReaderShortcutTargetBlocked(event)) {
    const group = reader.focusedGroup
    const hasTarget =
      index === 8 ? !!group?.tabs.length : index !== undefined ? !!group?.tabs[index] : !!group?.tabs.length
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

function getCommandTabIndex(event: KeyboardEvent) {
  const match = /^(?:Digit|Numpad)([1-9])$/.exec(event.code)
  if (match) return Number(match[1]) - 1
  if (/^[1-9]$/.test(event.key)) return Number(event.key) - 1
}

function getCommandTabDirection(event: KeyboardEvent): -1 | 0 | 1 {
  if (event.code === 'ArrowLeft') return -1
  if (event.code === 'ArrowRight') return 1
  return 0
}

function hasCommandModifier(event: KeyboardEvent) {
  return event.metaKey || event.ctrlKey
}

function getFontSizeShortcutDelta(event: KeyboardEvent) {
  if (event.code === 'Equal' || event.code === 'NumpadAdd' || event.key === '+' || event.key === '=') {
    return 1
  }
  if (event.code === 'Minus' || event.code === 'NumpadSubtract' || event.key === '-' || event.key === '_') {
    return -1
  }
  return 0
}

function isFontSizeResetShortcut(event: KeyboardEvent) {
  return !event.shiftKey && (event.code === 'Digit0' || event.code === 'Numpad0')
}

function updateBookFontSize(tab: BookTab, delta: number) {
  const fontSize =
    parseFontSize(tab.book.configuration?.typography?.fontSize) ?? getCurrentBodyFontSize(tab) ?? FONT_SIZE_DEFAULT
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
  const typography = { ...tab.book.configuration?.typography }
  delete typography.fontSize

  tab.updateBook({
    configuration: {
      ...tab.book.configuration,
      typography,
    },
  })
}

function updateZenBookFontSize(tab: BookTab, delta: number, setZenTypographyOverrides: ZenTypographyOverridesSetter) {
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

function clearZenBookFontSize(tab: BookTab, setZenTypographyOverrides: ZenTypographyOverridesSetter) {
  setZenTypographyOverrides((overrides) => {
    const bookId = tab.book.id
    const typography = { ...overrides[bookId] }
    delete typography.fontSize

    if (!Object.keys(typography).length) {
      const next = { ...overrides }
      delete next[bookId]
      return next
    }
    return { ...overrides, [bookId]: typography }
  })
}

function getCurrentBodyFontSize(tab: BookTab) {
  return getBodyTypographyBaseline(tab.view?.contents, tab.bodyTextCache).fontSize
}

function parseFontSize(value: string | undefined) {
  if (!value) return
  const size = parseInt(value, 10)
  return Number.isFinite(size) ? size : undefined
}

function handleChapterShortcut(event: KeyboardEvent, tab?: BookTab) {
  if (!tab) return false

  const direction =
    event.code === 'BracketLeft' || event.key === '[' ? -1 : event.code === 'BracketRight' || event.key === ']' ? 1 : 0
  if (!direction || shouldIgnoreReaderShortcut(event)) return false

  consumeShortcut(event)
  void (direction < 0 ? tab.prevSection() : tab.nextSection())
  return true
}

function handlePageTurnShortcut(event: KeyboardEvent, tab?: BookTab) {
  if (!tab) return false
  if (event.ctrlKey || event.metaKey || event.altKey) return false
  if (isReaderShortcutTargetBlocked(event)) return false

  switch (event.code) {
    case 'ArrowLeft':
    case 'ArrowUp':
      tab.prev()
      return true
    case 'ArrowRight':
    case 'ArrowDown':
      tab.next()
      return true
    case 'Space':
      event.shiftKey ? tab.prev() : tab.next()
      return true
    default:
      return false
  }
}

function handleReturnShortcut(event: KeyboardEvent, tab?: BookTab) {
  if (!tab?.locationToReturn) return false

  const key = event.key.toLowerCase()
  if (!['b', 'r', 'q'].includes(key)) return false
  if (shouldIgnoreReaderShortcut(event)) return false

  consumeShortcut(event)
  if (key === 'b') return tab.returnToPreviousLocation()
  if (key === 'r') return tab.returnToFirstLocation()

  tab.hidePrevLocation()
  return true
}

function shouldIgnoreReaderShortcut(event: KeyboardEvent) {
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) {
    return true
  }
  return isReaderShortcutTargetBlocked(event)
}

export function isReaderShortcutTargetBlocked(event: KeyboardEvent) {
  return isGlobalKeyboardShortcutBlocked(event) || hasKeyboardCapturingLayer(event.target)
}

export function isEditableTarget(target: EventTarget | null) {
  return isEditableKeyboardTarget(target)
}

export function hasKeyboardCapturingLayer(target: EventTarget | null) {
  return hasKeyboardCaptureLayer(target, [`.${notePopoverClass}`, '[role="dialog"]', '[role="menu"]'])
}

function consumeShortcut(event: KeyboardEvent) {
  event.preventDefault()
  event.stopPropagation()
  event.stopImmediatePropagation?.()
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}
