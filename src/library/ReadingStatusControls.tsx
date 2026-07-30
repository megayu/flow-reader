import clsx from 'clsx'
import { CheckIcon } from 'lucide-react'
import type React from 'react'

import { AppTooltip } from '../components/AppTooltip'
import { ReadingStatusIcon } from '../components/ReadingStatusIcon'
import { DropdownMenuItemIndicator, DropdownMenuRadioGroup, DropdownMenuRadioItem } from '../components/ui/menu'
import { useTranslation } from '../hooks/useTranslation'
import { toMessageKeySegment } from '../locales'
import type { ReadingStatus } from '../storage'

import { bookCoverCornerBadgeClassName, bookCoverCornerIconSize } from './model'

export const readingStatusOptions: ReadingStatus[] = ['toRead', 'reading', 'read']

const readingStatusBadgeClassName: Record<ReadingStatus, string> = {
  toRead: 'bg-amber-500 text-white ring-amber-700/15',
  reading: 'bg-sky-500 text-white ring-sky-700/15',
  read: 'bg-emerald-600 text-white ring-emerald-800/15',
}

export const readingStatusEditButtonClassName: Record<ReadingStatus | 'unmarked', string> = {
  unmarked: 'bg-popover/95 text-muted-foreground ring-border hover:bg-muted hover:text-foreground',
  toRead: 'bg-amber-50/95 text-amber-600 ring-amber-200 hover:bg-amber-100',
  reading: 'bg-sky-50/95 text-sky-600 ring-sky-200 hover:bg-sky-100',
  read: 'bg-emerald-50/95 text-emerald-600 ring-emerald-200 hover:bg-emerald-100',
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

export const ReadingStatusMenu: React.FC<{
  status: ReadingStatus | null
  onChange: (status: ReadingStatus | null) => void
}> = ({ status, onChange }) => {
  const t = useTranslation('home')
  const selectedValue = status ?? 'unmarked'

  return (
    <DropdownMenuRadioGroup className="flex flex-col gap-0.5" value={selectedValue}>
      <ReadingStatusMenuItem
        iconStatus={null}
        label={t('reading_status.unmarked')}
        value="unmarked"
        onSelect={() => onChange(null)}
      />
      {readingStatusOptions.map((option) => (
        <ReadingStatusMenuItem
          key={option}
          iconStatus={option}
          label={t(`reading_status.${toMessageKeySegment(option)}`)}
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
