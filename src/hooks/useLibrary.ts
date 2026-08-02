import { useEffect, useState } from 'react'

import { db } from '../storage/client'
import type { BookRecord, CoverRecord, LibraryPins, LibraryTagRecord } from '../storage/types'

export function useLibrary() {
  const [books, setBooks] = useState<BookRecord[] | undefined>(() => db.books.peekAll())

  useEffect(() => {
    let disposed = false

    const load = () => {
      db.books
        .toArray()
        .then((books) => {
          if (!disposed) setBooks(books)
        })
        .catch(console.error)
    }

    load()
    const unsubscribe = db.subscribe('books', load)

    return () => {
      disposed = true
      unsubscribe()
    }
  }, [])

  return books
}

export function useCovers() {
  const [covers, setCovers] = useState<CoverRecord[] | undefined>(() => db.covers.peekAll())

  useEffect(() => {
    let disposed = false

    const load = () => {
      db.covers
        .toArray()
        .then((covers) => {
          if (!disposed) setCovers(covers)
        })
        .catch(console.error)
    }

    load()
    const unsubscribe = db.subscribe('covers', load)

    return () => {
      disposed = true
      unsubscribe()
    }
  }, [])

  return covers
}

export function useLibraryTags() {
  const [tags, setTags] = useState<LibraryTagRecord[] | undefined>(() => db.tags.peekAll())

  useEffect(() => {
    let disposed = false

    const load = () => {
      db.tags
        .toArray()
        .then((tags) => {
          if (!disposed) setTags(tags)
        })
        .catch(console.error)
    }

    load()
    const unsubscribe = db.subscribe('tags', load)

    return () => {
      disposed = true
      unsubscribe()
    }
  }, [])

  return tags
}

export function useLibraryPins() {
  const [pins, setPins] = useState<LibraryPins | undefined>(() => db.pins.peek())

  useEffect(() => {
    let disposed = false

    const load = () => {
      db.pins
        .get()
        .then((pins) => {
          if (!disposed) setPins(pins)
        })
        .catch(console.error)
    }

    load()
    const unsubscribe = db.subscribe('pins', load)

    return () => {
      disposed = true
      unsubscribe()
    }
  }, [])

  return pins
}
