export type ReaderOpenErrorStage =
  | 'source'
  | 'open'
  | 'render'
  | 'spine'
  | 'position'

export interface ReaderOpenErrorEvent {
  bookTitle: string
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
