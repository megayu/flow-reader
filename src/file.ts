import { BookRecord, importBookPaths } from './db'

const nativeOpenEvent = 'flow-open-files'

interface HandleFilesOptions {
  replaceExisting?: boolean
}

export async function handleFiles(
  _files: Iterable<File>,
  _options: HandleFilesOptions = {},
) {
  return []
}

export async function handleFilePaths(
  paths: string[],
  { replaceExisting = true }: HandleFilesOptions = {},
) {
  if (!paths.length) return []

  return importBookPaths(paths, { replaceExisting })
}

export async function openImportDialog() {
  const { open } = await import('@tauri-apps/plugin-dialog')
  const selected = await open({
    multiple: true,
    filters: [{ name: 'EPUB', extensions: ['epub'] }],
  })
  const paths = Array.isArray(selected) ? selected : selected ? [selected] : []

  return handleFilePaths(paths, { replaceExisting: true })
}

export async function setupNativeOpenFiles({
  onOpen,
  onDrop,
}: {
  onOpen?: (books: BookRecord[]) => void
  onDrop?: (books: BookRecord[]) => void
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
      const { getCurrentWebviewWindow } = await import(
        '@tauri-apps/api/webviewWindow'
      )
      unlistenDrop = await getCurrentWebviewWindow().onDragDropEvent(
        (event) => {
          if (event.payload.type !== 'drop') return
          void handleFilePaths(event.payload.paths, {
            replaceExisting: true,
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
