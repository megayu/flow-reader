import clsx from 'clsx'
import {
  ArrowDownIcon,
  ArrowUpIcon,
  BookTextIcon,
  BookOpenIcon,
  CalendarPlusIcon,
  CheckIcon,
  FileInputIcon,
  HistoryIcon,
  InfoIcon,
  ListChecksIcon,
  ListXIcon,
  PencilIcon,
  SquareCheckBigIcon,
  SquareXIcon,
  TagIcon,
  Trash2Icon,
  TriangleAlertIcon,
  UserRound,
  type LucideIcon,
} from 'lucide-react'
import Head from 'next/head'
import { useRouter } from 'next/router'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  cleanBookText,
  compareBookDisplayTitle,
  getBookDisplayTitle,
  getBookTooltip,
} from '../book'
import {
  AppTooltip,
  readerPageTooltipContentStyle,
} from '../components/AppTooltip'
import { BookTooltipContent } from '../components/BookTooltipContent'
import { Button } from '../components/Button'
import { ReaderGridView } from '../components/Reader'
import { ReadingStatusIcon } from '../components/ReadingStatusIcon'
import { TextImportDialog } from '../components/TextImportDialog'
import { DropZone } from '../components/base/DropZone'
import { Button as UiButton } from '../components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog'
import { Input } from '../components/ui/input'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '../components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select'
import {
  BookRecord,
  CoverRecord,
  LibraryTagRecord,
  ReadingStatus,
  db,
} from '../db'
import { handleFiles, openImportDialog, setupNativeOpenFiles } from '../file'
import { useAction, useLibraryAction } from '../hooks/useAction'
import { useBoolean } from '../hooks/useBoolean'
import { useCovers, useLibrary, useLibraryTags } from '../hooks/useLibrary'
import { useTranslation } from '../hooks/useTranslation'
import {
  cleanLibraryTagName,
  filterBooksByLibraryFilters,
  sameLibraryTagName,
} from '../libraryFilters'
import { reader, useReaderSnapshot } from '../models/reader'
import {
  defaultLibrarySort,
  librarySortFieldOptions,
  type LibrarySortDirection,
  type LibrarySortField,
  useLibraryAuthorFilter,
  useLibraryStatusFilter,
  useLibraryTagFilter,
  useSettings,
  useSettingsReady,
  useViewMode,
} from '../state'
import { lock } from '../styles'

const placeholder = `data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect fill="gray" fill-opacity="0" width="1" height="1"/></svg>`

const collator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
})

const sortFieldIconMap = {
  title: BookTextIcon,
  creator: UserRound,
  updatedAt: HistoryIcon,
  createdAt: CalendarPlusIcon,
} satisfies Record<LibrarySortField, LucideIcon>

const readingStatusOptions: ReadingStatus[] = ['toRead', 'reading', 'read']

const toolbarButtonClass = 'h-8 leading-none'

function isKeyboardTargetBlocked(e: KeyboardEvent) {
  const target = e.target as HTMLElement | null
  return !!target?.closest(
    'input, textarea, select, [contenteditable="true"], [data-flow-keyboard-capture="true"]',
  )
}

function toggleReadingStatusFilter(
  filters: ReadingStatus[],
  status: ReadingStatus,
) {
  return filters.includes(status)
    ? filters.filter((item) => item !== status)
    : [...filters, status]
}

function formatFileSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return ''

  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unitIndex = 0

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex++
  }

  return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 2)} ${
    units[unitIndex]
  }`
}

function formatDateTime(value?: number) {
  if (!value) return ''

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''

  return date.toLocaleString()
}

function formatPercentage(value?: number) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return ''

  return `${Math.max(0, Math.min(100, value * 100)).toFixed(2)}%`
}

function getBookProgressPercent(value?: number) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return

  return Math.max(0, Math.min(100, value * 100))
}

function formatLanguage(value?: string) {
  const language = cleanBookText(value)
  if (!language) return ''

  try {
    const displayNames = new Intl.DisplayNames([navigator.language], {
      type: 'language',
    })
    return displayNames.of(language) ?? language
  } catch {
    return language
  }
}

function cleanBookDescription(value?: string) {
  return (
    value
      ?.replace(/\r\n?/g, '\n')
      .split(/\n{2,}/)
      .map((paragraph) => paragraph.replace(/[ \t\n]+/g, ' ').trim())
      .filter(Boolean)
      .join('\n\n') ?? ''
  )
}

function uniqueStringValues(values: string[]) {
  const seen = new Set<string>()
  const result: string[] = []

  values.forEach((value) => {
    const normalized = value.replace(/\s+/g, ' ').trim()
    if (!normalized || seen.has(normalized)) return

    seen.add(normalized)
    result.push(normalized)
  })

  return result
}

function mergeLibraryTags(
  tags: LibraryTagRecord[],
  extraTags: LibraryTagRecord[],
) {
  const byId = new Map<string, LibraryTagRecord>()
  ;[...tags, ...extraTags].forEach((tag) => {
    byId.set(tag.id, tag)
  })

  return Array.from(byId.values()).sort((a, b) =>
    collator.compare(a.name, b.name),
  )
}

function clampMenuPosition(x: number, y: number) {
  if (typeof window === 'undefined') return { x, y }

  return {
    x: Math.min(x, Math.max(8, window.innerWidth - 176)),
    y: Math.min(y, Math.max(8, window.innerHeight - 208)),
  }
}

function compareBookTitle(a: BookRecord, b: BookRecord) {
  return compareBookDisplayTitle(a, b)
}

function compareBookString(
  a: BookRecord,
  b: BookRecord,
  getValue: (book: BookRecord) => string,
) {
  return collator.compare(getValue(a), getValue(b))
}

function compareBookNumber(
  a: BookRecord,
  b: BookRecord,
  getValue: (book: BookRecord) => number | undefined,
) {
  return (getValue(a) ?? 0) - (getValue(b) ?? 0)
}

function compareBooksByField(
  a: BookRecord,
  b: BookRecord,
  field: LibrarySortField,
) {
  if (field === 'title') return compareBookTitle(a, b)
  if (field === 'creator') {
    return compareBookString(a, b, (book) =>
      cleanBookText(book.metadata.creator),
    )
  }
  if (field === 'updatedAt') {
    return compareBookNumber(a, b, (book) => book.lastReadAt ?? book.updatedAt)
  }

  return compareBookNumber(a, b, (book) => book.createdAt)
}

function sortBooks(
  books: BookRecord[],
  field: LibrarySortField,
  direction: LibrarySortDirection,
) {
  return [...books].sort((a, b) => {
    const primary = compareBooksByField(a, b, field)
    if (primary) return direction === 'asc' ? primary : -primary

    if (field !== 'title') {
      return compareBookTitle(a, b)
    }

    return 0
  })
}

function toggleSortDirection(
  direction: LibrarySortDirection,
): LibrarySortDirection {
  return direction === 'asc' ? 'desc' : 'asc'
}

function useStringSet() {
  const [values, setValues] = useState(() => new Set<string>())

  const add = useCallback((value: string) => {
    setValues((current) => {
      if (current.has(value)) return current
      const next = new Set(current)
      next.add(value)
      return next
    })
  }, [])

  const has = useCallback((value: string) => values.has(value), [values])

  const toggle = useCallback((value: string) => {
    setValues((current) => {
      const next = new Set(current)
      if (next.has(value)) {
        next.delete(value)
      } else {
        next.add(value)
      }
      return next
    })
  }, [])

  const reset = useCallback(() => {
    setValues((current) => (current.size ? new Set() : current))
  }, [])

  return [values, { add, has, toggle, reset }] as const
}

export default function Index() {
  const { focusedBookTab, focusedTab, groups } = useReaderSnapshot()
  const [viewMode, setViewMode] = useViewMode()
  const [readerAction, setReaderAction] = useAction()
  const [libraryAction, setLibraryAction] = useLibraryAction()
  const [settings, setSettings] = useSettings()
  const settingsReady = useSettingsReady()
  const viewModeRef = useRef(viewMode)
  const openedFromNativeRef = useRef(false)
  const startupRestoreStartedRef = useRef(false)
  const router = useRouter()
  const [nativeOpenReady, setNativeOpenReady] = useState(false)
  const [startupRestoreDone, setStartupRestoreDone] = useState(false)
  const [textImportDialog, setTextImportDialog] = useState<{
    paths: string[]
    openAfterImport: boolean
  }>()
  const focusedBookId = focusedBookTab?.book.id

  const applySavedSidebarState = useCallback(() => {
    setReaderAction(settings.readerSidebarOpen === false ? undefined : 'toc')
    setLibraryAction(settings.librarySidebarOpen ? 'libraryFilter' : undefined)
  }, [
    setLibraryAction,
    setReaderAction,
    settings.librarySidebarOpen,
    settings.readerSidebarOpen,
  ])

  const openTextImportDialog = useCallback(
    (paths: string[], openAfterImport: boolean) => {
      if (!paths.length) return
      setTextImportDialog({ paths, openAfterImport })
    },
    [],
  )

  const handleTextImported = useCallback(
    (books: BookRecord[], openAfterImport: boolean) => {
      if (!openAfterImport || !books.length) return

      books.forEach((book) => reader.addTab(book))
      setViewMode('reader')
    },
    [setViewMode],
  )

  useEffect(() => {
    viewModeRef.current = viewMode
  }, [viewMode])

  useEffect(() => {
    router.beforePopState(({ url }) => {
      if (url === '/') {
        reader.clear()
      }
      return true
    })
  }, [router])

  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined

    setupNativeOpenFiles({
      onOpen: (books) => {
        openedFromNativeRef.current = true
        reader.addTab(books[0]!)
        setViewMode('reader')
      },
      onDrop: (books) => {
        if (viewModeRef.current === 'library') return

        books.forEach((book) => reader.addTab(book))
        setViewMode('reader')
      },
      onDropTextPaths: (paths) => {
        openTextImportDialog(paths, viewModeRef.current !== 'library')
      },
    }).then((handler) => {
      if (disposed) {
        handler?.()
      } else {
        unlisten = handler
        setNativeOpenReady(true)
      }
    })

    return () => {
      disposed = true
      unlisten?.()
    }
  }, [openTextImportDialog, setViewMode])

  useEffect(() => {
    if (
      !settingsReady ||
      !nativeOpenReady ||
      startupRestoreStartedRef.current
    ) {
      return
    }

    startupRestoreStartedRef.current = true
    if (
      openedFromNativeRef.current ||
      !settings.restoreLastReadingOnStartup ||
      settings.startupSession?.viewMode !== 'reader' ||
      !settings.startupSession.bookId
    ) {
      applySavedSidebarState()
      setStartupRestoreDone(true)
      return
    }

    db.books
      .get(settings.startupSession.bookId)
      .then((book) => {
        if (!book || reader.groups.length) {
          applySavedSidebarState()
          return
        }

        reader.addTab(book)
        setReaderAction(
          settings.readerSidebarOpen === false ? undefined : 'toc',
        )
        setLibraryAction(
          settings.librarySidebarOpen ? 'libraryFilter' : undefined,
        )
        setViewMode('reader')
      })
      .finally(() => {
        setStartupRestoreDone(true)
      })
  }, [
    applySavedSidebarState,
    nativeOpenReady,
    setLibraryAction,
    setReaderAction,
    setViewMode,
    settings.librarySidebarOpen,
    settings.readerSidebarOpen,
    settings.restoreLastReadingOnStartup,
    settings.startupSession?.bookId,
    settings.startupSession?.viewMode,
    settingsReady,
    startupRestoreDone,
  ])

  useEffect(() => {
    if (!settingsReady || !startupRestoreDone) return

    const nextSession =
      viewMode === 'reader' && focusedBookId
        ? {
            viewMode,
            bookId: focusedBookId,
          }
        : viewMode === 'library'
          ? {
              viewMode,
            }
          : undefined

    if (!nextSession) return

    setSettings((prev) => {
      if (
        prev.startupSession?.viewMode === nextSession.viewMode &&
        prev.startupSession?.bookId === nextSession.bookId
      ) {
        return prev
      }

      return {
        ...prev,
        startupSession: nextSession,
      }
    })
  }, [focusedBookId, setSettings, settingsReady, startupRestoreDone, viewMode])

  useEffect(() => {
    if (!settingsReady || !startupRestoreDone) return

    const nextReaderSidebarOpen = readerAction !== undefined
    const nextLibrarySidebarOpen = libraryAction !== undefined

    setSettings((prev) => {
      if (
        prev.readerSidebarOpen === nextReaderSidebarOpen &&
        prev.librarySidebarOpen === nextLibrarySidebarOpen
      ) {
        return prev
      }

      return {
        ...prev,
        readerSidebarOpen: nextReaderSidebarOpen,
        librarySidebarOpen: nextLibrarySidebarOpen,
      }
    })
  }, [
    libraryAction,
    readerAction,
    setSettings,
    settingsReady,
    startupRestoreDone,
  ])

  useEffect(() => {
    if (!groups.length && viewMode !== 'library') {
      setViewMode('library')
    }
  }, [groups.length, setViewMode, viewMode])

  const library = (
    <Library
      onOpenBook={() => setViewMode('reader')}
      onTextPaths={(paths) => openTextImportDialog(paths, false)}
    />
  )
  const contentReady = startupRestoreDone

  return (
    <>
      <Head>
        <title>{focusedTab?.title ?? 'Flow Reader'}</title>
      </Head>
      {!contentReady ? null : groups.length ? (
        <ReaderGridView
          content={viewMode === 'library' ? library : undefined}
        />
      ) : (
        library
      )}
      {textImportDialog && (
        <TextImportDialog
          paths={textImportDialog.paths}
          openAfterImport={textImportDialog.openAfterImport}
          onClose={() => setTextImportDialog(undefined)}
          onImported={handleTextImported}
        />
      )}
    </>
  )
}

interface LibraryProps {
  onOpenBook: () => void
  onTextPaths: (paths: string[]) => void
}

const Library: React.FC<LibraryProps> = ({ onOpenBook, onTextPaths }) => {
  const books = useLibrary()
  const covers = useCovers()
  const tags = useLibraryTags()
  const t = useTranslation('home')
  const [settings, setSettings] = useSettings()
  const sortField = settings.librarySort?.field ?? defaultLibrarySort.field
  const sortDirection =
    settings.librarySort?.direction ?? defaultLibrarySort.direction
  const [statusFilters, setStatusFilters] = useLibraryStatusFilter()
  const [authorFilters] = useLibraryAuthorFilter()
  const [tagFilters] = useLibraryTagFilter()
  const [, setLibraryAction] = useLibraryAction()

  const [select, toggleSelect] = useBoolean(false)
  const [selectedBookIds, { add, has, toggle, reset }] = useStringSet()
  const [batchTagsOpen, setBatchTagsOpen] = useState(false)

  const setSortField = useCallback(
    (field: LibrarySortField) => {
      setSettings((settings) => ({
        ...settings,
        librarySort: {
          field,
          direction:
            settings.librarySort?.direction ?? defaultLibrarySort.direction,
        },
      }))
    },
    [setSettings],
  )

  const toggleCurrentSortDirection = useCallback(() => {
    setSettings((settings) => {
      const librarySort = settings.librarySort ?? defaultLibrarySort

      return {
        ...settings,
        librarySort: {
          field: librarySort.field,
          direction: toggleSortDirection(librarySort.direction),
        },
      }
    })
  }, [setSettings])

  useEffect(() => {
    if (!select) reset()
  }, [reset, select])

  useEffect(() => {
    if (!select) return

    const cancelSelectionOnEscape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return

      e.preventDefault()
      toggleSelect()
    }

    document.addEventListener('keydown', cancelSelectionOnEscape)

    return () => {
      document.removeEventListener('keydown', cancelSelectionOnEscape)
    }
  }, [select, toggleSelect])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || isKeyboardTargetBlocked(e)) {
        return
      }

      const key = e.key.toLowerCase()
      if (key === 's') {
        e.preventDefault()
        e.stopPropagation()
        setLibraryAction((action) =>
          action === 'libraryFilter' ? undefined : 'libraryFilter',
        )
        return
      }

      if (e.key === '0' || e.key === '`' || e.code === 'Backquote') {
        e.preventDefault()
        e.stopPropagation()
        setStatusFilters([])
        return
      }

      const status = readingStatusOptions[Number(e.key) - 1]
      if (status) {
        e.preventDefault()
        e.stopPropagation()
        setStatusFilters((filters) =>
          toggleReadingStatusFilter(filters, status),
        )
      }
    }

    document.addEventListener('keydown', onKeyDown)

    return () => {
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [setLibraryAction, setStatusFilters])

  const sortedBooks = useMemo(
    () =>
      filterBooksByLibraryFilters(
        sortBooks(books ?? [], sortField, sortDirection),
        statusFilters,
        authorFilters,
        tagFilters,
      ),
    [authorFilters, books, sortDirection, sortField, statusFilters, tagFilters],
  )

  if (!books) return null

  const allSelected = selectedBookIds.size === books.length
  const selectedBooks = books.filter((book) => selectedBookIds.has(book.id))
  const DirectionIcon = sortDirection === 'asc' ? ArrowUpIcon : ArrowDownIcon

  return (
    <DropZone
      className="scroll-parent flex h-full min-h-0 flex-col p-4"
      onContextMenu={(e) => {
        e.preventDefault()
      }}
      onDrop={(e) => {
        const bookId = e.dataTransfer.getData('text/plain')
        const book = books.find((b) => b.id === bookId)
        if (book) {
          reader.addTab(book)
          onOpenBook()
        }

        if (e.dataTransfer.files.length) {
          handleFiles(e.dataTransfer.files, { onTextPaths })
        }
      }}
    >
      <div className="mb-4 space-y-2.5">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            {!!books.length && !select && (
              <div className="flex items-center">
                <Select
                  value={sortField}
                  onValueChange={(value) =>
                    setSortField(value as LibrarySortField)
                  }
                >
                  <SelectTrigger
                    aria-label={t(`sort.${sortField}`)}
                    className={clsx(
                      toolbarButtonClass,
                      'bg-secondary text-secondary-foreground min-w-[6.25rem] rounded-r-none border-transparent px-2.5 text-base font-medium hover:bg-[var(--flow-bg-control-hover)] [&_[data-slot=select-value]]:leading-none [&_[data-slot=select-value]]:font-medium',
                    )}
                    size="default"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent
                    align="start"
                    className="min-w-[7rem] p-1 text-base"
                    position="popper"
                  >
                    {librarySortFieldOptions.map((field) => {
                      const SortIcon = sortFieldIconMap[field]

                      return (
                        <SelectItem
                          key={field}
                          value={field}
                          className="h-8 py-0 pr-7 pl-2 text-base leading-none font-medium"
                        >
                          <SortIcon
                            aria-hidden
                            className="text-muted-foreground size-4"
                          />
                          <span className="leading-none">
                            {t(`sort.${field}`)}
                          </span>
                        </SelectItem>
                      )
                    })}
                  </SelectContent>
                </Select>
                <Button
                  type="button"
                  variant="secondary"
                  compact
                  className={clsx(
                    toolbarButtonClass,
                    'border-background/40 w-8 rounded-l-none border-l px-0 text-center font-medium',
                  )}
                  title={t(`sort.${sortDirection}`)}
                  aria-label={t(`sort.${sortDirection}`)}
                  onClick={toggleCurrentSortDirection}
                >
                  <DirectionIcon size={16} className="mx-auto" />
                </Button>
              </div>
            )}
            {!!books.length && (
              <Button
                variant="secondary"
                className={clsx(toolbarButtonClass, 'gap-1.5 px-3')}
                onClick={toggleSelect}
              >
                {select ? (
                  <SquareXIcon aria-hidden className="size-4" />
                ) : (
                  <SquareCheckBigIcon aria-hidden className="size-4" />
                )}
                <span className="leading-none">
                  {t(select ? 'cancel' : 'select')}
                </span>
              </Button>
            )}
            {select &&
              (allSelected ? (
                <Button
                  variant="secondary"
                  className={clsx(toolbarButtonClass, 'gap-1.5 px-3')}
                  onClick={reset}
                >
                  <ListXIcon aria-hidden className="size-4" />
                  <span className="leading-none">{t('deselect_all')}</span>
                </Button>
              ) : (
                <Button
                  variant="secondary"
                  className={clsx(toolbarButtonClass, 'gap-1.5 px-3')}
                  onClick={() => books.forEach((b) => add(b.id))}
                >
                  <ListChecksIcon aria-hidden className="size-4" />
                  <span className="leading-none">{t('select_all')}</span>
                </Button>
              ))}
          </div>

          <div className="space-x-2">
            {select ? (
              <>
                <Button
                  variant="secondary"
                  className={clsx(toolbarButtonClass, 'gap-1.5 px-3')}
                  disabled={!selectedBookIds.size}
                  onClick={() => setBatchTagsOpen(true)}
                >
                  <TagIcon aria-hidden className="size-4" />
                  <span className="leading-none">{t('tags')}</span>
                </Button>
                <Button
                  variant="destructive"
                  className={clsx(toolbarButtonClass, 'gap-1.5 px-3')}
                  onClick={() => {
                    toggleSelect()
                    const bookIds = [...selectedBookIds]

                    db.books.bulkDelete(bookIds)
                  }}
                >
                  <Trash2Icon aria-hidden className="size-4" />
                  <span className="leading-none">{t('delete')}</span>
                </Button>
              </>
            ) : (
              <Button
                className={clsx(toolbarButtonClass, 'gap-1.5 px-3')}
                onClick={() => {
                  void openImportDialog({ onTextPaths })
                }}
              >
                <FileInputIcon aria-hidden className="size-4" />
                <span className="leading-none">{t('import')}</span>
              </Button>
            )}
          </div>
        </div>
      </div>

      <div className="scroll min-h-0 flex-1">
        <ul
          className="grid p-1"
          style={{
            gridTemplateColumns: `repeat(auto-fill, minmax(calc(120px + 2vw), 1fr))`,
            columnGap: lock(10, 16),
            rowGap: lock(10, 16),
          }}
        >
          {sortedBooks.map((book) => (
            <Book
              key={book.id}
              book={book}
              covers={covers}
              select={select}
              selected={has(book.id)}
              toggle={toggle}
              onOpenBook={onOpenBook}
            />
          ))}
        </ul>
      </div>
      {batchTagsOpen && (
        <BatchTagsDialog
          books={selectedBooks}
          tags={tags ?? []}
          onClose={() => setBatchTagsOpen(false)}
        />
      )}
    </DropZone>
  )
}

interface BookProps {
  book: BookRecord
  covers?: CoverRecord[]
  select?: boolean
  selected?: boolean
  toggle: (id: string) => void
  onOpenBook: () => void
}
const Book: React.FC<BookProps> = ({
  book,
  covers,
  select,
  selected,
  toggle,
  onOpenBook,
}) => {
  const t = useTranslation('home')
  const contextMenuRef = useRef<HTMLDivElement>(null)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number }>()
  const [statusMenuOpen, setStatusMenuOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const [infoOpen, setInfoOpen] = useState(false)
  const [tagsOpen, setTagsOpen] = useState(false)

  const cover = covers?.find((c) => c.id === book.id)?.cover
  const displayTitle = getBookDisplayTitle(book)
  const tooltip = getBookTooltip(book)

  const closeContextMenu = useCallback(() => {
    setContextMenu(undefined)
    setConfirmDelete(false)
  }, [])

  const openContextMenu = useCallback(
    (e: React.MouseEvent) => {
      if (select) return

      e.preventDefault()
      e.stopPropagation()
      setContextMenu(clampMenuPosition(e.clientX, e.clientY))
      setConfirmDelete(false)
    },
    [select],
  )

  const openBook = useCallback(async () => {
    reader.addTab((await db.books.get(book.id)) ?? book)
    onOpenBook()
  }, [book, onOpenBook])

  const updateReadingStatus = useCallback(
    (readingStatus: ReadingStatus | null) => {
      setStatusMenuOpen(false)
      void db.books.update(book.id, { readingStatus })
    },
    [book.id],
  )

  const activateBook = useCallback(() => {
    if (select) {
      toggle(book.id)
    } else {
      void openBook()
    }
  }, [book.id, openBook, select, toggle])

  const onBookKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key !== 'Enter' && e.key !== ' ') return

      e.preventDefault()
      activateBook()
    },
    [activateBook],
  )

  useEffect(() => {
    if (!contextMenu) return

    const onPointerDown = (e: PointerEvent) => {
      if (contextMenuRef.current?.contains(e.target as Node)) return
      closeContextMenu()
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeContextMenu()
    }

    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)

    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [closeContextMenu, contextMenu])

  const progressPercent = getBookProgressPercent(book.percentage)

  return (
    <div className="relative" onContextMenu={openContextMenu}>
      <div
        role="button"
        tabIndex={0}
        className={clsx(
          'group focus-visible:ring-ring/50 relative flex cursor-pointer flex-col rounded-md p-1 transition-colors outline-none focus-visible:ring-2',
          select && selected
            ? 'bg-[var(--flow-accent-bg)] ring-2 ring-[var(--flow-accent)] hover:bg-[var(--flow-accent-bg)]'
            : 'hover:bg-popover/70',
        )}
        onClick={activateBook}
        onContextMenu={openContextMenu}
        onKeyDown={onBookKeyDown}
      >
        {contextMenu && (
          <div
            ref={contextMenuRef}
            className="ring-border bg-popover text-popover-foreground fixed z-[70] w-40 rounded-lg p-1 shadow-lg ring-1"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          >
            <BookContextMenuButton
              Icon={BookOpenIcon}
              label={t('context.open')}
              onClick={() => {
                closeContextMenu()
                void openBook()
              }}
            />
            <BookContextMenuButton
              Icon={PencilIcon}
              label={t('context.edit')}
              onClick={() => {
                closeContextMenu()
                setEditOpen(true)
              }}
            />
            <BookContextMenuButton
              Icon={TagIcon}
              label={t('tags')}
              onClick={() => {
                closeContextMenu()
                setTagsOpen(true)
              }}
            />
            <BookContextMenuButton
              Icon={InfoIcon}
              label={t('context.info')}
              onClick={() => {
                closeContextMenu()
                setInfoOpen(true)
              }}
            />
            <div className="bg-muted my-1 h-px" />
            <BookContextMenuButton
              danger
              Icon={confirmDelete ? TriangleAlertIcon : Trash2Icon}
              label={t(
                confirmDelete ? 'context.confirm_delete' : 'context.delete',
              )}
              onClick={() => {
                if (!confirmDelete) {
                  setConfirmDelete(true)
                  return
                }

                closeContextMenu()
                void db.books.delete(book.id)
              }}
            />
          </div>
        )}
        <div className="border-border relative mx-auto aspect-[9/12] w-full max-w-[15rem] overflow-hidden rounded-md border shadow-sm">
          {book.readingStatus && (
            <ReadingStatusBadge
              status={book.readingStatus}
              title={t(`reading_status.${book.readingStatus}`)}
              hidden={statusMenuOpen}
            />
          )}
          {!select && (
            <Popover open={statusMenuOpen} onOpenChange={setStatusMenuOpen}>
              <div
                className="absolute top-2 right-2 z-20"
                onClick={(e) => e.stopPropagation()}
                onPointerDown={(e) => e.stopPropagation()}
                onContextMenu={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                }}
              >
                <AppTooltip label={t('reading_status.change')}>
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      aria-label={t('reading_status.change')}
                      className={clsx(
                        'flex size-8 items-center justify-center rounded-lg opacity-0 shadow-sm ring-1 transition-opacity ring-inset group-hover:opacity-100',
                        readingStatusEditButtonClassName[
                          book.readingStatus ?? 'unmarked'
                        ],
                        statusMenuOpen && 'opacity-100',
                      )}
                    >
                      <ReadingStatusIcon
                        intent="edit"
                        status={book.readingStatus ?? null}
                        size={18}
                        tone="current"
                      />
                    </button>
                  </PopoverTrigger>
                </AppTooltip>
                <PopoverContent
                  align="start"
                  side="bottom"
                  sideOffset={4}
                  className="w-36 p-1 text-base"
                  style={{ fontSize: 'var(--app-font-size-md)' }}
                  onClick={(e) => e.stopPropagation()}
                  onPointerDown={(e) => e.stopPropagation()}
                >
                  <ReadingStatusMenu
                    status={book.readingStatus ?? null}
                    onChange={updateReadingStatus}
                  />
                </PopoverContent>
              </div>
            </Popover>
          )}
          <img
            src={cover ?? placeholder}
            alt="Cover"
            className="block h-full w-full rounded-[inherit] object-cover"
            draggable={false}
          />
          {!select && progressPercent !== undefined && (
            <BookProgress
              percent={progressPercent}
              status={book.readingStatus ?? null}
            />
          )}
          {select && (
            <div className="absolute right-2 bottom-2 z-20">
              <div
                aria-hidden
                className={clsx(
                  'flex size-6 items-center justify-center rounded-md shadow-sm ring-1 ring-inset',
                  selected
                    ? 'bg-[var(--flow-accent)] text-[var(--flow-accent-text)] ring-[var(--flow-accent)]'
                    : 'bg-[var(--flow-bg-panel)] ring-[var(--flow-border)]',
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
          <div className="text-foreground mt-2 flex min-h-[2.5em] w-full items-start justify-center px-1 text-center text-lg leading-tight font-semibold">
            <span className="line-clamp-2 min-w-0 break-words">
              {displayTitle}
            </span>
          </div>
        </AppTooltip>
      </div>
      {editOpen && (
        <EditBookDialog book={book} onClose={() => setEditOpen(false)} />
      )}
      {tagsOpen && (
        <BookTagsDialog book={book} onClose={() => setTagsOpen(false)} />
      )}
      {infoOpen && (
        <BookInfoDialog
          book={book}
          cover={cover}
          onClose={() => setInfoOpen(false)}
        />
      )}
    </div>
  )
}

interface BookContextMenuButtonProps {
  danger?: boolean
  Icon: React.ComponentType<{ size?: number; className?: string }>
  label: string
  onClick: () => void
}

const BookContextMenuButton: React.FC<BookContextMenuButtonProps> = ({
  danger,
  Icon,
  label,
  onClick,
}) => {
  return (
    <button
      type="button"
      className={clsx(
        'hover:bg-muted flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-base outline-none',
        danger ? 'text-destructive' : 'text-muted-foreground',
      )}
      onClick={onClick}
    >
      <Icon size={18} className="shrink-0" />
      <span className="min-w-0 truncate">{label}</span>
    </button>
  )
}

const readingStatusBadgeClassName: Record<ReadingStatus, string> = {
  toRead: 'bg-amber-500 text-white ring-amber-700/15',
  reading: 'bg-sky-500 text-white ring-sky-700/15',
  read: 'bg-emerald-600 text-white ring-emerald-800/15',
}

const readingStatusEditButtonClassName: Record<
  ReadingStatus | 'unmarked',
  string
> = {
  unmarked:
    'bg-popover/95 text-muted-foreground ring-border hover:bg-muted hover:text-foreground',
  toRead: 'bg-amber-50/95 text-amber-600 ring-amber-200 hover:bg-amber-100',
  reading: 'bg-sky-50/95 text-sky-600 ring-sky-200 hover:bg-sky-100',
  read: 'bg-emerald-50/95 text-emerald-600 ring-emerald-200 hover:bg-emerald-100',
}

const readingStatusProgressBarClassName: Record<
  ReadingStatus | 'unmarked',
  string
> = {
  unmarked: 'bg-sky-500',
  toRead: 'bg-amber-500',
  reading: 'bg-sky-500',
  read: 'bg-emerald-500',
}

const readingStatusProgressPillClassName: Record<
  ReadingStatus | 'unmarked',
  string
> = {
  unmarked: 'bg-sky-50/95 text-sky-600 ring-sky-200',
  toRead: 'bg-amber-50/95 text-amber-600 ring-amber-200',
  reading: 'bg-sky-50/95 text-sky-600 ring-sky-200',
  read: 'bg-emerald-50/95 text-emerald-600 ring-emerald-200',
}

interface BookProgressProps {
  percent: number
  status: ReadingStatus | null
}

const BookProgress: React.FC<BookProgressProps> = ({ percent, status }) => {
  const statusKey = status ?? 'unmarked'

  return (
    <div className="pointer-events-none absolute right-1 bottom-1 left-1 z-10 flex items-center gap-1.5">
      <div className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-white/75 shadow-sm ring-1 ring-black/5">
        <div
          className={clsx(
            'h-full rounded-full',
            readingStatusProgressBarClassName[statusKey],
          )}
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

interface ReadingStatusBadgeProps {
  hidden?: boolean
  status: ReadingStatus
  title: string
}

const ReadingStatusBadge: React.FC<ReadingStatusBadgeProps> = ({
  hidden,
  status,
  title,
}) => {
  const badge = (
    <div
      aria-label={title}
      className={clsx(
        'absolute top-2 right-2 z-10 flex size-8 items-center justify-center rounded-lg shadow-sm ring-1 transition-opacity ring-inset group-hover:opacity-0',
        readingStatusBadgeClassName[status],
        hidden && 'opacity-0',
      )}
    >
      <ReadingStatusIcon
        status={status}
        size={18}
        tone="current"
        className="text-white"
      />
    </div>
  )

  return <AppTooltip label={title}>{badge}</AppTooltip>
}

interface ReadingStatusMenuProps {
  status: ReadingStatus | null
  onChange: (status: ReadingStatus | null) => void
}

const ReadingStatusMenu: React.FC<ReadingStatusMenuProps> = ({
  status,
  onChange,
}) => {
  const t = useTranslation('home')

  return (
    <div className="flex flex-col gap-0.5">
      <ReadingStatusMenuItem
        iconStatus={null}
        label={t('reading_status.unmarked')}
        checked={!status}
        onClick={() => onChange(null)}
      />
      {readingStatusOptions.map((option) => {
        return (
          <ReadingStatusMenuItem
            key={option}
            iconStatus={option}
            label={t(`reading_status.${option}`)}
            checked={status === option}
            onClick={() => onChange(option)}
          />
        )
      })}
    </div>
  )
}

interface ReadingStatusMenuItemProps {
  danger?: boolean
  checked: boolean
  iconStatus: ReadingStatus | null
  label: string
  onClick: () => void
  removeIcon?: boolean
}

const ReadingStatusMenuItem: React.FC<ReadingStatusMenuItemProps> = ({
  danger,
  checked,
  iconStatus,
  label,
  onClick,
  removeIcon,
}) => {
  return (
    <UiButton
      type="button"
      variant="ghost"
      size="sm"
      className={clsx(
        'h-8 w-full justify-start gap-2 px-2 text-base leading-none',
        danger
          ? 'text-destructive hover:bg-destructive/10 hover:text-destructive'
          : 'text-muted-foreground',
      )}
      style={{ fontSize: 'var(--app-font-size-md)' }}
      onClick={onClick}
    >
      <ReadingStatusIcon
        intent={removeIcon ? 'remove' : 'status'}
        status={iconStatus}
        className={danger ? 'text-destructive' : undefined}
      />
      <span className="min-w-0 flex-1 truncate text-left leading-none">
        {label}
      </span>
      {checked && (
        <CheckIcon className="size-4 shrink-0 text-[var(--flow-accent)]" />
      )}
    </UiButton>
  )
}

interface BookDialogProps {
  book: BookRecord
  onClose: () => void
}

function selectInputOnFocus(e: React.FocusEvent<HTMLInputElement>) {
  e.currentTarget.select()
}

const tagPickerChipClassName =
  'h-8 max-w-full justify-start gap-1.5 px-3 text-base leading-none'
const tagPickerInactiveChipClassName =
  'bg-transparent text-[var(--flow-text)] ring-1 ring-[var(--flow-sidebar-item-border)] ring-inset hover:bg-[var(--flow-sidebar-item-bg-hover)]'
const tagPickerPartialChipClassName =
  'bg-[var(--flow-sidebar-item-bg-hover)] text-[var(--flow-text)] ring-1 ring-[var(--flow-accent)]/60 ring-inset hover:bg-[var(--flow-sidebar-item-bg-hover)]'

type TagSelectionState = 'none' | 'partial' | 'selected'

interface TemporaryLibraryTagRecord extends LibraryTagRecord {
  temporary: true
}

interface TagSelectionEditorProps {
  onSelectTag: (tagId: string) => void
  onTemporaryTagsChange: React.Dispatch<
    React.SetStateAction<TemporaryLibraryTagRecord[]>
  >
  onToggleTag: (tagId: string) => void
  partialTagIds?: Set<string>
  selectedTagIds: Set<string>
  tags: LibraryTagRecord[]
  temporaryTags: TemporaryLibraryTagRecord[]
}

const TagSelectionEditor: React.FC<TagSelectionEditorProps> = ({
  onSelectTag,
  onTemporaryTagsChange,
  onToggleTag,
  partialTagIds,
  selectedTagIds,
  tags,
  temporaryTags,
}) => {
  const t = useTranslation('home')
  const [newTagName, setNewTagName] = useState('')
  const temporaryTagIndexRef = useRef(0)
  const visibleTags = useMemo(
    () => mergeLibraryTags(tags, temporaryTags),
    [tags, temporaryTags],
  )
  const cleanName = cleanLibraryTagName(newTagName)

  const addTag = () => {
    if (!cleanName) return

    const existing = visibleTags.find((tag) =>
      sameLibraryTagName(tag.name, cleanName),
    )
    if (existing) {
      onSelectTag(existing.id)
      setNewTagName('')
      return
    }

    temporaryTagIndexRef.current += 1
    const tag: TemporaryLibraryTagRecord = {
      id: `temp-tag-${Date.now()}-${temporaryTagIndexRef.current}`,
      name: cleanName,
      createdAt: Date.now(),
      temporary: true,
    }

    onTemporaryTagsChange(
      (current) =>
        mergeLibraryTags(current, [tag]) as TemporaryLibraryTagRecord[],
    )
    onSelectTag(tag.id)
    setNewTagName('')
  }

  return (
    <div className="space-y-3">
      <div className="flex items-end gap-2">
        <label className="min-w-0 flex-1">
          <span className="text-muted-foreground mb-1.5 block leading-none font-medium">
            {t('edit.new_tag')}
          </span>
          <Input
            value={newTagName}
            onChange={(e) => setNewTagName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return

              e.preventDefault()
              addTag()
            }}
            className="focus-visible:border-input text-base focus-visible:ring-0"
          />
        </label>
        <UiButton
          type="button"
          variant="secondary"
          disabled={!cleanName}
          onClick={() => {
            addTag()
          }}
        >
          {t('edit.add_tag')}
        </UiButton>
      </div>

      {visibleTags.length > 0 && (
        <div className="flex min-w-0 flex-wrap gap-1.5">
          {visibleTags.map((tag) => {
            const state: TagSelectionState = selectedTagIds.has(tag.id)
              ? 'selected'
              : partialTagIds?.has(tag.id)
                ? 'partial'
                : 'none'

            return (
              <UiButton
                key={tag.id}
                type="button"
                size="sm"
                variant={state === 'selected' ? 'default' : 'secondary'}
                aria-pressed={
                  state === 'partial' ? 'mixed' : state === 'selected'
                }
                title={tag.name}
                className={clsx(
                  tagPickerChipClassName,
                  state === 'partial' && tagPickerPartialChipClassName,
                  state === 'none' && tagPickerInactiveChipClassName,
                )}
                onClick={() => onToggleTag(tag.id)}
              >
                <span className="min-w-0 truncate leading-none">
                  {tag.name}
                </span>
              </UiButton>
            )
          })}
        </div>
      )}
    </div>
  )
}

function getTagsInAllBooks(books: BookRecord[], tags: LibraryTagRecord[]) {
  return new Set(
    tags
      .filter(
        (tag) =>
          books.length > 0 &&
          books.every((book) => (book.tagIds ?? []).includes(tag.id)),
      )
      .map((tag) => tag.id),
  )
}

function getTagsInAnyBook(books: BookRecord[], tags: LibraryTagRecord[]) {
  return new Set(
    tags
      .filter((tag) =>
        books.some((book) => (book.tagIds ?? []).includes(tag.id)),
      )
      .map((tag) => tag.id),
  )
}

function getPartiallySelectedTags(
  books: BookRecord[],
  tags: LibraryTagRecord[],
) {
  const allTagIds = getTagsInAllBooks(books, tags)

  return new Set(
    [...getTagsInAnyBook(books, tags)].filter((tagId) => !allTagIds.has(tagId)),
  )
}

async function resolveSelectedTagIds(
  selectedTagIds: Set<string>,
  temporaryTags: TemporaryLibraryTagRecord[],
) {
  const temporaryById = new Map(temporaryTags.map((tag) => [tag.id, tag]))
  const resolvedIds: string[] = []

  for (const tagId of selectedTagIds) {
    const temporaryTag = temporaryById.get(tagId)
    if (!temporaryTag) {
      resolvedIds.push(tagId)
      continue
    }

    const tag = await db.tags.create(temporaryTag.name)
    if (tag) resolvedIds.push(tag.id)
  }

  return uniqueStringValues(resolvedIds)
}

interface BatchTagsDialogProps {
  books: BookRecord[]
  onClose: () => void
  tags: LibraryTagRecord[]
}

const BatchTagsDialog: React.FC<BatchTagsDialogProps> = ({
  books,
  onClose,
  tags,
}) => {
  const t = useTranslation('home')
  const [selectedTagIds, setSelectedTagIds] = useState(() =>
    getTagsInAllBooks(books, tags),
  )
  const [partialTagIds, setPartialTagIds] = useState(() =>
    getPartiallySelectedTags(books, tags),
  )
  const [temporaryTags, setTemporaryTags] = useState<
    TemporaryLibraryTagRecord[]
  >([])

  const toggleTag = useCallback((tagId: string) => {
    setSelectedTagIds((current) => {
      const next = new Set(current)
      if (next.has(tagId)) {
        next.delete(tagId)
      } else {
        next.add(tagId)
      }

      return next
    })
    setPartialTagIds((current) => {
      if (!current.has(tagId)) return current

      const next = new Set(current)
      next.delete(tagId)
      return next
    })
  }, [])

  const selectTag = useCallback((tagId: string) => {
    setSelectedTagIds((current) => {
      if (current.has(tagId)) return current

      const next = new Set(current)
      next.add(tagId)
      return next
    })
    setPartialTagIds((current) => {
      if (!current.has(tagId)) return current

      const next = new Set(current)
      next.delete(tagId)
      return next
    })
  }, [])

  const apply = async () => {
    if (!books.length) return

    const persistedSelectedTagIds = new Set(
      await resolveSelectedTagIds(selectedTagIds, temporaryTags),
    )
    const initialTagIds = getTagsInAllBooks(books, tags)
    const initialAnyTagIds = getTagsInAnyBook(books, tags)
    const addTagIds = [...persistedSelectedTagIds].filter(
      (tagId) => !initialTagIds.has(tagId),
    )
    const removeTagIds = [...initialAnyTagIds].filter(
      (tagId) =>
        !persistedSelectedTagIds.has(tagId) && !partialTagIds.has(tagId),
    )

    await db.books.updateTags(
      books.map((book) => book.id),
      { addTagIds, removeTagIds },
    )
    onClose()
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent
        data-flow-keyboard-capture="true"
        className="w-[min(32rem,calc(100vw-2rem))] max-w-none text-base"
      >
        <DialogHeader>
          <DialogTitle>{t('batch_tags.title')}</DialogTitle>
        </DialogHeader>
        <TagSelectionEditor
          tags={tags}
          temporaryTags={temporaryTags}
          selectedTagIds={selectedTagIds}
          partialTagIds={partialTagIds}
          onToggleTag={toggleTag}
          onSelectTag={selectTag}
          onTemporaryTagsChange={setTemporaryTags}
        />
        <DialogFooter className="-mx-4 mt-1 -mb-4 px-4 py-3">
          <UiButton type="button" variant="secondary" onClick={onClose}>
            {t('cancel')}
          </UiButton>
          <UiButton
            type="button"
            disabled={!books.length}
            onClick={() => {
              void apply()
            }}
          >
            {t('batch_tags.apply')}
          </UiButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

const BookTagsDialog: React.FC<BookDialogProps> = ({ book, onClose }) => {
  const t = useTranslation('home')
  const tags = useLibraryTags()
  const [tagIds, setTagIds] = useState(
    () => new Set(uniqueStringValues(book.tagIds ?? [])),
  )
  const [temporaryTags, setTemporaryTags] = useState<
    TemporaryLibraryTagRecord[]
  >([])

  const toggleTag = useCallback((tagId: string) => {
    setTagIds((current) => {
      const next = new Set(current)
      if (next.has(tagId)) {
        next.delete(tagId)
      } else {
        next.add(tagId)
      }

      return next
    })
  }, [])

  const selectTag = useCallback((tagId: string) => {
    setTagIds((current) => {
      if (current.has(tagId)) return current

      const next = new Set(current)
      next.add(tagId)
      return next
    })
  }, [])

  const apply = () => {
    void resolveSelectedTagIds(tagIds, temporaryTags)
      .then((resolvedTagIds) =>
        db.books.update(book.id, { tagIds: resolvedTagIds }),
      )
      .then(() => onClose())
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent
        data-flow-keyboard-capture="true"
        className="w-[min(32rem,calc(100vw-2rem))] max-w-none text-base"
      >
        <DialogHeader>
          <DialogTitle>{t('batch_tags.title')}</DialogTitle>
        </DialogHeader>
        <TagSelectionEditor
          tags={tags ?? []}
          temporaryTags={temporaryTags}
          selectedTagIds={tagIds}
          onToggleTag={toggleTag}
          onSelectTag={selectTag}
          onTemporaryTagsChange={setTemporaryTags}
        />
        <DialogFooter className="-mx-4 mt-1 -mb-4 px-4 py-3">
          <UiButton type="button" variant="secondary" onClick={onClose}>
            {t('cancel')}
          </UiButton>
          <UiButton type="button" onClick={apply}>
            {t('batch_tags.apply')}
          </UiButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

const EditBookDialog: React.FC<BookDialogProps> = ({ book, onClose }) => {
  const t = useTranslation('home')
  const titleRef = useRef<HTMLInputElement>(null)
  const [title, setTitle] = useState(getBookDisplayTitle(book))
  const [creator, setCreator] = useState(cleanBookText(book.metadata.creator))

  const save = () => {
    void db.books
      .update(book.id, {
        metadata: {
          ...book.metadata,
          title: cleanBookText(title),
          creator: cleanBookText(creator),
        },
      })
      .then(() => onClose())
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent
        data-flow-keyboard-capture="true"
        className="w-[min(28rem,calc(100vw-2rem))] max-w-none text-base"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          titleRef.current?.focus()
          titleRef.current?.select()
        }}
      >
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            save()
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('edit.dialog_title')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <label className="block">
              <span className="text-muted-foreground mb-1.5 block leading-none font-medium">
                {t('edit.title')}
              </span>
              <Input
                ref={titleRef}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onFocus={selectInputOnFocus}
                className="focus-visible:border-input text-base focus-visible:ring-0"
              />
            </label>
            <label className="block">
              <span className="text-muted-foreground mb-1.5 block leading-none font-medium">
                {t('edit.creator')}
              </span>
              <Input
                value={creator}
                onChange={(e) => setCreator(e.target.value)}
                onFocus={selectInputOnFocus}
                className="focus-visible:border-input text-base focus-visible:ring-0"
              />
            </label>
          </div>
          <DialogFooter className="-mx-4 mt-1 -mb-4 px-4 py-3">
            <UiButton type="button" variant="secondary" onClick={onClose}>
              {t('cancel')}
            </UiButton>
            <UiButton type="submit">{t('edit.save')}</UiButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

interface BookInfoDialogProps extends BookDialogProps {
  cover?: string | null
}

const BookInfoDialog: React.FC<BookInfoDialogProps> = ({
  book,
  cover,
  onClose,
}) => {
  const t = useTranslation('home')
  const title = getBookDisplayTitle(book)
  const description = cleanBookDescription(book.metadata.description)
  const rows = [
    [t('info.creator'), cleanBookText(book.metadata.creator)],
    [t('info.language'), formatLanguage(book.metadata.language)],
    [t('info.publisher'), cleanBookText(book.metadata.publisher)],
    [t('info.pubdate'), cleanBookText(book.metadata.pubdate)],
    [t('info.filename'), cleanBookText(book.name)],
    [t('info.size'), formatFileSize(book.size)],
    [t('info.createdAt'), formatDateTime(book.createdAt)],
    [t('info.lastReadAt'), formatDateTime(book.lastReadAt)],
    [t('info.percentage'), formatPercentage(book.percentage)],
  ].filter(([, value]) => !!value)

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent
        data-flow-keyboard-capture="true"
        className="max-h-[calc(100vh-4rem)] w-[min(46rem,calc(100vw-2rem))] max-w-none gap-0 overflow-hidden p-0 text-base"
      >
        <div className="grid grid-cols-[12rem_minmax(0,1fr)] gap-5 p-5 pr-12">
          <div className="w-full">
            {cover && (
              <img
                src={cover}
                alt=""
                className="aspect-[9/12] w-full object-cover shadow-sm"
                draggable={false}
              />
            )}
          </div>
          <div className="min-w-0 pr-6">
            <DialogTitle className="text-foreground !text-xl leading-tight font-bold">
              {title}
            </DialogTitle>
            {!!rows.length && (
              <dl className="mt-4 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-2 gap-y-1 text-base">
                {rows.map(([label, value]) => (
                  <React.Fragment key={label}>
                    <dt className="font-semibold">{label}:</dt>
                    <dd className="min-w-0 break-words">{value}</dd>
                  </React.Fragment>
                ))}
              </dl>
            )}
          </div>
        </div>
        {description && (
          <div className="scroll border-border max-h-[min(18rem,38vh)] overflow-y-auto border-t p-5 pt-4 text-justify text-base">
            {description.split(/\n{2,}/).map((paragraph, index) => (
              <p key={index} className={clsx(index > 0 && 'mt-3')}>
                {paragraph}
              </p>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
