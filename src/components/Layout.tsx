import { Overlay } from '@literal-ui/core'
import clsx from 'clsx'
import { ComponentProps, PropsWithChildren, useEffect, useState } from 'react'
import { useMemo } from 'react'
import { IconType } from 'react-icons'
import {
  MdFormatUnderlined,
  MdLibraryBooks,
  MdMenuBook,
  MdOutlineImage,
  MdSearch,
  MdToc,
  MdOutlineLightMode,
} from 'react-icons/md'
import { RiFontSize, RiHome6Line, RiSettings5Line } from 'react-icons/ri'
import { useRecoilState, useRecoilValue } from 'recoil'

import {
  Env,
  Action,
  useAction,
  useBackground,
  useColorScheme,
  useMobile,
  useSetAction,
  useTranslation,
} from '../hooks'
import { reader, useReaderSnapshot } from '../models'
import { navbarState, viewModeState } from '../state'
import { activeClass } from '../styles'

import { SplitView, useSplitViewItem } from './base'
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
  const [settingsOpen, setSettingsOpen] = useState(false)
  const setAction = useSetAction()
  const mobile = useMobile()

  useEffect(() => {
    if (mobile === undefined) return
    setAction(mobile ? undefined : 'toc')
    setReady(true)
  }, [mobile, setAction])

  return (
    <div id="layout" className="select-none">
      <SplitView>
        {mobile === false && (
          <ActivityBar
            settingsOpen={settingsOpen}
            onSettingsOpenChange={setSettingsOpen}
          />
        )}
        {mobile === true && (
          <NavigationBar
            settingsOpen={settingsOpen}
            onSettingsOpenChange={setSettingsOpen}
          />
        )}
        {ready && <SideBar />}
        {ready && <Reader>{children}</Reader>}
      </SplitView>
      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      />
    </div>
  )
}

interface IAction {
  name: string
  title: string
  Icon: IconType
  env: number
}
interface IViewAction extends IAction {
  name: Action
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
  const viewMode = useRecoilValue(viewModeState)
  const t = useTranslation()
  const disabled = viewMode === 'library'

  return (
    <ActionBar className={className}>
      {viewActions
        .filter((a) => a.env & env)
        .map(({ name, title, Icon }) => {
          const active = !disabled && action === name
          return (
            <Action
              title={t(`${title}.title`)}
              Icon={Icon}
              active={active}
              disabled={disabled}
              onClick={() => {
                if (disabled) return
                setAction(active ? undefined : name)
              }}
              key={name}
            />
          )
        })}
    </ActionBar>
  )
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
  const { focusedBookTab } = useReaderSnapshot()
  const t = useTranslation()

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
    [focusedBookTab, viewMode],
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
                (settingsOpen && name === 'settings')
            const titleKey = name === 'mode' ? title : `${title}.title`
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
  const mobile = useMobile()
  const t = useTranslation()
  const viewMode = useRecoilValue(viewModeState)
  const [, , background] = useBackground()

  const { size } = useSplitViewItem(SideBar, {
    preferredSize: 240,
    minSize: 160,
    visible: !!action,
  })

  return (
    <>
      {action && mobile && <Overlay onClick={() => setAction(undefined)} />}
      <div
        className={clsx(
          'SideBar flex flex-col',
          background.sidebarClassName,
          !action && '!hidden',
          viewMode === 'library' && 'pointer-events-none opacity-50',
          mobile ? 'absolute inset-y-0 right-0 z-10' : '',
        )}
        style={{ width: mobile ? '75%' : size }}
      >
        {viewActions.map(({ name, title, View }) => (
          <View
            key={name}
            name={t(`${name}.title`)}
            title={t(`${title}.title`)}
            className={clsx(name !== action && '!hidden')}
          />
        ))}
      </div>
    </>
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
