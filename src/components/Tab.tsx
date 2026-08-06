import clsx from 'clsx'
import { type LucideIcon, XIcon } from 'lucide-react'
import type { ComponentProps, MouseEvent, ReactNode, Ref } from 'react'

import { activeClass } from '../styles'

import { AppTooltip } from './AppTooltip'
import { IconButton } from './IconButton'

interface TabProps extends ComponentProps<'div'> {
  dropIndicator?: 'before' | 'after'
  onDelete?: () => void
  selected?: boolean
  focused?: boolean
  showSeparator?: boolean
  Icon: LucideIcon
  children?: string
  tooltipContent?: ReactNode
}
export function Tab({
  dropIndicator,
  selected,
  focused,
  showSeparator,
  Icon,
  className,
  children,
  onDelete,
  tooltipContent,
  title,
  onAuxClick,
  onMouseDown,
  ...props
}: TabProps) {
  const tooltip = typeof title === 'string' ? title : children
  const closeOnMiddleClick = (event: MouseEvent<HTMLDivElement>) => {
    if (event.button !== 1 || !onDelete) return false

    event.preventDefault()
    event.stopPropagation()
    return true
  }

  if (!children) return null
  const tab = (
    <div
      className={clsx(
        'flow-reader-tab group/tab relative mx-0.5 mt-0.5 mb-0 flex h-10 min-w-9 max-w-max flex-[1_1_0] cursor-pointer items-center gap-1 px-2 text-base outline-none',
        selected
          ? 'text-foreground z-10 rounded-t-[10px] rounded-b-none bg-(--flow-bg-tab-active) shadow-[inset_0_1px_0_var(--flow-tab-border)] before:pointer-events-none before:absolute before:bottom-0 before:-left-2.5 before:size-2.5 before:rounded-br-[10px] before:shadow-[5px_5px_0_5px_var(--flow-bg-tab-active)] after:pointer-events-none after:absolute after:-right-2.5 after:bottom-0 after:size-2.5 after:rounded-bl-[10px] after:shadow-[-5px_5px_0_5px_var(--flow-bg-tab-active)]'
          : clsx(
              'text-muted-foreground/60 hover:text-foreground rounded-[10px] before:pointer-events-none before:absolute before:inset-x-0 before:top-0.5 before:bottom-1 before:rounded-[10px] before:opacity-0 before:transition-none hover:before:bg-(--flow-bg-control-hover) hover:before:opacity-100 hover:before:shadow-[inset_0_0_0_1px_var(--flow-tab-border)]',
              showSeparator &&
                'after:pointer-events-none after:absolute after:top-1/2 after:-right-0.75 after:h-5 after:w-0.5 after:-translate-y-1/2 after:rounded-full after:bg-(--flow-tab-border)',
            ),
        focused && 'text-foreground!',
        className,
      )}
      onMouseDown={(event) => {
        onMouseDown?.(event)
        if (!event.defaultPrevented) closeOnMiddleClick(event)
      }}
      onAuxClick={(event) => {
        onAuxClick?.(event)
        if (event.defaultPrevented || !closeOnMiddleClick(event)) return

        onDelete?.()
      }}
      {...props}
    >
      {focused && <div className={clsx('absolute inset-x-2 top-0 h-px rounded-full', activeClass)} />}
      {dropIndicator && (
        <div
          data-flow-tab-drop-indicator={dropIndicator}
          className={clsx(
            'pointer-events-none absolute top-1/2 z-20 h-5 w-0.5 -translate-y-1/2 rounded-full',
            dropIndicator === 'before' ? '-left-0.75' : '-right-0.75',
            activeClass,
          )}
        />
      )}
      <span className="size-4 shrink-0">
        <Icon size={16} className="flow-reader-tab-leading-icon text-muted-foreground relative z-10 block" />
      </span>
      <span className="flow-reader-tab-label relative z-10 min-w-0 max-w-50 truncate">{children}</span>
      <IconButton
        className={clsx(
          'flow-reader-tab-close pointer-events-none absolute top-2 right-1 z-20 size-6 opacity-0 transition-none group-hover/tab:pointer-events-auto group-hover/tab:opacity-100 active:translate-y-0',
          selected ? 'group-hover/tab:bg-(--flow-bg-tab-active)' : 'group-hover/tab:bg-(--flow-bg-control-hover)',
        )}
        Icon={XIcon}
        onClick={(e) => {
          e.stopPropagation()
          onDelete?.()
        }}
      />
    </div>
  )

  return (
    <AppTooltip content={tooltipContent} label={tooltip ?? children}>
      {tab}
    </AppTooltip>
  )
}

interface ListProps extends Omit<ComponentProps<'ul'>, 'onWheel'> {
  listRef?: Ref<HTMLUListElement>
  onDelete?: () => void
  onWheel?: ComponentProps<'div'>['onWheel']
}
const List: React.FC<ListProps> = ({ className, listRef, onDelete, onWheel, ...props }) => {
  return (
    <div className={clsx('flex min-w-0 items-end justify-between bg-(--flow-bg-tabbar)', className)} onWheel={onWheel}>
      <ul ref={listRef} className={clsx('flex min-w-0 flex-1 items-end overflow-hidden px-2.5')} {...props} />
      {onDelete && (
        <IconButton
          className="mx-2"
          Icon={XIcon}
          onClick={(e) => {
            e.stopPropagation()
            onDelete()
          }}
        />
      )}
    </div>
  )
}

Tab.List = List
