import clsx from 'clsx'
import { ComponentProps, forwardRef, useState } from 'react'

import { scale } from '@flow/reader/platform'

import { Twisty } from '../Row'
import { Action, ActionBar } from '../base'

import { SplitView, useSplitViewItem } from './SplitView'

interface PaneProps extends ComponentProps<'div'> {
  headline: string
  preferredSize?: number
  actions?: Action[]
}
export const Pane = forwardRef<HTMLDivElement, PaneProps>(function Pane(
  { className, headline, preferredSize, children, actions, ...props },
  ref,
) {
  const [expanded, setExpanded] = useState(true)
  const { size } = useSplitViewItem(headline, {
    preferredSize,
    visible: expanded,
  })
  return (
    <div
      className={clsx(
        'Pane scroll-parent group min-h-0',
        size || !expanded ? 'shrink-0' : 'flex-1',
      )}
      style={{
        height: expanded ? size : 24,
      }}
    >
      <div
        role="button"
        className="flex h-6 shrink-0 items-center"
        onClick={() => setExpanded((e) => !e)}
      >
        <Twisty expanded={expanded} />
        <div
          className="!font-bold text-on-surface-variant typescale-label-small"
          style={{ fontSize: scale(11, 12) }}
        >
          {headline.toUpperCase()}
        </div>
        {actions && (
          <ActionBar
            actions={actions}
            className="invisible ml-auto flex pr-1 group-hover:visible"
          />
        )}
      </div>
      <div
        ref={ref}
        className={clsx(
          'scroll min-h-0 flex-1 text-on-surface-variant typescale-body-small',
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

export interface PaneViewProps extends ComponentProps<'div'> {
  name: string
  title: string
  actions?: Action[]
}
export function PaneView({
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
