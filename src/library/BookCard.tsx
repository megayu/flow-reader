import clsx from 'clsx'
import {
  ArchiveIcon,
  BookOpenIcon,
  CheckIcon,
  CircleIcon,
  DownloadIcon,
  FileX2Icon,
  InfoIcon,
  PencilIcon,
  PlayIcon,
  TagIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from 'lucide-react'
import type React from 'react'
import { memo, useCallback, useEffect, useRef, useState } from 'react'

import { cleanBookText, getBookDisplayTitle, getBookTooltip } from '../book'
import { AppTooltip } from '../components/AppTooltip'
import { readerPageTooltipContentStyle } from '../components/appTooltipStyles'
import { BookTooltipContent } from '../components/BookTooltipContent'
import { ReadingStatusIcon } from '../components/ReadingStatusIcon'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  DropdownMenu,
  DropdownMenuTrigger,
} from '../components/ui/menu'
import { useNotify } from '../components/ui/notificationContext'
import { formatErrorMessage } from '../errorMessage'
import { useTranslation } from '../hooks/useTranslation'
import { toMessageKeySegment } from '../locales'
import { reader } from '../models/reader'
import { type BookExportFormat, type BookRecord, type BookSourceStatus, db, type ReadingStatus } from '../storage'

import { bookCoverPlaceholder, CoverImage } from './CoverImage'
import { BookInfoDialog, BookTagsDialog, EditBookDialog } from './LibraryDialogs'
import {
  bookCoverCornerBadgeClassName,
  bookCoverCornerIconSize,
  bookCoverCornerIconStrokeWidth,
  bookExportFormats,
  bookSourceDescriptionKey,
  exportBookWithDialog,
  getBookProgressPercent,
  hasUnexportedBookChanges,
  isArchiveOnlyBook,
  isBookSourceUnavailable,
  readingStatusEditButtonClassName,
} from './model'
import { BookProgress, ReadingStatusBadge, ReadingStatusMenuContent } from './ReadingStatusControls'
import type { LibraryBookSelectionEvent } from './selection'

const newBookMarkerDurationMs = 24 * 60 * 60 * 1000
const generatedCoverFontFamily = 'Noto Serif CJK SC, Source Han Serif SC, STSong, SimSun, serif'

function GeneratedBookCover({ book }: { book: BookRecord }) {
  const creator = cleanBookText(book.metadata.creator)

  return (
    <div
      aria-hidden
      className="pointer-events-none relative h-full w-full select-none overflow-hidden rounded-[inherit] bg-[#ead7b5]"
      style={{ containerType: 'inline-size', fontFamily: generatedCoverFontFamily }}
    >
      <div className="absolute top-[30%] left-[7.5%] flex h-[40%] w-[85%] items-start justify-center overflow-hidden text-center text-[#3d3122]">
        <div
          className="max-w-full font-extrabold"
          style={{
            fontSize: 'clamp(18px, 12cqw, 30px)',
            lineHeight: 1.12,
            overflowWrap: 'anywhere',
            wordBreak: 'break-word',
          }}
        >
          {getBookDisplayTitle(book)}
        </div>
      </div>
      {creator && (
        <div className="absolute top-[70%] left-[7.5%] flex h-[30%] w-[85%] items-start justify-center overflow-hidden text-center text-[#776b5c]">
          <div
            className="max-w-full font-bold"
            style={{
              fontSize: 'clamp(14px, 8cqw, 22px)',
              lineHeight: 1.18,
              overflowWrap: 'anywhere',
              wordBreak: 'break-word',
            }}
          >
            {creator}
          </div>
        </div>
      )}
    </div>
  )
}

function isNewBook(book: BookRecord) {
  if (book.lastReadAt !== undefined) return false

  const bookAgeMs = Date.now() - book.createdAt
  return bookAgeMs >= 0 && bookAgeMs < newBookMarkerDurationMs
}

interface BookCardProps {
  book: BookRecord
  cover?: string | null
  highlighted?: boolean
  recent?: boolean
  retainCoverResource?: boolean
  select?: boolean
  selected?: boolean
  showModifiedExportIndicator: boolean
  sourceStatus?: BookSourceStatus
  onSelectBook: (id: string, e?: LibraryBookSelectionEvent) => void
  onOpenBook: () => void
}

const BookCardComponent: React.FC<BookCardProps> = ({
  book,
  cover,
  highlighted,
  recent,
  retainCoverResource,
  select,
  selected,
  showModifiedExportIndicator,
  sourceStatus,
  onSelectBook,
  onOpenBook,
}) => {
  const t = useTranslation('home')
  const errorT = useTranslation('error')
  const notify = useNotify()
  const [statusMenuOpen, setStatusMenuOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const [infoOpen, setInfoOpen] = useState(false)
  const [tagsOpen, setTagsOpen] = useState(false)
  const [exportingFormat, setExportingFormat] = useState<BookExportFormat>()
  const [exportFormatsExpanded, setExportFormatsExpanded] = useState(false)
  const longPressRef = useRef<number | 'triggered' | undefined>(undefined)

  const displayTitle = getBookDisplayTitle(book)
  const tooltip = getBookTooltip(book)
  const exportFormats = bookExportFormats(book)
  const showNewBookMarker = isNewBook(book)

  const openBook = useCallback(async () => {
    if (isBookSourceUnavailable(sourceStatus)) {
      notify({
        autoCloseMs: false,
        description: t(bookSourceDescriptionKey(sourceStatus)),
        title: t('source_unavailable'),
        type: 'error',
      })
      return
    }
    reader.openBookFromLibrary((await db.books.get(book.id)) ?? book)
    onOpenBook()
  }, [book, notify, onOpenBook, sourceStatus, t])

  const handleCoverClick = useCallback(
    (event: React.MouseEvent) => {
      if (longPressRef.current === 'triggered') {
        longPressRef.current = undefined
        event.preventDefault()
        event.stopPropagation()
        return
      }

      if (select || event.button !== 0) return

      const revealSource = event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey
      const openDirectory = event.metaKey || event.ctrlKey
      if (!revealSource && !openDirectory) return

      event.preventDefault()
      event.stopPropagation()

      if (revealSource) {
        void db.books.revealSource(book.id).catch(console.error)
        return
      }

      void db.books.openDirectory(book.id).catch((error) => {
        console.error(error)
        notify({
          autoCloseMs: false,
          description: `${getBookDisplayTitle(book)}: ${formatErrorMessage(error)}`,
          title: errorT('open_book_directory_failed'),
          type: 'error',
        })
      })
    },
    [book, errorT, notify, select],
  )

  const clearLongPressTimer = useCallback(() => {
    if (typeof longPressRef.current !== 'number') return
    window.clearTimeout(longPressRef.current)
    longPressRef.current = undefined
  }, [])

  useEffect(() => clearLongPressTimer, [clearLongPressTimer])

  function handleCoverPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (
      select ||
      !event.isPrimary ||
      event.button !== 0 ||
      event.shiftKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey
    ) {
      return
    }

    clearLongPressTimer()
    longPressRef.current = window.setTimeout(() => {
      longPressRef.current = 'triggered'
      onSelectBook(book.id)
    }, 500)
  }

  const updateReadingStatus = useCallback(
    (readingStatus: ReadingStatus | null) => {
      setStatusMenuOpen(false)
      void db.books.update(book.id, { readingStatus })
    },
    [book.id],
  )

  const activateBook = useCallback(
    (event: LibraryBookSelectionEvent) => {
      if (select) {
        onSelectBook(book.id, event)
      } else {
        void openBook()
      }
    },
    [book.id, onSelectBook, openBook, select],
  )

  const progressPercent = getBookProgressPercent(book.percentage)

  function startBookExport(format: BookExportFormat | undefined) {
    if (!format) return

    setExportingFormat(format)
    void exportBookWithDialog(book, format)
      .then((outputPath) => {
        if (!outputPath) return
        notify({
          action: {
            label: t('export_reveal'),
            onClick: () => {
              void db.files.reveal(outputPath).catch(console.error)
            },
          },
          description: outputPath,
          title: t('export_complete'),
          type: 'success',
        })
      })
      .catch((error) => {
        console.error(error)
        notify({
          autoCloseMs: false,
          description: `${getBookDisplayTitle(book)} · ${format.toUpperCase()}: ${formatErrorMessage(error)}`,
          title: errorT('export_failed'),
          type: 'error',
        })
      })
      .finally(() => setExportingFormat(undefined))
  }

  return (
    <div className="relative">
      <ContextMenu
        modal={false}
        onOpenChange={(open) => {
          if (!open) {
            setConfirmDelete(false)
            setExportFormatsExpanded(false)
          }
        }}
      >
        <ContextMenuTrigger asChild disabled={select}>
          <div
            data-flow-library-book-card
            className={clsx(
              'group relative flex cursor-pointer flex-col rounded-md p-1 transition-colors',
              select && selected
                ? 'bg-(--flow-accent-bg) ring-2 ring-(--flow-accent) hover:bg-(--flow-accent-bg)'
                : highlighted
                  ? 'ring-2 ring-(--flow-accent)'
                  : 'hover:bg-popover/70',
            )}
            onClick={activateBook}
          >
            <div
              className="border-border relative mx-auto aspect-9/12 w-full overflow-hidden rounded-md border shadow-sm"
              style={{ maxWidth: 'var(--library-book-card-width)' }}
              onClick={handleCoverClick}
              onPointerCancel={clearLongPressTimer}
              onPointerDown={handleCoverPointerDown}
              onPointerLeave={clearLongPressTimer}
              onPointerUp={clearLongPressTimer}
            >
              {book.readingStatus && (
                <ReadingStatusBadge
                  status={book.readingStatus}
                  title={t(`reading_status.${toMessageKeySegment(book.readingStatus)}`)}
                  hidden={statusMenuOpen}
                />
              )}
              {!select && (
                <DropdownMenu open={statusMenuOpen} modal={false} onOpenChange={setStatusMenuOpen}>
                  <div
                    className="absolute top-2 right-2 z-20"
                    onClick={(event) => event.stopPropagation()}
                    onPointerDown={(event) => event.stopPropagation()}
                    onContextMenu={(event) => {
                      event.preventDefault()
                      event.stopPropagation()
                    }}
                  >
                    <AppTooltip label={t('reading_status.change')}>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          aria-label={t('reading_status.change')}
                          className={clsx(
                            bookCoverCornerBadgeClassName,
                            'opacity-0 transition-opacity group-hover:opacity-100',
                            readingStatusEditButtonClassName[book.readingStatus ?? 'unmarked'],
                            statusMenuOpen && 'opacity-100',
                          )}
                        >
                          <ReadingStatusIcon
                            intent="edit"
                            status={book.readingStatus ?? null}
                            size={bookCoverCornerIconSize}
                            tone="current"
                          />
                        </button>
                      </DropdownMenuTrigger>
                    </AppTooltip>
                    <ReadingStatusMenuContent status={book.readingStatus ?? null} onChange={updateReadingStatus} />
                  </div>
                </DropdownMenu>
              )}
              {book.generatedCover ? (
                <GeneratedBookCover book={book} />
              ) : retainCoverResource && cover ? (
                <CoverImage bookId={book.id} cover={cover} alt="Cover" />
              ) : (
                <img
                  src={cover ?? bookCoverPlaceholder}
                  alt="Cover"
                  className="block h-full w-full rounded-[inherit] object-cover"
                  decoding="async"
                  draggable={false}
                  loading="lazy"
                />
              )}
              {recent && !select && (
                <div className="pointer-events-none absolute inset-0 z-1 flex items-center justify-center bg-black/0 opacity-0 transition-[background-color,opacity] group-hover:bg-black/20 group-hover:opacity-100">
                  <span className="flex size-12 items-center justify-center rounded-full bg-black/65 text-white shadow-md ring-1 ring-white/50">
                    <PlayIcon aria-hidden className="size-6 fill-current" strokeWidth={1.8} />
                  </span>
                </div>
              )}
              {isBookSourceUnavailable(sourceStatus) && (
                <AppTooltip
                  label={t('source_unavailable')}
                  contentStyle={{ maxWidth: 'calc(50vw - 2rem)' }}
                  content={
                    <span className="flex w-max max-w-[calc(50vw-2rem)] min-w-0 flex-col gap-1">
                      <span className="min-w-0 text-base font-medium wrap-break-word">{t('source_unavailable')}</span>
                      <span className="text-muted-foreground min-w-0 text-base wrap-break-word">
                        {t(bookSourceDescriptionKey(sourceStatus))}
                      </span>
                    </span>
                  }
                >
                  <div
                    className={clsx(
                      bookCoverCornerBadgeClassName,
                      'absolute top-2 left-2 z-10 bg-zinc-950/90 text-white ring-white/50',
                    )}
                  >
                    <FileX2Icon size={bookCoverCornerIconSize} strokeWidth={bookCoverCornerIconStrokeWidth} />
                  </div>
                </AppTooltip>
              )}
              {!isBookSourceUnavailable(sourceStatus) && isArchiveOnlyBook(book) && (
                <AppTooltip
                  label={t('compat.archive_only')}
                  contentStyle={{ maxWidth: 'calc(50vw - 2rem)' }}
                  content={
                    <span className="flex w-max max-w-[calc(50vw-2rem)] min-w-0 flex-col gap-1">
                      <span className="min-w-0 text-base font-medium wrap-break-word">{t('compat.archive_only')}</span>
                      <span className="text-muted-foreground min-w-0 text-base wrap-break-word">
                        {t('compat.archive_only_description')}
                      </span>
                    </span>
                  }
                >
                  <div
                    className={clsx(
                      bookCoverCornerBadgeClassName,
                      'absolute top-2 left-2 z-10 bg-zinc-950/90 text-white ring-white/50',
                    )}
                  >
                    <ArchiveIcon size={bookCoverCornerIconSize} strokeWidth={bookCoverCornerIconStrokeWidth} />
                  </div>
                </AppTooltip>
              )}
              {showModifiedExportIndicator && !isArchiveOnlyBook(book) && hasUnexportedBookChanges(book) && (
                <AppTooltip label={t('modified_export_indicator')}>
                  <div
                    className={clsx(
                      bookCoverCornerBadgeClassName,
                      'absolute top-2 left-2 z-10 bg-(--flow-accent) text-(--flow-accent-text) ring-white/40',
                    )}
                  >
                    <DownloadIcon size={bookCoverCornerIconSize} strokeWidth={bookCoverCornerIconStrokeWidth} />
                  </div>
                </AppTooltip>
              )}
              {!select && progressPercent !== undefined && (
                <BookProgress percent={progressPercent} status={book.readingStatus ?? null} />
              )}
              {select && (
                <div className="absolute right-2 bottom-2 z-20">
                  <div
                    aria-hidden
                    className={clsx(
                      'flex size-6 items-center justify-center rounded-md shadow-sm ring-1 ring-inset',
                      selected
                        ? 'bg-(--flow-accent) text-(--flow-accent-text) ring-(--flow-accent)'
                        : 'bg-(--flow-bg-panel) ring-(--flow-border)',
                    )}
                  >
                    {selected && <CheckIcon className="size-4" strokeWidth={2.5} />}
                  </div>
                </div>
              )}
            </div>
            <AppTooltip
              content={<BookTooltipContent book={book} />}
              contentStyle={readerPageTooltipContentStyle}
              label={tooltip}
            >
              <div
                className="text-foreground mx-auto mt-2 flex h-6 w-full items-center gap-2 text-base leading-none font-semibold"
                style={{ maxWidth: 'var(--library-book-card-width)' }}
              >
                <span className="flex min-w-0 flex-1 items-center gap-0.5">
                  {showNewBookMarker && (
                    <CircleIcon
                      aria-hidden
                      className="size-[0.55em] shrink-0 fill-current text-(--flow-accent)"
                      strokeWidth={0}
                    />
                  )}
                  <span className="min-w-0 flex-1 truncate text-left">{displayTitle}</span>
                </span>
                {!select && progressPercent !== undefined && (
                  <span className="text-muted-foreground shrink-0 text-xs leading-none font-normal tabular-nums">
                    {progressPercent.toFixed()}%
                  </span>
                )}
              </div>
            </AppTooltip>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-max max-w-[calc(100vw-2rem)]">
          <BookContextMenuItem
            Icon={BookOpenIcon}
            label={t('context.open')}
            onSelect={() => {
              void openBook()
            }}
          />
          <BookContextMenuItem Icon={PencilIcon} label={t('context.edit')} onSelect={() => setEditOpen(true)} />
          <BookContextMenuItem Icon={TagIcon} label={t('tags')} onSelect={() => setTagsOpen(true)} />
          <BookContextMenuItem Icon={InfoIcon} label={t('context.info')} onSelect={() => setInfoOpen(true)} />
          {!exportFormatsExpanded ? (
            <BookContextMenuItem
              Icon={DownloadIcon}
              label={`${t('context.export')}${hasUnexportedBookChanges(book) ? ' *' : ''}`}
              disabled={exportingFormat !== undefined}
              onSelect={(event) => {
                if (exportFormats.length > 1) {
                  event.preventDefault()
                  setExportFormatsExpanded(true)
                  return
                }
                startBookExport(exportFormats[0])
              }}
            />
          ) : (
            exportFormats.map((format) => (
              <BookContextMenuItem
                key={format}
                Icon={DownloadIcon}
                label={format.toUpperCase()}
                disabled={exportingFormat === format}
                onSelect={() => startBookExport(format)}
              />
            ))
          )}
          <ContextMenuSeparator />
          <BookContextMenuItem
            variant="destructive"
            Icon={confirmDelete ? TriangleAlertIcon : Trash2Icon}
            label={t(confirmDelete ? 'context.confirm_delete' : 'context.delete')}
            onSelect={(event) => {
              if (!confirmDelete) {
                event.preventDefault()
                setConfirmDelete(true)
                return
              }

              reader.closeBookTab(book.id)
              void db.books.delete(book.id)
            }}
          />
        </ContextMenuContent>
      </ContextMenu>
      {editOpen && <EditBookDialog book={book} onClose={() => setEditOpen(false)} />}
      {tagsOpen && <BookTagsDialog book={book} onClose={() => setTagsOpen(false)} />}
      {infoOpen && <BookInfoDialog book={book} cover={cover} onClose={() => setInfoOpen(false)} />}
    </div>
  )
}

export const BookCard = memo(BookCardComponent)

const BookContextMenuItem: React.FC<{
  disabled?: boolean
  Icon: React.ComponentType<{ size?: number; className?: string }>
  label: string
  onSelect: (event: Event) => void
  variant?: 'default' | 'destructive'
}> = ({ disabled, Icon, label, onSelect, variant }) => (
  <ContextMenuItem aria-label={label} disabled={disabled} variant={variant} onSelect={onSelect}>
    <Icon size={18} className="shrink-0" />
    <span className="min-w-0 truncate">{label}</span>
  </ContextMenuItem>
)
