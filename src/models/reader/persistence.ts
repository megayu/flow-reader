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
    keys.every((key) => ['cfi', 'percentage', 'updatedAt', 'lastReadAt', 'configuration'].includes(key))
  )
}

export class BookPersistenceController {
  private readingPositionSequence = 0

  updateBook(host: BookPersistenceHost, changes: Partial<BookRecord>) {
    const currentBook = host.getBook()
    const readingPositionOnly = isReadingPositionOnlyUpdate(changes, currentBook)
    const updatedAt = Date.now()
    const committedChanges = {
      ...changes,
      updatedAt,
      ...(readingPositionOnly ? { lastReadAt: updatedAt } : {}),
    }
    const book = { ...currentBook, ...committedChanges }

    host.applyBookUpdate(book, committedChanges)
    db.books.remember(book)

    if (readingPositionOnly) {
      void this.recordReadingPosition(host, committedChanges).catch((error) => {
        console.error(error)
      })
      return
    }

    void db.books.update(book.id, committedChanges).catch((error) => {
      console.error(error)
    })
  }

  private recordReadingPosition(host: BookPersistenceHost, changes: Partial<BookRecord>) {
    const book = host.getBook()
    return db.books.recordReadingPosition({
      bookId: book.id,
      cfi: changes.cfi,
      percentage: changes.percentage,
      spread: changes.configuration?.spread ?? null,
      updatedAt: changes.updatedAt ?? Date.now(),
      sequence: ++this.readingPositionSequence,
    })
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
    try {
      await host.waitForNavigation()
    } catch (error) {
      console.error(error)
    }

    const positionUpdate = host.createCurrentPositionUpdate()
    if (positionUpdate) {
      const updatedAt = Date.now()
      const changes = {
        ...positionUpdate,
        updatedAt,
        lastReadAt: updatedAt,
      }
      const book = { ...host.getBook(), ...changes }
      host.replaceBook(book)
      db.books.remember(book)
      if (recordReadingPosition) {
        await this.recordReadingPosition(host, changes)
      }
    }

    if (flushStorage) await db.flush()
  }
}
