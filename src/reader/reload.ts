import { reader } from '../models/reader'
import { useAppStore } from '../state'

import { subscribeReaderOpenErrors } from './errorEvents'

const RESTORE_BOOK_KEY = 'flow-reader:reload-book'
let reloading = false
let restoredBook: { id: string; show: () => void } | undefined

function hideAppForReload() {
  const body = document.body
  const previousOpacity = body.style.opacity
  const previousInert = body.inert
  // Keep geometry intact while hiding intermediate tab changes, including portals.
  body.style.opacity = '0'
  body.inert = true
  return () => {
    body.style.opacity = previousOpacity
    body.inert = previousInert
  }
}

export function revealRestoredBook(bookId: string) {
  if (restoredBook?.id !== bookId) return
  const { show } = restoredBook
  restoredBook = undefined
  show()
}

export async function reloadCurrentView() {
  if (reloading) return
  const reading = useAppStore.getState().viewMode === 'reader'
  const tab = reader.focusedBookTab
  if (!import.meta.env.DEV && (!reading || !tab)) return

  reloading = true
  try {
    if (import.meta.env.DEV) {
      const bookId = reading && tab?.book.scope === 'library' ? tab.book.id : undefined
      const show = hideAppForReload()
      try {
        sessionStorage.removeItem(RESTORE_BOOK_KEY)
        await reader.closeAllTabs()
        await reader.collectAppCloseBookCheckpoints()
        if (bookId) sessionStorage.setItem(RESTORE_BOOK_KEY, bookId)
        window.location.reload()
      } catch (error) {
        show()
        throw error
      }
    } else {
      await tab!.reloadContent()
    }
  } finally {
    reloading = false
  }
}

export async function restoreBookAfterReload() {
  if (!import.meta.env.DEV) return
  const bookId = sessionStorage.getItem(RESTORE_BOOK_KEY)
  sessionStorage.removeItem(RESTORE_BOOK_KEY)
  if (!bookId) return

  const show = hideAppForReload()
  const unsubscribe = subscribeReaderOpenErrors((event) => revealRestoredBook(event.bookId))
  restoredBook = {
    id: bookId,
    show: () => {
      unsubscribe()
      show()
    },
  }
  try {
    await reader.openBookFromLibrary(bookId)
    useAppStore.getState().setViewMode('reader')
  } catch (error) {
    revealRestoredBook(bookId)
    throw error
  }
}
