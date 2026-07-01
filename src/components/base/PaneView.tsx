import clsx from 'clsx'
import { ComponentProps, forwardRef, useState } from 'react'

import { Twisty } from '../Row'

import { Action, ActionBar } from './ActionBar'
import { SplitView, useSplitViewItem } from './SplitView'

const COLLAPSED_STORAGE_SUFFIX = ':collapsed'
const PANE_HEADER_SIZE = 28

interface PaneProps extends ComponentProps<'div'> {
  headline: string
  maxSize?: number
  minSize?: number
  preferredSize?: number
  storageKey?: string
  actions?: Action[]
}
export const Pane = forwardRef<HTMLDivElement, PaneProps>(function Pane(
  {
    actions,
    children,
    className,
    headline,
    maxSize,
    minSize = 72,
    preferredSize,
    storageKey,
    ...props
  },
  ref,
) {
  const [expanded, setExpanded] = useState(() => readPaneExpanded(storageKey))
  const { size } = useSplitViewItem(headline, {
    dragMinSize: PANE_HEADER_SIZE,
    maxSize,
    minSize,
    preferredSize,
    storageKey,
    visible: expanded,
  })
  const toggleExpanded = () => {
    setExpanded((current) => {
      const next = !current
      writePaneExpanded(storageKey, next)
      return next
    })
  }

  return (
    <div
      className={clsx(
        'Pane scroll-parent group min-h-0',
        size || !expanded ? 'shrink-0' : 'flex-1',
      )}
      style={{
        height: expanded ? size : PANE_HEADER_SIZE,
      }}
    >
      <div
        role="button"
        tabIndex={0}
        className="border-border/70 bg-foreground/[0.035] hover:bg-foreground/[0.055] flex h-7 shrink-0 items-center border-y px-0.5 transition-colors"
        onClick={toggleExpanded}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          event.currentTarget.click()
        }}
      >
        <Twisty expanded={expanded} className="text-muted-foreground/80" />
        <div className="text-muted-foreground/85 text-base leading-none font-semibold tracking-normal">
          {headline.toUpperCase()}
        </div>
        {actions && (
          <ActionBar
            actions={actions}
            className="invisible ml-auto flex pr-0.5 group-hover:visible"
          />
        )}
      </div>
      <div
        ref={ref}
        className={clsx(
          'scroll text-muted-foreground min-h-0 flex-1 text-base',
          !expanded && 'hidden',
          className,
        )}
        {...props}
      >
        {children}
      </div>
    </div>
  )
})

function readPaneExpanded(storageKey?: string) {
  if (!storageKey || typeof window === 'undefined') return true

  return window.localStorage.getItem(collapsedStorageKey(storageKey)) !== '1'
}

function writePaneExpanded(storageKey: string | undefined, expanded: boolean) {
  if (!storageKey || typeof window === 'undefined') return

  window.localStorage.setItem(
    collapsedStorageKey(storageKey),
    expanded ? '0' : '1',
  )
}

function collapsedStorageKey(storageKey: string) {
  return `${storageKey}${COLLAPSED_STORAGE_SUFFIX}`
}

export interface PaneViewProps extends ComponentProps<'div'> {
  active?: boolean
  name: string
  title: string
  actions?: Action[]
}
export function PaneView({
  active: _active,
  className,
  name: _name,
  title: _title,
  actions: _actions,
  ...props
}: PaneViewProps) {
  return (
    <SplitView
      vertical
      className={clsx('scroll-parent min-h-0', className)}
      {...props}
    />
  )
}
