// Reader failures are broadcast without coupling the model to library UI.
export type ReaderOpenErrorStage = 'source' | 'open' | 'render' | 'spine' | 'position' | 'navigation' | 'toc'

export interface ReaderOpenErrorEvent {
  bookId: string
  bookTitle: string
  closeTab: boolean
  fatal: boolean
  error: unknown
  stage: ReaderOpenErrorStage
}

type ReaderOpenErrorListener = (event: ReaderOpenErrorEvent) => void

const readerOpenErrorListeners = new Set<ReaderOpenErrorListener>()

export function emitReaderOpenError(event: ReaderOpenErrorEvent) {
  readerOpenErrorListeners.forEach((listener) => listener(event))
}

export function subscribeReaderOpenErrors(listener: ReaderOpenErrorListener) {
  readerOpenErrorListeners.add(listener)

  return () => {
    readerOpenErrorListeners.delete(listener)
  }
}
