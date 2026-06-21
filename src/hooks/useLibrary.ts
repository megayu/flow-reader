import { useEffect, useState } from 'react'

import { BookRecord, CoverRecord, db } from '../db'

export function useLibrary() {
  const [books, setBooks] = useState<BookRecord[]>()

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
  const [covers, setCovers] = useState<CoverRecord[]>()

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
