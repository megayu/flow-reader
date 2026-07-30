import clsx from 'clsx'
import {
  BookOpen,
  ChevronDown,
  Focus,
  Highlighter,
  Image,
  Library,
  ListFilter,
  type LucideIcon,
  Maximize,
  Minimize,
  PencilIcon,
  PinIcon,
  PinOffIcon,
  PlusIcon,
  RotateCcwIcon,
  Search,
  Settings,
  Sun,
  TableOfContents,
  Trash2Icon,
  Type,
  XIcon,
} from 'lucide-react'
import {
  type ComponentProps,
  type PropsWithChildren,
  type ReactNode,
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from 'react'

import { SettingsDialog } from '@/settings/SettingsDialog'

import { useBackground } from '../hooks/theme/useBackground'
import { useColorScheme } from '../hooks/theme/useColorScheme'
import { type LibraryAction, type Action as ReaderPanelAction, useAction, useLibraryAction } from '../hooks/useAction'
import { useLibrary, useLibraryTags } from '../hooks/useLibrary'
import { useTranslation } from '../hooks/useTranslation'
import { isGlobalKeyboardShortcutBlocked } from '../keyboard'
import {
  areStringListsEqual,
  cleanLibraryTagName,
  getLibraryAuthorOptions,
  getLibraryTagOptions,
  pinLibraryAuthor,
  pinLibraryTag,
  pruneLibraryAuthorFilters,
  pruneLibraryTagFilters,
  sameLibraryTagName,
  toggleLibraryAuthorFilter,
  toggleLibraryTagFilter,
  unpinLibraryAuthor,
  unpinLibraryTag,
} from '../library/filters'
import { toMessageKeySegment } from '../locales'
import { useReaderSnapshot } from '../models/reader'
import { getShortcutChords, type ShortcutActionId } from '../shortcuts'
import {
  useLibraryAuthorFilter,
  useLibraryStatusFilter,
  useLibraryTagFilter,
  useSettings,
  useSettingsDialogOpen,
  useSetZenTypographyOverrides,
  useViewMode,
  useViewModeValue,
  useZenMode,
  useZenModeValue,
} from '../state'
import { db, type LibraryTagRecord } from '../storage'
import { activeClass } from '../styles'

import { AppTooltip } from './AppTooltip'
import { PaneView } from './base/PaneView'
import { SplitView, useSplitViewItem } from './base/SplitView'
import { ReadingStatusIcon } from './ReadingStatusIcon'
import { Button as UiButton } from './ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog'
import { Input } from './ui/input'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from './ui/menu'
import { AnnotationView } from './viewlets/AnnotationView'
import { ImageView } from './viewlets/ImageView'
import { SearchView } from './viewlets/SearchView'
import { ThemePanel } from './viewlets/ThemePanel'
import { TocView } from './viewlets/TocView'
import { TypographyView } from './viewlets/TypographyView'

export const Layout: React.FC<PropsWithChildren> = ({ children }) => {
  useColorScheme()

  const [settingsOpen, setSettingsOpen] = useSettingsDialogOpen()
  const [action, setAction] = useAction()
  const actionBeforeZen = useRef<ReaderPanelAction | undefined>(undefined)
  const zenModeRef = useRef(false)
  const zenMode = useZenModeValue()
  const { focusedBookTab } = useReaderSnapshot()
  const setZenTypographyOverrides = useSetZenTypographyOverrides()

  useEffect(() => {
    if (zenMode && !zenModeRef.current) {
      actionBeforeZen.current = action
      setAction(undefined)
      setSettingsOpen(false)
    }

    if (!zenMode && zenModeRef.current) {
      setAction(actionBeforeZen.current)
      actionBeforeZen.current = undefined
      setZenTypographyOverrides({})
    }

    zenModeRef.current = zenMode
  }, [action, setAction, setSettingsOpen, setZenTypographyOverrides, zenMode])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!isSettingsShortcut(e)) return
      if (isGlobalKeyboardShortcutBlocked(e)) return

      e.preventDefault()
      e.stopPropagation()
      e.stopImmediatePropagation?.()
      setSettingsOpen(true)
    }

    const targets = [window, ...getIframeWindows()]
    targets.forEach((target) => target.addEventListener('keydown', onKeyDown))
    return () => {
      targets.forEach((target) => target.removeEventListener('keydown', onKeyDown))
    }
  }, [focusedBookTab?.id, setSettingsOpen])

  useEffect(() => {
    const preventNativeContextMenu = (e: MouseEvent) => {
      e.preventDefault()
    }

    document.addEventListener('contextmenu', preventNativeContextMenu)

    return () => {
      document.removeEventListener('contextmenu', preventNativeContextMenu)
    }
  }, [])

  return (
    <div id="layout" className="select-none">
      <SplitView>
        {!zenMode && <ActivityBar settingsOpen={settingsOpen} onSettingsOpenChange={setSettingsOpen} />}
        {!zenMode && <SideBar />}
        <Reader>{children}</Reader>
      </SplitView>
      {!zenMode && <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />}
    </div>
  )
}

function isSettingsShortcut(e: KeyboardEvent) {
  return (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === ',' || e.code === 'Comma')
}

function getIframeWindows() {
  return Array.from(document.querySelectorAll('iframe')).flatMap((frame) => {
    try {
      return frame.contentWindow ? [frame.contentWindow] : []
    } catch {
      return []
    }
  })
}

function isFullscreenShortcut(e: KeyboardEvent) {
  return !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && (e.key.toLowerCase() === 'f' || e.code === 'KeyF')
}

function isAppShortcutTargetBlocked(e: KeyboardEvent) {
  return isGlobalKeyboardShortcutBlocked(e)
}

interface IAction {
  name: string
  title: string
  Icon: LucideIcon
  shortcutId?: ShortcutActionId
}
interface IViewAction extends IAction {
  name: ReaderPanelAction
  View: React.FC<any>
}

const viewActions: IViewAction[] = [
  {
    name: 'toc',
    title: 'toc',
    Icon: TableOfContents,
    shortcutId: 'tocPanel',
    View: TocView,
  },
  {
    name: 'search',
    title: 'search',
    Icon: Search,
    shortcutId: 'searchPanel',
    View: SearchView,
  },
  {
    name: 'annotation',
    title: 'annotation',
    Icon: Highlighter,
    shortcutId: 'annotationPanel',
    View: AnnotationView,
  },
  {
    name: 'image',
    title: 'image',
    Icon: Image,
    shortcutId: 'imagePanel',
    View: ImageView,
  },
  {
    name: 'typography',
    title: 'typography',
    Icon: Type,
    shortcutId: 'typographyPanel',
    View: TypographyView,
  },
]

interface ILibraryViewAction extends IAction {
  name: LibraryAction
  View: React.FC<any>
}

const libraryViewActions: ILibraryViewAction[] = [
  {
    name: 'libraryFilter',
    title: 'library_filter',
    Icon: ListFilter,
    shortcutId: 'libraryFilterPanel',
    View: LibraryFilterView,
  },
]

interface SettingsActionProps {
  settingsOpen: boolean
  onSettingsOpenChange: (open: boolean) => void
}

const ActivityBar: React.FC<SettingsActionProps> = ({ settingsOpen, onSettingsOpenChange }) => {
  useSplitViewItem('ActivityBar', {
    preferredSize: 48,
    minSize: 48,
    maxSize: 48,
  })
  const [, , background] = useBackground()

  return (
    <div className={clsx('ActivityBar flex flex-col justify-between', background.activityBarClassName)}>
      <ViewActionBar />
      <PageActionBar settingsOpen={settingsOpen} onSettingsOpenChange={onSettingsOpenChange} />
    </div>
  )
}

interface PageActionBarProps extends ComponentProps<'div'>, SettingsActionProps {}

function ViewActionBar({ className }: ComponentProps<'div'>) {
  const [action, setAction] = useAction()
  const [libraryAction, setLibraryAction] = useLibraryAction()
  const viewMode = useViewModeValue()
  const t = useTranslation()
  const actions: Array<IViewAction | ILibraryViewAction> = viewMode === 'library' ? libraryViewActions : viewActions
  const activeAction = viewMode === 'library' ? libraryAction : action

  return (
    <ActionBar className={className}>
      {actions.map(({ name, title, Icon, shortcutId }) => {
        const active = activeAction === name
        return (
          <Action
            label={t(`${title}.title`)}
            Icon={Icon}
            active={active}
            shortcut={getPrimaryShortcut(shortcutId)}
            onClick={() => {
              if (viewMode === 'library') {
                setLibraryAction(active ? undefined : (name as LibraryAction))
              } else {
                setAction(active ? undefined : (name as ReaderPanelAction))
              }
            }}
            key={name}
          />
        )
      })}
    </ActionBar>
  )
}

function useFullscreenAction() {
  const [fullscreen, setFullscreen] = useState(false)
  const fullscreenRef = useRef(false)

  const updateFullscreen = useCallback(async () => {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window')
      const nextFullscreen = await getCurrentWindow().isFullscreen()
      fullscreenRef.current = nextFullscreen
      setFullscreen(nextFullscreen)
    } catch {
      fullscreenRef.current = false
      setFullscreen(false)
    }
  }, [])

  useEffect(() => {
    let unlistenResize: (() => void) | undefined
    let unlistenFocus: (() => void) | undefined
    let disposed = false

    const initialize = async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window')
        const win = getCurrentWindow()

        await updateFullscreen()

        const [resizeListener, focusListener] = await Promise.all([
          win.onResized(updateFullscreen),
          win.onFocusChanged(updateFullscreen),
        ])

        if (disposed) {
          resizeListener()
          focusListener()
          return
        }

        unlistenResize = resizeListener
        unlistenFocus = focusListener
      } catch {
        fullscreenRef.current = false
        setFullscreen(false)
      }
    }

    void initialize()

    return () => {
      disposed = true
      unlistenResize?.()
      unlistenFocus?.()
    }
  }, [updateFullscreen])

  useEffect(() => {
    const onKeyDown = async (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !fullscreenRef.current) return

      e.preventDefault()
      e.stopPropagation()

      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window')
        await getCurrentWindow().setFullscreen(false)
      } finally {
        fullscreenRef.current = false
        setFullscreen(false)
      }
    }

    document.addEventListener('keydown', onKeyDown, true)

    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [])

  const toggleFullscreen = useCallback(async () => {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window')
      const win = getCurrentWindow()
      const nextFullscreen = !(await win.isFullscreen())
      await win.setFullscreen(nextFullscreen)
      fullscreenRef.current = nextFullscreen
      setFullscreen(nextFullscreen)
    } catch {
      fullscreenRef.current = false
      setFullscreen(false)
    }
  }, [])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!isFullscreenShortcut(e) || isAppShortcutTargetBlocked(e)) return

      e.preventDefault()
      e.stopPropagation()
      e.stopImmediatePropagation?.()
      void toggleFullscreen()
    }

    document.addEventListener('keydown', onKeyDown, true)

    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [toggleFullscreen])

  return { fullscreen, toggleFullscreen }
}

function PageActionBar({ settingsOpen, onSettingsOpenChange }: PageActionBarProps) {
  const [themeOpen, setThemeOpen] = useState(false)
  const [viewMode, setViewMode] = useViewMode()
  const [zenMode, setZenMode] = useZenMode()
  const { focusedBookTab } = useReaderSnapshot()
  const t = useTranslation()
  const { fullscreen, toggleFullscreen } = useFullscreenAction()

  interface IPageAction extends IAction {
    disabled?: boolean
  }

  const pageActions: IPageAction[] = useMemo(
    () => [
      {
        name: 'mode',
        title: viewMode === 'library' ? 'mode.return_reader' : 'mode.enter_library',
        Icon: viewMode === 'library' ? BookOpen : Library,
        shortcutId: 'libraryReaderToggle',
        disabled: viewMode === 'library' && !focusedBookTab,
      },
      {
        name: 'theme',
        title: 'theme',
        Icon: Sun,
      },
      {
        name: 'fullscreen',
        title: fullscreen ? 'fullscreen.exit' : 'fullscreen.enter',
        Icon: fullscreen ? Minimize : Maximize,
        shortcutId: 'fullscreen',
      },
      {
        name: 'zen',
        title: 'zen.enter',
        Icon: Focus,
        shortcutId: 'zenMode',
        disabled: viewMode === 'library' || !focusedBookTab,
      },
      {
        name: 'settings',
        title: 'settings',
        Icon: Settings,
        shortcutId: 'openSettings',
      },
    ],
    [focusedBookTab, fullscreen, viewMode],
  )

  return (
    <div>
      <ActionBar>
        {pageActions.map(({ name, title, Icon, shortcutId, disabled }) => {
          const active =
            (viewMode === 'library' && name === 'mode') ||
            (themeOpen && name === 'theme') ||
            (fullscreen && name === 'fullscreen') ||
            (zenMode && name === 'zen') ||
            (settingsOpen && name === 'settings')
          const titleKey = name === 'mode' || name === 'fullscreen' || name === 'zen' ? title : `${title}.title`
          const actionButton = (
            <Action
              key={name}
              label={t(titleKey)}
              Icon={Icon}
              active={active}
              disabled={disabled}
              shortcut={getPrimaryShortcut(shortcutId)}
              onClick={() => {
                if (name === 'theme') {
                  setThemeOpen((open) => !open)
                  return
                }

                setThemeOpen(false)
                if (name === 'fullscreen') {
                  void toggleFullscreen()
                  return
                }

                if (name === 'zen') {
                  if (viewMode !== 'library' && focusedBookTab) {
                    onSettingsOpenChange(false)
                    setZenMode(true)
                  }
                  return
                }

                if (name === 'mode') {
                  if (viewMode === 'library') {
                    if (focusedBookTab) setViewMode('reader')
                  } else {
                    setViewMode('library')
                  }
                  return
                }

                if (name === 'settings') {
                  onSettingsOpenChange(true)
                }
              }}
            />
          )

          if (name === 'theme') {
            return (
              <div className="relative h-12 w-12" key={name}>
                {themeOpen && (
                  <ThemePanel className="absolute bottom-0 left-full ml-1" onClose={() => setThemeOpen(false)} />
                )}
                {actionButton}
              </div>
            )
          }

          return actionButton
        })}
      </ActionBar>
    </div>
  )
}

interface ActionBarProps extends ComponentProps<'ul'> {}
function ActionBar({ className, ...props }: ActionBarProps) {
  return <ul className={clsx('ActionBar flex flex-col', className)} {...props} />
}

interface ActionProps extends ComponentProps<'button'> {
  Icon: LucideIcon
  active?: boolean
  label: string
  shortcut?: string[]
}
const Action: React.FC<ActionProps> = ({ className, Icon, active, label, shortcut, ...props }) => {
  const button = (
    <button
      type="button"
      aria-label={label}
      className={clsx(
        'Action relative flex h-12 w-12 items-center justify-center',
        props.disabled
          ? 'text-muted-foreground/35 cursor-not-allowed opacity-60'
          : clsx(
              'hover:text-muted-foreground cursor-pointer',
              active ? 'text-muted-foreground' : 'text-muted-foreground/70',
            ),
        className,
      )}
      {...props}
    >
      {active && <div className={clsx('absolute', 'inset-y-0 left-0 w-0.5', activeClass)} />}
      <Icon size={28} />
    </button>
  )

  return (
    <AppTooltip disabled={props.disabled} label={label} shortcut={shortcut} side="right">
      {button}
    </AppTooltip>
  )
}

function getPrimaryShortcut(shortcutId: ShortcutActionId | undefined) {
  return shortcutId ? getShortcutChords(shortcutId)[0] : undefined
}

const SideBar: React.FC = () => {
  const viewMode = useViewModeValue()

  return <SideBarForMode key={viewMode} viewMode={viewMode} />
}

const SideBarForMode: React.FC<{
  viewMode: ReturnType<typeof useViewModeValue>
}> = ({ viewMode }) => {
  const [action] = useAction()
  const [libraryAction] = useLibraryAction()
  const [, , background] = useBackground()
  const activeAction = viewMode === 'library' ? libraryAction : action
  const actions = viewMode === 'library' ? libraryViewActions : viewActions

  const { size } = useSplitViewItem('SideBar', {
    preferredSize: 240,
    minSize: 160,
    storageKey: `flow-reader:sidebar:${viewMode}:width`,
    visible: !!activeAction,
  })

  return (
    <div
      className={clsx('SideBar flex flex-col', background.sidebarClassName, !activeAction && '!hidden')}
      style={{ width: size }}
    >
      {actions.map(({ name, View }) => (
        <View active={name === activeAction} key={name} className={clsx(name !== activeAction && '!hidden')} />
      ))}
    </div>
  )
}

const libraryStatusOptions = ['toRead', 'reading', 'read'] as const
const libraryFilterPanelClassName =
  'rounded-md bg-(--flow-sidebar-item-bg)/70 p-2 ring-(--flow-sidebar-item-border) ring-inset'
const libraryFilterPanelHeaderClassName = 'mb-1 flex h-6 items-center gap-1'
const libraryFilterOptionsClassName = 'flex min-w-0 flex-wrap gap-1'
const libraryFilterChipClassName = 'h-7 max-w-full min-w-0 gap-1 px-2 text-sm leading-none'
const libraryFilterInactiveChipClassName =
  'bg-transparent text-(--flow-text) ring-1 ring-(--flow-sidebar-item-border) ring-inset hover:bg-(--flow-sidebar-item-bg-hover)'
const libraryFilterSectionHeaderClassName = 'text-(--flow-text) text-base leading-none font-semibold'
const libraryFilterIconButtonClassName = 'size-8 rounded-md text-(--flow-text-muted) hover:text-(--flow-text)'

function LibraryFilterView({ className }: ComponentProps<'div'>) {
  const t = useTranslation('home')
  const books = useLibrary()
  const tags = useLibraryTags()
  const [libraryAction] = useLibraryAction()
  const [settings, setSettings] = useSettings()
  const [statusFilters, setStatusFilters] = useLibraryStatusFilter()
  const [authorFilters, setAuthorFilters] = useLibraryAuthorFilter()
  const [tagFilters, setTagFilters] = useLibraryTagFilter()
  const [authorsExpanded, setAuthorsExpanded] = useState(true)
  const [tagsExpanded, setTagsExpanded] = useState(true)
  const [creatingTag, setCreatingTag] = useState(false)
  const [newTagName, setNewTagName] = useState('')
  const [editingTag, setEditingTag] = useState<LibraryTagRecord>()
  const [deletingTag, setDeletingTag] = useState<LibraryTagRecord>()
  const newTagInputRef = useRef<HTMLInputElement>(null)
  const authorOptions = useMemo(
    () => getLibraryAuthorOptions(books ?? [], statusFilters, settings.libraryPinnedAuthors ?? []),
    [books, settings.libraryPinnedAuthors, statusFilters],
  )
  const tagOptions = useMemo(
    () => getLibraryTagOptions(books ?? [], statusFilters, tags ?? [], settings.libraryPinnedTags ?? []),
    [books, settings.libraryPinnedTags, statusFilters, tags],
  )
  const hasFilters = statusFilters.length > 0 || authorFilters.length > 0 || tagFilters.length > 0

  const toggle = (status: (typeof libraryStatusOptions)[number]) => {
    setStatusFilters((current) =>
      current.includes(status) ? current.filter((item) => item !== status) : [...current, status],
    )
  }

  const clearFilters = useCallback(() => {
    setStatusFilters([])
    setAuthorFilters([])
    setTagFilters([])
  }, [setAuthorFilters, setStatusFilters, setTagFilters])

  const resetAuthors = useCallback(() => {
    setAuthorFilters([])
  }, [setAuthorFilters])

  const resetTags = useCallback(() => {
    setTagFilters([])
  }, [setTagFilters])

  const createGlobalTag = useCallback(async () => {
    const name = cleanLibraryTagName(newTagName)
    if (!name) return

    const existing = tags?.find((tag) => sameLibraryTagName(tag.name, name))
    if (!existing) {
      await db.tags.create(name)
    }

    setNewTagName('')
    requestAnimationFrame(() => newTagInputRef.current?.focus())
  }, [newTagName, tags])

  const toggleAuthor = useCallback(
    (author: string) => {
      setAuthorFilters((current) => toggleLibraryAuthorFilter(current, author))
    },
    [setAuthorFilters],
  )

  const toggleTag = useCallback(
    (tagId: string) => {
      setTagFilters((current) => toggleLibraryTagFilter(current, tagId))
    },
    [setTagFilters],
  )

  const pinAuthor = useCallback(
    (author: string) => {
      setSettings((current) => ({
        ...current,
        libraryPinnedAuthors: pinLibraryAuthor(current.libraryPinnedAuthors ?? [], author),
      }))
    },
    [setSettings],
  )

  const unpinAuthor = useCallback(
    (author: string) => {
      setSettings((current) => ({
        ...current,
        libraryPinnedAuthors: unpinLibraryAuthor(current.libraryPinnedAuthors ?? [], author),
      }))
    },
    [setSettings],
  )

  const pinTag = useCallback(
    (tagId: string) => {
      setSettings((current) => ({
        ...current,
        libraryPinnedTags: pinLibraryTag(current.libraryPinnedTags ?? [], tagId),
      }))
    },
    [setSettings],
  )

  const unpinTag = useCallback(
    (tagId: string) => {
      setSettings((current) => ({
        ...current,
        libraryPinnedTags: unpinLibraryTag(current.libraryPinnedTags ?? [], tagId),
      }))
    },
    [setSettings],
  )

  useEffect(() => {
    setAuthorFilters((current) => {
      const next = pruneLibraryAuthorFilters(current, authorOptions)
      return areStringListsEqual(current, next) ? current : next
    })
  }, [authorOptions, setAuthorFilters])

  useEffect(() => {
    setTagFilters((current) => {
      const next = pruneLibraryTagFilters(current, tagOptions)
      return areStringListsEqual(current, next) ? current : next
    })
  }, [setTagFilters, tagOptions])

  useEffect(() => {
    if (!creatingTag) return

    requestAnimationFrame(() => newTagInputRef.current?.focus())
  }, [creatingTag])

  const handleLibraryFilterKeyDown = useEffectEvent((e: KeyboardEvent) => {
    if (e.key !== 'Escape' || e.defaultPrevented || isLibraryFilterShortcutBlocked(e)) return

    e.preventDefault()
    e.stopPropagation()

    if (hasFilters) {
      clearFilters()
    }
  })

  useEffect(() => {
    if (libraryAction !== 'libraryFilter') return

    const onKeyDown = (e: KeyboardEvent) => {
      handleLibraryFilterKeyDown(e)
    }

    document.addEventListener('keydown', onKeyDown)

    return () => {
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [libraryAction])

  return (
    <PaneView className={clsx('p-3', className)}>
      <div className="flex h-full min-h-0 flex-col gap-2" data-testid="library-filter-panel">
        <div className="flex h-6 items-center justify-between gap-2">
          <div className="text-foreground text-lg leading-none font-semibold">{t('library_filter.title')}</div>
          <AppTooltip label={t('library_filter.clear')} shortcut={getPrimaryShortcut('libraryFilterClear')}>
            <UiButton
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t('library_filter.clear')}
              className={libraryFilterIconButtonClassName}
              disabled={!hasFilters}
              onClick={clearFilters}
            >
              <XIcon aria-hidden className="size-4.5" />
            </UiButton>
          </AppTooltip>
        </div>

        <section className={libraryFilterPanelClassName} data-testid="library-status-filter">
          <div className={libraryFilterPanelHeaderClassName}>
            <div className={libraryFilterSectionHeaderClassName}>{t('library_filter.status')}</div>
          </div>
          <div className={libraryFilterOptionsClassName}>
            <UiButton
              type="button"
              size="sm"
              variant={statusFilters.length === 0 ? 'default' : 'secondary'}
              aria-pressed={statusFilters.length === 0}
              data-testid="library-filter-status-all"
              className={clsx(
                libraryFilterChipClassName,
                statusFilters.length !== 0 && libraryFilterInactiveChipClassName,
              )}
              onClick={() => setStatusFilters([])}
            >
              <ReadingStatusIcon
                status={null}
                className={statusFilters.length === 0 ? 'text-primary-foreground' : ''}
              />
              <span className="min-w-0 truncate leading-none">{t('library_filter.all')}</span>
            </UiButton>
            {libraryStatusOptions.map((status) => {
              const active = statusFilters.includes(status)
              return (
                <UiButton
                  key={status}
                  type="button"
                  size="sm"
                  variant={active ? 'default' : 'secondary'}
                  aria-pressed={active}
                  data-testid={`library-filter-status-${status}`}
                  className={clsx(libraryFilterChipClassName, !active && libraryFilterInactiveChipClassName)}
                  onClick={() => toggle(status)}
                >
                  <ReadingStatusIcon status={status} className={active ? 'text-primary-foreground' : ''} />
                  <span className="min-w-0 truncate leading-none">
                    {t(`reading_status.${toMessageKeySegment(status)}`)}
                  </span>
                </UiButton>
              )
            })}
          </div>
        </section>

        <FilterSection
          title={t('library_filter.author')}
          expanded={authorsExpanded}
          onExpandedChange={setAuthorsExpanded}
          resetLabel={t('library_filter.reset')}
          resetDisabled={!authorFilters.length}
          onReset={resetAuthors}
          testId="library-author-section"
        >
          {authorOptions.length ? (
            <div className={libraryFilterOptionsClassName}>
              {authorOptions.map((option) => (
                <LibraryFilterChip
                  key={option.name}
                  label={option.name}
                  pinned={option.pinned}
                  testId="library-author-chip"
                  labelTestId="library-author-chip-label"
                  contextMenuTestId="library-author-context-menu"
                  active={authorFilters.includes(option.name)}
                  onToggle={() => toggleAuthor(option.name)}
                  pinLabel={t('library_filter.pin_author')}
                  unpinLabel={t('library_filter.unpin_author')}
                  onPin={() => pinAuthor(option.name)}
                  onUnpin={() => unpinAuthor(option.name)}
                />
              ))}
            </div>
          ) : (
            <div className="text-muted-foreground py-0.5 text-sm leading-tight">{t('library_filter.no_authors')}</div>
          )}
        </FilterSection>

        <FilterSection
          title={t('library_filter.tags')}
          expanded={tagsExpanded}
          onExpandedChange={setTagsExpanded}
          resetLabel={t('library_filter.reset')}
          resetDisabled={!tagFilters.length}
          onReset={resetTags}
          testId="library-tag-section"
          actions={
            <AppTooltip label={t('library_filter.new_tag')}>
              <UiButton
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t('library_filter.new_tag')}
                className={libraryFilterIconButtonClassName}
                onClick={(e) => {
                  e.stopPropagation()
                  setCreatingTag(true)
                  setTagsExpanded(true)
                }}
              >
                <PlusIcon aria-hidden className="size-4.5" />
              </UiButton>
            </AppTooltip>
          }
        >
          {creatingTag && (
            <div className="mb-1">
              <Input
                ref={newTagInputRef}
                aria-label={t('library_filter.new_tag')}
                value={newTagName}
                onChange={(e) => setNewTagName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.preventDefault()
                    setCreatingTag(false)
                    setNewTagName('')
                    return
                  }

                  if (e.key !== 'Enter') return

                  e.preventDefault()
                  void createGlobalTag()
                }}
                className="focus-visible:border-input h-7 rounded-md px-2 text-sm focus-visible:ring-0"
              />
            </div>
          )}
          {tagOptions.length ? (
            <div className={libraryFilterOptionsClassName}>
              {tagOptions.map((option) => {
                const tag = tags?.find((item) => item.id === option.id)
                if (!tag) return null

                return (
                  <LibraryFilterChip
                    key={option.id}
                    active={tagFilters.includes(option.id)}
                    label={option.name}
                    pinned={option.pinned}
                    testId="library-tag-chip"
                    labelTestId="library-tag-chip-label"
                    contextMenuTestId="library-tag-context-menu"
                    dataValue={option.id}
                    onToggle={() => toggleTag(option.id)}
                    pinLabel={t('library_filter.pin_tag')}
                    unpinLabel={t('library_filter.unpin_tag')}
                    onPin={() => pinTag(option.id)}
                    onUnpin={() => unpinTag(option.id)}
                    menuItems={[
                      {
                        Icon: PencilIcon,
                        label: t('library_filter.edit_tag'),
                        onClick: () => setEditingTag(tag),
                      },
                      {
                        danger: true,
                        Icon: Trash2Icon,
                        label: t('library_filter.delete_tag'),
                        onClick: () => setDeletingTag(tag),
                      },
                    ]}
                  />
                )
              })}
            </div>
          ) : (
            <div className="text-muted-foreground py-0.5 text-sm leading-tight">{t('library_filter.no_tags')}</div>
          )}
        </FilterSection>
      </div>
      {editingTag && (
        <EditLibraryTagDialog key={editingTag.id} tag={editingTag} onClose={() => setEditingTag(undefined)} />
      )}
      {deletingTag && (
        <DeleteLibraryTagDialog
          tag={deletingTag}
          onDeleted={() => {
            setSettings((current) => ({
              ...current,
              libraryPinnedTags: unpinLibraryTag(current.libraryPinnedTags ?? [], deletingTag.id),
            }))
            setDeletingTag(undefined)
          }}
          onClose={() => setDeletingTag(undefined)}
        />
      )}
    </PaneView>
  )
}

function isLibraryFilterShortcutBlocked(e: KeyboardEvent) {
  return isGlobalKeyboardShortcutBlocked(e)
}

interface FilterSectionProps extends PropsWithChildren {
  actions?: ReactNode
  expanded: boolean
  onExpandedChange: (expanded: boolean) => void
  onReset: () => void
  resetDisabled: boolean
  resetLabel: string
  testId?: string
  title: string
}

const FilterSection: React.FC<FilterSectionProps> = ({
  actions,
  children,
  expanded,
  onExpandedChange,
  onReset,
  resetDisabled,
  resetLabel,
  testId,
  title,
}) => {
  return (
    <section className={libraryFilterPanelClassName} data-testid={testId}>
      <div className={libraryFilterPanelHeaderClassName}>
        <UiButton
          type="button"
          variant="ghost"
          size="sm"
          aria-label={`${title} section`}
          aria-expanded={expanded}
          className="h-8 min-w-0 flex-1 justify-start gap-1.5 rounded-xl bg-transparent px-0 text-left hover:bg-transparent focus-visible:border-transparent focus-visible:ring-0 aria-expanded:bg-transparent aria-expanded:text-(--flow-text)"
          onClick={() => onExpandedChange(!expanded)}
        >
          <span className={libraryFilterSectionHeaderClassName}>{title}</span>
          <ChevronDown
            aria-hidden
            className={clsx('size-4.5 shrink-0 transition-transform', !expanded && '-rotate-90')}
          />
        </UiButton>
        {actions}
        <AppTooltip label={resetLabel}>
          <UiButton
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={resetLabel}
            className={libraryFilterIconButtonClassName}
            disabled={resetDisabled}
            onClick={(e) => {
              e.stopPropagation()
              onReset()
            }}
          >
            <RotateCcwIcon aria-hidden className="size-4.5" />
          </UiButton>
        </AppTooltip>
      </div>

      {expanded && children}
    </section>
  )
}

interface LibraryFilterMenuItem {
  danger?: boolean
  Icon: LucideIcon
  label: string
  onClick: () => void
}

const EMPTY_LIBRARY_FILTER_MENU_ITEMS: LibraryFilterMenuItem[] = []

interface LibraryFilterChipProps {
  active: boolean
  contextMenuTestId: string
  dataValue?: string
  label: string
  labelTestId: string
  menuItems?: LibraryFilterMenuItem[]
  onPin: () => void
  onToggle: () => void
  onUnpin: () => void
  pinLabel: string
  pinned: boolean
  testId: string
  unpinLabel: string
}

const LibraryFilterChip: React.FC<LibraryFilterChipProps> = ({
  active,
  contextMenuTestId,
  dataValue,
  label,
  labelTestId,
  menuItems = EMPTY_LIBRARY_FILTER_MENU_ITEMS,
  onPin,
  onToggle,
  onUnpin,
  pinLabel,
  pinned,
  testId,
  unpinLabel,
}) => {
  const labelRef = useRef<HTMLSpanElement>(null)
  const [labelOverflowing, setLabelOverflowing] = useState(false)

  useEffect(() => {
    const labelElement = labelRef.current
    if (!labelElement) return

    const updateOverflow = () => {
      setLabelOverflowing(labelElement.scrollWidth > labelElement.clientWidth)
    }

    updateOverflow()

    if (typeof ResizeObserver === 'undefined') return

    const observer = new ResizeObserver(updateOverflow)
    observer.observe(labelElement)

    return () => {
      observer.disconnect()
    }
  }, [label])

  return (
    <div className="relative max-w-full min-w-0">
      <ContextMenu modal={false}>
        <ContextMenuTrigger asChild>
          <UiButton
            type="button"
            size="sm"
            variant={active ? 'default' : 'secondary'}
            aria-pressed={active}
            aria-label={label}
            title={labelOverflowing ? label : undefined}
            data-testid={testId}
            data-value={dataValue ?? label}
            className={clsx(
              libraryFilterChipClassName,
              'max-w-full justify-start',
              !active && libraryFilterInactiveChipClassName,
            )}
            onClick={onToggle}
          >
            {pinned && (
              <PinIcon
                aria-hidden
                className={clsx('size-3.5', active ? 'text-primary-foreground' : 'text-muted-foreground')}
              />
            )}
            <span ref={labelRef} className="min-w-0 truncate leading-none" data-testid={labelTestId}>
              {label}
            </span>
          </UiButton>
        </ContextMenuTrigger>
        <ContextMenuContent data-testid={contextMenuTestId}>
          <LibraryFilterContextMenuItem
            Icon={PinIcon}
            label={pinLabel}
            onSelect={() => {
              onPin()
            }}
          />
          {pinned && (
            <LibraryFilterContextMenuItem
              Icon={PinOffIcon}
              label={unpinLabel}
              onSelect={() => {
                onUnpin()
              }}
            />
          )}
          {menuItems.length > 0 && <ContextMenuSeparator />}
          {menuItems.map((item) => (
            <LibraryFilterContextMenuItem
              key={item.label}
              variant={item.danger ? 'destructive' : 'default'}
              Icon={item.Icon}
              label={item.label}
              onSelect={() => {
                item.onClick()
              }}
            />
          ))}
        </ContextMenuContent>
      </ContextMenu>
    </div>
  )
}

interface LibraryFilterContextMenuItemProps {
  Icon: LucideIcon
  label: string
  onSelect: () => void
  variant?: 'default' | 'destructive'
}

const LibraryFilterContextMenuItem: React.FC<LibraryFilterContextMenuItemProps> = ({
  Icon,
  label,
  onSelect,
  variant,
}) => {
  return (
    <ContextMenuItem variant={variant} onSelect={onSelect}>
      <Icon aria-hidden className="size-4 shrink-0" />
      <span className="min-w-0 truncate">{label}</span>
    </ContextMenuItem>
  )
}

interface LibraryTagDialogProps {
  onClose: () => void
  tag: LibraryTagRecord
}

const EditLibraryTagDialog: React.FC<LibraryTagDialogProps> = ({ onClose, tag }) => {
  const t = useTranslation('home')
  const inputRef = useRef<HTMLInputElement>(null)
  const [nameState, setNameState] = useState({ tagId: tag.id, name: tag.name })
  if (nameState.tagId !== tag.id) {
    setNameState({ tagId: tag.id, name: tag.name })
  }
  const name = nameState.tagId === tag.id ? nameState.name : tag.name
  const trimmedName = name.replace(/\s+/g, ' ').trim()
  const canSave = !!trimmedName && trimmedName !== tag.name

  const save = () => {
    if (!canSave) return

    void db.tags.update(tag.id, trimmedName).then(() => onClose())
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent
        data-flow-keyboard-capture="true"
        className="w-[min(24rem,calc(100vw-2rem))] max-w-none text-base"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          inputRef.current?.focus()
          inputRef.current?.select()
        }}
      >
        <form
          autoComplete="off"
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            save()
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('library_filter.edit_tag')}</DialogTitle>
          </DialogHeader>
          <label className="block">
            <span className="text-muted-foreground mb-1.5 block leading-none font-medium">
              {t('library_filter.tag_name')}
            </span>
            <Input
              ref={inputRef}
              value={name}
              onChange={(e) =>
                setNameState((state) => ({
                  ...state,
                  name: e.target.value,
                }))
              }
              className="focus-visible:border-input text-base focus-visible:ring-0"
            />
          </label>
          <DialogFooter className="-mx-4 mt-1 -mb-4 px-4 py-3">
            <UiButton type="button" variant="secondary" onClick={onClose}>
              {t('cancel')}
            </UiButton>
            <UiButton type="submit" disabled={!canSave}>
              {t('edit.save')}
            </UiButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

interface DeleteLibraryTagDialogProps extends LibraryTagDialogProps {
  onDeleted: () => void
}

const DeleteLibraryTagDialog: React.FC<DeleteLibraryTagDialogProps> = ({ onClose, onDeleted, tag }) => {
  const t = useTranslation('home')

  const remove = () => {
    void db.tags.delete(tag.id).then(() => onDeleted())
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent data-flow-keyboard-capture="true" className="w-[min(24rem,calc(100vw-2rem))] max-w-none text-base">
        <DialogHeader>
          <DialogTitle>{t('library_filter.delete_tag')}</DialogTitle>
        </DialogHeader>
        <div className="text-muted-foreground leading-relaxed">
          {t('library_filter.delete_tag_message')} <span className="text-foreground font-medium">{tag.name}</span>
        </div>
        <DialogFooter className="-mx-4 mt-1 -mb-4 px-4 py-3">
          <UiButton
            type="button"
            variant="secondary"
            className="focus:border-ring focus:ring-ring focus:ring-1 focus:ring-inset focus-visible:ring-1 focus-visible:ring-inset"
            onClick={onClose}
          >
            {t('cancel')}
          </UiButton>
          <UiButton type="button" variant="destructive" onClick={remove}>
            {t('library_filter.delete_tag')}
          </UiButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

interface ReaderProps extends ComponentProps<'div'> {}
const Reader: React.FC<ReaderProps> = ({ className, ...props }) => {
  useSplitViewItem(Reader)
  const [bg] = useBackground()

  return <div className={clsx('Reader flex-1 overflow-hidden', className, bg)} {...props} />
}
