import clsx from 'clsx'
import { type LucideIcon, XIcon } from 'lucide-react'
import { ComponentProps, ReactNode } from 'react'

import { useTranslation } from '../hooks/useTranslation'
import { activeClass } from '../styles'

import { AppTooltip } from './AppTooltip'
import { IconButton } from './Button'

interface TabProps extends ComponentProps<'div'> {
  onDelete?: () => void
  selected?: boolean
  focused?: boolean
  showSeparator?: boolean
  Icon: LucideIcon
  children?: string
  tooltipContent?: ReactNode
}
export function Tab({
  selected,
  focused,
  showSeparator,
  Icon,
  className,
  children,
  onDelete,
  tooltipContent,
  title,
  ...props
}: TabProps) {
  const t = useTranslation()
  const tooltip = typeof title === 'string' ? title : children

  if (!children) return null
  const tab = (
    <div
      role="tab"
      aria-label={children}
      className={clsx(
        'relative mx-0.5 mt-0.5 mb-0 flex cursor-pointer items-center gap-1 p-2 pr-1 text-base outline-none',
        selected
          ? 'text-foreground z-10 rounded-t-[10px] rounded-b-none bg-[var(--flow-bg-tab-active)] shadow-[inset_0_1px_0_var(--flow-tab-border)] before:pointer-events-none before:absolute before:bottom-0 before:-left-[10px] before:size-[10px] before:rounded-br-[10px] before:shadow-[5px_5px_0_5px_var(--flow-bg-tab-active)] after:pointer-events-none after:absolute after:right-[-10px] after:bottom-0 after:size-[10px] after:rounded-bl-[10px] after:shadow-[-5px_5px_0_5px_var(--flow-bg-tab-active)]'
          : clsx(
              'text-muted-foreground/60 hover:text-foreground rounded-[10px] before:pointer-events-none before:absolute before:inset-x-0 before:top-0.5 before:bottom-1 before:rounded-[10px] before:opacity-0 before:transition-none hover:before:bg-[var(--flow-bg-control-hover)] hover:before:opacity-100 hover:before:shadow-[inset_0_0_0_1px_var(--flow-tab-border)]',
              showSeparator &&
                'after:pointer-events-none after:absolute after:top-1/2 after:right-[-3px] after:h-5 after:w-0.5 after:-translate-y-1/2 after:rounded-full after:bg-[var(--flow-tab-border)]',
            ),
        focused && '!text-foreground',
        className,
      )}
      {...props}
    >
      {focused && (
        <div
          className={clsx(
            'absolute inset-x-2 top-0 h-px rounded-full',
            activeClass,
          )}
        />
      )}
      <Icon size={16} className="text-muted-foreground relative z-10" />
      <span className="relative z-10 max-w-[200px] truncate">{children}</span>
      <IconButton
        className="relative z-10 transition-none active:translate-y-0"
        aria-label={t('action.close')}
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
const List: React.FC<ListProps> = ({
  className,
  onDelete,
  onWheel,
  ...props
}) => {
  const t = useTranslation()

  return (
    <div
      className={clsx(
        'flex items-end justify-between bg-[var(--flow-bg-tabbar)]',
        className,
      )}
      onWheel={onWheel}
    >
      <ul className={clsx('scroll-h flex items-end px-2.5')} {...props} />
      {onDelete && (
        <IconButton
          className="mx-2"
          aria-label={t('action.close')}
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
