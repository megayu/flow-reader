import clsx from 'clsx'
import { ChevronDownIcon, ChevronRightIcon, XIcon } from 'lucide-react'
import { ComponentProps, CSSProperties } from 'react'

import { useBackground } from '../hooks/theme/useBackground'
import { LIST_ITEM_SIZE } from '../hooks/useList'
import { useTranslation } from '../hooks/useTranslation'

import { AppTooltip } from './AppTooltip'
import { IconButton } from './Button'
import { StateLayer } from './base/StateLayer'

interface RowProps extends ComponentProps<'div'> {
  expanded?: boolean
  active?: boolean
  depth?: number
  label?: string
  description?: string | number
  info?: string
  subitems?: Readonly<any[]>
  toggle?: () => void
  onDelete?: () => void
  badge?: boolean
  tooltipContentStyle?: CSSProperties
}
export const Row: React.FC<RowProps> = ({
  title,
  label,
  description,
  info,
  expanded = false,
  active = false,
  depth = 0,
  subitems,
  toggle,
  className,
  children,
  badge,
  onClick,
  onDelete,
  tooltipContentStyle,
  ...props
}) => {
  const trans = useTranslation()
  const [, , background] = useBackground()

  const childCount = subitems?.length
  const t = children || label || title
  const tooltip = typeof title === 'string' ? title : undefined
  const indent = Math.max(0, depth - 1) * 20

  const row = (
    <div
      aria-label={tooltip}
      className={clsx(
        'list-row group/row relative flex cursor-pointer items-center text-left',
        active && background.rowActiveClassName,
        className,
      )}
      style={{
        paddingLeft: indent,
        paddingRight: 0,
        height: LIST_ITEM_SIZE,
      }}
      onClick={onClick ?? toggle}
      {...props}
    >
      <StateLayer className="transition-colors group-hover/row:bg-[var(--flow-bg-control-hover)]" />
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
        <span className="block min-w-0 truncate whitespace-nowrap">
          {t || trans('untitled')}
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
      </div>
      <div className="relative z-10 ml-auto flex h-full items-center">
        {badge && childCount && (
          <div className="mr-1 flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-[var(--flow-bg-control)] px-1 text-sm leading-none text-[var(--flow-text-muted)] ring-1 ring-[var(--flow-border)] ring-inset">
            {childCount}
          </div>
        )}
        {onDelete && (
          <IconButton
            className="action hidden"
            Icon={XIcon}
            onClick={(e) => {
              e.stopPropagation()
              onDelete?.()
            }}
          />
        )}
        <span className="text-muted-foreground">{info}</span>
      </div>
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
export const Twisty: React.FC<TwistyProps> = ({
  expanded,
  className,
  ...props
}) => {
  const Icon = expanded ? ChevronDownIcon : ChevronRightIcon
  return (
    <Icon
      size={20}
      className={clsx('text-muted-foreground shrink-0', className)}
      style={{ padding: 2 }}
      {...props}
    />
  )
}
