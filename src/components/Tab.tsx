import clsx from 'clsx'
import { type LucideIcon, XIcon } from 'lucide-react'
import type { ComponentProps, MouseEvent, ReactNode } from 'react'

import { activeClass } from '../styles'

import { AppTooltip } from './AppTooltip'
import { IconButton } from './Button'

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
        'relative mx-0.5 mt-0.5 mb-0 flex cursor-pointer items-center gap-1 p-2 pr-1 text-base outline-none',
        selected
          ? 'text-foreground z-10 rounded-t-[10px] rounded-b-none bg-(--flow-bg-tab-active) shadow-[inset_0_1px_0_var(--flow-tab-border)] before:pointer-events-none before:absolute before:bottom-0 before:-left-[10px] before:size-[10px] before:rounded-br-[10px] before:shadow-[5px_5px_0_5px_var(--flow-bg-tab-active)] after:pointer-events-none after:absolute after:right-[-10px] after:bottom-0 after:size-[10px] after:rounded-bl-[10px] after:shadow-[-5px_5px_0_5px_var(--flow-bg-tab-active)]'
          : clsx(
              'text-muted-foreground/60 hover:text-foreground rounded-[10px] before:pointer-events-none before:absolute before:inset-x-0 before:top-0.5 before:bottom-1 before:rounded-[10px] before:opacity-0 before:transition-none hover:before:bg-(--flow-bg-control-hover) hover:before:opacity-100 hover:before:shadow-[inset_0_0_0_1px_var(--flow-tab-border)]',
              showSeparator &&
                'after:pointer-events-none after:absolute after:top-1/2 after:right-[-3px] after:h-5 after:w-0.5 after:-translate-y-1/2 after:rounded-full after:bg-(--flow-tab-border)',
            ),
        focused && '!text-foreground',
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
            dropIndicator === 'before' ? 'left-[-3px]' : 'right-[-3px]',
            activeClass,
          )}
        />
      )}
      <Icon size={16} className="text-muted-foreground relative z-10" />
      <span className="relative z-10 max-w-[200px] truncate">{children}</span>
      <IconButton
        className="relative z-10 size-6 transition-none active:translate-y-0"
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
  onDelete?: () => void
  onWheel?: ComponentProps<'div'>['onWheel']
}
const List: React.FC<ListProps> = ({ className, onDelete, onWheel, ...props }) => {
  return (
    <div className={clsx('flex items-end justify-between bg-(--flow-bg-tabbar)', className)} onWheel={onWheel}>
      <ul className={clsx('scroll-h flex items-end px-2.5')} {...props} />
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
