export const recentReadingLimit = 10

interface RecentReadingSession {
  baselineCfi?: string
}

function normalizeRecentBookIds(ids: readonly string[]) {
  const seen = new Set<string>()
  return ids.flatMap((id) => {
    if (!id || seen.has(id) || seen.size >= recentReadingLimit) return []
    seen.add(id)
    return [id]
  })
}

export class RecentReadingModel {
  private bookIds: string[]
  private readonly sessions = new Map<string, RecentReadingSession>()

  constructor(bookIds: readonly string[] = []) {
    this.bookIds = normalizeRecentBookIds(bookIds)
  }

  replace(bookIds: readonly string[]) {
    this.bookIds = normalizeRecentBookIds(bookIds)
  }

  snapshot() {
    return [...this.bookIds]
  }

  record(bookId: string) {
    if (!bookId || this.bookIds[0] === bookId) return false
    this.bookIds = [bookId, ...this.bookIds.filter((id) => id !== bookId)].slice(0, recentReadingLimit)
    return true
  }

  beginSession(bookId: string, baselineCfi?: string) {
    if (!bookId) return
    this.sessions.set(bookId, { baselineCfi })
  }

  cancelSession(bookId: string) {
    this.sessions.delete(bookId)
  }

  observePosition(bookId: string, cfi: string | undefined, userNavigation: boolean) {
    const session = this.sessions.get(bookId)
    if (!session || !cfi) return false

    if (!session.baselineCfi || !userNavigation) {
      session.baselineCfi = cfi
      return false
    }
    if (session.baselineCfi === cfi) return false

    this.sessions.delete(bookId)
    return this.record(bookId)
  }
}
