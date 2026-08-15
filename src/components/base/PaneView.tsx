import clsx from 'clsx'
import type { LucideIcon } from 'lucide-react'
import {
  type ComponentProps,
  forwardRef,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useRef,
} from 'react'

import type { OverlayScrollbarMetrics } from '@/hooks/useOverlayScrollbarMetrics'
import { useAppStore } from '@/state'

import { IconButton } from '../IconButton'
import { Twisty } from '../Row'

import { SplitView } from './SplitView'
import { useSplitViewItem } from './splitViewContext'

const PANE_HEADER_SIZE = 28

interface PaneButtonAction {
  id: string
  title: string
  Icon: LucideIcon
  handle: () => void
}

interface PaneCustomAction {
  content: ReactNode
  id: string
}

type PaneAction = PaneButtonAction | PaneCustomAction

interface PaneProps extends ComponentProps<'div'> {
  headline: string
  maxSize?: number
  minSize?: number
  overlayScroll?: boolean
  preferredSize?: number
  reserveScrollbarWidth?: boolean
  scrollbar?: OverlayScrollbarMetrics
  stateKey: string
  actions?: PaneAction[]
}
export const Pane = forwardRef<HTMLDivElement, PaneProps>(function Pane(
  {
    actions,
    children,
    className,
    headline,
    maxSize,
    minSize = 72,
    overlayScroll = false,
    preferredSize,
    reserveScrollbarWidth = false,
    scrollbar,
    stateKey,
    ...props
  },
  ref,
) {
  const paneState = useAppStore((state) => state.panes?.[stateKey])
  const setPaneState = useAppStore((state) => state.setPaneState)
  const expanded = paneState?.expanded ?? true
  const handleSizeChange = useCallback(
    (nextSize: number) =>
      setPaneState(stateKey, (current) => ({ expanded: current?.expanded ?? true, size: nextSize })),
    [setPaneState, stateKey],
  )
  const { size } = useSplitViewItem(stateKey, {
    dragMinSize: PANE_HEADER_SIZE,
    maxSize,
    minSize,
    preferredSize,
    initialSize: paneState?.size,
    onSizeChange: handleSizeChange,
    visible: expanded,
  })
  const toggleExpanded = () => {
    setPaneState(stateKey, (current) => ({ expanded: !(current?.expanded ?? true), size: current?.size }))
  }

  return (
    <div
      className={clsx('Pane scroll-parent group min-h-0', size || !expanded ? 'shrink-0' : 'flex-1')}
      style={{
        height: expanded ? size : PANE_HEADER_SIZE,
      }}
    >
      <div
        className="border-border/70 bg-foreground/[0.035] hover:bg-foreground/5.5 flex h-7 shrink-0 items-center border-y px-0.5 transition-colors"
        onClick={toggleExpanded}
      >
        <Twisty expanded={expanded} className="text-muted-foreground/80" />
        <div className="text-muted-foreground/85 flex h-full min-w-0 flex-1 items-center truncate text-base leading-none font-semibold tracking-normal">
          {headline.toUpperCase()}
        </div>
        {actions && (
          <ul
            className="text-muted-foreground invisible ml-auto flex shrink-0 items-center gap-1 pr-0.5 group-hover:visible group-focus-within:visible"
            onClick={(event) => event.stopPropagation()}
          >
            {actions.map((action) => (
              <li key={action.id} className="flex items-center">
                {'content' in action ? (
                  action.content
                ) : (
                  <IconButton title={action.title} Icon={action.Icon} onClick={action.handle} />
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      {overlayScroll ? (
        <OverlayScroll
          ref={ref}
          className={clsx('text-muted-foreground text-base', className)}
          containerClassName={clsx('min-h-0 flex-1', !expanded && 'hidden')}
          reserveScrollbarWidth={reserveScrollbarWidth}
          scrollbar={scrollbar}
          {...props}
        >
          {children}
        </OverlayScroll>
      ) : (
        <div
          ref={ref}
          className={clsx('scroll text-muted-foreground min-h-0 flex-1 text-base', !expanded && 'hidden', className)}
          data-pane-scroll="true"
          {...props}
        >
          {children}
        </div>
      )}
    </div>
  )
})

interface ScrollbarDrag {
  pointerId: number
  startScrollTop: number
  startY: number
}

const MIN_SCROLLBAR_THUMB_SIZE = 20

interface OverlayScrollProps extends ComponentProps<'div'> {
  containerClassName?: string
  reserveScrollbarWidth?: boolean
  scrollbar?: OverlayScrollbarMetrics
}

export const OverlayScroll = forwardRef<HTMLDivElement, OverlayScrollProps>(function OverlayScroll(
  { children, className, containerClassName, reserveScrollbarWidth = false, scrollbar, ...props },
  ref,
) {
  return (
    <div className={clsx('group/pane-scroll relative overflow-hidden', containerClassName)}>
      <div
        ref={ref}
        className={clsx(
          'no-scrollbar h-full w-full overflow-y-auto overscroll-contain',
          reserveScrollbarWidth && 'sidebar-scroll-content-reserved',
          className,
        )}
        data-pane-scroll="true"
        {...props}
      >
        {children}
      </div>
      {scrollbar && <OverlayScrollbar {...scrollbar} />}
    </div>
  )
})

export function OverlayScrollbar({ scrollRef, scrollTop, totalSize, viewportHeight }: OverlayScrollbarMetrics) {
  const dragRef = useRef<ScrollbarDrag | undefined>(undefined)
  const maxScrollTop = Math.max(0, totalSize - viewportHeight)
  const trackHeight = viewportHeight

  if (!maxScrollTop || !trackHeight) return null

  const thumbHeight = Math.min(
    trackHeight,
    Math.max(MIN_SCROLLBAR_THUMB_SIZE, (trackHeight * viewportHeight) / totalSize),
  )
  const maxThumbTop = Math.max(0, trackHeight - thumbHeight)
  const thumbTop = maxThumbTop ? (Math.min(maxScrollTop, scrollTop) / maxScrollTop) * maxThumbTop : 0
  const scrollToThumbTop = (nextThumbTop: number) => {
    const scroll = scrollRef.current
    if (!scroll || !maxThumbTop) return

    scroll.scrollTop = (Math.max(0, Math.min(maxThumbTop, nextThumbTop)) / maxThumbTop) * maxScrollTop
  }
  const handleThumbPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const scroll = scrollRef.current
    if (!scroll || event.button !== 0) return

    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = {
      pointerId: event.pointerId,
      startScrollTop: scroll.scrollTop,
      startY: event.clientY,
    }
  }
  const handleThumbPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId || !maxThumbTop) return

    const scroll = scrollRef.current
    if (!scroll) return

    scroll.scrollTop = drag.startScrollTop + ((event.clientY - drag.startY) / maxThumbTop) * maxScrollTop
  }
  const handleThumbPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return

    dragRef.current = undefined
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  return (
    <div
      className="pointer-events-none absolute inset-y-0 right-0 z-20 w-2.5 touch-none bg-transparent opacity-0 select-none group-hover/pane-scroll:pointer-events-auto group-hover/pane-scroll:opacity-100"
      data-orientation="vertical"
      onPointerDown={(event) => {
        if (event.button !== 0 || event.target !== event.currentTarget) return

        event.preventDefault()
        const trackRect = event.currentTarget.getBoundingClientRect()
        scrollToThumbTop(event.clientY - trackRect.top - thumbHeight / 2)
      }}
    >
      <div
        className="bg-muted-foreground/20 hover:bg-muted-foreground/30 active:bg-muted-foreground/40 absolute right-0 left-0 rounded-full"
        data-pane-scrollbar-thumb="true"
        style={{ height: thumbHeight, top: thumbTop }}
        onPointerDown={handleThumbPointerDown}
        onPointerMove={handleThumbPointerMove}
        onPointerUp={handleThumbPointerUp}
        onPointerCancel={handleThumbPointerUp}
      />
    </div>
  )
}

export interface PaneViewProps extends ComponentProps<'div'> {
  active?: boolean
}
export function PaneView({ active: _active, className, ...props }: PaneViewProps) {
  return <SplitView vertical className={clsx('scroll-parent min-h-0', className)} {...props} />
}
