import clsx from 'clsx'
import { ComponentProps } from 'react'
import { MdClose } from 'react-icons/md'
import { VscChevronDown, VscChevronRight } from 'react-icons/vsc'

import { useBackground } from '../hooks/theme/useBackground'
import { LIST_ITEM_SIZE } from '../hooks/useList'
import { useTranslation } from '../hooks/useTranslation'

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
  ...props
}) => {
  const trans = useTranslation()
  const [, , background] = useBackground()

  const childCount = subitems?.length
  const t = children || label || title

  return (
    <div
      className={clsx(
        'list-row relative flex cursor-pointer items-center text-left',
        active && background.rowActiveClassName,
        className,
      )}
      style={{
        paddingLeft: depth * 8,
        paddingRight: 12,
        height: LIST_ITEM_SIZE,
      }}
      title={title}
      onClick={onClick ?? toggle}
      {...props}
    >
      <StateLayer />
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
          'truncate text-xs',
          t ? 'text-muted-foreground' : 'text-muted-foreground/60',
        )}
        style={{
          fontSize: 12,
          marginLeft: 0,
        }}
      >
        {t || trans('untitled')}
        {description && (
          <span
            className="text-muted-foreground"
            style={{
              fontSize: 11,
              marginLeft: 4,
            }}
          >
            {description}
          </span>
        )}
      </div>
      <div className="ml-auto">
        {badge && childCount && (
          <div
            className="bg-accent text-accent-foreground rounded-full px-1.5 py-px"
            style={{
              fontSize: 11,
            }}
          >
            {childCount}
          </div>
        )}
        {onDelete && (
          <IconButton
            className="action hidden"
            Icon={MdClose}
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
}

interface TwistyProps extends ComponentProps<'svg'> {
  expanded: boolean
}
export const Twisty: React.FC<TwistyProps> = ({
  expanded,
  className,
  ...props
}) => {
  const Icon = expanded ? VscChevronDown : VscChevronRight
  return (
    <Icon
      size={20}
      className={clsx('text-muted-foreground shrink-0', className)}
      style={{ padding: 2 }}
      {...props}
    />
  )
}
