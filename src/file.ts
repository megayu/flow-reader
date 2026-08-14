import { invoke } from '@tauri-apps/api/core'

import { waitForBookCacheClearing } from './state'
import {
  applyFolderImportTags,
  type BookImportProgress,
  type BookImportResult,
  type BookRecord,
  type FolderImportCandidate,
  importEpubPaths,
  importTextPaths,
  openExternalEpubPaths,
  type TextImportSelection,
} from './storage'

const nativeOpenEvent = 'flow-open-files'
const filePathCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
})

interface HandleFilesOptions {
  directTextImport?: boolean
  onImportProgress?: (progress: BookImportProgress) => void
  onTextPaths?: (paths: string[], waitForEpubImport?: Promise<void>) => void
  onImportResult?: (result: BookImportResult) => Set<string> | void | Promise<Set<string> | void>
}

export interface FolderImportTagRules {
  rootDirectory: boolean
  intermediateDirectories: boolean
  directDirectory: boolean
}

export interface FolderImportSelection {
  candidates: FolderImportCandidate[]
  tagRules: FolderImportTagRules
}

function isEpubPath(path: string) {
  return path.toLowerCase().endsWith('.epub')
}

function isTxtPath(path: string) {
  return path.toLowerCase().endsWith('.txt')
}

function getPathFilename(path: string) {
  const separatorIndex = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return path.slice(separatorIndex + 1)
}

function compareExactText(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0
}

function sortDroppedFilePaths(paths: readonly string[]) {
  return [...paths].sort((a, b) => {
    const filenameOrder = filePathCollator.compare(getPathFilename(a), getPathFilename(b))
    if (filenameOrder) return filenameOrder

    const pathOrder = filePathCollator.compare(a, b)
    return pathOrder || compareExactText(a, b)
  })
}

function getNativeFilePath(file: File) {
  const path = (file as File & { path?: string }).path
  return typeof path === 'string' && path ? path : ''
}

export async function handleFiles(files: Iterable<File>, options: HandleFilesOptions = {}) {
  const paths: string[] = []
  for (const file of files) {
    const path = getNativeFilePath(file)
    if (path) paths.push(path)
  }
  if (!paths.length) return []

  return handleFilePaths(sortDroppedFilePaths(paths), options)
}

export async function handleFilePaths(
  paths: string[],
  { directTextImport, onImportProgress, onImportResult, onTextPaths }: HandleFilesOptions = {},
) {
  if (!paths.length) return []
  await waitForBookCacheClearing()

  const epubPaths = paths.filter(isEpubPath)
  const textPaths = paths.filter(isTxtPath)
  let completeEpubImport: (() => void) | undefined
  const waitForEpubImport =
    epubPaths.length && textPaths.length && !directTextImport
      ? new Promise<void>((resolve) => {
          completeEpubImport = resolve
        })
      : undefined

  try {
    if (textPaths.length && !directTextImport) onTextPaths?.(textPaths, waitForEpubImport)

    const directTextPaths = directTextImport ? textPaths : []
    const batch = await runDirectTextImportBatch(epubPaths, directTextPaths, {
      onImportProgress,
      importEpubPhase: (importId, onProgress) =>
        importEpubPaths(epubPaths, {
          importId,
          onProgress,
        }),
      importTextPhase: (importId, onProgress) =>
        importTextPaths(
          directTextPaths.map((path) => ({ path })),
          {
            importId,
            onProgress,
          },
        ),
    })
    if (!batch) return []

    const result = {
      books: [...batch.epubResult.books, ...batch.textResult.books],
      failures: [...batch.epubResult.failures, ...batch.textResult.failures],
      skipped: [...batch.epubResult.skipped, ...batch.textResult.skipped],
    }
    const openedBookIds = await onImportResult?.(result)
    if (!openedBookIds?.size) return result.books
    return result.books.filter((book) => !openedBookIds.has(book.id))
  } finally {
    completeEpubImport?.()
  }
}

export async function importTextSelections(
  imports: TextImportSelection[],
  {
    copySourceFiles,
    onImportProgress,
  }: {
    copySourceFiles?: boolean
    onImportProgress?: (progress: BookImportProgress) => void
  } = {},
): Promise<BookImportResult> {
  const batchImportId = createBookImportId()
  onImportProgress?.(initialBookImportProgress(batchImportId, imports.length))
  return runBookImportPhase(
    onImportProgress,
    (progress) => aggregateBookImportProgress(progress, batchImportId, imports.length),
    imports.length,
    (importId, onProgress) =>
      importTextPaths(imports, {
        copySourceFiles,
        importId,
        onProgress,
      }),
  )
}

export async function openImportDialog(options: HandleFilesOptions = {}) {
  const { open } = await import('@tauri-apps/plugin-dialog')
  const selected = await open({
    multiple: true,
    filters: [{ name: 'Books', extensions: ['epub', 'txt'] }],
  })
  const paths = Array.isArray(selected) ? selected : selected ? [selected] : []

  return handleFilePaths(paths, options)
}

export async function selectImportFolder() {
  const { open } = await import('@tauri-apps/plugin-dialog')
  const selected = await open({
    directory: true,
    multiple: false,
  })
  return typeof selected === 'string' ? selected : undefined
}

export async function applyFolderImportTagsToResult(result: BookImportResult, selection?: FolderImportSelection) {
  if (!selection || !result.books.length) return result

  const candidateByPath = new Map(
    selection.candidates.map((candidate) => [candidate.path.replaceAll('\\', '/'), candidate]),
  )
  const tagNamesByBookId = new Map<string, string[]>()
  for (const book of result.books) {
    const candidate = candidateByPath.get(book.sourcePath.replaceAll('\\', '/'))
    if (!candidate) continue

    const tagNames = tagNamesByBookId.get(book.id) ?? []
    if (selection.tagRules.rootDirectory && candidate.rootDirectory) tagNames.push(candidate.rootDirectory)
    if (selection.tagRules.intermediateDirectories) tagNames.push(...candidate.intermediateDirectories)
    if (selection.tagRules.directDirectory && candidate.directDirectory) tagNames.push(candidate.directDirectory)
    tagNamesByBookId.set(book.id, tagNames)
  }
  const assignments = Array.from(tagNamesByBookId, ([bookId, tagNames]) => ({ bookId, tagNames })).filter(
    (assignment) => assignment.tagNames.length,
  )
  if (!assignments.length) return result

  const tagged = await applyFolderImportTags(assignments)
  const taggedById = new Map(tagged.books.map((book) => [book.id, book]))
  return {
    ...result,
    books: result.books.map((book) => {
      const taggedBook = taggedById.get(book.id)
      return taggedBook ? { ...book, tagIds: taggedBook.tagIds, updatedAt: taggedBook.updatedAt } : book
    }),
  }
}

export async function setupNativeOpenFiles({
  onOpen,
  onOpenRequest,
  onDrop,
  onDropFolder,
  onDropMixedItems,
  onDropMultipleFolders,
  onImportProgress,
  onImportResult,
  onDropTextPaths,
  getDirectTextImport,
}: {
  onOpen?: (books: BookRecord[]) => void
  onOpenRequest?: (paths: string[]) => void
  onDrop?: (books: BookRecord[]) => void
  onDropFolder?: (path: string) => void
  onDropMixedItems?: () => void
  onDropMultipleFolders?: () => void
  onImportProgress?: (progress: BookImportProgress) => void
  onImportResult?: (result: BookImportResult) => Set<string> | void | Promise<Set<string> | void>
  onDropTextPaths?: (paths: string[], waitForEpubImport?: Promise<void>) => void
  getDirectTextImport?: () => boolean
}) {
  if (typeof window === 'undefined') return

  let unlistenOpen: (() => void) | undefined
  try {
    const { listen } = await import('@tauri-apps/api/event')

    const openPaths = async (paths: string[]) => {
      if (!paths.length) return

      const epubPaths = paths.filter(isEpubPath)
      const textPaths = paths.filter(isTxtPath)
      if (epubPaths.length) onOpenRequest?.(epubPaths)
      if (textPaths.length && getDirectTextImport?.()) {
        const batch = await runDirectTextImportBatch(epubPaths, textPaths, {
          onImportProgress,
          importEpubPhase: () => openExternalEpubPaths(epubPaths),
          importTextPhase: (importId, onProgress) =>
            importTextPaths(
              textPaths.map((path) => ({ path })),
              {
                importId,
                onProgress,
              },
            ),
        })
        if (!batch) return

        const importResult = {
          books: batch.textResult.books,
          failures: [...batch.epubResult.failures, ...batch.textResult.failures],
          skipped: [...batch.epubResult.skipped, ...batch.textResult.skipped],
        }
        const openedBookIds = await onImportResult?.(importResult)
        const books = [
          ...batch.epubResult.books,
          ...batch.textResult.books.filter((book) => !openedBookIds?.has(book.id)),
        ]
        if (books.length) onOpen?.(books)
        return
      }

      if (epubPaths.length) {
        const result = await openExternalEpubPaths(epubPaths)
        if (result.failures.length) onImportResult?.(result)
        if (result.books.length) onOpen?.(result.books)
      }
    }

    unlistenOpen = await listen<string[]>(nativeOpenEvent, (event) => {
      void openPaths(event.payload).catch(console.error)
    })

    const pendingOpenPaths = await invoke<string[]>('take_pending_open_paths')
    await openPaths(pendingOpenPaths)

    let unlistenDrop: (() => void) | undefined
    try {
      const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow')
      unlistenDrop = await getCurrentWebviewWindow().onDragDropEvent((event) => {
        if (event.payload.type !== 'drop') return
        const paths = sortDroppedFilePaths(event.payload.paths)
        void invoke<string[]>('filter_directory_paths', { paths })
          .then((directoryPaths) => {
            if (directoryPaths.length > 1) {
              onDropMultipleFolders?.()
              return []
            }
            if (directoryPaths.length && directoryPaths.length < paths.length) {
              onDropMixedItems?.()
              return []
            }
            const [directoryPath] = directoryPaths
            if (directoryPath) {
              onDropFolder?.(directoryPath)
              return []
            }

            return handleFilePaths(paths, {
              directTextImport: getDirectTextImport?.(),
              onImportProgress,
              onImportResult,
              onTextPaths: onDropTextPaths,
            })
          })
          .then((books) => {
            if (books.length) onDrop?.(books)
          })
          .catch(console.error)
      })
    } catch (error) {
      console.debug('Native file drop is unavailable', error)
    }

    return {
      cleanup: () => {
        unlistenOpen?.()
        unlistenDrop?.()
      },
    }
  } catch (error) {
    unlistenOpen?.()
    console.debug('Native file open is unavailable', error)
  }
}

function createBookImportId() {
  return `book-import-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function initialBookImportProgress(importId: string, total: number): BookImportProgress {
  return {
    importId,
    total,
    completed: 0,
    imported: 0,
    failed: 0,
    skipped: 0,
  }
}

function emptyBookImportResult(): BookImportResult {
  return { books: [], failures: [], skipped: [] }
}

interface DirectTextImportBatchOptions {
  onImportProgress?: (progress: BookImportProgress) => void
  importEpubPhase: (importId: string, onProgress?: (progress: BookImportProgress) => void) => Promise<BookImportResult>
  importTextPhase: (importId: string, onProgress?: (progress: BookImportProgress) => void) => Promise<BookImportResult>
}

async function runDirectTextImportBatch(
  epubPaths: string[],
  textPaths: string[],
  { onImportProgress, importEpubPhase, importTextPhase }: DirectTextImportBatchOptions,
) {
  const total = epubPaths.length + textPaths.length
  if (!total) return

  const batchImportId = createBookImportId()
  onImportProgress?.(initialBookImportProgress(batchImportId, total))
  let epubResult = emptyBookImportResult()
  if (epubPaths.length) {
    epubResult = await runBookImportPhase(
      onImportProgress,
      (progress) => aggregateBookImportProgress(progress, batchImportId, total),
      epubPaths.length,
      importEpubPhase,
    )
  }

  let textResult = emptyBookImportResult()
  if (textPaths.length) {
    textResult = await runBookImportPhase(
      onImportProgress,
      (progress) =>
        aggregateBookImportProgress(progress, batchImportId, total, {
          completed: epubPaths.length,
          imported: epubResult.books.length,
          failed: epubResult.failures.length,
          skipped: epubResult.skipped.length,
        }),
      textPaths.length,
      importTextPhase,
    )
  }

  return { epubResult, textResult }
}

interface BookImportProgressOffset {
  completed: number
  imported: number
  failed: number
  skipped: number
}

function aggregateBookImportProgress(
  progress: BookImportProgress,
  importId: string,
  total: number,
  offset: BookImportProgressOffset = { completed: 0, imported: 0, failed: 0, skipped: 0 },
): BookImportProgress {
  return {
    ...progress,
    importId,
    total,
    completed: offset.completed + progress.completed,
    imported: offset.imported + progress.imported,
    failed: offset.failed + progress.failed,
    skipped: offset.skipped + progress.skipped,
  }
}

async function runBookImportPhase(
  onImportProgress: ((progress: BookImportProgress) => void) | undefined,
  presentProgress: (progress: BookImportProgress) => BookImportProgress,
  total: number,
  operation: (importId: string, onProgress?: (progress: BookImportProgress) => void) => Promise<BookImportResult>,
) {
  const importId = createBookImportId()
  const result = await operation(
    importId,
    onImportProgress ? (progress) => onImportProgress(presentProgress(progress)) : undefined,
  )
  onImportProgress?.(
    presentProgress({
      importId,
      total,
      completed: total,
      imported: result.books.length,
      failed: result.failures.length,
      skipped: result.skipped.length,
    }),
  )
  return result
}
