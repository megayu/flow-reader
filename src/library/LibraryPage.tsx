import clsx from 'clsx'
import {
  ArrowDownIcon,
  ArrowUpIcon,
  BookImageIcon,
  BookOpenIcon,
  BookTextIcon,
  CalendarPlusIcon,
  ChevronDownIcon,
  FileInputIcon,
  FolderInputIcon,
  HistoryIcon,
  ListChecksIcon,
  ListXIcon,
  type LucideIcon,
  SearchIcon,
  SquareCheckBigIcon,
  SquareXIcon,
  TagIcon,
  Trash2Icon,
  UserRound,
  XIcon,
} from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState } from 'react'

import { getBookDisplayTitle } from '../book'
import { AppTooltip } from '../components/AppTooltip'
import { DropZone } from '../components/base/DropZone'
import { OverlayScroll } from '../components/base/PaneView'
import { IconButton } from '../components/IconButton'
import { ReaderGridView } from '../components/Reader'
import { ReadingStatusIcon } from '../components/ReadingStatusIcon'
import { TextImportDialog } from '../components/TextImportDialog'
import { TooltipButton } from '../components/TooltipButton'
import { Button as UiButton } from '../components/ui/button'
import { InputGroup, InputGroupActions, InputGroupInput } from '../components/ui/input-group'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../components/ui/menu'
import { useNotify } from '../components/ui/notificationContext'
import { Popover, PopoverContent, PopoverTrigger } from '../components/ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select'
import { formatErrorMessage } from '../errorMessage'
import {
  applyFolderImportTagsToResult,
  type FolderImportSelection,
  handleFilePaths,
  handleFiles,
  importTextSelections,
  openImportDialog,
  selectImportFolder,
  setupNativeOpenFiles,
} from '../file'
import { useLibraryAction } from '../hooks/useAction'
import { useBookImportNotifications } from '../hooks/useBookImportNotifications'
import { useCovers, useLibrary, useLibraryTags, useRecentBookIds } from '../hooks/useLibrary'
import { useOverlayScrollbarMetrics } from '../hooks/useOverlayScrollbarMetrics'
import { useTranslation } from '../hooks/useTranslation'
import { isGlobalKeyboardShortcutBlocked } from '../keyboard'
import { completeTabOpen, reader, useReaderSnapshot } from '../models/reader'
import { subscribeReaderOpenErrors } from '../reader/errorEvents'
import { createTextSearchIndex, matchesTextSearch } from '../search/textSearch'
import { getShortcutChords } from '../shortcuts'
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
import {
  type BookImportProgress,
  type BookImportResult,
  type BookRecord,
  type BookSourceStatus,
  db,
  type TextImportSelection,
} from '../storage'
import type { ReadingStatus } from '../storage/types'
import { clamp } from '../utils'

import { BookCard } from './BookCard'
import { BookImportProgressPanel } from './BookImportProgressPanel'
import {
  type CoverResourceIdentity,
  configureCoverResourceCache,
  disposeCoverResourceCache,
  getCoverResourceCacheBudget,
  leaseCoverResources,
  libraryReturnGraceMs,
  resumeCoverResourceCache,
  suspendCoverResourceCache,
} from './coverResourceCache'
import { FolderImportDialog } from './FolderImportDialog'
import { filterBooksByLibraryFilters } from './filters'
import { BatchTagsDialog, DeleteSelectedBooksDialog } from './LibraryDialogs'
import { libraryGridVirtualizationThreshold } from './libraryGridWindow'
import {
  bookSourceDescriptionKey,
  bookSourceStatusFromError,
  bookSourceStatusRefreshEvent,
  isArchiveOnlyBook,
  readingStatusOptions,
  sortBooks,
  toggleReadingStatusFilter,
  toggleSortDirection,
} from './model'
import { ReadingStatusMenuContent } from './ReadingStatusControls'
import {
  getBookIdRange,
  type LibraryBookSelectionEvent,
  type LibraryRangeSelectionSession,
  selectBookIdRange,
  useStringSet,
} from './selection'
import { useLibraryGridWindow } from './useLibraryGridWindow'

const sortFieldIconMap = {
  title: BookTextIcon,
  creator: UserRound,
  updatedAt: HistoryIcon,
  createdAt: CalendarPlusIcon,
} satisfies Record<LibrarySortField, LucideIcon>
const sortFieldMessageKey = {
  title: 'sort.title',
  creator: 'sort.creator',
  updatedAt: 'sort.last_read',
  createdAt: 'sort.date_added',
} satisfies Record<LibrarySortField, string>

const toolbarButtonClass = 'h-8 leading-none'
// Match the selected tab's straight side: 10px list padding plus its 2px outer margin.
const libraryContentInlineInset = 12
const libraryBookCardOuterInset = 4
const librarySelectionRingOutset = 2
const libraryToolbarStyle = {
  paddingInline: `${libraryContentInlineInset}px`,
} as React.CSSProperties
const libraryScrollContentStyle = {
  paddingBlock: `${librarySelectionRingOutset}px`,
  paddingInline: `${libraryContentInlineInset}px`,
} as React.CSSProperties
const libraryBookCardSizePresets = [
  { key: 'small', value: 140 },
  { key: 'medium', value: 160 },
  { key: 'large', value: 200 },
] as const
const noCoverResourceIdentities: readonly CoverResourceIdentity[] = []
const dragImportAutoOpenBookTabLimit = 8

function selectDroppedBooksToAutoOpen(books: BookRecord[]) {
  const openBookIds = new Set(reader.groups.flatMap((group) => group.tabs.map((tab) => tab.book.id)))
  if (openBookIds.size >= dragImportAutoOpenBookTabLimit) return []

  const selectedBooks: BookRecord[] = []
  for (const book of books) {
    if (openBookIds.has(book.id)) continue

    openBookIds.add(book.id)
    selectedBooks.push(book)
    if (openBookIds.size >= dragImportAutoOpenBookTabLimit) break
  }
  return selectedBooks
}

function isKeyboardTargetBlocked(e: KeyboardEvent) {
  return isGlobalKeyboardShortcutBlocked(e)
}

export function LibraryPage() {
  const { focusedBookTab, groups } = useReaderSnapshot()
  const [viewMode, setViewMode] = useViewMode()
  const [settings, setSettings] = useSettings()
  const settingsReady = useSettingsReady()
  const libraryReturnStateRef = useRef<LibraryReturnState | undefined>(undefined)
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
    waitForEpubImport?: Promise<void>
    folderImportSelection?: FolderImportSelection
  }>()
  const [bookImportProgress, setBookImportProgress] = useState<BookImportProgress>()
  const notify = useNotify()
  const notifyBookImportResult = useBookImportNotifications()
  const errorT = useTranslation('error')
  const homeT = useTranslation('home')
  const focusedBookId = focusedBookTab?.book.id
  const directTextImport = settings.directTextImport === true
  const defaultCopyTextSourceFiles =
    settings.importSourceStorage === 'referenced' ? settings.copyTextImports === true : undefined
  const openBookIds = new Set(groups.flatMap((group) => group.tabs.map((tab) => tab.book.id)))

  useLayoutEffect(() => {
    if (viewMode === 'library') {
      resumeCoverResourceCache()
    } else {
      suspendCoverResourceCache()
    }
  }, [viewMode])
  useEffect(() => disposeCoverResourceCache, [])

  const openTextImportDialog = useCallback(
    (
      paths: string[],
      openAfterImport: boolean,
      waitForEpubImport?: Promise<void>,
      folderImportSelection?: FolderImportSelection,
    ) => {
      if (!paths.length) return
      setTextImportDialog({ paths, openAfterImport, waitForEpubImport, folderImportSelection })
    },
    [],
  )

  const openImportedTextBooks = useCallback(
    (books: BookRecord[], openAfterImport: boolean) => {
      if (!openAfterImport || !books.length) return

      selectDroppedBooksToAutoOpen(books).forEach((book) => {
        completeTabOpen(reader.openBookTab(book), () => setViewMode('reader'))
      })
    },
    [setViewMode],
  )

  const handleBookImportProgress = useCallback((progress: BookImportProgress) => {
    setBookImportProgress(progress)
  }, [])

  const handleEpubImportResult = useCallback(
    async (result: BookImportResult) => {
      setBookImportProgress(undefined)
      let openedBookIds: Set<string> | undefined
      try {
        openedBookIds = await reader.promoteExternalBooks(result.books)
      } catch (error) {
        console.error(error)
      }
      if (viewModeRef.current === 'reader') {
        const refreshedBookIds = reader.refreshImportedBooks(result.books)
        openedBookIds ??= new Set()
        refreshedBookIds.forEach((id) => openedBookIds?.add(id))
      }
      notifyBookImportResult(result)
      return openedBookIds
    },
    [notifyBookImportResult],
  )

  const handleTextImport = useCallback(
    (
      imports: TextImportSelection[],
      openAfterImport: boolean,
      waitForEpubImport?: Promise<void>,
      folderImportSelection?: FolderImportSelection,
      copySourceFiles?: boolean,
    ) => {
      void Promise.resolve(waitForEpubImport)
        .then(() =>
          importTextSelections(imports, {
            copySourceFiles,
            onImportProgress: handleBookImportProgress,
          }),
        )
        .then((result) => applyFolderImportTagsToResult(result, folderImportSelection))
        .then((result: BookImportResult) => {
          setBookImportProgress(undefined)
          const openBookIds = openAfterImport ? reader.refreshImportedBooks(result.books) : new Set<string>()
          notifyBookImportResult(result)
          openImportedTextBooks(
            result.books.filter((book) => !openBookIds.has(book.id)),
            openAfterImport,
          )
        })
        .catch((error) => {
          setBookImportProgress(undefined)
          const message = formatErrorMessage(error)
          notify({
            autoCloseMs: false,
            description: message,
            title: errorT('txt_import_failed'),
            type: 'error',
          })
        })
    },
    [errorT, handleBookImportProgress, notify, notifyBookImportResult, openImportedTextBooks],
  )

  const handleNativeEpubImportResult = useEffectEvent((result: BookImportResult) => handleEpubImportResult(result))
  const getNativeDirectTextImport = useEffectEvent(() => directTextImport)

  useEffect(() => {
    return subscribeReaderOpenErrors(({ bookId, bookTitle, closeTab, error, stage }) => {
      setNativeStartupReaderFailed(true)
      if (closeTab) {
        void reader.closeBookTab(bookId).catch(console.error)
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
      setStartupRestoreDone(true)
      return
    }

    if (
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

        completeTabOpen(reader.openBookTab(book), () => setViewMode('reader'))
      })
      .catch(console.error)
      .finally(() => {
        setStartupRestoreDone(true)
      })
  })

  useEffect(() => {
    viewModeRef.current = viewMode
  }, [viewMode])

  const startNativeOpenSetup = useEffectEvent(() =>
    setupNativeOpenFiles({
      onImportProgress: handleBookImportProgress,
      onImportResult: (result) => handleNativeEpubImportResult(result),
      getDirectTextImport: () => getNativeDirectTextImport(),
      onOpenRequest: () => {
        openedFromNativeRef.current = true
        setNativeStartupPending(true)
      },
      onOpen: (books) => {
        books.forEach((book) => {
          completeTabOpen(reader.openBookTab(book), () => setViewMode('reader'))
        })
      },
      onDrop: (books) => {
        if (viewModeRef.current === 'library') return

        selectDroppedBooksToAutoOpen(books).forEach((book) => {
          completeTabOpen(reader.openBookTab(book), () => setViewMode('reader'))
        })
      },
      onDropTextPaths: (paths, waitForEpubImport) => {
        openTextImportDialog(paths, viewModeRef.current !== 'library', waitForEpubImport)
      },
    }),
  )

  useEffect(() => {
    if (!settingsReady) return

    let disposed = false

    nativeOpenSetupPromiseRef.current ??= startNativeOpenSetup()

    void nativeOpenSetupPromiseRef.current
      .then((result) => {
        if (disposed) return
        nativeOpenCleanupRef.current = result?.cleanup
      })
      .finally(() => {
        if (disposed) return
        nativeOpenReadyRef.current = true
        tryRestoreStartupSession()
      })
      .catch((error) => {
        console.error('Failed to finish native file setup', error)
      })

    return () => {
      disposed = true
      nativeOpenCleanupRef.current?.()
      nativeOpenCleanupRef.current = undefined
    }
  }, [settingsReady])

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
    if (!groups.length && viewMode !== 'library') {
      setViewMode('library')
    }
  }, [groups.length, setViewMode, viewMode])

  const library = (
    <Library
      openBookIds={openBookIds}
      onOpenBook={() => setViewMode('reader')}
      onEpubImportProgress={handleBookImportProgress}
      onEpubImportResult={handleEpubImportResult}
      directTextImport={directTextImport}
      onTextPaths={(paths, waitForEpubImport, folderImportSelection) =>
        openTextImportDialog(paths, false, waitForEpubImport, folderImportSelection)
      }
      returnStateRef={libraryReturnStateRef}
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
          onEpubImportProgress={handleBookImportProgress}
          onEpubImportResult={handleEpubImportResult}
          directTextImport={directTextImport}
        />
      ) : startupRestoreDone ? (
        library
      ) : null}
      {!contentReady && <div className="bg-background fixed inset-0 z-50" data-testid="native-startup-surface" />}
      {textImportDialog && (
        <TextImportDialog
          defaultCopySourceFiles={defaultCopyTextSourceFiles}
          paths={textImportDialog.paths}
          openAfterImport={textImportDialog.openAfterImport}
          onClose={() => setTextImportDialog(undefined)}
          onImport={(imports, openAfterImport, copySourceFiles) =>
            handleTextImport(
              imports,
              openAfterImport,
              textImportDialog.waitForEpubImport,
              textImportDialog.folderImportSelection,
              copySourceFiles,
            )
          }
        />
      )}
      {bookImportProgress && <BookImportProgressPanel progress={bookImportProgress} />}
    </>
  )
}

interface LibraryProps {
  directTextImport: boolean
  openBookIds: ReadonlySet<string>
  onEpubImportProgress: (progress: BookImportProgress) => void
  onEpubImportResult: (result: BookImportResult) => Set<string> | void | Promise<Set<string> | void>
  onOpenBook: () => void
  onTextPaths: (
    paths: string[],
    waitForEpubImport?: Promise<void>,
    folderImportSelection?: FolderImportSelection,
  ) => void
  returnStateRef: { current: LibraryReturnState | undefined }
}

interface LibraryReturnState {
  debouncedTitleSearchQuery: string
  resultCriteriaSignature: string
  scrollExpiresAt: number
  scrollTop: number
  titleSearchQuery: string
}

const Library: React.FC<LibraryProps> = ({
  directTextImport,
  openBookIds,
  onEpubImportProgress,
  onEpubImportResult,
  onOpenBook,
  onTextPaths,
  returnStateRef,
}) => {
  const books = useLibrary()
  const covers = useCovers()
  const tags = useLibraryTags()
  const t = useTranslation('home')
  const errorT = useTranslation('error')
  const notify = useNotify()
  const [settings, setSettings] = useSettings()
  const recentBookIds = useRecentBookIds(settings.showRecentBooks === true)
  const sortField = settings.librarySort?.field ?? defaultLibrarySort.field
  const sortDirection = settings.librarySort?.direction ?? defaultLibrarySort.direction
  const bookCardWidth = normalizeLibraryBookCardWidth(
    settings.libraryDisplay?.bookCardWidth ?? defaultLibraryDisplay.bookCardWidth,
  )
  const bookCardGap = clamp(Math.round(bookCardWidth * 0.08), 10, 20)
  const [statusFilters, setStatusFilters] = useLibraryStatusFilter()
  const [authorFilters] = useLibraryAuthorFilter()
  const [tagFilters] = useLibraryTagFilter()
  const [, setLibraryAction] = useLibraryAction()

  const [returnState] = useState(() => returnStateRef.current)
  const [select, setSelect] = useState(false)
  const [titleSearchQuery, setTitleSearchQuery] = useState(returnState?.titleSearchQuery ?? '')
  const [debouncedTitleSearchQuery, setDebouncedTitleSearchQuery] = useState(
    returnState?.debouncedTitleSearchQuery ?? '',
  )
  const [selectedBookIds, { has, toggle, replace, reset }] = useStringSet()
  const [highlightedBookIds, setHighlightedBookIds] = useState<Set<string>>(() => new Set())
  const [sourceStatuses, setSourceStatuses] = useState(() => new Map<string, BookSourceStatus>())
  const [batchTagsOpen, setBatchTagsOpen] = useState(false)
  const [deleteBooksOpen, setDeleteBooksOpen] = useState(false)
  const [folderImportPath, setFolderImportPath] = useState<string>()
  const bookGridRef = useRef<HTMLUListElement>(null)
  const libraryScrollRef = useRef<HTMLDivElement>(null)
  const libraryScrollContentRef = useRef<HTMLDivElement>(null)
  const titleSearchInputRef = useRef<HTMLInputElement>(null)
  const selectionAnchorIdRef = useRef<string | undefined>(undefined)
  const rangeSelectionSessionRef = useRef<LibraryRangeSelectionSession | undefined>(undefined)
  const titleSearchIndexByBookId = useMemo(
    () => new Map((books ?? []).map((book) => [book.id, createTextSearchIndex([getBookDisplayTitle(book)])])),
    [books],
  )
  const stableFilteredBooks = useMemo(
    () =>
      filterBooksByLibraryFilters(
        sortBooks(books ?? [], sortField, sortDirection),
        statusFilters,
        authorFilters,
        tagFilters,
      ),
    [authorFilters, books, sortDirection, sortField, statusFilters, tagFilters],
  )
  const sortedBooks = useMemo(() => {
    if (!debouncedTitleSearchQuery.trim()) return stableFilteredBooks

    return stableFilteredBooks.filter((book) =>
      matchesTextSearch(titleSearchIndexByBookId.get(book.id) ?? [], debouncedTitleSearchQuery),
    )
  }, [debouncedTitleSearchQuery, stableFilteredBooks, titleSearchIndexByBookId])
  const visibleBookIds = useMemo(() => sortedBooks.map((book) => book.id), [sortedBooks])
  const recentBooks = useMemo(() => {
    if (!settings.showRecentBooks || !recentBookIds?.length) return []

    const booksById = new Map((books ?? []).map((book) => [book.id, book]))
    return recentBookIds.flatMap((bookId) => {
      const book = booksById.get(bookId)
      return book ? [book] : []
    })
  }, [books, recentBookIds, settings.showRecentBooks])
  const coversById = useMemo(() => new Map(covers?.map((cover) => [cover.id, cover.cover])), [covers])
  const selectedBooks = useMemo(
    () => (selectedBookIds.size ? sortedBooks.filter((book) => selectedBookIds.has(book.id)) : []),
    [selectedBookIds, sortedBooks],
  )
  const openSelectedBookCount = useMemo(
    () => selectedBooks.filter((book) => openBookIds.has(book.id)).length,
    [openBookIds, selectedBooks],
  )
  const resultCriteriaSignature = useMemo(
    () =>
      JSON.stringify([
        debouncedTitleSearchQuery,
        [...statusFilters].sort(),
        [...authorFilters].sort(),
        [...tagFilters].sort(),
        sortField,
        sortDirection,
      ]),
    [authorFilters, debouncedTitleSearchQuery, sortDirection, sortField, statusFilters, tagFilters],
  )
  const [initialScrollTop] = useState(() =>
    returnState &&
    returnState.scrollExpiresAt > Date.now() &&
    returnState.resultCriteriaSignature === resultCriteriaSignature
      ? returnState.scrollTop
      : 0,
  )
  const latestReturnStateRef = useRef({
    debouncedTitleSearchQuery,
    resultCriteriaSignature,
    titleSearchQuery,
  })
  useLayoutEffect(() => {
    const latest = {
      debouncedTitleSearchQuery,
      resultCriteriaSignature,
      titleSearchQuery,
    }
    latestReturnStateRef.current = latest
    returnStateRef.current = {
      ...latest,
      scrollExpiresAt: returnStateRef.current?.scrollExpiresAt ?? 0,
      scrollTop: returnStateRef.current?.scrollTop ?? 0,
    }
  }, [debouncedTitleSearchQuery, resultCriteriaSignature, returnStateRef, titleSearchQuery])
  useLayoutEffect(
    () => () => {
      const scroll = libraryScrollRef.current
      if (!scroll) return

      returnStateRef.current = {
        ...latestReturnStateRef.current,
        scrollExpiresAt: Date.now() + libraryReturnGraceMs,
        scrollTop: scroll.scrollTop,
      }
    },
    [returnStateRef],
  )
  const virtualizeLibraryGrid = (books?.length ?? 0) >= libraryGridVirtualizationThreshold
  const libraryGridLayoutKey = `${select}:${settings.showRecentBooks === true}:${recentBooks.length}`
  const libraryGridWindow = useLibraryGridWindow({
    cardWidth: bookCardWidth,
    enabled: virtualizeLibraryGrid,
    endInset: librarySelectionRingOutset,
    gridRef: bookGridRef,
    initialScrollTop,
    layoutKey: libraryGridLayoutKey,
    resetKey: resultCriteriaSignature,
    rowGap: bookCardGap,
    scrollRef: libraryScrollRef,
    totalCount: sortedBooks.length,
  })
  const libraryGridWindowCount = libraryGridWindow.endIndex - libraryGridWindow.startIndex
  const recentBookCapacity =
    settings.showRecentBooks && !select && recentBooks.length ? libraryGridWindow.columnCount : 0
  const windowedBooks = useMemo(
    () =>
      virtualizeLibraryGrid ? sortedBooks.slice(libraryGridWindow.startIndex, libraryGridWindow.endIndex) : sortedBooks,
    [libraryGridWindow.endIndex, libraryGridWindow.startIndex, sortedBooks, virtualizeLibraryGrid],
  )
  const [stableFilterCoverCount, setStableFilterCoverCount] = useState(0)
  useEffect(() => {
    if (!virtualizeLibraryGrid || titleSearchQuery.trim()) return
    setStableFilterCoverCount((current) =>
      current === libraryGridWindow.topWindowCount ? current : libraryGridWindow.topWindowCount,
    )
  }, [libraryGridWindow.topWindowCount, titleSearchQuery, virtualizeLibraryGrid])
  const stableFilterCoverResources = useMemo(() => {
    if (!virtualizeLibraryGrid) return noCoverResourceIdentities
    return stableFilteredBooks.slice(0, stableFilterCoverCount).flatMap<CoverResourceIdentity>((book) => {
      if (book.generatedCover) return []
      const cover = coversById.get(book.id)
      return cover ? [{ bookId: book.id, cover }] : []
    })
  }, [coversById, stableFilterCoverCount, stableFilteredBooks, virtualizeLibraryGrid])
  const stableFilterCoverOverlap = debouncedTitleSearchQuery.trim()
    ? 0
    : Math.max(0, Math.min(stableFilterCoverCount, libraryGridWindow.endIndex) - libraryGridWindow.startIndex)
  const protectedCoverCount = virtualizeLibraryGrid
    ? stableFilterCoverCount + libraryGridWindowCount - stableFilterCoverOverlap
    : 0
  const coverResourceCacheBudget = useMemo(
    () => getCoverResourceCacheBudget(protectedCoverCount),
    [protectedCoverCount],
  )
  useEffect(() => {
    if (virtualizeLibraryGrid) {
      configureCoverResourceCache(coverResourceCacheBudget)
    } else {
      disposeCoverResourceCache()
    }
  }, [coverResourceCacheBudget, virtualizeLibraryGrid])
  useEffect(() => {
    if (!virtualizeLibraryGrid || !stableFilterCoverResources.length) return
    return leaseCoverResources(stableFilterCoverResources)
  }, [stableFilterCoverResources, virtualizeLibraryGrid])
  const fullGridScrollbar = useOverlayScrollbarMetrics(
    libraryScrollRef,
    libraryScrollContentRef,
    !virtualizeLibraryGrid,
  )
  useEffect(() => {
    if (!titleSearchQuery) {
      setDebouncedTitleSearchQuery('')
      return
    }

    const timeout = window.setTimeout(() => setDebouncedTitleSearchQuery(titleSearchQuery), 150)
    return () => window.clearTimeout(timeout)
  }, [titleSearchQuery])

  const focusTitleSearch = useCallback(() => {
    titleSearchInputRef.current?.focus()
    titleSearchInputRef.current?.select()
  }, [])

  const clearTitleSearch = useCallback(() => {
    setTitleSearchQuery('')
    setDebouncedTitleSearchQuery('')
  }, [])
  const updateSelectedReadingStatus = (readingStatus: ReadingStatus | null) => {
    void db.books.updateReadingStatus(
      selectedBooks.map((book) => book.id),
      readingStatus,
    )
  }
  const referencedArchiveIds = useMemo(
    () =>
      (books ?? []).reduce<string[]>((ids, book) => {
        if (!book.managed && isArchiveOnlyBook(book)) {
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

  const selectAllBooks = useCallback(() => {
    if (!sortedBooks.length) return

    setSelect(true)
    replace([...selectedBookIds, ...visibleBookIds])
  }, [replace, selectedBookIds, setSelect, sortedBooks.length, visibleBookIds])

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
    async (result: BookImportResult) => {
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

  const importBooks = useCallback(() => {
    void openImportDialog({
      directTextImport,
      onImportProgress: onEpubImportProgress,
      onImportResult: handleEpubImportResult,
      onTextPaths,
    })
  }, [directTextImport, handleEpubImportResult, onEpubImportProgress, onTextPaths])

  const importFolder = useCallback(() => {
    void selectImportFolder()
      .then((path) => {
        if (path) setFolderImportPath(path)
      })
      .catch((error) => {
        notify({
          autoCloseMs: false,
          description: formatErrorMessage(error),
          title: errorT('folder_import_failed'),
          type: 'error',
        })
      })
  }, [errorT, notify])

  const importFolderSelection = useCallback(
    (folderImportSelection: FolderImportSelection) => {
      setFolderImportPath(undefined)
      void handleFilePaths(
        folderImportSelection.candidates.map((candidate) => candidate.path),
        {
          directTextImport,
          onImportProgress: onEpubImportProgress,
          onImportResult: async (result) =>
            handleEpubImportResult(await applyFolderImportTagsToResult(result, folderImportSelection)),
          onTextPaths: (paths, waitForEpubImport) => onTextPaths(paths, waitForEpubImport, folderImportSelection),
        },
      ).catch((error) => {
        notify({
          autoCloseMs: false,
          description: formatErrorMessage(error),
          title: errorT('folder_import_failed'),
          type: 'error',
        })
      })
    },
    [directTextImport, errorT, handleEpubImportResult, notify, onEpubImportProgress, onTextPaths],
  )

  const handleCancelSelectionKeyDown = useEffectEvent((e: KeyboardEvent) => {
    if (e.key !== 'Escape') return
    if (isGlobalKeyboardShortcutBlocked(e)) return

    e.preventDefault()
    e.stopPropagation()
    e.stopImmediatePropagation()
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

    document.addEventListener('keydown', cancelSelectionOnEscape, true)

    return () => {
      document.removeEventListener('keydown', cancelSelectionOnEscape, true)
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
      if (e.altKey || isKeyboardTargetBlocked(e)) return

      const key = e.key.toLowerCase()
      const commandModifier = e.ctrlKey || e.metaKey
      if (commandModifier) {
        if (!e.shiftKey && (e.code === 'KeyF' || key === 'f')) {
          e.preventDefault()
          e.stopPropagation()
          focusTitleSearch()
          return
        }

        if (!select && (e.code === 'KeyO' || key === 'o')) {
          e.preventDefault()
          e.stopPropagation()
          if (e.shiftKey) importFolder()
          else importBooks()
          return
        }

        if (e.shiftKey) return

        if (e.code === 'KeyA' || key === 'a') {
          e.preventDefault()
          e.stopPropagation()
          selectAllBooks()
          return
        }

        return
      }

      if (e.shiftKey) return

      if (select && (e.code === 'KeyT' || key === 't') && selectedBooks.length) {
        e.preventDefault()
        e.stopPropagation()
        setBatchTagsOpen(true)
        return
      }

      if (select && e.key === 'Delete' && selectedBooks.length) {
        e.preventDefault()
        e.stopPropagation()
        setDeleteBooksOpen(true)
        return
      }

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
  }, [
    importBooks,
    importFolder,
    focusTitleSearch,
    select,
    selectAllBooks,
    selectedBooks.length,
    setLibraryAction,
    setStatusFilters,
  ])

  const selectBook = useCallback(
    (bookId: string, e?: LibraryBookSelectionEvent) => {
      setSelect(true)
      if (!e?.shiftKey) {
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
    [replace, selectedBookIds, setSelect, toggle, visibleBookIds],
  )

  if (!books) return null

  const visibleSelectedCount = selectedBooks.length
  const allSelected = !!sortedBooks.length && visibleSelectedCount === sortedBooks.length
  const selectAllShortcut = getShortcutChords('librarySelectAll')[0]
  const batchTagsShortcut = getShortcutChords('libraryBatchTags')[0]
  const deleteSelectionShortcut = getShortcutChords('libraryDeleteSelection')[0]
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
  const bookGridStyle = {
    gridTemplateColumns: `repeat(auto-fill, ${bookCardWidth}px)`,
    columnGap: `${bookCardGap}px`,
    rowGap: `${bookCardGap}px`,
    justifyContent: 'space-between',
    marginInline: `-${libraryBookCardOuterInset}px`,
    '--library-book-card-width': `${bookCardWidth}px`,
  } as React.CSSProperties
  const virtualBookGridStyle = {
    ...bookGridStyle,
    paddingBlockStart: `${libraryGridWindow.paddingTop}px`,
    paddingBlockEnd: `${libraryGridWindow.paddingBottom}px`,
  } as React.CSSProperties

  return (
    <DropZone
      className="scroll-parent flex h-full min-h-0 flex-col py-4"
      onContextMenu={(e) => {
        e.preventDefault()
      }}
      onDrop={(e) => {
        const bookId = e.dataTransfer.getData('text/plain')
        const book = books.find((b) => b.id === bookId)
        if (book) {
          completeTabOpen(reader.openBookFromLibrary(book.id), onOpenBook)
        }

        if (e.dataTransfer.files.length) {
          handleFiles(e.dataTransfer.files, {
            directTextImport,
            onImportProgress: onEpubImportProgress,
            onImportResult: handleEpubImportResult,
            onTextPaths,
          })
        }
      }}
    >
      <div className="mb-4 space-y-2.5" style={libraryToolbarStyle}>
        <div className="flex flex-wrap items-start gap-2">
          <div className="flex min-w-30 flex-1 basis-0 flex-wrap items-center gap-2">
            {!!books.length && (
              <InputGroup className="min-w-30 max-w-60 flex-[1_1_120px] bg-transparent focus-within:ring-0 dark:bg-transparent">
                <SearchIcon aria-hidden className="text-muted-foreground ml-2.5 size-4 shrink-0" />
                <InputGroupInput
                  ref={titleSearchInputRef}
                  value={titleSearchQuery}
                  escapeBehavior="none"
                  placeholder={t('library_search.title')}
                  aria-label={t('library_search.title')}
                  onValueChange={setTitleSearchQuery}
                  onKeyDown={(event) => {
                    if (event.nativeEvent.isComposing) return

                    if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key === 'f') {
                      event.preventDefault()
                      event.stopPropagation()
                      event.currentTarget.select()
                      return
                    }

                    if (event.key !== 'Escape') return
                    event.preventDefault()
                    event.stopPropagation()
                    clearTitleSearch()
                    event.currentTarget.blur()
                  }}
                />
                <InputGroupActions>
                  <IconButton
                    Icon={XIcon}
                    title={t('library_search.clear')}
                    disabled={!titleSearchQuery}
                    className="text-muted-foreground"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => {
                      clearTitleSearch()
                      titleSearchInputRef.current?.focus()
                    }}
                  />
                </InputGroupActions>
              </InputGroup>
            )}
            {!!books.length && !select && (
              <div className="flex items-center">
                <Select value={sortField} onValueChange={(value) => setSortField(value as LibrarySortField)}>
                  <SelectTrigger
                    aria-label={t(sortFieldMessageKey[sortField])}
                    className={clsx(
                      toolbarButtonClass,
                      'bg-secondary text-secondary-foreground min-w-25 rounded-r-none border-transparent px-2.5 text-base font-medium hover:bg-(--flow-bg-control-hover) **:data-[slot=select-value]:leading-none **:data-[slot=select-value]:font-medium',
                    )}
                    size="default"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent align="start" className="min-w-28 p-1 text-base" position="popper">
                    {librarySortFieldOptions.map((field) => {
                      const SortIcon = sortFieldIconMap[field]

                      return (
                        <SelectItem
                          key={field}
                          value={field}
                          className="h-8 py-0 pr-7 pl-2 text-base leading-none font-medium"
                        >
                          <SortIcon aria-hidden className="text-muted-foreground size-4" />
                          <span className="leading-none">{t(sortFieldMessageKey[field])}</span>
                        </SelectItem>
                      )
                    })}
                  </SelectContent>
                </Select>
                <TooltipButton
                  type="button"
                  variant="secondary"
                  size="sm"
                  className={clsx(
                    toolbarButtonClass,
                    'border-background/40 w-8 rounded-l-none border-l px-0 text-center font-medium',
                  )}
                  title={t(`sort.${sortDirection}`)}
                  aria-label={t(`sort.${sortDirection}`)}
                  onClick={toggleCurrentSortDirection}
                >
                  <DirectionIcon size={16} className="mx-auto" />
                </TooltipButton>
              </div>
            )}
            {!!books.length && !select && (
              <Popover>
                <AppTooltip label={t('book_size.title')}>
                  <PopoverTrigger asChild>
                    <UiButton
                      type="button"
                      variant="secondary"
                      size="sm"
                      className={clsx(toolbarButtonClass, 'w-8 px-0')}
                      aria-label={t('book_size.title')}
                    >
                      <BookImageIcon aria-hidden className="mx-auto size-4" />
                    </UiButton>
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
              <TooltipButton
                variant="secondary"
                className={clsx(toolbarButtonClass, 'gap-1.5 px-3')}
                aria-label={t(select ? 'cancel' : 'select')}
                title={t(`${select ? 'cancel' : 'select'}.tooltip`)}
                onClick={toggleSelectMode}
              >
                {select ? (
                  <SquareXIcon aria-hidden className="size-4" />
                ) : (
                  <SquareCheckBigIcon aria-hidden className="size-4" />
                )}
                <span className="leading-none">{t(select ? 'cancel' : 'select')}</span>
              </TooltipButton>
            )}
            {select &&
              (allSelected ? (
                <TooltipButton
                  variant="secondary"
                  className={clsx(toolbarButtonClass, 'gap-1.5 px-3')}
                  aria-label={t('deselect_all')}
                  title={t('deselect_all.tooltip')}
                  onClick={reset}
                >
                  <ListXIcon aria-hidden className="size-4" />
                  <span className="leading-none">{t('deselect_all')}</span>
                </TooltipButton>
              ) : (
                <TooltipButton
                  variant="secondary"
                  className={clsx(toolbarButtonClass, 'gap-1.5 px-3')}
                  aria-label={t('select_all')}
                  title={t('select_all.tooltip')}
                  shortcut={selectAllShortcut}
                  onClick={selectAllBooks}
                >
                  <ListChecksIcon aria-hidden className="size-4" />
                  <span className="leading-none">{t('select_all')}</span>
                </TooltipButton>
              ))}
          </div>

          <AppTooltip label={libraryCountTooltip}>
            <div
              className={clsx(
                'flex h-8 min-w-16 shrink-0 items-center justify-center gap-1.5 overflow-hidden text-base leading-none tabular-nums',
                select ? 'text-foreground font-medium' : 'text-muted-foreground',
              )}
            >
              <LibraryCountIcon aria-hidden className="size-4 shrink-0" />
              <span className="min-w-0 truncate">{libraryCountText}</span>
            </div>
          </AppTooltip>

          <div className="flex min-w-30 flex-1 basis-0 flex-wrap items-center justify-end gap-2">
            {select ? (
              <>
                <DropdownMenu modal={false}>
                  <AppTooltip label={t('reading_status.batch_change')}>
                    <DropdownMenuTrigger asChild>
                      <UiButton
                        variant="secondary"
                        className={clsx(toolbarButtonClass, 'gap-1.5 px-3')}
                        disabled={!selectedBooks.length}
                        aria-label={t('reading_status.batch_change')}
                      >
                        <ReadingStatusIcon intent="edit" status={null} />
                        <span className="leading-none">{t('reading_status.label')}</span>
                        <ChevronDownIcon aria-hidden className="size-3.5" />
                      </UiButton>
                    </DropdownMenuTrigger>
                  </AppTooltip>
                  <ReadingStatusMenuContent align="end" onChange={updateSelectedReadingStatus} />
                </DropdownMenu>
                <TooltipButton
                  variant="secondary"
                  className={clsx(toolbarButtonClass, 'gap-1.5 px-3')}
                  disabled={!selectedBooks.length}
                  aria-label={t('tags')}
                  title={t('tags.tooltip')}
                  shortcut={batchTagsShortcut}
                  onClick={() => setBatchTagsOpen(true)}
                >
                  <TagIcon aria-hidden className="size-4" />
                  <span className="leading-none">{t('tags')}</span>
                </TooltipButton>
                <TooltipButton
                  variant="destructive"
                  className={clsx(toolbarButtonClass, 'gap-1.5 px-3')}
                  disabled={!selectedBooks.length}
                  aria-label={t('delete')}
                  title={t('delete.tooltip')}
                  shortcut={deleteSelectionShortcut}
                  onClick={() => setDeleteBooksOpen(true)}
                >
                  <Trash2Icon aria-hidden className="size-4" />
                  <span className="leading-none">{t('delete')}</span>
                </TooltipButton>
              </>
            ) : (
              <DropdownMenu>
                <AppTooltip label={t('import.tooltip')}>
                  <DropdownMenuTrigger asChild>
                    <UiButton className={clsx(toolbarButtonClass, 'gap-1.5 px-3')} aria-label={t('import')}>
                      <FileInputIcon aria-hidden className="size-4" />
                      <span className="leading-none">{t('import')}</span>
                      <ChevronDownIcon aria-hidden className="size-3.5" />
                    </UiButton>
                  </DropdownMenuTrigger>
                </AppTooltip>
                <DropdownMenuContent align="end" sideOffset={4} className="w-max max-w-[calc(100vw-2rem)]">
                  <DropdownMenuItem onSelect={importBooks}>
                    <FileInputIcon aria-hidden className="size-4" />
                    <span className="leading-none whitespace-nowrap">{t('import_books')}</span>
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={importFolder}>
                    <FolderInputIcon aria-hidden className="size-4" />
                    <span className="leading-none whitespace-nowrap">{t('folder_import.action')}</span>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </div>
      </div>

      <OverlayScroll
        ref={libraryScrollRef}
        containerClassName="-mt-0.5 min-h-0 flex-1"
        scrollbar={virtualizeLibraryGrid ? libraryGridWindow.scrollbar : fullGridScrollbar}
      >
        <div ref={libraryScrollContentRef} style={libraryScrollContentStyle}>
          {settings.showRecentBooks && !select && recentBookCapacity > 0 && recentBooks.length > 0 && (
            <section data-flow-library-recent-books className="border-border/60 mb-2 border-b pb-2">
              <ul className="grid" style={bookGridStyle}>
                {recentBooks.slice(0, recentBookCapacity).map((book) => (
                  <BookCard
                    key={`recent-${book.id}`}
                    book={book}
                    sourceStatus={sourceStatuses.get(book.id)}
                    cover={coversById.get(book.id)}
                    recent
                    retainCoverResource={virtualizeLibraryGrid}
                    showModifiedExportIndicator={settings.showModifiedBookExportIndicator === true}
                    onSelectBook={selectBook}
                    onOpenBook={onOpenBook}
                  />
                ))}
              </ul>
            </section>
          )}
          <ul
            ref={bookGridRef}
            className="grid"
            data-flow-library-grid="true"
            data-flow-library-grid-start-index={virtualizeLibraryGrid ? libraryGridWindow.startIndex : 0}
            data-flow-library-grid-total-count={sortedBooks.length}
            style={virtualizeLibraryGrid ? virtualBookGridStyle : bookGridStyle}
          >
            {windowedBooks.map((book) => (
              <BookCard
                key={book.id}
                book={book}
                sourceStatus={sourceStatuses.get(book.id)}
                cover={coversById.get(book.id)}
                select={select}
                selected={has(book.id)}
                highlighted={highlightedBookIds.has(book.id)}
                retainCoverResource={virtualizeLibraryGrid}
                showModifiedExportIndicator={settings.showModifiedBookExportIndicator === true}
                onSelectBook={selectBook}
                onOpenBook={onOpenBook}
              />
            ))}
          </ul>
        </div>
      </OverlayScroll>
      {batchTagsOpen && (
        <BatchTagsDialog books={selectedBooks} tags={tags ?? []} onClose={() => setBatchTagsOpen(false)} />
      )}
      {deleteBooksOpen && (
        <DeleteSelectedBooksDialog
          count={selectedBooks.length}
          openCount={openSelectedBookCount}
          onClose={() => setDeleteBooksOpen(false)}
          onConfirm={() => {
            const bookIds = selectedBooks.map((book) => book.id)
            setDeleteBooksOpen(false)
            exitSelectMode()
            void Promise.all(bookIds.map((bookId) => reader.closeBookTab(bookId)))
              .then(() => db.books.bulkDelete(bookIds))
              .catch((error) => {
                notify({
                  autoCloseMs: false,
                  description: formatErrorMessage(error),
                  title: errorT('delete_books_failed'),
                  type: 'error',
                })
              })
          }}
        />
      )}
      {folderImportPath && (
        <FolderImportDialog
          rootPath={folderImportPath}
          onClose={() => setFolderImportPath(undefined)}
          onImport={importFolderSelection}
        />
      )}
    </DropZone>
  )
}
