import { invoke } from '@tauri-apps/api/core'

import {
  type BookImportProgress,
  type BookImportResult,
  type BookRecord,
  importEpubPaths,
  importTextPaths,
  openExternalEpubPaths,
  rememberBookImportProgress,
  type TextImportRulesInput,
  type TextImportSelection,
} from './storage'

const nativeOpenEvent = 'flow-open-files'
const bookImportProgressEvent = 'flow-book-import-progress'

interface HandleFilesOptions {
  onImportProgress?: (progress: BookImportProgress) => void
  replaceExisting?: boolean
  onTextPaths?: (paths: string[]) => void
  onImportResult?: (result: BookImportResult) => Set<string> | void | Promise<Set<string> | void>
}

function isEpubPath(path: string) {
  return path.toLowerCase().endsWith('.epub')
}

function isTxtPath(path: string) {
  return path.toLowerCase().endsWith('.txt')
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

  return handleFilePaths(paths, options)
}

export async function handleFilePaths(
  paths: string[],
  { onImportProgress, replaceExisting = true, onImportResult, onTextPaths }: HandleFilesOptions = {},
) {
  if (!paths.length) return []

  const epubPaths = paths.filter(isEpubPath)
  const textPaths = paths.filter(isTxtPath)

  if (textPaths.length) onTextPaths?.(textPaths)
  if (!epubPaths.length) return []

  const importId = createBookImportId()
  onImportProgress?.(initialBookImportProgress(importId, epubPaths.length))
  const unlisten = onImportProgress ? await listenBookImportProgress(importId, onImportProgress) : undefined

  try {
    const result = await importEpubPaths(epubPaths, {
      importId,
      progressiveUpdates: !!unlisten,
      replaceExisting,
    })
    const openedBookIds = await onImportResult?.(result)
    if (!openedBookIds?.size) return result.books
    return result.books.filter((book) => !openedBookIds.has(book.id))
  } finally {
    unlisten?.()
  }
}

export async function importTextSelections(
  imports: TextImportSelection[],
  {
    onImportProgress,
    rules,
  }: {
    onImportProgress?: (progress: BookImportProgress) => void
    rules?: TextImportRulesInput
  } = {},
): Promise<BookImportResult> {
  const importId = createBookImportId()
  onImportProgress?.(initialBookImportProgress(importId, imports.length))
  const unlisten = onImportProgress ? await listenBookImportProgress(importId, onImportProgress) : undefined

  try {
    return await importTextPaths(imports, {
      importId,
      progressiveUpdates: !!unlisten,
      rules,
    })
  } finally {
    unlisten?.()
  }
}

export async function openImportDialog(options: HandleFilesOptions = {}) {
  const { open } = await import('@tauri-apps/plugin-dialog')
  const selected = await open({
    multiple: true,
    filters: [{ name: 'Books', extensions: ['epub', 'txt'] }],
  })
  const paths = Array.isArray(selected) ? selected : selected ? [selected] : []

  return handleFilePaths(paths, { replaceExisting: true, ...options })
}

export async function setupNativeOpenFiles({
  onOpen,
  onOpenRequest,
  onDrop,
  onImportProgress,
  onImportResult,
  onDropTextPaths,
}: {
  onOpen?: (books: BookRecord[]) => void
  onOpenRequest?: (paths: string[]) => void
  onDrop?: (books: BookRecord[]) => void
  onImportProgress?: (progress: BookImportProgress) => void
  onImportResult?: (result: BookImportResult) => Set<string> | void | Promise<Set<string> | void>
  onDropTextPaths?: (paths: string[]) => void
}) {
  if (typeof window === 'undefined') return

  try {
    const { listen } = await import('@tauri-apps/api/event')

    const openPaths = async (paths: string[]) => {
      if (!paths.length) return

      const epubPaths = paths.filter(isEpubPath)
      const textPaths = paths.filter(isTxtPath)
      if (epubPaths.length) onOpenRequest?.(epubPaths)
      if (textPaths.length) {
        const books = await handleFilePaths(textPaths, {
          onImportProgress,
          onImportResult,
          replaceExisting: false,
        })
        if (books.length) onOpen?.(books)
      }

      if (epubPaths.length) {
        const result = await openExternalEpubPaths(epubPaths)
        if (result.failures.length) onImportResult?.(result)
        if (result.books.length) onOpen?.(result.books)
      }
    }

    const pendingOpenPaths = await invoke<string[]>('take_pending_open_paths')
    await openPaths(pendingOpenPaths)

    const unlistenOpen = await listen<string[]>(nativeOpenEvent, (event) => {
      void openPaths(event.payload)
    })

    let unlistenDrop: (() => void) | undefined
    try {
      const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow')
      unlistenDrop = await getCurrentWebviewWindow().onDragDropEvent((event) => {
        if (event.payload.type !== 'drop') return
        void handleFilePaths(event.payload.paths, {
          onImportProgress,
          onImportResult,
          replaceExisting: true,
          onTextPaths: onDropTextPaths,
        }).then((books) => {
          if (books.length) onDrop?.(books)
        })
      })
    } catch (error) {
      console.debug('Native file drop is unavailable', error)
    }

    return {
      cleanup: () => {
        unlistenOpen()
        unlistenDrop?.()
      },
    }
  } catch (error) {
    console.debug('Native file open is unavailable', error)
  }
}

export function isTauriRuntime() {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
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
  }
}

async function listenBookImportProgress(importId: string, onImportProgress: (progress: BookImportProgress) => void) {
  const { listen } = await import('@tauri-apps/api/event')
  return listen<BookImportProgress>(bookImportProgressEvent, (event) => {
    const progress = event.payload
    if (progress.importId !== importId) return

    rememberBookImportProgress(progress)
    onImportProgress(progress)
  })
}
