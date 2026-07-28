import { useEffect, useState } from 'react'

import { BookRecord, CoverRecord, LibraryTagRecord, db } from '../storage'

export function useLibrary() {
  const [books, setBooks] = useState<BookRecord[] | undefined>(() =>
    db.books.peekAll(),
  )

  useEffect(() => {
    let disposed = false

    const load = () => {
      db.books.toArray().then((books) => {
        if (!disposed) setBooks(books)
      })
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
  const [covers, setCovers] = useState<CoverRecord[] | undefined>(() =>
    db.covers.peekAll(),
  )

  useEffect(() => {
    let disposed = false

    const load = () => {
      db.covers.toArray().then((covers) => {
        if (!disposed) setCovers(covers)
      })
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
  const [tags, setTags] = useState<LibraryTagRecord[] | undefined>(() =>
    db.tags.peekAll(),
  )

  useEffect(() => {
    let disposed = false

    const load = () => {
      db.tags.toArray().then((tags) => {
        if (!disposed) setTags(tags)
      })
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
