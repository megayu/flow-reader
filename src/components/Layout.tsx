import clsx from 'clsx'
import {
  BookOpen,
  ChevronDown,
  Focus,
  Highlighter,
  Image,
  Library,
  ListFilter,
  Maximize,
  Minimize,
  PinIcon,
  PinOffIcon,
  RotateCcwIcon,
  Search,
  Settings,
  Sun,
  TableOfContents,
  Type,
  XIcon,
  type LucideIcon,
} from 'lucide-react'
import {
  ComponentProps,
  MouseEvent as ReactMouseEvent,
  PropsWithChildren,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

import { useBackground } from '../hooks/theme/useBackground'
import { useColorScheme } from '../hooks/theme/useColorScheme'
import {
  useAction,
  useLibraryAction,
  type Action as ReaderPanelAction,
  type LibraryAction,
} from '../hooks/useAction'
import { useLibrary } from '../hooks/useLibrary'
import { useTranslation } from '../hooks/useTranslation'
import {
  areStringListsEqual,
  getLibraryAuthorOptions,
  pinLibraryAuthor,
  pruneLibraryAuthorFilters,
  toggleLibraryAuthorFilter,
  unpinLibraryAuthor,
  type LibraryAuthorOption,
} from '../libraryFilters'
import { useReaderSnapshot } from '../models/reader'
import { getShortcutChords, type ShortcutActionId } from '../shortcuts'
import {
  useLibraryAuthorFilter,
  useLibraryStatusFilter,
  useSettings,
  useSettingsDialogOpen,
  useSetZenTypographyOverrides,
  useViewMode,
  useViewModeValue,
  useZenMode,
  useZenModeValue,
} from '../state'
import { activeClass } from '../styles'

import { AppTooltip } from './AppTooltip'
import { ReadingStatusIcon } from './ReadingStatusIcon'
import { PaneView } from './base/PaneView'
import { SplitView, useSplitViewItem } from './base/SplitView'
import { SettingsDialog } from './pages/settings'
import { Button as UiButton } from './ui/button'
import { AnnotationView } from './viewlets/AnnotationView'
import { ImageView } from './viewlets/ImageView'
import { SearchView } from './viewlets/SearchView'
import { ThemePanel } from './viewlets/ThemeView'
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

      e.preventDefault()
      e.stopPropagation()
      e.stopImmediatePropagation?.()
      setSettingsOpen(true)
    }

    const targets = [window, ...getIframeWindows()]
    targets.forEach((target) => target.addEventListener('keydown', onKeyDown))
    return () => {
      targets.forEach((target) =>
        target.removeEventListener('keydown', onKeyDown),
      )
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
        {!zenMode && (
          <ActivityBar
            settingsOpen={settingsOpen}
            onSettingsOpenChange={setSettingsOpen}
          />
        )}
        {!zenMode && <SideBar />}
        <Reader>{children}</Reader>
      </SplitView>
      {!zenMode && (
        <SettingsDialog
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  )
}

function isSettingsShortcut(e: KeyboardEvent) {
  return (
    (e.ctrlKey || e.metaKey) &&
    !e.altKey &&
    !e.shiftKey &&
    (e.key === ',' || e.code === 'Comma')
  )
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

const ActivityBar: React.FC<SettingsActionProps> = ({
  settingsOpen,
  onSettingsOpenChange,
}) => {
  useSplitViewItem('ActivityBar', {
    preferredSize: 48,
    minSize: 48,
    maxSize: 48,
  })
  const [, , background] = useBackground()

  return (
    <div
      className={clsx(
        'ActivityBar flex flex-col justify-between',
        background.activityBarClassName,
      )}
    >
      <ViewActionBar />
      <PageActionBar
        settingsOpen={settingsOpen}
        onSettingsOpenChange={onSettingsOpenChange}
      />
    </div>
  )
}

interface PageActionBarProps
  extends ComponentProps<'div'>, SettingsActionProps {}

function ViewActionBar({ className }: ComponentProps<'div'>) {
  const [action, setAction] = useAction()
  const [libraryAction, setLibraryAction] = useLibraryAction()
  const viewMode = useViewModeValue()
  const t = useTranslation()
  const actions: Array<IViewAction | ILibraryViewAction> =
    viewMode === 'library' ? libraryViewActions : viewActions
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

  return { fullscreen, toggleFullscreen }
}

function PageActionBar({
  settingsOpen,
  onSettingsOpenChange,
}: PageActionBarProps) {
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
        title:
          viewMode === 'library' ? 'mode.return_reader' : 'mode.enter_library',
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
        {pageActions.map(({ name, title, Icon, shortcutId, disabled }, i) => {
          const active =
            (viewMode === 'library' && name === 'mode') ||
            (themeOpen && name === 'theme') ||
            (fullscreen && name === 'fullscreen') ||
            (zenMode && name === 'zen') ||
            (settingsOpen && name === 'settings')
          const titleKey =
            name === 'mode' || name === 'fullscreen' || name === 'zen'
              ? title
              : `${title}.title`
          const actionButton = (
            <Action
              key={i}
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
              <div className="relative h-12 w-12" key={i}>
                {themeOpen && (
                  <ThemePanel
                    className="absolute bottom-0 left-full ml-1"
                    onClose={() => setThemeOpen(false)}
                  />
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
  return (
    <ul className={clsx('ActionBar flex flex-col', className)} {...props} />
  )
}

interface ActionProps extends ComponentProps<'button'> {
  Icon: LucideIcon
  active?: boolean
  label: string
  shortcut?: string[]
}
const Action: React.FC<ActionProps> = ({
  className,
  Icon,
  active,
  label,
  shortcut,
  ...props
}) => {
  const button = (
    <button
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
      {active && (
        <div
          className={clsx('absolute', 'inset-y-0 left-0 w-0.5', activeClass)}
        />
      )}
      <Icon size={28} />
    </button>
  )

  return (
    <AppTooltip
      disabled={props.disabled}
      label={label}
      shortcut={shortcut}
      side="right"
    >
      {button}
    </AppTooltip>
  )
}

function getPrimaryShortcut(shortcutId: ShortcutActionId | undefined) {
  return shortcutId ? getShortcutChords(shortcutId)[0] : undefined
}

const SideBar: React.FC = () => {
  const [action] = useAction()
  const [libraryAction] = useLibraryAction()
  const t = useTranslation()
  const viewMode = useViewModeValue()
  const [, , background] = useBackground()
  const activeAction = viewMode === 'library' ? libraryAction : action
  const actions = viewMode === 'library' ? libraryViewActions : viewActions

  const { size } = useSplitViewItem(SideBar, {
    preferredSize: 240,
    minSize: 160,
    visible: !!activeAction,
  })

  return (
    <div
      className={clsx(
        'SideBar flex flex-col',
        background.sidebarClassName,
        !activeAction && '!hidden',
      )}
      style={{ width: size }}
    >
      {actions.map(({ name, title, View }) => (
        <View
          key={name}
          name={t(`${name}.title`)}
          title={t(`${title}.title`)}
          className={clsx(name !== activeAction && '!hidden')}
        />
      ))}
    </div>
  )
}

const libraryStatusOptions = ['toRead', 'reading', 'read'] as const
const libraryFilterPanelClassName =
  'rounded-md bg-[var(--flow-sidebar-item-bg)]/70 p-2 ring-[var(--flow-sidebar-item-border)] ring-inset'
const libraryFilterPanelHeaderClassName = 'mb-1 flex h-6 items-center gap-1'
const libraryFilterOptionsClassName = 'flex min-w-0 flex-wrap gap-1'
const libraryFilterChipClassName =
  'h-7 max-w-full min-w-0 gap-1 px-2 text-sm leading-none'
const libraryFilterInactiveChipClassName =
  'bg-transparent text-[var(--flow-text)] ring-1 ring-[var(--flow-sidebar-item-border)] ring-inset hover:bg-[var(--flow-sidebar-item-bg-hover)]'
const libraryFilterSectionHeaderClassName =
  'text-[var(--flow-text)] text-base leading-none font-semibold'
const libraryFilterIconButtonClassName =
  'size-8 rounded-md text-[var(--flow-text-muted)] hover:text-[var(--flow-text)]'

function LibraryFilterView({ className }: ComponentProps<'div'>) {
  const t = useTranslation('home')
  const books = useLibrary()
  const [settings, setSettings] = useSettings()
  const [statusFilters, setStatusFilters] = useLibraryStatusFilter()
  const [authorFilters, setAuthorFilters] = useLibraryAuthorFilter()
  const [authorsExpanded, setAuthorsExpanded] = useState(true)
  const authorOptions = useMemo(
    () =>
      getLibraryAuthorOptions(
        books ?? [],
        statusFilters,
        settings.libraryPinnedAuthors ?? [],
      ),
    [books, settings.libraryPinnedAuthors, statusFilters],
  )
  const hasFilters = statusFilters.length > 0 || authorFilters.length > 0

  const toggle = (status: (typeof libraryStatusOptions)[number]) => {
    setStatusFilters((current) =>
      current.includes(status)
        ? current.filter((item) => item !== status)
        : [...current, status],
    )
  }

  const clearFilters = useCallback(() => {
    setStatusFilters([])
    setAuthorFilters([])
  }, [setAuthorFilters, setStatusFilters])

  const resetAuthors = useCallback(() => {
    setAuthorFilters([])
  }, [setAuthorFilters])

  const toggleAuthor = useCallback(
    (author: string) => {
      setAuthorFilters((current) => toggleLibraryAuthorFilter(current, author))
    },
    [setAuthorFilters],
  )

  const pinAuthor = useCallback(
    (author: string) => {
      setSettings((current) => ({
        ...current,
        libraryPinnedAuthors: pinLibraryAuthor(
          current.libraryPinnedAuthors ?? [],
          author,
        ),
      }))
    },
    [setSettings],
  )

  const unpinAuthor = useCallback(
    (author: string) => {
      setSettings((current) => ({
        ...current,
        libraryPinnedAuthors: unpinLibraryAuthor(
          current.libraryPinnedAuthors ?? [],
          author,
        ),
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

  return (
    <PaneView
      name={t('library_filter.title')}
      title={t('library_filter.title')}
      className={clsx('p-3', className)}
    >
      <div
        className="flex h-full min-h-0 flex-col gap-3"
        data-testid="library-filter-panel"
      >
        <div className="flex h-9 items-center justify-between gap-2">
          <div className="text-foreground text-lg leading-none font-semibold">
            {t('library_filter.title')}
          </div>
          <AppTooltip label={t('library_filter.clear')}>
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

        <section
          className={libraryFilterPanelClassName}
          data-testid="library-status-filter"
        >
          <div className={libraryFilterPanelHeaderClassName}>
            <div className={libraryFilterSectionHeaderClassName}>
              {t('library_filter.status')}
            </div>
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
                statusFilters.length !== 0 &&
                  libraryFilterInactiveChipClassName,
              )}
              onClick={() => setStatusFilters([])}
            >
              <ReadingStatusIcon
                status={null}
                className={
                  statusFilters.length === 0 ? 'text-primary-foreground' : ''
                }
              />
              <span className="min-w-0 truncate leading-none">
                {t('library_filter.all')}
              </span>
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
                  className={clsx(
                    libraryFilterChipClassName,
                    !active && libraryFilterInactiveChipClassName,
                  )}
                  onClick={() => toggle(status)}
                >
                  <ReadingStatusIcon
                    status={status}
                    className={active ? 'text-primary-foreground' : ''}
                  />
                  <span className="min-w-0 truncate leading-none">
                    {t(`reading_status.${status}`)}
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
        >
          {authorOptions.length ? (
            <div className={libraryFilterOptionsClassName}>
              {authorOptions.map((option) => (
                <AuthorFilterChip
                  key={option.name}
                  option={option}
                  active={authorFilters.includes(option.name)}
                  onToggle={() => toggleAuthor(option.name)}
                  onPin={() => pinAuthor(option.name)}
                  onUnpin={() => unpinAuthor(option.name)}
                />
              ))}
            </div>
          ) : (
            <div className="text-muted-foreground py-0.5 text-sm leading-tight">
              {t('library_filter.no_authors')}
            </div>
          )}
        </FilterSection>
      </div>
    </PaneView>
  )
}

interface FilterSectionProps extends PropsWithChildren {
  expanded: boolean
  onExpandedChange: (expanded: boolean) => void
  onReset: () => void
  resetDisabled: boolean
  resetLabel: string
  title: string
}

const FilterSection: React.FC<FilterSectionProps> = ({
  children,
  expanded,
  onExpandedChange,
  onReset,
  resetDisabled,
  resetLabel,
  title,
}) => {
  return (
    <section className={libraryFilterPanelClassName}>
      <div className={libraryFilterPanelHeaderClassName}>
        <UiButton
          type="button"
          variant="ghost"
          size="sm"
          aria-expanded={expanded}
          className="h-8 min-w-0 flex-1 justify-start gap-2 rounded-xl bg-transparent px-0 text-left hover:bg-transparent focus-visible:border-transparent focus-visible:ring-0 aria-expanded:bg-transparent aria-expanded:text-[var(--flow-text)]"
          onClick={() => onExpandedChange(!expanded)}
        >
          <ChevronDown
            aria-hidden
            className={clsx(
              'size-4.5 shrink-0 transition-transform',
              !expanded && '-rotate-90',
            )}
          />
          <span className={libraryFilterSectionHeaderClassName}>{title}</span>
        </UiButton>
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

interface AuthorFilterChipProps {
  active: boolean
  onPin: () => void
  onToggle: () => void
  onUnpin: () => void
  option: LibraryAuthorOption
}

const AuthorFilterChip: React.FC<AuthorFilterChipProps> = ({
  active,
  onPin,
  onToggle,
  onUnpin,
  option,
}) => {
  const t = useTranslation('home')
  const contextMenuRef = useRef<HTMLDivElement>(null)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number }>()

  const closeContextMenu = useCallback(() => {
    setContextMenu(undefined)
  }, [])

  const openContextMenu = useCallback((e: ReactMouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu(clampFilterContextMenuPosition(e.clientX, e.clientY))
  }, [])

  useEffect(() => {
    if (!contextMenu) return

    const onPointerDown = (e: PointerEvent) => {
      if (contextMenuRef.current?.contains(e.target as Node)) return
      closeContextMenu()
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeContextMenu()
    }

    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)

    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [closeContextMenu, contextMenu])

  return (
    <div className="relative max-w-full min-w-0" data-testid="author-chip-wrap">
      <UiButton
        type="button"
        size="sm"
        variant={active ? 'default' : 'secondary'}
        aria-pressed={active}
        aria-label={option.name}
        title={option.name}
        data-testid="library-author-chip"
        data-author={option.name}
        className={clsx(
          libraryFilterChipClassName,
          'max-w-full justify-start',
          !active && libraryFilterInactiveChipClassName,
        )}
        onClick={onToggle}
        onContextMenu={openContextMenu}
      >
        {option.pinned && (
          <PinIcon
            aria-hidden
            className={clsx(
              'size-3.5',
              active ? 'text-primary-foreground' : 'text-muted-foreground',
            )}
          />
        )}
        <span
          className="min-w-0 truncate leading-none"
          data-testid="library-author-chip-label"
        >
          {option.name}
        </span>
      </UiButton>

      {contextMenu && (
        <div
          ref={contextMenuRef}
          role="menu"
          data-testid="library-author-context-menu"
          className="ring-border bg-popover text-popover-foreground fixed z-[70] w-36 rounded-lg p-1 shadow-lg ring-1"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          <AuthorContextMenuButton
            Icon={PinIcon}
            label={t('library_filter.pin_author')}
            onClick={() => {
              onPin()
              closeContextMenu()
            }}
          />
          {option.pinned && (
            <AuthorContextMenuButton
              Icon={PinOffIcon}
              label={t('library_filter.unpin_author')}
              onClick={() => {
                onUnpin()
                closeContextMenu()
              }}
            />
          )}
        </div>
      )}
    </div>
  )
}

interface AuthorContextMenuButtonProps {
  Icon: LucideIcon
  label: string
  onClick: () => void
}

const AuthorContextMenuButton: React.FC<AuthorContextMenuButtonProps> = ({
  Icon,
  label,
  onClick,
}) => {
  return (
    <button
      type="button"
      role="menuitem"
      className="hover:bg-muted text-muted-foreground flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-base outline-none"
      onClick={onClick}
    >
      <Icon aria-hidden className="size-4 shrink-0" />
      <span className="min-w-0 truncate">{label}</span>
    </button>
  )
}

function clampFilterContextMenuPosition(x: number, y: number) {
  if (typeof window === 'undefined') return { x, y }

  return {
    x: Math.min(x, Math.max(8, window.innerWidth - 160)),
    y: Math.min(y, Math.max(8, window.innerHeight - 96)),
  }
}

interface ReaderProps extends ComponentProps<'div'> {}
const Reader: React.FC<ReaderProps> = ({ className, ...props }) => {
  useSplitViewItem(Reader)
  const [bg] = useBackground()

  return (
    <div
      className={clsx('Reader flex-1 overflow-hidden', className, bg)}
      {...props}
    />
  )
}
