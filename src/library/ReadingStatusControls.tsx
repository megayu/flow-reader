import clsx from 'clsx'
import { CheckIcon } from 'lucide-react'
import type React from 'react'

import { AppTooltip } from '../components/AppTooltip'
import { ReadingStatusIcon } from '../components/ReadingStatusIcon'
import {
  DropdownMenuContent,
  DropdownMenuItemIndicator,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from '../components/ui/menu'
import { useTranslation } from '../hooks/useTranslation'
import type { ReadingStatus } from '../storage'

import {
  bookCoverCornerBadgeClassName,
  bookCoverCornerIconSize,
  readingStatusMessageKey,
  readingStatusOptions,
} from './model'

const readingStatusBadgeClassName: Record<ReadingStatus, string> = {
  toRead: 'bg-amber-500 text-white ring-amber-700/15',
  reading: 'bg-sky-500 text-white ring-sky-700/15',
  read: 'bg-emerald-600 text-white ring-emerald-800/15',
}

const readingStatusProgressBarClassName: Record<ReadingStatus | 'unmarked', string> = {
  unmarked: 'bg-sky-500',
  toRead: 'bg-amber-500',
  reading: 'bg-sky-500',
  read: 'bg-emerald-500',
}

export const BookProgress: React.FC<{
  percent: number
  status: ReadingStatus | null
}> = ({ percent, status }) => {
  const statusKey = status ?? 'unmarked'

  return (
    <div className="bg-muted-foreground/20 pointer-events-none absolute right-1 bottom-0 left-1 z-10 h-0.5 overflow-hidden">
      <div className={clsx('h-full', readingStatusProgressBarClassName[statusKey])} style={{ width: `${percent}%` }} />
    </div>
  )
}

export const ReadingStatusBadge: React.FC<{
  hidden?: boolean
  status: ReadingStatus
  title: string
}> = ({ hidden, status, title }) => {
  const badge = (
    <div
      className={clsx(
        bookCoverCornerBadgeClassName,
        'absolute top-2 right-2 z-10 transition-opacity group-hover:opacity-0',
        readingStatusBadgeClassName[status],
        hidden && 'opacity-0',
      )}
    >
      <ReadingStatusIcon status={status} size={bookCoverCornerIconSize} tone="current" className="text-white" />
    </div>
  )

  return <AppTooltip label={title}>{badge}</AppTooltip>
}

export const ReadingStatusMenuContent: React.FC<{
  align?: 'start' | 'center' | 'end'
  status?: ReadingStatus | null
  onChange: (status: ReadingStatus | null) => void
}> = ({ align = 'start', status, onChange }) => (
  <DropdownMenuContent
    align={align}
    side="bottom"
    sideOffset={4}
    className="w-max max-w-[calc(100vw-2rem)]"
    onClick={(event) => event.stopPropagation()}
    onPointerDown={(event) => event.stopPropagation()}
  >
    <ReadingStatusMenu status={status} onChange={onChange} />
  </DropdownMenuContent>
)

const ReadingStatusMenu: React.FC<{
  status?: ReadingStatus | null
  onChange: (status: ReadingStatus | null) => void
}> = ({ status, onChange }) => {
  const t = useTranslation()
  const selectedValue = status === undefined ? '' : (status ?? 'unmarked')

  return (
    <DropdownMenuRadioGroup className="flex flex-col gap-0.5" value={selectedValue}>
      <ReadingStatusMenuItem
        iconStatus={null}
        label={t('home.reading_status.unmarked')}
        value="unmarked"
        onSelect={() => onChange(null)}
      />
      {readingStatusOptions.map((option) => (
        <ReadingStatusMenuItem
          key={option}
          iconStatus={option}
          label={t(readingStatusMessageKey(option))}
          value={option}
          onSelect={() => onChange(option)}
        />
      ))}
    </DropdownMenuRadioGroup>
  )
}

const ReadingStatusMenuItem: React.FC<{
  iconStatus: ReadingStatus | null
  label: string
  onSelect: () => void
  value: string
}> = ({ iconStatus, label, onSelect, value }) => (
  <DropdownMenuRadioItem
    className="leading-none"
    style={{ fontSize: 'var(--app-font-size-md)' }}
    value={value}
    onSelect={onSelect}
  >
    <ReadingStatusIcon intent="status" status={iconStatus} />
    <span className="min-w-0 flex-1 truncate text-left leading-none">{label}</span>
    <DropdownMenuItemIndicator>
      <CheckIcon className="size-4 shrink-0 text-(--flow-accent)" />
    </DropdownMenuItemIndicator>
  </DropdownMenuRadioItem>
)
