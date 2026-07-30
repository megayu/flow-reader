import clsx from 'clsx'
import {
  ArchiveIcon,
  BookOpenIcon,
  CheckIcon,
  DownloadIcon,
  FileX2Icon,
  InfoIcon,
  PencilIcon,
  TagIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from 'lucide-react'
import type React from 'react'
import { useCallback, useState } from 'react'

import { getBookDisplayTitle, getBookTooltip } from '../book'
import { AppTooltip, readerPageTooltipContentStyle } from '../components/AppTooltip'
import { BookTooltipContent } from '../components/BookTooltipContent'
import { ReadingStatusIcon } from '../components/ReadingStatusIcon'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '../components/ui/menu'
import { useNotify } from '../components/ui/notification'
import { formatErrorMessage } from '../errorMessage'
import { useTranslation } from '../hooks/useTranslation'
import { toMessageKeySegment } from '../locales'
import { reader } from '../models/reader'
import {
  type BookExportFormat,
  type BookRecord,
  type BookSourceStatus,
  type CoverRecord,
  db,
  type ReadingStatus,
} from '../storage'

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
  isBookExportDirty,
  isBookSourceUnavailable,
} from './model'
import {
  BookProgress,
  ReadingStatusBadge,
  ReadingStatusMenu,
  readingStatusEditButtonClassName,
} from './ReadingStatusControls'
import type { LibraryBookSelectionEvent } from './selection'

const placeholder = `data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect fill="gray" fill-opacity="0" width="1" height="1"/></svg>`

interface BookCardProps {
  book: BookRecord
  covers?: CoverRecord[]
  highlighted?: boolean
  select?: boolean
  selected?: boolean
  showModifiedExportIndicator: boolean
  sourceStatus?: BookSourceStatus
  onSelectBook: (id: string, e: LibraryBookSelectionEvent) => void
  onOpenBook: () => void
}

export const BookCard: React.FC<BookCardProps> = ({
  book,
  covers,
  highlighted,
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

  const cover = covers?.find((item) => item.id === book.id)?.cover
  const displayTitle = getBookDisplayTitle(book)
  const tooltip = getBookTooltip(book)
  const exportFormats = bookExportFormats(book)

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
    reader.addTab((await db.books.get(book.id)) ?? book)
    onOpenBook()
  }, [book, notify, onOpenBook, sourceStatus, t])

  const handleCoverClick = useCallback(
    (event: React.MouseEvent) => {
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

  return (
    <div className="relative">
      <ContextMenu
        modal={false}
        onOpenChange={(open) => {
          if (!open) setConfirmDelete(false)
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
                    <DropdownMenuContent
                      align="start"
                      side="bottom"
                      sideOffset={4}
                      className="w-36 p-1 text-base"
                      style={{ fontSize: 'var(--app-font-size-md)' }}
                      onClick={(event) => event.stopPropagation()}
                      onPointerDown={(event) => event.stopPropagation()}
                    >
                      <ReadingStatusMenu status={book.readingStatus ?? null} onChange={updateReadingStatus} />
                    </DropdownMenuContent>
                  </div>
                </DropdownMenu>
              )}
              <img
                src={cover ?? placeholder}
                alt="Cover"
                className="block h-full w-full rounded-[inherit] object-cover"
                draggable={false}
              />
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
                <span className="min-w-0 flex-1 truncate text-left">{displayTitle}</span>
                {!select && progressPercent !== undefined && (
                  <span className="text-muted-foreground shrink-0 text-xs leading-none font-normal tabular-nums">
                    {progressPercent.toFixed()}%
                  </span>
                )}
              </div>
            </AppTooltip>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
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
          {exportFormats.map((format) => {
            const dirty = isBookExportDirty(book, format)
            return (
              <BookContextMenuItem
                key={format}
                Icon={DownloadIcon}
                label={`${t('context.export')} ${format.toUpperCase()}${dirty ? ' *' : ''}`}
                disabled={exportingFormat === format}
                onSelect={() => {
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
                }}
              />
            )
          })}
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

              reader.closeBookTabs(book.id)
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
