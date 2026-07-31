import clsx from 'clsx'
import { ChevronDownIcon, ChevronRightIcon, XIcon } from 'lucide-react'
import type { ComponentProps, CSSProperties, PointerEvent } from 'react'

import { useBackground } from '../hooks/theme/useBackground'
import { LIST_ITEM_SIZE } from '../hooks/useList'

import { AppTooltip } from './AppTooltip'
import { StateLayer } from './base/StateLayer'
import { IconButton } from './IconButton'

export const TREE_INDENT_SIZE = 10
export const EMPTY_ROW_LABEL = '—'

interface RowProps extends ComponentProps<'div'> {
  as?: 'button' | 'div'
  expanded?: boolean
  active?: boolean
  activeClassName?: string
  depth?: number
  label?: string
  emptyLabel?: string
  description?: string | number
  info?: string
  subitems?: Readonly<any[]>
  toggle?: () => void
  onDelete?: () => void
  badge?: boolean
  tooltipContentStyle?: CSSProperties
}
export const Row: React.FC<RowProps> = ({
  as = 'div',
  title,
  label,
  emptyLabel = EMPTY_ROW_LABEL,
  description,
  info,
  expanded = false,
  active = false,
  activeClassName,
  depth = 0,
  subitems,
  toggle,
  className,
  children,
  badge,
  onClick,
  onDelete,
  onPointerDown,
  tooltipContentStyle,
  tabIndex,
  ...props
}) => {
  const [, , background] = useBackground()

  const childCount = subitems?.length
  const t = children || label || title
  const tooltip = typeof title === 'string' ? title : undefined
  const indent = Math.max(0, depth - 1) * TREE_INDENT_SIZE
  const rowClassName = clsx(
    'list-row group/row focus:ring-ring relative flex cursor-pointer items-center text-left outline-none focus:ring-1 focus:ring-inset',
    active && (activeClassName ?? background.rowActiveClassName),
    className,
  )
  const rowStyle = {
    paddingLeft: indent,
    paddingRight: 'var(--flow-row-end-inset, 0px)',
    height: LIST_ITEM_SIZE,
  }
  const handlePointerDown = (event: PointerEvent<HTMLElement>) => {
    if (onClick && event.button === 0) {
      event.currentTarget.focus({ preventScroll: true })
    }
    onPointerDown?.(event as PointerEvent<HTMLDivElement>)
  }
  const content = (
    <>
      <StateLayer
        className={clsx(
          'transition-colors',
          active ? 'group-hover/row:bg-(--flow-bg-active-hover)' : 'group-hover/row:bg-(--flow-bg-control-hover)',
        )}
      />
      <Twisty
        expanded={expanded}
        className={clsx(!childCount && 'invisible')}
        onClick={(e) => {
          e.stopPropagation()
          toggle?.()
        }}
      />
      <div
        className={clsx(
          'relative z-10 flex h-full min-w-0 flex-1 items-center text-base leading-none',
          t ? 'text-muted-foreground' : 'text-muted-foreground/60',
        )}
        style={{
          marginLeft: 0,
        }}
      >
        <span className="flex h-full min-w-0 items-center whitespace-nowrap">
          <span className="block min-w-0 truncate">
            {t || emptyLabel}
            {description && (
              <span
                className="text-muted-foreground/60"
                style={{
                  marginLeft: 4,
                }}
              >
                {description}
              </span>
            )}
          </span>
        </span>
      </div>
      <div className="relative z-10 ml-auto flex h-full items-center">
        {badge && childCount && (
          <div className="mr-1 flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-(--flow-bg-control) px-1 text-sm leading-none text-(--flow-text-muted) ring-1 ring-(--flow-border) ring-inset">
            {childCount}
          </div>
        )}
        {onDelete && (
          <IconButton
            className="action invisible"
            Icon={XIcon}
            onClick={(e) => {
              e.stopPropagation()
              onDelete?.()
            }}
          />
        )}
        <span className="text-muted-foreground">{info}</span>
      </div>
    </>
  )
  const row =
    as === 'button' ? (
      <button
        type="button"
        className={rowClassName}
        style={rowStyle}
        tabIndex={tabIndex}
        onClick={(onClick ?? toggle) as ComponentProps<'button'>['onClick']}
        onPointerDown={handlePointerDown}
        {...(props as ComponentProps<'button'>)}
      >
        {content}
      </button>
    ) : (
      <div
        className={rowClassName}
        style={rowStyle}
        tabIndex={tabIndex ?? (onClick ? -1 : undefined)}
        onClick={onClick ?? toggle}
        onPointerDown={handlePointerDown}
        {...props}
      >
        {content}
      </div>
    )

  return tooltip ? (
    <AppTooltip contentStyle={tooltipContentStyle} label={tooltip}>
      {row}
    </AppTooltip>
  ) : (
    row
  )
}

interface TwistyProps extends ComponentProps<'svg'> {
  expanded: boolean
}
export const Twisty: React.FC<TwistyProps> = ({ expanded, className, ...props }) => {
  const Icon = expanded ? ChevronDownIcon : ChevronRightIcon
  return (
    <Icon
      size={20}
      className={clsx('text-muted-foreground relative z-10 shrink-0', className)}
      style={{ padding: 2 }}
      {...props}
    />
  )
}
