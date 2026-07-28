import clsx from 'clsx'
import {
  ArrowDownIcon,
  ArrowUpIcon,
  BookImageIcon,
  BookOpenIcon,
  BookTextIcon,
  CalendarPlusIcon,
  FileInputIcon,
  HistoryIcon,
  ListChecksIcon,
  ListXIcon,
  type LucideIcon,
  SquareCheckBigIcon,
  SquareXIcon,
  TagIcon,
  Trash2Icon,
  UserRound,
} from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'

import { AppTooltip } from '../components/AppTooltip'
import { Button } from '../components/Button'
import { DropZone } from '../components/base/DropZone'
import { ReaderGridView } from '../components/Reader'
import { TextImportDialog } from '../components/TextImportDialog'
import { Button as UiButton } from '../components/ui/button'
import { useNotify } from '../components/ui/notification'
import { Popover, PopoverContent, PopoverTrigger } from '../components/ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select'
import { formatErrorMessage } from '../errorMessage'
import { handleFiles, openImportDialog, setupNativeOpenFiles } from '../file'
import { useAction, useLibraryAction } from '../hooks/useAction'
import { useBoolean } from '../hooks/useBoolean'
import { useEpubImportNotifications } from '../hooks/useEpubImportNotifications'
import { useCovers, useLibrary, useLibraryTags } from '../hooks/useLibrary'
import { useTranslation } from '../hooks/useTranslation'
import { isGlobalKeyboardShortcutBlocked } from '../keyboard'
import { reader, useReaderSnapshot } from '../models/reader'
import { subscribeReaderOpenErrors } from '../reader/errorEvents'
import {
  defaultLibraryDisplay,
  defaultLibrarySort,
  type LibrarySortField,
  libraryBookCardWidthMax,
  libraryBookCardWidthMin,
  libraryBookCardWidthStep,
  librarySortFieldOptions,
  normalizeLibraryBookCardWidth,
  useLibraryAuthorFilter,
  useLibraryStatusFilter,
  useLibraryTagFilter,
  useSettings,
  useSettingsReady,
  useViewMode,
} from '../state'
import { type BookRecord, type BookSourceStatus, db, type EpubImportProgress, type EpubImportResult } from '../storage'
import { clamp } from '../utils'

import { BookCard } from './BookCard'
import { EpubImportProgressPanel } from './EpubImportProgressPanel'
import { filterBooksByLibraryFilters } from './filters'
import { BatchTagsDialog } from './LibraryDialogs'
import {
  bookSourceDescriptionKey,
  bookSourceStatusFromError,
  bookSourceStatusRefreshEvent,
  isArchiveOnlyBook,
  sortBooks,
  toggleReadingStatusFilter,
  toggleSortDirection,
} from './model'
import { readingStatusOptions } from './ReadingStatusControls'
import {
  getBookIdRange,
  type LibraryBookSelectionEvent,
  type LibraryRangeSelectionSession,
  selectBookIdRange,
  useStringSet,
} from './selection'

const sortFieldIconMap = {
  title: BookTextIcon,
  creator: UserRound,
  updatedAt: HistoryIcon,
  createdAt: CalendarPlusIcon,
} satisfies Record<LibrarySortField, LucideIcon>

const toolbarButtonClass = 'h-8 leading-none'
const libraryBookCardSizePresets = [
  { key: 'small', value: 140 },
  { key: 'medium', value: 160 },
  { key: 'large', value: 200 },
] as const

function isKeyboardTargetBlocked(e: KeyboardEvent) {
  return isGlobalKeyboardShortcutBlocked(e)
}

export function LibraryPage() {
  const { focusedBookTab, groups } = useReaderSnapshot()
  const [viewMode, setViewMode] = useViewMode()
  const [readerAction, setReaderAction] = useAction()
  const [libraryAction, setLibraryAction] = useLibraryAction()
  const [settings, setSettings] = useSettings()
  const settingsReady = useSettingsReady()
  const viewModeRef = useRef(viewMode)
  const openedFromNativeRef = useRef(false)
  const nativeOpenReadyRef = useRef(false)
  const nativeOpenSetupPromiseRef = useRef<ReturnType<typeof setupNativeOpenFiles>>(undefined)
  const nativeOpenCleanupRef = useRef<() => void>(undefined)
  const startupRestoreStartedRef = useRef(false)
  const [startupRestoreDone, setStartupRestoreDone] = useState(false)
  const [nativeStartupPending, setNativeStartupPending] = useState(false)
  const [nativeStartupReaderFailed, setNativeStartupReaderFailed] = useState(false)
  const [textImportDialog, setTextImportDialog] = useState<{
    paths: string[]
    openAfterImport: boolean
  }>()
  const [epubImportProgress, setEpubImportProgress] = useState<EpubImportProgress>()
  const notify = useNotify()
  const notifyEpubImportResult = useEpubImportNotifications()
  const errorT = useTranslation('error')
  const homeT = useTranslation('home')
  const focusedBookId = focusedBookTab?.book.id

  const applySavedSidebarState = useCallback(() => {
    setReaderAction(settings.readerSidebarOpen === false ? undefined : 'toc')
    setLibraryAction(settings.librarySidebarOpen ? 'libraryFilter' : undefined)
  }, [setLibraryAction, setReaderAction, settings.librarySidebarOpen, settings.readerSidebarOpen])

  const openTextImportDialog = useCallback((paths: string[], openAfterImport: boolean) => {
    if (!paths.length) return
    setTextImportDialog({ paths, openAfterImport })
  }, [])

  const handleTextImported = useCallback(
    (books: BookRecord[], openAfterImport: boolean) => {
      if (!openAfterImport || !books.length) return

      books.forEach((book) => reader.addTab(book))
      setViewMode('reader')
    },
    [setViewMode],
  )

  const handleEpubImportProgress = useCallback((progress: EpubImportProgress) => {
    setEpubImportProgress(progress)
  }, [])

  const handleEpubImportResult = useCallback(
    async (result: EpubImportResult) => {
      setEpubImportProgress(undefined)
      let openedBookIds: Set<string> | undefined
      try {
        openedBookIds = await reader.promoteExternalBooks(result.books)
      } catch (error) {
        console.error(error)
      }
      notifyEpubImportResult(result)
      return openedBookIds
    },
    [notifyEpubImportResult],
  )

  useEffect(() => {
    return subscribeReaderOpenErrors(({ bookId, bookTitle, closeTab, error, stage }) => {
      setNativeStartupReaderFailed(true)
      if (closeTab) {
        reader.closeBookTabs(bookId)
        window.dispatchEvent(new Event(bookSourceStatusRefreshEvent))
      }
      const errorMessage = formatErrorMessage(error)
      const sourceErrorStatus = bookSourceStatusFromError(errorMessage)
      const sourceErrorDescription = sourceErrorStatus ? homeT(bookSourceDescriptionKey(sourceErrorStatus)) : undefined
      notify({
        autoCloseMs: false,
        description: `${bookTitle}: ${sourceErrorDescription ?? errorMessage}`,
        title: sourceErrorDescription
          ? homeT('source_unavailable')
          : errorT(stage === 'source' || stage === 'open' ? 'reader_open_failed' : 'reader_render_failed'),
        type: 'error',
      })
    })
  }, [errorT, homeT, notify])

  const tryRestoreStartupSession = useEffectEvent(() => {
    if (!settingsReady || !nativeOpenReadyRef.current || startupRestoreStartedRef.current) {
      return
    }

    startupRestoreStartedRef.current = true
    if (openedFromNativeRef.current) {
      applySavedSidebarState()
      setStartupRestoreDone(true)
      return
    }

    if (
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
        setReaderAction(settings.readerSidebarOpen === false ? undefined : 'toc')
        setLibraryAction(settings.librarySidebarOpen ? 'libraryFilter' : undefined)
        setViewMode('reader')
      })
      .finally(() => {
        setStartupRestoreDone(true)
      })
  })

  useEffect(() => {
    viewModeRef.current = viewMode
  }, [viewMode])

  const startNativeOpenSetup = useEffectEvent(() =>
    setupNativeOpenFiles({
      onImportProgress: handleEpubImportProgress,
      onImportResult: handleEpubImportResult,
      onOpenRequest: () => {
        openedFromNativeRef.current = true
        setNativeStartupPending(true)
      },
      onOpen: (books) => {
        books.forEach((book) => reader.openBookTab(book))
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
    }),
  )

  useEffect(() => {
    let disposed = false

    nativeOpenSetupPromiseRef.current ??= startNativeOpenSetup()

    nativeOpenSetupPromiseRef.current.then((result) => {
      if (disposed || !result) return

      nativeOpenCleanupRef.current = result.cleanup
      nativeOpenReadyRef.current = true
      tryRestoreStartupSession()
    })

    return () => {
      disposed = true
      nativeOpenCleanupRef.current?.()
      nativeOpenCleanupRef.current = undefined
    }
  }, [])

  useEffect(() => {
    tryRestoreStartupSession()
  })

  useEffect(() => {
    if (!nativeStartupPending || !startupRestoreDone) return
    if (groups.length && (!focusedBookTab?.rendered || viewMode !== 'reader') && !nativeStartupReaderFailed) {
      return
    }

    setNativeStartupPending(false)
  }, [
    focusedBookTab?.rendered,
    groups.length,
    nativeStartupPending,
    nativeStartupReaderFailed,
    startupRestoreDone,
    viewMode,
  ])

  useEffect(() => {
    if (!settingsReady || !startupRestoreDone) return

    const nextSession =
      viewMode === 'reader' && focusedBookId && focusedBookTab?.book.scope !== 'external'
        ? {
            viewMode,
            bookId: focusedBookId,
          }
        : viewMode === 'library' || (viewMode === 'reader' && focusedBookTab?.book.scope === 'external')
          ? {
              viewMode: 'library' as const,
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
  }, [focusedBookId, focusedBookTab?.book.scope, setSettings, settingsReady, startupRestoreDone, viewMode])

  useEffect(() => {
    if (!settingsReady || !startupRestoreDone) return

    const nextReaderSidebarOpen = readerAction !== undefined
    const nextLibrarySidebarOpen = libraryAction !== undefined

    setSettings((prev) => {
      if (prev.readerSidebarOpen === nextReaderSidebarOpen && prev.librarySidebarOpen === nextLibrarySidebarOpen) {
        return prev
      }

      return {
        ...prev,
        readerSidebarOpen: nextReaderSidebarOpen,
        librarySidebarOpen: nextLibrarySidebarOpen,
      }
    })
  }, [libraryAction, readerAction, setSettings, settingsReady, startupRestoreDone])

  useEffect(() => {
    if (!groups.length && viewMode !== 'library') {
      setViewMode('library')
    }
  }, [groups.length, setViewMode, viewMode])

  const library = (
    <Library
      onOpenBook={() => setViewMode('reader')}
      onEpubImportProgress={handleEpubImportProgress}
      onEpubImportResult={handleEpubImportResult}
      onTextPaths={(paths) => openTextImportDialog(paths, false)}
    />
  )
  const nativeStartupContentReady =
    !nativeStartupPending || !groups.length || focusedBookTab?.rendered || nativeStartupReaderFailed
  const contentReady = startupRestoreDone && nativeStartupContentReady

  return (
    <>
      {startupRestoreDone && groups.length ? (
        <ReaderGridView
          content={viewMode === 'library' ? library : undefined}
          onEpubImportProgress={handleEpubImportProgress}
          onEpubImportResult={handleEpubImportResult}
        />
      ) : startupRestoreDone ? (
        library
      ) : null}
      {!contentReady && <div className="bg-background fixed inset-0 z-50" data-testid="native-startup-surface" />}
      {textImportDialog && (
        <TextImportDialog
          paths={textImportDialog.paths}
          openAfterImport={textImportDialog.openAfterImport}
          onClose={() => setTextImportDialog(undefined)}
          onImported={handleTextImported}
        />
      )}
      {epubImportProgress && <EpubImportProgressPanel progress={epubImportProgress} />}
    </>
  )
}

interface LibraryProps {
  onEpubImportProgress: (progress: EpubImportProgress) => void
  onEpubImportResult: (result: EpubImportResult) => Set<string> | void | Promise<Set<string> | void>
  onOpenBook: () => void
  onTextPaths: (paths: string[]) => void
}

const Library: React.FC<LibraryProps> = ({ onEpubImportProgress, onEpubImportResult, onOpenBook, onTextPaths }) => {
  const books = useLibrary()
  const covers = useCovers()
  const tags = useLibraryTags()
  const t = useTranslation('home')
  const [settings, setSettings] = useSettings()
  const sortField = settings.librarySort?.field ?? defaultLibrarySort.field
  const sortDirection = settings.librarySort?.direction ?? defaultLibrarySort.direction
  const bookCardWidth = normalizeLibraryBookCardWidth(
    settings.libraryDisplay?.bookCardWidth ?? defaultLibraryDisplay.bookCardWidth,
  )
  const [statusFilters, setStatusFilters] = useLibraryStatusFilter()
  const [authorFilters] = useLibraryAuthorFilter()
  const [tagFilters] = useLibraryTagFilter()
  const [, setLibraryAction] = useLibraryAction()

  const [select, , setSelect] = useBoolean(false)
  const [selectedBookIds, { add, has, toggle, replace, reset }] = useStringSet()
  const [highlightedBookIds, setHighlightedBookIds] = useState<Set<string>>(() => new Set())
  const [sourceStatuses, setSourceStatuses] = useState(() => new Map<string, BookSourceStatus>())
  const [batchTagsOpen, setBatchTagsOpen] = useState(false)
  const selectionAnchorIdRef = useRef<string | undefined>(undefined)
  const rangeSelectionSessionRef = useRef<LibraryRangeSelectionSession | undefined>(undefined)
  const referencedArchiveIds = useMemo(
    () =>
      (books ?? []).reduce<string[]>((ids, book) => {
        if (book.sourceStorage === 'referenced' && isArchiveOnlyBook(book)) {
          ids.push(book.id)
        }
        return ids
      }, []),
    [books],
  )
  useEffect(() => {
    if (!referencedArchiveIds.length) {
      setSourceStatuses((current) => (current.size ? new Map<string, BookSourceStatus>() : current))
      return
    }

    let active = true
    const refresh = () => {
      void db.books
        .checkSourceStatuses(referencedArchiveIds)
        .then((records) => {
          if (!active) return
          setSourceStatuses(new Map(records.map((record) => [record.id, record.status])))
        })
        .catch(console.error)
    }

    refresh()
    window.addEventListener('focus', refresh)
    window.addEventListener(bookSourceStatusRefreshEvent, refresh)
    return () => {
      active = false
      window.removeEventListener('focus', refresh)
      window.removeEventListener(bookSourceStatusRefreshEvent, refresh)
    }
  }, [referencedArchiveIds])

  const clearBookSelection = useCallback(() => {
    reset()
    selectionAnchorIdRef.current = undefined
    rangeSelectionSessionRef.current = undefined
  }, [reset])

  const exitSelectMode = useCallback(() => {
    setSelect(false)
    clearBookSelection()
  }, [clearBookSelection, setSelect])

  const toggleSelectMode = useCallback(() => {
    if (select) {
      exitSelectMode()
      return
    }

    setSelect(true)
  }, [exitSelectMode, select, setSelect])

  const setBookCardWidth = useCallback(
    (bookCardWidth: number) => {
      const normalized = normalizeLibraryBookCardWidth(bookCardWidth)

      setSettings((settings) => ({
        ...settings,
        libraryDisplay: {
          ...(settings.libraryDisplay ?? defaultLibraryDisplay),
          bookCardWidth: normalized,
        },
      }))
    },
    [setSettings],
  )

  const setSortField = useCallback(
    (field: LibrarySortField) => {
      setSettings((settings) => ({
        ...settings,
        librarySort: {
          field,
          direction: settings.librarySort?.direction ?? defaultLibrarySort.direction,
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

  const handleEpubImportResult = useCallback(
    async (result: EpubImportResult) => {
      const importedIds: string[] = []
      for (const book of result.books) {
        if (book.scope !== 'external') importedIds.push(book.id)
      }

      if (importedIds.length) {
        setHighlightedBookIds((current) => {
          const next = new Set(current)
          importedIds.forEach((id) => next.add(id))
          return next
        })
        window.setTimeout(() => {
          setHighlightedBookIds((current) => {
            const next = new Set(current)
            importedIds.forEach((id) => next.delete(id))
            return next
          })
        }, 5000)
      }

      return onEpubImportResult(result)
    },
    [onEpubImportResult],
  )

  const handleCancelSelectionKeyDown = useEffectEvent((e: KeyboardEvent) => {
    if (e.key !== 'Escape') return
    if (isGlobalKeyboardShortcutBlocked(e)) return

    e.preventDefault()
    if (selectedBookIds.size) {
      clearBookSelection()
    } else {
      exitSelectMode()
    }
  })

  useEffect(() => {
    if (!select) return

    const cancelSelectionOnEscape = (e: KeyboardEvent) => {
      handleCancelSelectionKeyDown(e)
    }

    document.addEventListener('keydown', cancelSelectionOnEscape)

    return () => {
      document.removeEventListener('keydown', cancelSelectionOnEscape)
    }
  }, [select])

  useEffect(() => {
    if (!select) return

    const endRangeSelectionSession = (e: KeyboardEvent) => {
      if (e.key === 'Shift') rangeSelectionSessionRef.current = undefined
    }
    const clearRangeSelectionSession = () => {
      rangeSelectionSessionRef.current = undefined
    }

    document.addEventListener('keyup', endRangeSelectionSession)
    window.addEventListener('blur', clearRangeSelectionSession)

    return () => {
      document.removeEventListener('keyup', endRangeSelectionSession)
      window.removeEventListener('blur', clearRangeSelectionSession)
    }
  }, [select])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || isKeyboardTargetBlocked(e)) {
        return
      }

      const key = e.key.toLowerCase()
      if (key === 's') {
        e.preventDefault()
        e.stopPropagation()
        setLibraryAction((action) => (action === 'libraryFilter' ? undefined : 'libraryFilter'))
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
        setStatusFilters((filters) => toggleReadingStatusFilter(filters, status))
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
  const visibleBookIds = useMemo(() => sortedBooks.map((book) => book.id), [sortedBooks])

  const selectBook = useCallback(
    (bookId: string, e: LibraryBookSelectionEvent) => {
      if (!e.shiftKey) {
        rangeSelectionSessionRef.current = undefined
        selectionAnchorIdRef.current = bookId
        toggle(bookId)
        return
      }

      const session = rangeSelectionSessionRef.current ?? {
        anchorId: selectionAnchorIdRef.current ?? bookId,
        baseSelectedIds: new Set(selectedBookIds),
      }
      rangeSelectionSessionRef.current = session
      selectionAnchorIdRef.current = session.anchorId

      replace(selectBookIdRange(session.baseSelectedIds, getBookIdRange(visibleBookIds, session.anchorId, bookId)))
    },
    [replace, selectedBookIds, toggle, visibleBookIds],
  )

  if (!books) return null

  const visibleSelectedCount = sortedBooks.filter((book) => selectedBookIds.has(book.id)).length
  const allSelected = !!sortedBooks.length && visibleSelectedCount === sortedBooks.length
  const selectedBooks = sortedBooks.filter((book) => selectedBookIds.has(book.id))
  const DirectionIcon = sortDirection === 'asc' ? ArrowUpIcon : ArrowDownIcon
  const LibraryCountIcon = select ? SquareCheckBigIcon : BookOpenIcon
  const libraryCountText = select
    ? `${visibleSelectedCount} / ${sortedBooks.length}`
    : sortedBooks.length === books.length
      ? String(books.length)
      : `${sortedBooks.length} / ${books.length}`
  const libraryCountTooltip = select
    ? t('book_count.selected')
    : sortedBooks.length === books.length
      ? t('book_count.total')
      : t('book_count.filtered')
  const bookCardGap = clamp(Math.round(bookCardWidth * 0.08), 10, 20)
  const bookGridPadding = clamp(Math.round(bookCardWidth * 0.04), 4, 10)
  const bookGridStyle = {
    gridTemplateColumns: `repeat(auto-fill, minmax(${bookCardWidth}px, 1fr))`,
    columnGap: `${bookCardGap}px`,
    rowGap: `${bookCardGap}px`,
    padding: `${bookGridPadding}px`,
    '--library-book-card-width': `${bookCardWidth}px`,
  } as React.CSSProperties

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
          handleFiles(e.dataTransfer.files, {
            onImportProgress: onEpubImportProgress,
            onImportResult: handleEpubImportResult,
            onTextPaths,
          })
        }
      }}
    >
      <div className="mb-4 space-y-2.5">
        <div className="relative flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            {!!books.length && !select && (
              <div className="flex items-center">
                <Select value={sortField} onValueChange={(value) => setSortField(value as LibrarySortField)}>
                  <SelectTrigger
                    aria-label={t(`sort.${sortField}`)}
                    className={clsx(
                      toolbarButtonClass,
                      'bg-secondary text-secondary-foreground min-w-[6.25rem] rounded-r-none border-transparent px-2.5 text-base font-medium hover:bg-(--flow-bg-control-hover) [&_[data-slot=select-value]]:leading-none [&_[data-slot=select-value]]:font-medium',
                    )}
                    size="default"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent align="start" className="min-w-[7rem] p-1 text-base" position="popper">
                    {librarySortFieldOptions.map((field) => {
                      const SortIcon = sortFieldIconMap[field]

                      return (
                        <SelectItem
                          key={field}
                          value={field}
                          className="h-8 py-0 pr-7 pl-2 text-base leading-none font-medium"
                        >
                          <SortIcon aria-hidden className="text-muted-foreground size-4" />
                          <span className="leading-none">{t(`sort.${field}`)}</span>
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
            {!!books.length && !select && (
              <Popover>
                <AppTooltip label={t('book_size.title')}>
                  <PopoverTrigger asChild>
                    <Button
                      type="button"
                      variant="secondary"
                      compact
                      className={clsx(toolbarButtonClass, 'w-8 px-0')}
                      aria-label={t('book_size.title')}
                    >
                      <BookImageIcon aria-hidden className="mx-auto size-4" />
                    </Button>
                  </PopoverTrigger>
                </AppTooltip>
                <PopoverContent
                  align="start"
                  className="w-64 gap-3 p-3 text-base"
                  onClick={(e) => e.stopPropagation()}
                  onPointerDown={(e) => e.stopPropagation()}
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-medium">{t('book_size.title')}</span>
                    <span className="text-muted-foreground tabular-nums">{bookCardWidth}px</span>
                  </div>
                  <div className="grid grid-cols-3 gap-1">
                    {libraryBookCardSizePresets.map((preset) => {
                      const active = bookCardWidth === preset.value

                      return (
                        <UiButton
                          key={preset.key}
                          type="button"
                          variant={active ? 'default' : 'secondary'}
                          size="sm"
                          className="h-8"
                          onClick={() => setBookCardWidth(preset.value)}
                        >
                          {t(`book_size.${preset.key}`)}
                        </UiButton>
                      )
                    })}
                  </div>
                  <input
                    type="range"
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    min={libraryBookCardWidthMin}
                    max={libraryBookCardWidthMax}
                    step={libraryBookCardWidthStep}
                    value={bookCardWidth}
                    aria-label={t('book_size.title')}
                    className="h-2 w-full cursor-pointer accent-(--flow-accent)"
                    onChange={(e) => setBookCardWidth(Number(e.target.value))}
                  />
                  <div className="flex items-center justify-between gap-3 text-base">
                    <span className="text-muted-foreground">{libraryBookCardWidthMin}px</span>
                    <UiButton
                      type="button"
                      variant="secondary"
                      size="sm"
                      className="h-7 px-2"
                      onClick={() => setBookCardWidth(defaultLibraryDisplay.bookCardWidth)}
                    >
                      {t('book_size.default')}
                    </UiButton>
                    <span className="text-muted-foreground">{libraryBookCardWidthMax}px</span>
                  </div>
                </PopoverContent>
              </Popover>
            )}
            {!!books.length && (
              <Button
                variant="secondary"
                className={clsx(toolbarButtonClass, 'gap-1.5 px-3')}
                onClick={toggleSelectMode}
              >
                {select ? (
                  <SquareXIcon aria-hidden className="size-4" />
                ) : (
                  <SquareCheckBigIcon aria-hidden className="size-4" />
                )}
                <span className="leading-none">{t(select ? 'cancel' : 'select')}</span>
              </Button>
            )}
            {select &&
              (allSelected ? (
                <Button variant="secondary" className={clsx(toolbarButtonClass, 'gap-1.5 px-3')} onClick={reset}>
                  <ListXIcon aria-hidden className="size-4" />
                  <span className="leading-none">{t('deselect_all')}</span>
                </Button>
              ) : (
                <Button
                  variant="secondary"
                  className={clsx(toolbarButtonClass, 'gap-1.5 px-3')}
                  onClick={() => sortedBooks.forEach((b) => add(b.id))}
                >
                  <ListChecksIcon aria-hidden className="size-4" />
                  <span className="leading-none">{t('select_all')}</span>
                </Button>
              ))}
          </div>

          <AppTooltip label={libraryCountTooltip}>
            <div
              className={clsx(
                'absolute top-1/2 left-1/2 flex h-8 max-w-[35%] -translate-x-1/2 -translate-y-1/2 items-center justify-center gap-1.5 overflow-hidden text-base leading-none tabular-nums',
                select ? 'text-foreground font-medium' : 'text-muted-foreground',
              )}
            >
              <LibraryCountIcon aria-hidden className="size-4 shrink-0" />
              <span className="min-w-0 truncate">{libraryCountText}</span>
            </div>
          </AppTooltip>

          <div className="space-x-2">
            {select ? (
              <>
                <Button
                  variant="secondary"
                  className={clsx(toolbarButtonClass, 'gap-1.5 px-3')}
                  disabled={!selectedBooks.length}
                  onClick={() => setBatchTagsOpen(true)}
                >
                  <TagIcon aria-hidden className="size-4" />
                  <span className="leading-none">{t('tags')}</span>
                </Button>
                <Button
                  variant="destructive"
                  className={clsx(toolbarButtonClass, 'gap-1.5 px-3')}
                  onClick={() => {
                    exitSelectMode()
                    const bookIds = selectedBooks.map((book) => book.id)

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
                  void openImportDialog({
                    onImportProgress: onEpubImportProgress,
                    onImportResult: handleEpubImportResult,
                    onTextPaths,
                  })
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
        <ul className="grid" style={bookGridStyle}>
          {sortedBooks.map((book) => (
            <BookCard
              key={book.id}
              book={book}
              sourceStatus={sourceStatuses.get(book.id)}
              covers={covers}
              select={select}
              selected={has(book.id)}
              highlighted={highlightedBookIds.has(book.id)}
              showModifiedExportIndicator={settings.showModifiedBookExportIndicator === true}
              onSelectBook={selectBook}
              onOpenBook={onOpenBook}
            />
          ))}
        </ul>
      </div>
      {batchTagsOpen && (
        <BatchTagsDialog books={selectedBooks} tags={tags ?? []} onClose={() => setBatchTagsOpen(false)} />
      )}
    </DropZone>
  )
}
