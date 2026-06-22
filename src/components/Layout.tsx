import { Overlay } from '@literal-ui/core'
import clsx from 'clsx'
import {
  ComponentProps,
  PropsWithChildren,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { IconType } from 'react-icons'
import {
  MdCenterFocusStrong,
  MdFormatUnderlined,
  MdFullscreen,
  MdFullscreenExit,
  MdFilterList,
  MdLibraryBooks,
  MdMenuBook,
  MdOutlineImage,
  MdSearch,
  MdToc,
  MdOutlineLightMode,
} from 'react-icons/md'
import { RiFontSize, RiHome6Line, RiSettings5Line } from 'react-icons/ri'
import { useRecoilState, useRecoilValue, useSetRecoilState } from 'recoil'

import {
  Env,
  type Action as ReaderPanelAction,
  type LibraryAction,
  useAction,
  useLibraryAction,
  useBackground,
  useColorScheme,
  useMobile,
  useTranslation,
} from '../hooks'
import { reader, useReaderSnapshot } from '../models'
import {
  navbarState,
  libraryStatusFilterState,
  settingsDialogOpenState,
  viewModeState,
  zenModeState,
  zenTypographyOverridesState,
} from '../state'
import { activeClass } from '../styles'

import { PaneView, SplitView, useSplitViewItem } from './base'
import { SettingsDialog } from './pages'
import { AnnotationView } from './viewlets/AnnotationView'
import { ImageView } from './viewlets/ImageView'
import { SearchView } from './viewlets/SearchView'
import { ThemePanel } from './viewlets/ThemeView'
import { TocView } from './viewlets/TocView'
import { TypographyView } from './viewlets/TypographyView'

export const Layout: React.FC<PropsWithChildren> = ({ children }) => {
  useColorScheme()

  const [ready, setReady] = useState(false)
  const [settingsOpen, setSettingsOpen] = useRecoilState(
    settingsDialogOpenState,
  )
  const [action, setAction] = useAction()
  const actionBeforeZen = useRef<ReaderPanelAction | undefined>()
  const zenModeRef = useRef(false)
  const mobile = useMobile()
  const zenMode = useRecoilValue(zenModeState)
  const { focusedBookTab } = useReaderSnapshot()
  const setZenTypographyOverrides = useSetRecoilState(
    zenTypographyOverridesState,
  )

  useEffect(() => {
    if (mobile === undefined) return
    if (mobile) setAction(undefined)
    setReady(true)
  }, [mobile, setAction])

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
        {!zenMode && mobile === false && (
          <ActivityBar
            settingsOpen={settingsOpen}
            onSettingsOpenChange={setSettingsOpen}
          />
        )}
        {!zenMode && mobile === true && (
          <NavigationBar
            settingsOpen={settingsOpen}
            onSettingsOpenChange={setSettingsOpen}
          />
        )}
        {ready && !zenMode && <SideBar />}
        {ready && <Reader>{children}</Reader>}
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
  Icon: IconType
  env: number
}
interface IViewAction extends IAction {
  name: ReaderPanelAction
  View: React.FC<any>
}

const viewActions: IViewAction[] = [
  {
    name: 'toc',
    title: 'toc',
    Icon: MdToc,
    View: TocView,
    env: Env.Desktop | Env.Mobile,
  },
  {
    name: 'search',
    title: 'search',
    Icon: MdSearch,
    View: SearchView,
    env: Env.Desktop | Env.Mobile,
  },
  {
    name: 'annotation',
    title: 'annotation',
    Icon: MdFormatUnderlined,
    View: AnnotationView,
    env: Env.Desktop | Env.Mobile,
  },
  {
    name: 'image',
    title: 'image',
    Icon: MdOutlineImage,
    View: ImageView,
    env: Env.Desktop,
  },
  {
    name: 'typography',
    title: 'typography',
    Icon: RiFontSize,
    View: TypographyView,
    env: Env.Desktop | Env.Mobile,
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
    Icon: MdFilterList,
    View: LibraryFilterView,
    env: Env.Desktop | Env.Mobile,
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
      <ViewActionBar env={Env.Desktop} />
      <PageActionBar
        env={Env.Desktop}
        settingsOpen={settingsOpen}
        onSettingsOpenChange={onSettingsOpenChange}
      />
    </div>
  )
}

interface EnvActionBarProps extends ComponentProps<'div'> {
  env: Env
}

interface PageActionBarProps extends EnvActionBarProps, SettingsActionProps {}

function ViewActionBar({ className, env }: EnvActionBarProps) {
  const [action, setAction] = useAction()
  const [libraryAction, setLibraryAction] = useLibraryAction()
  const viewMode = useRecoilValue(viewModeState)
  const t = useTranslation()
  const actions: Array<IViewAction | ILibraryViewAction> =
    viewMode === 'library' ? libraryViewActions : viewActions
  const activeAction = viewMode === 'library' ? libraryAction : action

  return (
    <ActionBar className={className}>
      {actions
        .filter((a) => a.env & env)
        .map(({ name, title, Icon }) => {
          const active = activeAction === name
          return (
            <Action
              title={t(`${title}.title`)}
              Icon={Icon}
              active={active}
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
  env,
  settingsOpen,
  onSettingsOpenChange,
}: PageActionBarProps) {
  const mobile = useMobile()
  const [action, setAction] = useState('Home')
  const [themeOpen, setThemeOpen] = useState(false)
  const [viewMode, setViewMode] = useRecoilState(viewModeState)
  const [zenMode, setZenMode] = useRecoilState(zenModeState)
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
        Icon: viewMode === 'library' ? MdMenuBook : MdLibraryBooks,
        disabled: viewMode === 'library' && !focusedBookTab,
        env: Env.Desktop,
      },
      {
        name: 'theme',
        title: 'theme',
        Icon: MdOutlineLightMode,
        env: Env.Desktop,
      },
      {
        name: 'fullscreen',
        title: fullscreen ? 'fullscreen.exit' : 'fullscreen.enter',
        Icon: fullscreen ? MdFullscreenExit : MdFullscreen,
        env: Env.Desktop,
      },
      {
        name: 'zen',
        title: 'zen.enter',
        Icon: MdCenterFocusStrong,
        disabled: viewMode === 'library' || !focusedBookTab,
        env: Env.Desktop,
      },
      {
        name: 'home',
        title: 'home',
        Icon: RiHome6Line,
        env: Env.Mobile,
      },
      {
        name: 'settings',
        title: 'settings',
        Icon: RiSettings5Line,
        env: Env.Desktop | Env.Mobile,
      },
    ],
    [focusedBookTab, fullscreen, viewMode],
  )

  return (
    <div>
      <ActionBar>
        {pageActions
          .filter((a) => a.env & env)
          .map(({ name, title, Icon, disabled }, i) => {
            const active = mobile
              ? action === name
              : (viewMode === 'library' && name === 'mode') ||
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
                title={t(titleKey)}
                Icon={Icon}
                active={active}
                disabled={disabled}
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
                  } else {
                    reader.clear()
                  }
                  setAction(name)
                }}
              />
            )

            if (name === 'theme') {
              return (
                <div className="relative h-12 w-12" key={i}>
                  {themeOpen && (
                    <ThemePanel
                      className="absolute bottom-full left-1/2 mb-1 -translate-x-1/2"
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

function NavigationBar({
  settingsOpen,
  onSettingsOpenChange,
}: SettingsActionProps) {
  const r = useReaderSnapshot()
  const readMode = r.focusedTab?.isBook
  const [visible, setVisible] = useRecoilState(navbarState)
  const [, , background] = useBackground()

  return (
    <>
      {visible && (
        <Overlay
          className="!bg-transparent"
          onClick={() => setVisible(false)}
        />
      )}
      <div
        className={clsx(
          'NavigationBar fixed inset-x-0 bottom-0 z-10 border-t border-on-surface-variant/25',
          background.sidebarClassName,
        )}
      >
        {readMode ? (
          <ViewActionBar
            env={Env.Mobile}
            className={clsx(visible || 'hidden')}
          />
        ) : (
          <PageActionBar
            env={Env.Mobile}
            settingsOpen={settingsOpen}
            onSettingsOpenChange={onSettingsOpenChange}
          />
        )}
      </div>
    </>
  )
}

interface ActionBarProps extends ComponentProps<'ul'> {}
function ActionBar({ className, ...props }: ActionBarProps) {
  return (
    <ul className={clsx('ActionBar flex sm:flex-col', className)} {...props} />
  )
}

interface ActionProps extends ComponentProps<'button'> {
  Icon: IconType
  active?: boolean
}
const Action: React.FC<ActionProps> = ({
  className,
  Icon,
  active,
  ...props
}) => {
  const mobile = useMobile()
  return (
    <button
      className={clsx(
        'Action relative flex h-12 w-12 flex-1 items-center justify-center sm:flex-initial',
        active ? 'text-on-surface-variant' : 'text-outline/70',
        props.disabled ? 'text-on-disabled' : 'hover:text-on-surface-variant ',
        className,
      )}
      {...props}
    >
      {active &&
        (mobile || (
          <div
            className={clsx('absolute', 'inset-y-0 left-0 w-0.5', activeClass)}
          />
        ))}
      <Icon size={28} />
    </button>
  )
}

const SideBar: React.FC = () => {
  const [action, setAction] = useAction()
  const [libraryAction, setLibraryAction] = useLibraryAction()
  const mobile = useMobile()
  const t = useTranslation()
  const viewMode = useRecoilValue(viewModeState)
  const [, , background] = useBackground()
  const activeAction = viewMode === 'library' ? libraryAction : action
  const setActiveAction = viewMode === 'library' ? setLibraryAction : setAction
  const actions = viewMode === 'library' ? libraryViewActions : viewActions

  const { size } = useSplitViewItem(SideBar, {
    preferredSize: 240,
    minSize: 160,
    visible: !!activeAction,
  })

  return (
    <>
      {activeAction && mobile && (
        <Overlay onClick={() => setActiveAction(undefined)} />
      )}
      <div
        className={clsx(
          'SideBar flex flex-col',
          background.sidebarClassName,
          !activeAction && '!hidden',
          mobile ? 'absolute inset-y-0 right-0 z-10' : '',
        )}
        style={{ width: mobile ? '75%' : size }}
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
    </>
  )
}

const libraryStatusOptions = ['toRead', 'reading', 'read'] as const

function LibraryFilterView({ className }: ComponentProps<'div'>) {
  const t = useTranslation('home')
  const [filters, setFilters] = useRecoilState(libraryStatusFilterState)

  const toggle = (status: typeof libraryStatusOptions[number]) => {
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
        <button
          type="button"
          className={clsx(
            'h-9 w-full px-3 text-left ring-1 ring-inset typescale-body-medium',
            filters.length === 0
              ? 'bg-primary70 text-on-primary-container ring-primary'
              : 'bg-surface text-on-surface-variant ring-surface-variant hover:bg-on-surface-variant/10',
          )}
          onClick={() => setFilters([])}
        >
          {t('library_filter.all')}
        </button>
        {libraryStatusOptions.map((status) => {
          const active = filters.includes(status)
          return (
            <button
              key={status}
              type="button"
              className={clsx(
                'flex h-9 w-full items-center justify-between px-3 text-left ring-1 ring-inset typescale-body-medium',
                active
                  ? 'bg-primary70 text-on-primary-container ring-primary'
                  : 'bg-surface text-on-surface-variant ring-surface-variant hover:bg-on-surface-variant/10',
              )}
              onClick={() => toggle(status)}
            >
              <span>{t(`reading_status.${status}`)}</span>
              {active && <span aria-hidden>✓</span>}
            </button>
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

  const r = useReaderSnapshot()
  const readMode = r.focusedTab?.isBook

  return (
    <div
      className={clsx(
        'Reader flex-1 overflow-hidden',
        readMode || 'mb-12 sm:mb-0',
        bg,
      )}
      {...props}
    />
  )
}
