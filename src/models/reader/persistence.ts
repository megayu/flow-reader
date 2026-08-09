import { type BookRecord, db } from '../../storage'

export interface BookPersistenceHost {
  getBook: () => BookRecord
  applyBookUpdate: (book: BookRecord, changes: Partial<BookRecord>) => void
  replaceBook: (book: BookRecord) => void
  createCurrentPositionUpdate: () => Partial<BookRecord> | undefined
  waitForNavigation: () => Promise<void> | undefined
}

function withoutReadingSpread(configuration: BookRecord['configuration'] | undefined) {
  const { spread, ...rest } = configuration ?? {}
  return rest
}

function isSpreadOnlyConfigurationUpdate(changes: Partial<BookRecord>, currentBook: BookRecord) {
  if (!('configuration' in changes)) return true

  return (
    JSON.stringify(withoutReadingSpread(changes.configuration)) ===
    JSON.stringify(withoutReadingSpread(currentBook.configuration))
  )
}

function isReadingPositionOnlyUpdate(changes: Partial<BookRecord>, currentBook: BookRecord) {
  const keys = Object.keys(changes)
  return (
    keys.some((key) => key === 'cfi' || key === 'percentage') &&
    isSpreadOnlyConfigurationUpdate(changes, currentBook) &&
    keys.every((key) => ['cfi', 'percentage', 'lastReadAt', 'configuration'].includes(key))
  )
}

export class BookPersistenceController {
  updateBook(host: BookPersistenceHost, changes: Partial<BookRecord>) {
    const currentBook = host.getBook()
    const readingPositionOnly = isReadingPositionOnlyUpdate(changes, currentBook)
    const cfiChanged = readingPositionOnly && 'cfi' in changes && changes.cfi !== currentBook.cfi
    const committedChanges: Partial<BookRecord> = readingPositionOnly
      ? { ...changes, ...(cfiChanged ? { lastReadAt: Date.now() } : {}) }
      : { ...changes, updatedAt: Date.now() }
    const book = { ...currentBook, ...committedChanges }

    host.applyBookUpdate(book, committedChanges)
    db.books.rememberUpdate(book, committedChanges)

    if (readingPositionOnly) return

    void db.books.update(book.id, committedChanges).catch((error) => {
      console.error(error)
    })
  }

  recordOpened(host: BookPersistenceHost) {
    const changes = { lastReadAt: Date.now() }
    const book = { ...host.getBook(), ...changes }
    host.applyBookUpdate(book, changes)
    db.books.rememberUpdate(book, changes)
    void db.books.update(book.id, changes).catch((error) => {
      console.error(error)
    })
  }

  private readingPosition(host: BookPersistenceHost) {
    const book = host.getBook()
    if (book.lastReadAt === undefined) return

    return {
      bookId: book.id,
      cfi: book.cfi,
      percentage: book.percentage,
      spread: book.configuration?.spread ?? null,
      lastReadAt: book.lastReadAt,
    }
  }

  async captureReadingPositionForClose(host: BookPersistenceHost) {
    try {
      await host.waitForNavigation()
    } catch (error) {
      console.error(error)
    }

    const positionUpdate = host.createCurrentPositionUpdate()
    if (positionUpdate) {
      const book = { ...host.getBook(), ...positionUpdate }
      host.replaceBook(book)
      db.books.rememberUpdate(book, positionUpdate)
    }

    return this.readingPosition(host)
  }

  async flushForClose({
    host,
    flushStorage = true,
    recordReadingPosition = true,
  }: {
    host: BookPersistenceHost
    flushStorage?: boolean
    recordReadingPosition?: boolean
  }) {
    const position = await this.captureReadingPositionForClose(host)
    if (flushStorage) await db.waitForPendingWrites()
    if (recordReadingPosition && position) await db.books.recordReadingPosition(position)
    return position
  }
}
