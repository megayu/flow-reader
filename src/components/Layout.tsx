import clsx from 'clsx'
import {
  BookOpen,
  Focus,
  Highlighter,
  Image,
  Library,
  ListFilter,
  Maximize,
  Minimize,
  Search,
  Settings,
  Sun,
  TableOfContents,
  Type,
  type LucideIcon,
} from 'lucide-react'
import {
  ComponentProps,
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
import { useTranslation } from '../hooks/useTranslation'
import { useReaderSnapshot } from '../models/reader'
import { getShortcutChords, type ShortcutActionId } from '../shortcuts'
import {
  useLibraryStatusFilter,
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
const libraryFilterButtonClassName =
  'h-9 w-full justify-start gap-2 px-3 text-base leading-none'
const libraryFilterInactiveButtonClassName =
  'bg-[var(--flow-sidebar-item-bg)] ring-1 ring-[var(--flow-sidebar-item-border)] ring-inset hover:bg-[var(--flow-sidebar-item-bg-hover)] aria-expanded:bg-[var(--flow-sidebar-item-bg-active)]'

function LibraryFilterView({ className }: ComponentProps<'div'>) {
  const t = useTranslation('home')
  const [filters, setFilters] = useLibraryStatusFilter()

  const toggle = (status: (typeof libraryStatusOptions)[number]) => {
    setFilters((current) =>
      current.includes(status)
        ? current.filter((item) => item !== status)
        : [...current, status],
    )
  }

  return (
    <PaneView
      name={t('library_filter.title')}
      title={t('library_filter.title')}
      className={clsx('p-3', className)}
    >
      <div className="space-y-2">
        <UiButton
          type="button"
          variant={filters.length === 0 ? 'default' : 'secondary'}
          className={clsx(
            libraryFilterButtonClassName,
            filters.length !== 0 && libraryFilterInactiveButtonClassName,
          )}
          onClick={() => setFilters([])}
        >
          <ReadingStatusIcon
            status={null}
            className={filters.length === 0 ? 'text-primary-foreground' : ''}
          />
          <span className="leading-none">{t('library_filter.all')}</span>
        </UiButton>
        {libraryStatusOptions.map((status) => {
          const active = filters.includes(status)
          return (
            <UiButton
              key={status}
              type="button"
              variant={active ? 'default' : 'secondary'}
              className={clsx(
                libraryFilterButtonClassName,
                !active && libraryFilterInactiveButtonClassName,
              )}
              onClick={() => toggle(status)}
            >
              <ReadingStatusIcon
                status={status}
                className={active ? 'text-primary-foreground' : ''}
              />
              <span className="min-w-0 flex-1 text-left leading-none">
                {t(`reading_status.${status}`)}
              </span>
              {active && <span aria-hidden>✓</span>}
            </UiButton>
          )
        })}
      </div>
    </PaneView>
  )
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
