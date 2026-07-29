import clsx from 'clsx'
import { CheckIcon } from 'lucide-react'
import type React from 'react'

import { AppTooltip } from '../components/AppTooltip'
import { ReadingStatusIcon } from '../components/ReadingStatusIcon'
import { Button } from '../components/ui/button'
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

const readingStatusProgressPillClassName: Record<ReadingStatus | 'unmarked', string> = {
  unmarked: 'bg-sky-50/95 text-sky-600 ring-sky-200',
  toRead: 'bg-amber-50/95 text-amber-600 ring-amber-200',
  reading: 'bg-sky-50/95 text-sky-600 ring-sky-200',
  read: 'bg-emerald-50/95 text-emerald-600 ring-emerald-200',
}

export const BookProgress: React.FC<{
  percent: number
  status: ReadingStatus | null
}> = ({ percent, status }) => {
  const statusKey = status ?? 'unmarked'

  return (
    <div className="pointer-events-none absolute right-1 bottom-1 left-1 z-10 flex items-center gap-1.5">
      <div className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-white/75 shadow-sm ring-1 ring-black/5">
        <div
          className={clsx('h-full rounded-full', readingStatusProgressBarClassName[statusKey])}
          style={{ width: `${percent}%` }}
        />
      </div>
      <div
        className={clsx(
          'flex h-5 items-center justify-center rounded-full px-1.5 text-xs leading-none font-semibold shadow-sm ring-1 ring-inset',
          readingStatusProgressPillClassName[statusKey],
        )}
      >
        {percent.toFixed()}%
      </div>
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

  return (
    <div className="flex flex-col gap-0.5">
      <ReadingStatusMenuItem
        iconStatus={null}
        label={t('reading_status.unmarked')}
        checked={!status}
        onClick={() => onChange(null)}
      />
      {readingStatusOptions.map((option) => (
        <ReadingStatusMenuItem
          key={option}
          iconStatus={option}
          label={t(`reading_status.${toMessageKeySegment(option)}`)}
          checked={status === option}
          onClick={() => onChange(option)}
        />
      ))}
    </div>
  )
}

const ReadingStatusMenuItem: React.FC<{
  danger?: boolean
  checked: boolean
  iconStatus: ReadingStatus | null
  label: string
  onClick: () => void
  removeIcon?: boolean
}> = ({ danger, checked, iconStatus, label, onClick, removeIcon }) => (
  <Button
    type="button"
    variant="ghost"
    size="sm"
    className={clsx(
      'h-8 w-full justify-start gap-2 px-2 text-base leading-none',
      danger ? 'text-destructive hover:bg-destructive/10 hover:text-destructive' : 'text-muted-foreground',
    )}
    style={{ fontSize: 'var(--app-font-size-md)' }}
    onClick={onClick}
  >
    <ReadingStatusIcon
      intent={removeIcon ? 'remove' : 'status'}
      status={iconStatus}
      className={danger ? 'text-destructive' : undefined}
    />
    <span className="min-w-0 flex-1 truncate text-left leading-none">{label}</span>
    {checked && <CheckIcon className="size-4 shrink-0 text-(--flow-accent)" />}
  </Button>
)
