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
  memo,
  type PropsWithChildren,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

import { SettingsDialog } from '@/settings/SettingsDialog'

import { useBackground } from '../hooks/theme/useBackground'
import { useColorScheme } from '../hooks/theme/useColorScheme'
import { type LibraryAction, type Action as ReaderPanelAction, useAction, useLibraryAction } from '../hooks/useAction'
import { useLibrary, useLibraryPins, useLibraryTags } from '../hooks/useLibrary'
import { useTranslation } from '../hooks/useTranslation'
import { isGlobalKeyboardShortcutBlocked } from '../keyboard'
import {
  areStringListsEqual,
  cleanLibraryTagName,
  getLibraryAuthorOptions,
  getLibraryTagOptions,
  pruneLibraryAuthorFilters,
  pruneLibraryTagFilters,
  sameLibraryTagName,
  toggleLibraryAuthorFilter,
  toggleLibraryTagFilter,
} from '../library/filters'
import { toMessageKeySegment } from '../locales'
import { useReaderSnapshot } from '../models/reader'
import { getShortcutChords, type ShortcutActionId } from '../shortcuts'
import {
  useLibraryAuthorFilter,
  useLibraryAuthorFilterExpanded,
  useLibraryStatusFilter,
  useLibraryTagFilter,
  useLibraryTagFilterExpanded,
  useSettingsDialogOpen,
  useSetZenTypographyOverrides,
  useSidebarWidth,
  useViewMode,
  useViewModeValue,
  useZenMode,
  useZenModeValue,
} from '../state'
import { db, type LibraryTagRecord } from '../storage'
import { activeClass } from '../styles'

import { AppTooltip } from './AppTooltip'
import { OverlayScroll, type OverlayScrollbarMetrics, PaneView } from './base/PaneView'
import { SplitView } from './base/SplitView'
import { useSplitViewItem } from './base/splitViewContext'
import { ReadingStatusIcon } from './ReadingStatusIcon'
import { Button as UiButton } from './ui/button'
import { ConfirmDialog } from './ui/confirm-dialog'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog'
import { Input } from './ui/input'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from './ui/menu'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'
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
        title: viewMode === 'library' ? 'mode.resume_reading' : 'mode.back_to_library',
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
              onClick={
                name === 'theme'
                  ? undefined
                  : () => {
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
                    }
              }
            />
          )

          if (name === 'theme') {
            return (
              <Popover key={name} open={themeOpen} onOpenChange={setThemeOpen}>
                <PopoverTrigger asChild>{actionButton}</PopoverTrigger>
                <PopoverContent
                  side="right"
                  align="end"
                  sideOffset={4}
                  collisionPadding={8}
                  variant="bare"
                  className="rounded-xl"
                >
                  <ThemePanel onClose={() => setThemeOpen(false)} />
                </PopoverContent>
              </Popover>
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
  const [sidebarWidth, setSidebarWidth] = useSidebarWidth(viewMode)

  const { size } = useSplitViewItem('SideBar', {
    preferredSize: 240,
    minSize: 160,
    initialSize: sidebarWidth,
    onSizeChange: setSidebarWidth,
    visible: !!activeAction,
  })

  return (
    <div
      className={clsx('SideBar flex flex-col', background.sidebarClassName, !activeAction && 'hidden!')}
      style={{ width: size }}
    >
      {actions.map(({ name, View }) => (
        <View active={name === activeAction} key={name} className={clsx(name !== activeAction && 'hidden!')} />
      ))}
    </div>
  )
}

const libraryStatusOptions = ['toRead', 'reading', 'read'] as const
const libraryFilterPanelClassName =
  'rounded-md bg-(--flow-sidebar-item-bg)/70 p-1.5 ring-(--flow-sidebar-item-border) ring-inset'
const libraryFilterPanelHeaderClassName = 'mb-1 flex h-7 shrink-0 items-center gap-0.5'
const libraryFilterOptionsClassName = 'flex min-w-0 flex-wrap gap-1'
const libraryFilterChipClassName = 'h-7 max-w-full min-w-0 gap-1 px-1.5 text-sm leading-tight'
const libraryFilterInactiveChipClassName =
  'bg-transparent text-(--flow-text) ring-1 ring-(--flow-sidebar-item-border) ring-inset hover:bg-(--flow-sidebar-item-bg-hover)'
const libraryFilterSectionHeaderClassName = 'text-(--flow-text) text-base leading-none font-semibold'
const libraryFilterIconButtonClassName = 'size-7 rounded-md text-(--flow-text-muted) hover:text-(--flow-text)'
const libraryFilterSectionIconButtonClassName = 'size-7 rounded-md text-(--flow-text-muted) hover:text-(--flow-text)'

type LibraryFacetSearchTarget = 'author' | 'tag'

interface LibraryFacetSearchState {
  lockedHeight?: number
  restoreCollapsed: boolean
  scrollTop: number
  target: LibraryFacetSearchTarget
}

function LibraryFilterView({ className }: ComponentProps<'div'>) {
  const t = useTranslation('home')
  const books = useLibrary()
  const tags = useLibraryTags()
  const pins = useLibraryPins()
  const [libraryAction, setLibraryAction] = useLibraryAction()
  const [statusFilters, setStatusFilters] = useLibraryStatusFilter()
  const [authorFilters, setAuthorFilters] = useLibraryAuthorFilter()
  const [tagFilters, setTagFilters] = useLibraryTagFilter()
  const [authorsExpanded, setAuthorsExpanded] = useLibraryAuthorFilterExpanded()
  const [tagsExpanded, setTagsExpanded] = useLibraryTagFilterExpanded()
  const [facetSearch, setFacetSearch] = useState<LibraryFacetSearchState>()
  const [facetSearchQuery, setFacetSearchQuery] = useState('')
  const [creatingTag, setCreatingTag] = useState(false)
  const [newTagName, setNewTagName] = useState('')
  const [editingTag, setEditingTag] = useState<LibraryTagRecord>()
  const [deletingTag, setDeletingTag] = useState<LibraryTagRecord>()
  const newTagInputRef = useRef<HTMLInputElement>(null)
  const authorSearchInputRef = useRef<HTMLInputElement>(null)
  const tagSearchInputRef = useRef<HTMLInputElement>(null)
  const authorSectionRef = useRef<HTMLElement>(null)
  const tagSectionRef = useRef<HTMLElement>(null)
  const authorScrollRef = useRef<HTMLDivElement>(null)
  const tagScrollRef = useRef<HTMLDivElement>(null)
  const facetSearchRef = useRef<LibraryFacetSearchState | undefined>(undefined)
  const authorOptions = useMemo(
    () => getLibraryAuthorOptions(books ?? [], statusFilters, pins?.authors ?? []),
    [books, pins?.authors, statusFilters],
  )
  const tagOptions = useMemo(
    () => getLibraryTagOptions(books ?? [], statusFilters, tags ?? [], pins?.tagIds ?? []),
    [books, pins?.tagIds, statusFilters, tags],
  )
  const tagsById = useMemo(() => new Map((tags ?? []).map((tag) => [tag.id, tag])), [tags])
  const normalizedFacetSearchQuery = facetSearchQuery.toLocaleLowerCase()
  const visibleAuthorOptions = useMemo(() => {
    if (facetSearch?.target !== 'author' || !normalizedFacetSearchQuery) return authorOptions

    return authorOptions.filter((option) => option.name.toLocaleLowerCase().indexOf(normalizedFacetSearchQuery) !== -1)
  }, [authorOptions, facetSearch?.target, normalizedFacetSearchQuery])
  const visibleTagOptions = useMemo(() => {
    if (facetSearch?.target !== 'tag' || !normalizedFacetSearchQuery) return tagOptions

    return tagOptions.filter((option) => option.name.toLocaleLowerCase().indexOf(normalizedFacetSearchQuery) !== -1)
  }, [facetSearch?.target, normalizedFacetSearchQuery, tagOptions])
  const selectedAuthors = useMemo(() => new Set(authorFilters), [authorFilters])
  const selectedTagIds = useMemo(() => new Set(tagFilters), [tagFilters])
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

  const exitFacetSearch = useCallback(
    (target?: LibraryFacetSearchTarget) => {
      const current = facetSearchRef.current
      if (!current || (target && current.target !== target)) return

      facetSearchRef.current = undefined
      setFacetSearch(undefined)
      setFacetSearchQuery('')
      if (current.restoreCollapsed) {
        if (current.target === 'author') setAuthorsExpanded(false)
        else setTagsExpanded(false)
      }

      const scrollRef = current.target === 'author' ? authorScrollRef : tagScrollRef
      requestAnimationFrame(() => {
        if (scrollRef.current) scrollRef.current.scrollTop = current.scrollTop
      })
    },
    [setAuthorsExpanded, setTagsExpanded],
  )

  const startFacetSearch = useCallback(
    (target: LibraryFacetSearchTarget) => {
      const current = facetSearchRef.current
      const inputRef = target === 'author' ? authorSearchInputRef : tagSearchInputRef
      if (current?.target === target) {
        inputRef.current?.focus()
        return
      }

      if (current) {
        if (current.restoreCollapsed) {
          if (current.target === 'author') setAuthorsExpanded(false)
          else setTagsExpanded(false)
        }

        const previousScrollRef = current.target === 'author' ? authorScrollRef : tagScrollRef
        requestAnimationFrame(() => {
          if (previousScrollRef.current) previousScrollRef.current.scrollTop = current.scrollTop
        })
      }

      const expanded = target === 'author' ? authorsExpanded : tagsExpanded
      const sectionRef = target === 'author' ? authorSectionRef : tagSectionRef
      const scrollRef = target === 'author' ? authorScrollRef : tagScrollRef
      const measuredHeight = expanded ? sectionRef.current?.getBoundingClientRect().height : undefined
      const nextSearch: LibraryFacetSearchState = {
        lockedHeight: measuredHeight && measuredHeight > 0 ? measuredHeight : undefined,
        restoreCollapsed: !expanded,
        scrollTop: scrollRef.current?.scrollTop ?? 0,
        target,
      }
      facetSearchRef.current = nextSearch
      setFacetSearch(nextSearch)
      setFacetSearchQuery('')
      setLibraryAction('libraryFilter')
      if (!expanded) {
        if (target === 'author') setAuthorsExpanded(true)
        else setTagsExpanded(true)
      }

      requestAnimationFrame(() => inputRef.current?.focus())
    },
    [authorsExpanded, setAuthorsExpanded, setLibraryAction, setTagsExpanded, tagsExpanded],
  )

  const lockFacetSearchHeight = useCallback((target: LibraryFacetSearchTarget, height: number) => {
    const current = facetSearchRef.current
    if (!current || current.target !== target || current.lockedHeight !== undefined || height <= 0) return

    const nextSearch = { ...current, lockedHeight: height }
    facetSearchRef.current = nextSearch
    setFacetSearch(nextSearch)
  }, [])

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

  const pinAuthor = useCallback((author: string) => {
    void db.pins.pinAuthor(author)
  }, [])

  const unpinAuthor = useCallback((author: string) => {
    void db.pins.unpinAuthor(author)
  }, [])

  const pinTag = useCallback((tagId: string) => {
    void db.pins.pinTag(tagId)
  }, [])

  const unpinTag = useCallback((tagId: string) => {
    void db.pins.unpinTag(tagId)
  }, [])

  const editTag = useCallback(
    (tagId: string) => {
      setEditingTag(tagsById.get(tagId))
    },
    [tagsById],
  )

  const deleteTag = useCallback(
    (tagId: string) => {
      setDeletingTag(tagsById.get(tagId))
    },
    [tagsById],
  )

  const tagMenuItems = useMemo<LibraryFilterMenuItem[]>(
    () => [
      {
        Icon: PencilIcon,
        label: t('library_filter.edit_tag'),
        onClick: editTag,
      },
      {
        danger: true,
        Icon: Trash2Icon,
        label: t('library_filter.delete_tag'),
        onClick: deleteTag,
      },
    ],
    [deleteTag, editTag, t],
  )

  useEffect(() => {
    const next = pruneLibraryAuthorFilters(authorFilters, authorOptions)
    if (!areStringListsEqual(authorFilters, next)) setAuthorFilters(next)
  }, [authorFilters, authorOptions, setAuthorFilters])

  useEffect(() => {
    const next = pruneLibraryTagFilters(tagFilters, tagOptions)
    if (!areStringListsEqual(tagFilters, next)) setTagFilters(next)
  }, [setTagFilters, tagFilters, tagOptions])

  useEffect(() => {
    if (!creatingTag) return

    requestAnimationFrame(() => newTagInputRef.current?.focus())
  }, [creatingTag])

  const handleLibraryFilterKeyDown = useEffectEvent((e: KeyboardEvent) => {
    const searchTarget = getLibraryFacetSearchShortcutTarget(e)
    if (searchTarget) {
      const insideFacetSearch = e.target instanceof Element && e.target.closest('[data-library-facet-search]') !== null
      if (isLibraryFilterShortcutBlocked(e) && !insideFacetSearch) return

      e.preventDefault()
      e.stopPropagation()
      e.stopImmediatePropagation()
      startFacetSearch(searchTarget)
      return
    }

    if (
      libraryAction !== 'libraryFilter' ||
      e.key !== 'Escape' ||
      e.defaultPrevented ||
      isLibraryFilterShortcutBlocked(e)
    )
      return

    e.preventDefault()
    e.stopPropagation()

    if (hasFilters) {
      clearFilters()
    }
  })

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      handleLibraryFilterKeyDown(e)
    }

    document.addEventListener('keydown', onKeyDown, { capture: true })

    return () => {
      document.removeEventListener('keydown', onKeyDown, { capture: true })
    }
  }, [])

  return (
    <PaneView className={clsx('p-2', className)}>
      <div className="flex h-full min-h-0 flex-col gap-1.5" data-testid="library-filter-panel">
        <div className="flex h-7 shrink-0 items-center justify-between gap-1.5">
          <div className="text-foreground text-base leading-none font-semibold">{t('library_filter.title')}</div>
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
              <XIcon aria-hidden className="size-3.5" />
            </UiButton>
          </AppTooltip>
        </div>

        <section className={clsx(libraryFilterPanelClassName, 'shrink-0')} data-testid="library-status-filter">
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
              <span className="min-w-0 truncate leading-tight">{t('library_filter.all')}</span>
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
                  <span className="min-w-0 truncate leading-tight">
                    {t(`reading_status.${toMessageKeySegment(status)}`)}
                  </span>
                </UiButton>
              )
            })}
          </div>
        </section>

        <FilterSection
          sectionRef={tagSectionRef}
          scrollRef={tagScrollRef}
          title={t('library_filter.tags')}
          expanded={tagsExpanded}
          onExpandedChange={setTagsExpanded}
          searching={facetSearch?.target === 'tag'}
          searchInputRef={tagSearchInputRef}
          searchLabel={t('library_filter.search_tags')}
          searchQuery={facetSearch?.target === 'tag' ? facetSearchQuery : ''}
          searchShortcutId="libraryTagSearch"
          lockedHeight={facetSearch?.target === 'tag' ? facetSearch.lockedHeight : undefined}
          onSearch={() => startFacetSearch('tag')}
          onSearchExit={() => exitFacetSearch('tag')}
          onSearchHeightLocked={(height) => lockFacetSearchHeight('tag', height)}
          onSearchQueryChange={setFacetSearchQuery}
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
                className={libraryFilterSectionIconButtonClassName}
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
          {tagsExpanded && (
            <>
              {creatingTag && (
                <div className="mb-1">
                  <Input
                    ref={newTagInputRef}
                    aria-label={t('library_filter.new_tag')}
                    value={newTagName}
                    onValueChange={setNewTagName}
                    onExitEditing={() => {
                      setCreatingTag(false)
                      setNewTagName('')
                    }}
                    onKeyDown={(e) => {
                      if (e.key !== 'Enter') return

                      e.preventDefault()
                      void createGlobalTag()
                    }}
                    className="focus-visible:border-input h-7 rounded-md px-2 text-sm focus-visible:ring-0"
                  />
                </div>
              )}
              {visibleTagOptions.length ? (
                <div className={libraryFilterOptionsClassName}>
                  {visibleTagOptions.map((option) => (
                    <LibraryFilterChip
                      key={option.id}
                      value={option.id}
                      active={selectedTagIds.has(option.id)}
                      preserveInputFocus={facetSearch?.target === 'tag'}
                      label={option.name}
                      pinned={option.pinned}
                      testId="library-tag-chip"
                      labelTestId="library-tag-chip-label"
                      contextMenuTestId="library-tag-context-menu"
                      onToggle={toggleTag}
                      pinLabel={t('library_filter.pin_tag')}
                      unpinLabel={t('library_filter.unpin_tag')}
                      onPin={pinTag}
                      onUnpin={unpinTag}
                      menuItems={tagMenuItems}
                    />
                  ))}
                </div>
              ) : (
                <div className="text-muted-foreground py-0.5 text-sm leading-tight">{t('library_filter.no_tags')}</div>
              )}
            </>
          )}
        </FilterSection>

        <FilterSection
          sectionRef={authorSectionRef}
          scrollRef={authorScrollRef}
          title={t('library_filter.author')}
          expanded={authorsExpanded}
          onExpandedChange={setAuthorsExpanded}
          searching={facetSearch?.target === 'author'}
          searchInputRef={authorSearchInputRef}
          searchLabel={t('library_filter.search_authors')}
          searchQuery={facetSearch?.target === 'author' ? facetSearchQuery : ''}
          searchShortcutId="libraryAuthorSearch"
          lockedHeight={facetSearch?.target === 'author' ? facetSearch.lockedHeight : undefined}
          onSearch={() => startFacetSearch('author')}
          onSearchExit={() => exitFacetSearch('author')}
          onSearchHeightLocked={(height) => lockFacetSearchHeight('author', height)}
          onSearchQueryChange={setFacetSearchQuery}
          resetLabel={t('library_filter.reset')}
          resetDisabled={!authorFilters.length}
          onReset={resetAuthors}
          testId="library-author-section"
        >
          {authorsExpanded &&
            (visibleAuthorOptions.length ? (
              <div className={libraryFilterOptionsClassName}>
                {visibleAuthorOptions.map((option) => (
                  <LibraryFilterChip
                    key={option.name}
                    value={option.name}
                    label={option.name}
                    pinned={option.pinned}
                    testId="library-author-chip"
                    labelTestId="library-author-chip-label"
                    contextMenuTestId="library-author-context-menu"
                    active={selectedAuthors.has(option.name)}
                    preserveInputFocus={facetSearch?.target === 'author'}
                    onToggle={toggleAuthor}
                    pinLabel={t('library_filter.pin_author')}
                    unpinLabel={t('library_filter.unpin_author')}
                    onPin={pinAuthor}
                    onUnpin={unpinAuthor}
                  />
                ))}
              </div>
            ) : (
              <div className="text-muted-foreground py-0.5 text-sm leading-tight">{t('library_filter.no_authors')}</div>
            ))}
        </FilterSection>
      </div>
      {editingTag && (
        <EditLibraryTagDialog key={editingTag.id} tag={editingTag} onClose={() => setEditingTag(undefined)} />
      )}
      {deletingTag && (
        <DeleteLibraryTagDialog
          tag={deletingTag}
          onDeleted={() => {
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

function getLibraryFacetSearchShortcutTarget(e: KeyboardEvent): LibraryFacetSearchTarget | undefined {
  const hasPrimaryModifier = (e.ctrlKey || e.metaKey) && !(e.ctrlKey && e.metaKey)
  if (!hasPrimaryModifier || e.altKey || e.shiftKey) return undefined

  if (e.code === 'KeyE' || e.key.toLocaleLowerCase() === 'e') return 'author'
  if (e.code === 'KeyT' || e.key.toLocaleLowerCase() === 't') return 'tag'
  return undefined
}

function useFilterSectionScrollbar(
  scrollRef: RefObject<HTMLDivElement | null>,
  contentRef: RefObject<HTMLDivElement | null>,
  active: boolean,
): OverlayScrollbarMetrics {
  const [metrics, setMetrics] = useState({ scrollTop: 0, totalSize: 0, viewportHeight: 0 })
  const updateMetrics = useCallback(() => {
    const scroll = scrollRef.current
    if (!scroll) return

    const next = {
      scrollTop: scroll.scrollTop,
      totalSize: scroll.scrollHeight,
      viewportHeight: scroll.clientHeight,
    }
    setMetrics((current) =>
      current.scrollTop === next.scrollTop &&
      current.totalSize === next.totalSize &&
      current.viewportHeight === next.viewportHeight
        ? current
        : next,
    )
  }, [scrollRef])

  useLayoutEffect(() => {
    if (active) updateMetrics()
  })

  useEffect(() => {
    if (!active) return

    const scroll = scrollRef.current
    const content = contentRef.current
    if (!scroll || !content) return

    scroll.addEventListener('scroll', updateMetrics, { passive: true })
    if (typeof ResizeObserver === 'undefined') {
      return () => scroll.removeEventListener('scroll', updateMetrics)
    }

    const observer = new ResizeObserver(updateMetrics)
    observer.observe(scroll)
    observer.observe(content)

    return () => {
      scroll.removeEventListener('scroll', updateMetrics)
      observer.disconnect()
    }
  }, [active, contentRef, scrollRef, updateMetrics])

  return { scrollRef, ...metrics }
}

interface FilterSectionProps extends PropsWithChildren {
  actions?: ReactNode
  expanded: boolean
  lockedHeight?: number
  onExpandedChange: (expanded: boolean) => void
  onReset: () => void
  onSearch: () => void
  onSearchExit: () => void
  onSearchHeightLocked: (height: number) => void
  onSearchQueryChange: (query: string) => void
  resetDisabled: boolean
  resetLabel: string
  scrollRef: RefObject<HTMLDivElement | null>
  searchInputRef: RefObject<HTMLInputElement | null>
  searchLabel: string
  searchQuery: string
  searching: boolean
  searchShortcutId: ShortcutActionId
  sectionRef: RefObject<HTMLElement | null>
  testId?: string
  title: string
}

const FilterSection: React.FC<FilterSectionProps> = ({
  actions,
  children,
  expanded,
  lockedHeight,
  onExpandedChange,
  onReset,
  onSearch,
  onSearchExit,
  onSearchHeightLocked,
  onSearchQueryChange,
  resetDisabled,
  resetLabel,
  scrollRef,
  searchInputRef,
  searchLabel,
  searchQuery,
  searching,
  searchShortcutId,
  sectionRef,
  testId,
  title,
}) => {
  const contentRef = useRef<HTMLDivElement>(null)
  const scrollbar = useFilterSectionScrollbar(scrollRef, contentRef, expanded)

  useLayoutEffect(() => {
    if (!searching || lockedHeight !== undefined || !sectionRef.current) return

    onSearchHeightLocked(sectionRef.current.getBoundingClientRect().height)
  }, [lockedHeight, onSearchHeightLocked, searching, sectionRef])

  return (
    <section
      ref={sectionRef}
      className={clsx(
        libraryFilterPanelClassName,
        'flex min-h-0 flex-col overflow-hidden',
        lockedHeight === undefined ? 'flex-1 basis-0' : 'shrink',
      )}
      data-testid={testId}
      style={{ height: lockedHeight, maxHeight: lockedHeight ?? 'max-content' }}
    >
      <div className={libraryFilterPanelHeaderClassName}>
        {searching ? (
          <div className="border-input focus-within:border-ring flex h-7 min-w-0 flex-1 items-center gap-1 rounded-md border px-1.5">
            <Search aria-hidden className="text-muted-foreground size-3.5 shrink-0" />
            <Input
              ref={searchInputRef}
              data-library-facet-search="true"
              aria-label={searchLabel}
              value={searchQuery}
              escapeBehavior="exit"
              focusBehavior="native"
              onBlur={onSearchExit}
              onExitEditing={onSearchExit}
              onValueChange={onSearchQueryChange}
              className="h-6 min-w-0 border-0 px-0 py-0 text-sm transition-none focus-visible:border-transparent focus-visible:ring-0"
            />
            <UiButton
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={searchLabel}
              className="text-muted-foreground hover:text-foreground -mr-1 size-6 shrink-0 rounded-sm"
              onPointerDown={(event) => {
                if (event.button === 0) event.preventDefault()
              }}
              onClick={onSearchExit}
            >
              <XIcon aria-hidden className="size-4.5" />
            </UiButton>
          </div>
        ) : (
          <>
            <UiButton
              type="button"
              variant="ghost"
              size="sm"
              aria-label={`${title} section`}
              aria-expanded={expanded}
              className="h-7 min-w-0 flex-1 justify-start gap-1.5 overflow-hidden rounded-xl bg-transparent px-0 text-left hover:bg-transparent focus-visible:border-transparent focus-visible:ring-0 aria-expanded:bg-transparent aria-expanded:text-(--flow-text)"
              onClick={() => onExpandedChange(!expanded)}
            >
              <span className={clsx(libraryFilterSectionHeaderClassName, 'min-w-0 truncate')}>{title}</span>
              <ChevronDown
                aria-hidden
                className={clsx('size-4.5 shrink-0 transition-transform', !expanded && '-rotate-90')}
              />
            </UiButton>
            {actions}
            <AppTooltip label={searchLabel} shortcut={getPrimaryShortcut(searchShortcutId)}>
              <UiButton
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={searchLabel}
                className={libraryFilterSectionIconButtonClassName}
                onClick={onSearch}
              >
                <Search aria-hidden className="size-4" />
              </UiButton>
            </AppTooltip>
            <AppTooltip label={resetLabel}>
              <UiButton
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={resetLabel}
                className={libraryFilterSectionIconButtonClassName}
                disabled={resetDisabled}
                onClick={(e) => {
                  e.stopPropagation()
                  onReset()
                }}
              >
                <RotateCcwIcon aria-hidden className="size-4" />
              </UiButton>
            </AppTooltip>
          </>
        )}
      </div>

      {expanded && (
        <OverlayScroll ref={scrollRef} containerClassName="min-h-0 flex-1" scrollbar={scrollbar} className="pr-0.5">
          <div ref={contentRef}>{children}</div>
        </OverlayScroll>
      )}
    </section>
  )
}

interface LibraryFilterMenuItem {
  danger?: boolean
  Icon: LucideIcon
  label: string
  onClick: (value: string) => void
}

const EMPTY_LIBRARY_FILTER_MENU_ITEMS: LibraryFilterMenuItem[] = []

interface LibraryFilterChipProps {
  active: boolean
  contextMenuTestId: string
  label: string
  labelTestId: string
  menuItems?: LibraryFilterMenuItem[]
  onPin: (value: string) => void
  onToggle: (value: string) => void
  onUnpin: (value: string) => void
  pinLabel: string
  pinned: boolean
  preserveInputFocus?: boolean
  testId: string
  unpinLabel: string
  value: string
}

const LibraryFilterChip = memo(function LibraryFilterChip({
  active,
  contextMenuTestId,
  label,
  labelTestId,
  menuItems = EMPTY_LIBRARY_FILTER_MENU_ITEMS,
  onPin,
  onToggle,
  onUnpin,
  pinLabel,
  pinned,
  preserveInputFocus = false,
  testId,
  unpinLabel,
  value,
}: LibraryFilterChipProps) {
  const labelRef = useRef<HTMLSpanElement>(null)

  const updateOverflowTitle = useCallback(
    (button: HTMLButtonElement) => {
      const labelElement = labelRef.current
      if (!labelElement) return

      button.title = labelElement.scrollWidth > labelElement.clientWidth ? label : ''
    },
    [label],
  )

  useLayoutEffect(() => {
    const labelElement = labelRef.current
    const button = labelElement?.closest('button')
    if (button instanceof HTMLButtonElement) updateOverflowTitle(button)
  }, [updateOverflowTitle])

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
            data-testid={testId}
            data-value={value}
            className={clsx(
              libraryFilterChipClassName,
              'max-w-full justify-start',
              !active && libraryFilterInactiveChipClassName,
            )}
            onPointerDown={(event) => {
              if (preserveInputFocus && event.button === 0) event.preventDefault()
            }}
            onPointerEnter={(event) => updateOverflowTitle(event.currentTarget)}
            onClick={() => onToggle(value)}
          >
            {pinned && (
              <PinIcon
                aria-hidden
                className={clsx('size-3.5', active ? 'text-primary-foreground' : 'text-muted-foreground')}
              />
            )}
            <span ref={labelRef} className="min-w-0 truncate leading-tight" data-testid={labelTestId}>
              {label}
            </span>
          </UiButton>
        </ContextMenuTrigger>
        <ContextMenuContent data-testid={contextMenuTestId}>
          <LibraryFilterContextMenuItem
            Icon={PinIcon}
            label={pinLabel}
            onSelect={() => {
              onPin(value)
            }}
          />
          {pinned && (
            <LibraryFilterContextMenuItem
              Icon={PinOffIcon}
              label={unpinLabel}
              onSelect={() => {
                onUnpin(value)
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
                item.onClick(value)
              }}
            />
          ))}
        </ContextMenuContent>
      </ContextMenu>
    </div>
  )
})

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
        className="w-[min(24rem,calc(100vw-2rem))] max-w-none text-base"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          inputRef.current?.focus()
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
              focusBehavior="select-all"
              onValueChange={(nextName) =>
                setNameState((state) => ({
                  ...state,
                  name: nextName,
                }))
              }
              className="focus-visible:border-input text-base focus-visible:ring-0"
            />
          </label>
          <DialogFooter>
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
    <ConfirmDialog
      title={t('library_filter.delete_tag')}
      description={
        <>
          {t('library_filter.delete_tag_message')} <span className="text-foreground font-medium">{tag.name}</span>
        </>
      }
      cancelLabel={t('cancel')}
      confirmLabel={t('library_filter.delete_tag')}
      onClose={onClose}
      onConfirm={remove}
    />
  )
}

interface ReaderProps extends ComponentProps<'div'> {}
const Reader: React.FC<ReaderProps> = ({ className, ...props }) => {
  useSplitViewItem(Reader)
  const [bg] = useBackground()

  return <div className={clsx('Reader flex-1 overflow-hidden', className, bg)} {...props} />
}
