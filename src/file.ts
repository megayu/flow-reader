import { BookRecord, importBookPaths } from './db'

const nativeOpenEvent = 'flow-open-files'

interface HandleFilesOptions {
  replaceExisting?: boolean
  onTextPaths?: (paths: string[]) => void
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

export async function handleFiles(
  files: Iterable<File>,
  options: HandleFilesOptions = {},
) {
  const paths = [...files].map(getNativeFilePath).filter(Boolean)
  if (!paths.length) return []

  return handleFilePaths(paths, options)
}

export async function handleFilePaths(
  paths: string[],
  { replaceExisting = true, onTextPaths }: HandleFilesOptions = {},
) {
  if (!paths.length) return []

  const epubPaths = paths.filter(isEpubPath)
  const textPaths = paths.filter(isTxtPath)

  if (textPaths.length) onTextPaths?.(textPaths)
  if (!epubPaths.length) return []

  return importBookPaths(epubPaths, { replaceExisting })
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
  onDrop,
  onDropTextPaths,
}: {
  onOpen?: (books: BookRecord[]) => void
  onDrop?: (books: BookRecord[]) => void
  onDropTextPaths?: (paths: string[]) => void
}) {
  if (typeof window === 'undefined') return

  try {
    const [{ invoke }, { listen }] = await Promise.all([
      import('@tauri-apps/api/core'),
      import('@tauri-apps/api/event'),
    ])

    const openPaths = async (
      paths: string[],
      { replaceExisting = false }: HandleFilesOptions = {},
    ) => {
      if (!paths.length) return

      const books = await handleFilePaths(paths, { replaceExisting })
      if (books.length) onOpen?.(books)
    }

    await openPaths(await invoke<string[]>('take_pending_open_paths'), {
      replaceExisting: false,
    })

    const unlistenOpen = await listen<string[]>(nativeOpenEvent, (event) => {
      void openPaths(event.payload, { replaceExisting: false })
    })

    let unlistenDrop: (() => void) | undefined
    try {
      const { getCurrentWebviewWindow } =
        await import('@tauri-apps/api/webviewWindow')
      unlistenDrop = await getCurrentWebviewWindow().onDragDropEvent(
        (event) => {
          if (event.payload.type !== 'drop') return
          void handleFilePaths(event.payload.paths, {
            replaceExisting: true,
            onTextPaths: onDropTextPaths,
          }).then((books) => {
            if (books.length) onDrop?.(books)
          })
        },
      )
    } catch (error) {
      console.debug('Native file drop is unavailable', error)
    }

    return () => {
      unlistenOpen()
      unlistenDrop?.()
    }
  } catch (error) {
    console.debug('Native file open is unavailable', error)
  }
}

export function isTauriRuntime() {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}
