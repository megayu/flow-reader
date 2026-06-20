import { useBoolean } from '@literal-ui/hooks'
import clsx from 'clsx'
import { useLiveQuery } from 'dexie-react-hooks'
import Head from 'next/head'
import { useRouter } from 'next/router'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  MdArrowDownward,
  MdArrowUpward,
  MdCheckBox,
  MdCheckBoxOutlineBlank,
  MdKeyboardArrowDown,
} from 'react-icons/md'
import { useRecoilState } from 'recoil'

import {
  cleanBookText,
  compareBookDisplayTitle,
  getBookDisplayTitle,
  getBookTooltip,
} from '../book'
import { ReaderGridView, Button, DropZone } from '../components'
import { BookRecord, CoverRecord, db } from '../db'
import { handleFiles, setupNativeOpenFiles } from '../file'
import {
  useDisablePinchZooming,
  useLibrary,
  useMobile,
  useTranslation,
} from '../hooks'
import { reader, useReaderSnapshot } from '../models'
import { viewModeState } from '../state'
import { lock } from '../styles'

const placeholder = `data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect fill="gray" fill-opacity="0" width="1" height="1"/></svg>`

type SortField = 'title' | 'creator' | 'updatedAt' | 'createdAt'
type SortDirection = 'asc' | 'desc'

const collator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
})

const sortFieldOptions: SortField[] = [
  'title',
  'creator',
  'updatedAt',
  'createdAt',
]

const toolbarButtonClass = 'h-8'

function compareBookTitle(a: BookRecord, b: BookRecord) {
  return compareBookDisplayTitle(a, b)
}

function compareBookString(
  a: BookRecord,
  b: BookRecord,
  getValue: (book: BookRecord) => string,
) {
  return collator.compare(getValue(a), getValue(b))
}

function compareBookNumber(
  a: BookRecord,
  b: BookRecord,
  getValue: (book: BookRecord) => number | undefined,
) {
  return (getValue(a) ?? 0) - (getValue(b) ?? 0)
}

function compareBooksByField(a: BookRecord, b: BookRecord, field: SortField) {
  if (field === 'title') return compareBookTitle(a, b)
  if (field === 'creator') {
    return compareBookString(a, b, (book) =>
      cleanBookText(book.metadata.creator),
    )
  }
  if (field === 'updatedAt') {
    return compareBookNumber(a, b, (book) => book.updatedAt)
  }

  return compareBookNumber(a, b, (book) => book.createdAt)
}

function sortBooks(
  books: BookRecord[],
  field: SortField,
  direction: SortDirection,
) {
  return [...books].sort((a, b) => {
    const primary = compareBooksByField(a, b, field)
    if (primary) return direction === 'asc' ? primary : -primary

    if (field !== 'title') {
      return compareBookTitle(a, b)
    }

    return 0
  })
}

function toggleSortDirection(direction: SortDirection): SortDirection {
  return direction === 'asc' ? 'desc' : 'asc'
}

function useStringSet() {
  const [values, setValues] = useState(() => new Set<string>())

  const add = useCallback((value: string) => {
    setValues((current) => {
      if (current.has(value)) return current
      const next = new Set(current)
      next.add(value)
      return next
    })
  }, [])

  const has = useCallback((value: string) => values.has(value), [values])

  const toggle = useCallback((value: string) => {
    setValues((current) => {
      const next = new Set(current)
      if (next.has(value)) {
        next.delete(value)
      } else {
        next.add(value)
      }
      return next
    })
  }, [])

  const reset = useCallback(() => {
    setValues((current) => (current.size ? new Set() : current))
  }, [])

  return [values, { add, has, toggle, reset }] as const
}

export default function Index() {
  const { focusedTab, groups } = useReaderSnapshot()
  const [viewMode, setViewMode] = useRecoilState(viewModeState)
  const router = useRouter()

  useDisablePinchZooming()

  useEffect(() => {
    router.beforePopState(({ url }) => {
      if (url === '/') {
        reader.clear()
      }
      return true
    })
  }, [router])

  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined

    setupNativeOpenFiles((books) => {
      reader.addTab(books[0]!)
      setViewMode('reader')
    }).then((handler) => {
      if (disposed) {
        handler?.()
      } else {
        unlisten = handler
      }
    })

    return () => {
      disposed = true
      unlisten?.()
    }
  }, [setViewMode])

  useEffect(() => {
    if (!groups.length && viewMode !== 'library') {
      setViewMode('library')
    }
  }, [groups.length, setViewMode, viewMode])

  const library = <Library onOpenBook={() => setViewMode('reader')} />

  return (
    <>
      <Head>
        {/* https://github.com/microsoft/vscode/blob/36fdf6b697cba431beb6e391b5a8c5f3606975a1/src/vs/code/browser/workbench/workbench.html#L16 */}
        {/* Disable pinch zooming */}
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1.0, maximum-scale=1.0, minimum-scale=1.0, user-scalable=no"
        />
        <title>{focusedTab?.title ?? 'Flow Reader'}</title>
      </Head>
      {groups.length ? (
        <ReaderGridView
          content={viewMode === 'library' ? library : undefined}
        />
      ) : (
        library
      )}
    </>
  )
}

interface LibraryProps {
  onOpenBook: () => void
}

const Library: React.FC<LibraryProps> = ({ onOpenBook }) => {
  const books = useLibrary()
  const covers = useLiveQuery(() => db?.covers.toArray() ?? [])
  const t = useTranslation('home')
  const [sortField, setSortField] = useState<SortField>('title')
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc')
  const [sortMenuOpen, setSortMenuOpen] = useState(false)
  const sortMenuRef = useRef<HTMLDivElement>(null)

  const [select, toggleSelect] = useBoolean(false)
  const [selectedBookIds, { add, has, toggle, reset }] = useStringSet()

  useEffect(() => {
    if (!select) reset()
  }, [reset, select])

  useEffect(() => {
    if (!select) return

    const cancelSelectionOnEscape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return

      e.preventDefault()
      toggleSelect()
    }

    document.addEventListener('keydown', cancelSelectionOnEscape)

    return () => {
      document.removeEventListener('keydown', cancelSelectionOnEscape)
    }
  }, [select, toggleSelect])

  useEffect(() => {
    if (!sortMenuOpen) return

    const closeOnPointerDown = (e: PointerEvent) => {
      if (!sortMenuRef.current?.contains(e.target as Node)) {
        setSortMenuOpen(false)
      }
    }
    const closeOnEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSortMenuOpen(false)
    }

    document.addEventListener('pointerdown', closeOnPointerDown)
    document.addEventListener('keydown', closeOnEscape)

    return () => {
      document.removeEventListener('pointerdown', closeOnPointerDown)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [sortMenuOpen])

  const sortedBooks = useMemo(
    () => sortBooks(books ?? [], sortField, sortDirection),
    [books, sortDirection, sortField],
  )

  if (!books) return null

  const allSelected = selectedBookIds.size === books.length
  const DirectionIcon =
    sortDirection === 'asc' ? MdArrowUpward : MdArrowDownward

  return (
    <DropZone
      className="scroll-parent flex h-full min-h-0 flex-col p-4"
      onDrop={(e) => {
        const bookId = e.dataTransfer.getData('text/plain')
        const book = books.find((b) => b.id === bookId)
        if (book) {
          reader.addTab(book)
          onOpenBook()
        }

        handleFiles(e.dataTransfer.files)
      }}
    >
      <div className="mb-4 space-y-2.5">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            {!!books.length && !select && (
              <div
                ref={sortMenuRef}
                className="relative flex items-center gap-1"
              >
                <Button
                  type="button"
                  variant="secondary"
                  compact
                  className={clsx(
                    toolbarButtonClass,
                    'inline-flex min-w-[4.5rem] items-center justify-between gap-1',
                  )}
                  aria-haspopup="menu"
                  aria-expanded={sortMenuOpen}
                  onClick={() => setSortMenuOpen((open) => !open)}
                >
                  <span>{t(`sort.${sortField}`)}</span>
                  <MdKeyboardArrowDown size={16} className="text-outline" />
                </Button>
                {sortMenuOpen && (
                  <div
                    role="menu"
                    className="absolute left-0 top-full z-20 mt-1 min-w-[7rem] bg-surface py-1 text-on-surface-variant shadow-1 ring-1 ring-inset ring-surface-variant"
                  >
                    {sortFieldOptions.map((field) => (
                      <button
                        key={field}
                        type="button"
                        role="menuitemradio"
                        aria-checked={field === sortField}
                        className={clsx(
                          'block w-full px-3 py-1.5 text-left typescale-label-large hover:bg-outline/10',
                          field === sortField &&
                            'bg-outline/10 text-on-surface',
                        )}
                        onClick={() => {
                          setSortField(field)
                          setSortMenuOpen(false)
                        }}
                      >
                        {t(`sort.${field}`)}
                      </button>
                    ))}
                  </div>
                )}
                <Button
                  type="button"
                  variant="secondary"
                  compact
                  className={clsx(toolbarButtonClass, 'w-8 px-0 text-center')}
                  title={t(`sort.${sortDirection}`)}
                  aria-label={t(`sort.${sortDirection}`)}
                  onClick={() =>
                    setSortDirection((direction) =>
                      toggleSortDirection(direction),
                    )
                  }
                >
                  <DirectionIcon size={16} className="mx-auto" />
                </Button>
              </div>
            )}
            {!!books.length && (
              <Button
                variant="secondary"
                className={toolbarButtonClass}
                onClick={toggleSelect}
              >
                {t(select ? 'cancel' : 'select')}
              </Button>
            )}
            {select &&
              (allSelected ? (
                <Button
                  variant="secondary"
                  className={toolbarButtonClass}
                  onClick={reset}
                >
                  {t('deselect_all')}
                </Button>
              ) : (
                <Button
                  variant="secondary"
                  className={toolbarButtonClass}
                  onClick={() => books.forEach((b) => add(b.id))}
                >
                  {t('select_all')}
                </Button>
              ))}
          </div>

          <div className="space-x-2">
            {select ? (
              <Button
                className={toolbarButtonClass}
                onClick={() => {
                  toggleSelect()
                  const bookIds = [...selectedBookIds]

                  db?.books.bulkDelete(bookIds)
                  db?.covers.bulkDelete(bookIds)
                  db?.files.bulkDelete(bookIds)
                }}
              >
                {t('delete')}
              </Button>
            ) : (
              <Button className={clsx(toolbarButtonClass, 'relative')}>
                <input
                  type="file"
                  accept="application/epub+zip,application/epub"
                  className="absolute inset-0 cursor-pointer opacity-0"
                  onChange={(e) => {
                    const files = e.target.files
                    if (files) handleFiles(files)
                  }}
                  multiple
                />
                {t('import')}
              </Button>
            )}
          </div>
        </div>
      </div>

      <div className="scroll min-h-0 flex-1">
        <ul
          className="grid"
          style={{
            gridTemplateColumns: `repeat(auto-fill, minmax(calc(80px + 3vw), 1fr))`,
            columnGap: lock(16, 32),
            rowGap: lock(24, 40),
          }}
        >
          {sortedBooks.map((book) => (
            <Book
              key={book.id}
              book={book}
              covers={covers}
              select={select}
              selected={has(book.id)}
              toggle={toggle}
              onOpenBook={onOpenBook}
            />
          ))}
        </ul>
      </div>
    </DropZone>
  )
}

interface BookProps {
  book: BookRecord
  covers?: CoverRecord[]
  select?: boolean
  selected?: boolean
  toggle: (id: string) => void
  onOpenBook: () => void
}
const Book: React.FC<BookProps> = ({
  book,
  covers,
  select,
  selected,
  toggle,
  onOpenBook,
}) => {
  const router = useRouter()
  const mobile = useMobile()

  const cover = covers?.find((c) => c.id === book.id)?.cover
  const displayTitle = getBookDisplayTitle(book)
  const tooltip = getBookTooltip(book)

  const Icon = selected ? MdCheckBox : MdCheckBoxOutlineBlank

  return (
    <div className="relative flex flex-col">
      <div
        role="button"
        className="relative border border-inverse-on-surface"
        onClick={async () => {
          if (select) {
            toggle(book.id)
          } else {
            if (mobile) await router.push('/_')
            reader.addTab(book)
            onOpenBook()
          }
        }}
      >
        {book.percentage !== undefined && (
          <div className="absolute right-0 bg-gray-500/60 px-2 text-gray-100 typescale-body-large">
            {(book.percentage * 100).toFixed()}%
          </div>
        )}
        <img
          src={cover ?? placeholder}
          alt="Cover"
          className="mx-auto aspect-[9/12] object-cover"
          draggable={false}
        />
        {select && (
          <div className="absolute bottom-1 right-1">
            <Icon
              size={24}
              className={clsx(
                '-m-1',
                selected ? 'text-tertiary' : 'text-outline',
              )}
            />
          </div>
        )}
      </div>

      <div
        className="mt-2 w-full text-center text-on-surface-variant typescale-body-small line-clamp-2 lg:typescale-body-medium"
        title={tooltip}
      >
        {displayTitle}
      </div>
    </div>
  )
}
