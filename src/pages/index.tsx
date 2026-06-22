import { Overlay } from '@literal-ui/core'
import { useBoolean } from '@literal-ui/hooks'
import clsx from 'clsx'
import Head from 'next/head'
import { useRouter } from 'next/router'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  MdArrowDownward,
  MdArrowUpward,
  MdBookmark,
  MdBookmarkBorder,
  MdCheck,
  MdCheckBox,
  MdCheckBoxOutlineBlank,
  MdCheckCircle,
  MdDeleteOutline,
  MdEdit,
  MdInfoOutline,
  MdKeyboardArrowDown,
  MdMenuBook,
  MdRemoveCircleOutline,
  MdWarningAmber,
} from 'react-icons/md'
import { useRecoilState } from 'recoil'

import {
  cleanBookText,
  compareBookDisplayTitle,
  getBookDisplayTitle,
  getBookTooltip,
} from '../book'
import { ReaderGridView, Button, DropZone } from '../components'
import { TextImportDialog } from '../components/TextImportDialog'
import { BookRecord, CoverRecord, ReadingStatus, db } from '../db'
import { handleFiles, openImportDialog, setupNativeOpenFiles } from '../file'
import {
  useCovers,
  useDisablePinchZooming,
  useLibrary,
  useLibraryAction,
  useMobile,
  useTranslation,
} from '../hooks'
import { reader, useReaderSnapshot } from '../models'
import {
  libraryStatusFilterState,
  useSettings,
  useSettingsReady,
  viewModeState,
} from '../state'
import { lock } from '../styles'

const placeholder = `data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect fill="gray" fill-opacity="0" width="1" height="1"/></svg>`

type SortField = 'title' | 'creator' | 'updatedAt' | 'createdAt'
type SortDirection = 'asc' | 'desc'

const collator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
})

const sortFieldOptions: SortField[] = [
  'title',
  'creator',
  'updatedAt',
  'createdAt',
]

const readingStatusOptions: ReadingStatus[] = ['toRead', 'reading', 'read']

const toolbarButtonClass = 'h-8'

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

function clampMenuPosition(x: number, y: number) {
  if (typeof window === 'undefined') return { x, y }

  return {
    x: Math.min(x, Math.max(8, window.innerWidth - 176)),
    y: Math.min(y, Math.max(8, window.innerHeight - 168)),
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

function compareBooksByField(a: BookRecord, b: BookRecord, field: SortField) {
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
  field: SortField,
  direction: SortDirection,
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

function toggleSortDirection(direction: SortDirection): SortDirection {
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
  const [viewMode, setViewMode] = useRecoilState(viewModeState)
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

  useDisablePinchZooming()

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
      setStartupRestoreDone(true)
      return
    }

    db.books
      .get(settings.startupSession.bookId)
      .then((book) => {
        if (!book || reader.groups.length) return

        reader.addTab(book)
        setViewMode('reader')
      })
      .finally(() => {
        setStartupRestoreDone(true)
      })
  }, [
    nativeOpenReady,
    setViewMode,
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
        {/* https://github.com/microsoft/vscode/blob/36fdf6b697cba431beb6e391b5a8c5f3606975a1/src/vs/code/browser/workbench/workbench.html#L16 */}
        {/* Disable pinch zooming */}
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1.0, maximum-scale=1.0, minimum-scale=1.0, user-scalable=no"
        />
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
  const t = useTranslation('home')
  const [sortField, setSortField] = useState<SortField>('title')
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc')
  const [sortMenuOpen, setSortMenuOpen] = useState(false)
  const sortMenuRef = useRef<HTMLDivElement>(null)
  const [statusFilters, setStatusFilters] = useRecoilState(
    libraryStatusFilterState,
  )
  const [, setLibraryAction] = useLibraryAction()

  const [select, toggleSelect] = useBoolean(false)
  const [selectedBookIds, { add, has, toggle, reset }] = useStringSet()

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
    if (!sortMenuOpen) return

    const closeOnPointerDown = (e: PointerEvent) => {
      if (!sortMenuRef.current?.contains(e.target as Node)) {
        setSortMenuOpen(false)
      }
    }
    const closeOnEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSortMenuOpen(false)
    }

    document.addEventListener('pointerdown', closeOnPointerDown)
    document.addEventListener('keydown', closeOnEscape)

    return () => {
      document.removeEventListener('pointerdown', closeOnPointerDown)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [sortMenuOpen])

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

      if (e.key === '1') {
        e.preventDefault()
        e.stopPropagation()
        setStatusFilters([])
        return
      }

      const status = readingStatusOptions[Number(e.key) - 2]
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
      sortBooks(books ?? [], sortField, sortDirection).filter((book) => {
        if (!statusFilters.length) return true
        return (
          !!book.readingStatus && statusFilters.includes(book.readingStatus)
        )
      }),
    [books, sortDirection, sortField, statusFilters],
  )

  if (!books) return null

  const allSelected = selectedBookIds.size === books.length
  const DirectionIcon =
    sortDirection === 'asc' ? MdArrowUpward : MdArrowDownward

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
              <div
                ref={sortMenuRef}
                className="relative flex items-center gap-1"
              >
                <Button
                  type="button"
                  variant="secondary"
                  compact
                  className={clsx(
                    toolbarButtonClass,
                    'inline-flex min-w-[4.5rem] items-center justify-between gap-1',
                  )}
                  aria-haspopup="menu"
                  aria-expanded={sortMenuOpen}
                  onClick={() => setSortMenuOpen((open) => !open)}
                >
                  <span>{t(`sort.${sortField}`)}</span>
                  <MdKeyboardArrowDown size={16} className="text-outline" />
                </Button>
                {sortMenuOpen && (
                  <div
                    role="menu"
                    className="absolute left-0 top-full z-20 mt-1 min-w-[7rem] bg-surface py-1 text-on-surface-variant shadow-1 ring-1 ring-inset ring-surface-variant"
                  >
                    {sortFieldOptions.map((field) => (
                      <button
                        key={field}
                        type="button"
                        role="menuitemradio"
                        aria-checked={field === sortField}
                        className={clsx(
                          'block w-full px-3 py-1.5 text-left typescale-label-large hover:bg-outline/10',
                          field === sortField &&
                            'bg-outline/10 text-on-surface',
                        )}
                        onClick={() => {
                          setSortField(field)
                          setSortMenuOpen(false)
                        }}
                      >
                        {t(`sort.${field}`)}
                      </button>
                    ))}
                  </div>
                )}
                <Button
                  type="button"
                  variant="secondary"
                  compact
                  className={clsx(toolbarButtonClass, 'w-8 px-0 text-center')}
                  title={t(`sort.${sortDirection}`)}
                  aria-label={t(`sort.${sortDirection}`)}
                  onClick={() =>
                    setSortDirection((direction) =>
                      toggleSortDirection(direction),
                    )
                  }
                >
                  <DirectionIcon size={16} className="mx-auto" />
                </Button>
              </div>
            )}
            {!!books.length && (
              <Button
                variant="secondary"
                className={toolbarButtonClass}
                onClick={toggleSelect}
              >
                {t(select ? 'cancel' : 'select')}
              </Button>
            )}
            {select &&
              (allSelected ? (
                <Button
                  variant="secondary"
                  className={toolbarButtonClass}
                  onClick={reset}
                >
                  {t('deselect_all')}
                </Button>
              ) : (
                <Button
                  variant="secondary"
                  className={toolbarButtonClass}
                  onClick={() => books.forEach((b) => add(b.id))}
                >
                  {t('select_all')}
                </Button>
              ))}
          </div>

          <div className="space-x-2">
            {select ? (
              <Button
                className={toolbarButtonClass}
                onClick={() => {
                  toggleSelect()
                  const bookIds = [...selectedBookIds]

                  db.books.bulkDelete(bookIds)
                }}
              >
                {t('delete')}
              </Button>
            ) : (
              <Button
                className={toolbarButtonClass}
                onClick={() => {
                  void openImportDialog({ onTextPaths })
                }}
              >
                {t('import')}
              </Button>
            )}
          </div>
        </div>
      </div>

      <div className="scroll min-h-0 flex-1">
        <ul
          className="grid"
          style={{
            gridTemplateColumns: `repeat(auto-fill, minmax(calc(80px + 3vw), 1fr))`,
            columnGap: lock(16, 32),
            rowGap: lock(24, 40),
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
  const router = useRouter()
  const mobile = useMobile()
  const t = useTranslation('home')
  const contextMenuRef = useRef<HTMLDivElement>(null)
  const statusMenuRef = useRef<HTMLDivElement>(null)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number }>()
  const [statusMenuOpen, setStatusMenuOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const [infoOpen, setInfoOpen] = useState(false)

  const cover = covers?.find((c) => c.id === book.id)?.cover
  const displayTitle = getBookDisplayTitle(book)
  const tooltip = getBookTooltip(book)

  const Icon = selected ? MdCheckBox : MdCheckBoxOutlineBlank
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
    if (mobile) await router.push('/_')
    reader.addTab((await db.books.get(book.id)) ?? book)
    onOpenBook()
  }, [book, mobile, onOpenBook, router])

  const updateReadingStatus = useCallback(
    (readingStatus: ReadingStatus | null) => {
      setStatusMenuOpen(false)
      void db.books.update(book.id, { readingStatus })
    },
    [book.id],
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

  useEffect(() => {
    if (!statusMenuOpen) return

    const onPointerDown = (e: PointerEvent) => {
      if (statusMenuRef.current?.contains(e.target as Node)) return
      setStatusMenuOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setStatusMenuOpen(false)
    }

    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)

    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [statusMenuOpen])

  return (
    <div className="relative flex flex-col" onContextMenu={openContextMenu}>
      <div
        role="button"
        className="group relative border border-inverse-on-surface"
        onClick={() => {
          if (select) {
            toggle(book.id)
          } else {
            void openBook()
          }
        }}
        onContextMenu={openContextMenu}
      >
        {contextMenu && (
          <div
            ref={contextMenuRef}
            className="ring-on-surface-variant/15 fixed z-[70] w-40 bg-surface py-1 text-on-surface-variant shadow-lg ring-1 ring-inset"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          >
            <BookContextMenuButton
              Icon={MdMenuBook}
              label={t('context.open')}
              onClick={() => {
                closeContextMenu()
                void openBook()
              }}
            />
            <BookContextMenuButton
              Icon={MdEdit}
              label={t('context.edit')}
              onClick={() => {
                closeContextMenu()
                setEditOpen(true)
              }}
            />
            <BookContextMenuButton
              Icon={MdInfoOutline}
              label={t('context.info')}
              onClick={() => {
                closeContextMenu()
                setInfoOpen(true)
              }}
            />
            <div className="my-1 h-px bg-on-surface-variant/10" />
            <BookContextMenuButton
              danger
              Icon={confirmDelete ? MdWarningAmber : MdDeleteOutline}
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
        {editOpen && (
          <EditBookDialog book={book} onClose={() => setEditOpen(false)} />
        )}
        {infoOpen && (
          <BookInfoDialog
            book={book}
            cover={cover}
            onClose={() => setInfoOpen(false)}
          />
        )}
        {book.readingStatus && (
          <ReadingStatusBadge
            status={book.readingStatus}
            title={t(`reading_status.${book.readingStatus}`)}
          />
        )}
        {!select && (
          <div
            ref={statusMenuRef}
            className="absolute right-1 top-1 z-20"
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
            onContextMenu={(e) => {
              e.preventDefault()
              e.stopPropagation()
            }}
          >
            <button
              type="button"
              title={t('reading_status.change')}
              className={clsx(
                'flex h-7 w-7 items-center justify-center rounded-sm bg-surface/90 text-outline opacity-0 shadow-sm ring-1 ring-inset ring-on-surface-variant/20 hover:text-on-surface-variant group-hover:opacity-100',
                statusMenuOpen && 'text-on-surface-variant opacity-100',
              )}
              onClick={() => setStatusMenuOpen((open) => !open)}
            >
              <MdBookmarkBorder size={18} />
            </button>
            {statusMenuOpen && (
              <ReadingStatusMenu
                status={book.readingStatus ?? null}
                onChange={updateReadingStatus}
              />
            )}
          </div>
        )}
        {book.percentage !== undefined && (
          <div className="absolute right-0 bg-gray-500/60 px-2 text-gray-100 typescale-body-large group-hover:hidden">
            {(book.percentage * 100).toFixed()}%
          </div>
        )}
        <img
          src={cover ?? placeholder}
          alt="Cover"
          className="mx-auto aspect-[9/12] object-cover"
          draggable={false}
        />
        {select && (
          <div className="absolute bottom-1 right-1">
            <Icon
              size={24}
              className={clsx(
                '-m-1',
                selected ? 'text-tertiary' : 'text-outline',
              )}
            />
          </div>
        )}
      </div>

      <div
        className="mt-2 w-full text-center text-on-surface-variant typescale-body-small line-clamp-2 lg:typescale-body-medium"
        title={tooltip}
      >
        {displayTitle}
      </div>
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
        'flex h-8 w-full items-center gap-2 px-3 text-left typescale-body-medium hover:bg-on-surface-variant/10',
        danger ? 'text-error' : 'text-on-surface-variant',
      )}
      onClick={onClick}
    >
      <Icon size={18} className="shrink-0" />
      <span className="min-w-0 truncate">{label}</span>
    </button>
  )
}

const readingStatusIcon: Record<
  ReadingStatus,
  React.ComponentType<{ size?: number; className?: string }>
> = {
  toRead: MdBookmark,
  reading: MdMenuBook,
  read: MdCheckCircle,
}

const readingStatusClassName: Record<ReadingStatus, string> = {
  toRead: 'bg-amber-500 text-white',
  reading: 'bg-sky-500 text-white',
  read: 'bg-emerald-600 text-white',
}

interface ReadingStatusBadgeProps {
  status: ReadingStatus
  title: string
}

const ReadingStatusBadge: React.FC<ReadingStatusBadgeProps> = ({
  status,
  title,
}) => {
  const Icon = readingStatusIcon[status]

  return (
    <div
      title={title}
      className={clsx(
        'absolute left-1 top-1 z-10 flex h-7 w-7 items-center justify-center rounded-sm shadow-sm',
        readingStatusClassName[status],
      )}
    >
      <Icon size={18} />
    </div>
  )
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
    <div className="ring-on-surface-variant/15 absolute right-0 top-full mt-1 w-40 bg-surface py-1 text-on-surface-variant shadow-lg ring-1 ring-inset">
      <ReadingStatusMenuItem
        Icon={MdBookmarkBorder}
        label={t('reading_status.unmarked')}
        checked={!status}
        onClick={() => onChange(null)}
      />
      {readingStatusOptions.map((option) => {
        const Icon = readingStatusIcon[option]
        return (
          <ReadingStatusMenuItem
            key={option}
            Icon={Icon}
            label={t(`reading_status.${option}`)}
            checked={status === option}
            onClick={() => onChange(option)}
          />
        )
      })}
      {status && (
        <>
          <div className="my-1 h-px bg-on-surface-variant/10" />
          <ReadingStatusMenuItem
            danger
            Icon={MdRemoveCircleOutline}
            label={t('reading_status.remove')}
            checked={false}
            onClick={() => onChange(null)}
          />
        </>
      )}
    </div>
  )
}

interface ReadingStatusMenuItemProps {
  danger?: boolean
  checked: boolean
  Icon: React.ComponentType<{ size?: number; className?: string }>
  label: string
  onClick: () => void
}

const ReadingStatusMenuItem: React.FC<ReadingStatusMenuItemProps> = ({
  danger,
  checked,
  Icon,
  label,
  onClick,
}) => {
  return (
    <button
      type="button"
      className={clsx(
        'flex h-8 w-full items-center gap-2 px-3 text-left typescale-body-medium hover:bg-on-surface-variant/10',
        danger ? 'text-error' : 'text-on-surface-variant',
      )}
      onClick={onClick}
    >
      <Icon size={17} className="shrink-0" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {checked && <MdCheck size={17} className="shrink-0 text-primary" />}
    </button>
  )
}

interface BookDialogProps {
  book: BookRecord
  onClose: () => void
}

const EditBookDialog: React.FC<BookDialogProps> = ({ book, onClose }) => {
  const t = useTranslation('home')
  const titleRef = useRef<HTMLInputElement>(null)
  const [title, setTitle] = useState(getBookDisplayTitle(book))
  const [creator, setCreator] = useState(cleanBookText(book.metadata.creator))

  useEffect(() => {
    const input = titleRef.current
    input?.focus()
    input?.select()
  }, [])

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
    <ModalShell onClose={onClose}>
      <form
        className="w-[min(28rem,calc(100vw-2rem))] bg-surface p-5 text-on-surface-variant shadow-lg ring-1 ring-inset ring-on-surface-variant/20"
        onSubmit={(e) => {
          e.preventDefault()
          save()
        }}
      >
        <div className="space-y-4">
          <label className="block">
            <span className="mb-1 block typescale-label-large">
              {t('edit.title')}
            </span>
            <input
              ref={titleRef}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onClick={(e) => e.currentTarget.select()}
              onFocus={(e) => e.currentTarget.select()}
              className="bg-default w-full px-2 py-1.5 text-on-surface-variant outline-none ring-1 ring-inset ring-surface-variant focus:ring-primary"
            />
          </label>
          <label className="block">
            <span className="mb-1 block typescale-label-large">
              {t('edit.creator')}
            </span>
            <input
              value={creator}
              onChange={(e) => setCreator(e.target.value)}
              onClick={(e) => e.currentTarget.select()}
              onFocus={(e) => e.currentTarget.select()}
              className="bg-default w-full px-2 py-1.5 text-on-surface-variant outline-none ring-1 ring-inset ring-surface-variant focus:ring-primary"
            />
          </label>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button type="submit">{t('edit.save')}</Button>
        </div>
      </form>
    </ModalShell>
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
    <ModalShell onClose={onClose}>
      <div className="relative max-h-[calc(100vh-4rem)] w-[min(46rem,calc(100vw-2rem))] overflow-hidden bg-surface p-5 text-on-surface-variant shadow-lg ring-1 ring-inset ring-on-surface-variant/20">
        <button
          type="button"
          aria-label={t('cancel')}
          className="absolute right-3 top-3 text-outline hover:text-on-surface-variant"
          onClick={onClose}
        >
          ×
        </button>
        <div className="grid gap-5 sm:grid-cols-[12rem_minmax(0,1fr)]">
          <div className="mx-auto w-40 sm:w-full">
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
            <h2 className="text-center !text-[30px] font-bold leading-tight text-on-surface-variant sm:text-left">
              {title}
            </h2>
            {!!rows.length && (
              <dl className="mt-4 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-2 gap-y-1 typescale-body-large">
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
          <div className="scroll border-on-surface-variant/15 mt-5 max-h-[min(18rem,38vh)] overflow-y-auto border-t pt-4 text-justify typescale-body-large">
            {description.split(/\n{2,}/).map((paragraph, index) => (
              <p key={index} className={clsx(index > 0 && 'mt-3')}>
                {paragraph}
              </p>
            ))}
          </div>
        )}
      </div>
    </ModalShell>
  )
}

interface ModalShellProps {
  children: React.ReactNode
  onClose: () => void
}

const ModalShell: React.FC<ModalShellProps> = ({ children, onClose }) => {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return

      e.preventDefault()
      onClose()
    }

    document.addEventListener('keydown', onKeyDown, true)

    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [onClose])

  return createPortal(
    <>
      <Overlay
        className="z-[80] !bg-black/20"
        onClick={(e) => {
          e.stopPropagation()
          onClose()
        }}
      />
      <div
        role="dialog"
        aria-modal="true"
        data-flow-keyboard-capture="true"
        className="fixed inset-0 z-[90] flex items-center justify-center p-4"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) onClose()
        }}
        onClick={(e) => {
          e.stopPropagation()
        }}
      >
        <div
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          {children}
        </div>
      </div>
    </>,
    document.body,
  )
}
