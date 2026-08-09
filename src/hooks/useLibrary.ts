import { useEffect, useState } from 'react'

import { db } from '../storage/client'
import type { BookRecord, CoverRecord, LibraryPins, LibraryTagRecord } from '../storage/types'

interface StorageSubscriptionSource<T> {
  load: () => Promise<T>
  peek: () => T | undefined
  subscribe: (load: () => void) => () => void
}

const booksSource: StorageSubscriptionSource<BookRecord[]> = {
  load: () => db.books.toArray(),
  peek: () => db.books.peekAll(),
  subscribe: (load) => db.subscribe('books', load),
}

const coversSource: StorageSubscriptionSource<CoverRecord[]> = {
  load: () => db.covers.toArray(),
  peek: () => db.covers.peekAll(),
  subscribe: (load) => db.subscribe('covers', load),
}

const tagsSource: StorageSubscriptionSource<LibraryTagRecord[]> = {
  load: () => db.tags.toArray(),
  peek: () => db.tags.peekAll(),
  subscribe: (load) => db.subscribe('tags', load),
}

const pinsSource: StorageSubscriptionSource<LibraryPins> = {
  load: () => db.pins.get(),
  peek: () => db.pins.peek(),
  subscribe: (load) => db.subscribe('pins', load),
}

const recentBooksSource: StorageSubscriptionSource<string[]> = {
  load: () => db.recentBooks.get(),
  peek: () => db.recentBooks.peek(),
  subscribe: (load) => db.subscribe('recentBooks', load),
}

function useStorageSubscription<T>(source: StorageSubscriptionSource<T>, enabled = true) {
  const [value, setValue] = useState<T | undefined>(source.peek)

  useEffect(() => {
    if (!enabled) return

    let disposed = false
    const load = () => {
      source
        .load()
        .then((nextValue) => {
          if (!disposed) setValue(nextValue)
        })
        .catch(console.error)
    }

    load()
    const unsubscribe = source.subscribe(load)
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [enabled, source])

  return value
}

export function useLibrary() {
  return useStorageSubscription(booksSource)
}

export function useCovers() {
  return useStorageSubscription(coversSource)
}

export function useLibraryTags() {
  return useStorageSubscription(tagsSource)
}

export function useLibraryPins() {
  return useStorageSubscription(pinsSource)
}

export function useRecentBookIds(enabled = true) {
  return useStorageSubscription(recentBooksSource, enabled)
}
