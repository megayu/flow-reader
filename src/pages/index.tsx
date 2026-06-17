import { useBoolean } from '@literal-ui/hooks'
import clsx from 'clsx'
import { useLiveQuery } from 'dexie-react-hooks'
import Head from 'next/head'
import { useRouter } from 'next/router'
import React, { useEffect, useMemo, useState } from 'react'
import { MdCheckBox, MdCheckBoxOutlineBlank } from 'react-icons/md'
import { useSet } from 'react-use'

import { pack } from '../backup'
import { ReaderGridView, Button, DropZone, Select } from '../components'
import { BookRecord, CoverRecord, db } from '../db'
import { handleFiles } from '../file'
import {
  useDisablePinchZooming,
  useLibrary,
  useMobile,
  useTranslation,
} from '../hooks'
import { reader, useReaderSnapshot } from '../models'
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

function cleanBookText(value?: string) {
  return value?.replace(/\s+/g, ' ').trim() ?? ''
}

function stripFileExtension(filename: string) {
  return cleanBookText(filename).replace(/\.[^.]+$/, '')
}

function getBookDisplayTitle(book: BookRecord) {
  return cleanBookText(book.metadata.title) || stripFileExtension(book.name)
}

function getBookTooltip(book: BookRecord) {
  return [
    cleanBookText(book.metadata.title),
    cleanBookText(book.metadata.creator),
    cleanBookText(book.name),
  ]
    .filter(Boolean)
    .join('\n')
}

function compareBookTitle(a: BookRecord, b: BookRecord) {
  return collator.compare(getBookDisplayTitle(a), getBookDisplayTitle(b))
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

export default function Index() {
  const { focusedTab } = useReaderSnapshot()
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

  return (
    <>
      <Head>
        {/* https://github.com/microsoft/vscode/blob/36fdf6b697cba431beb6e391b5a8c5f3606975a1/src/vs/code/browser/workbench/workbench.html#L16 */}
        {/* Disable pinch zooming */}
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1.0, maximum-scale=1.0, minimum-scale=1.0, user-scalable=no"
        />
        <title>{focusedTab?.title ?? 'Flow'}</title>
      </Head>
      <ReaderGridView />
      <Library />
    </>
  )
}

const Library: React.FC = () => {
  const books = useLibrary()
  const covers = useLiveQuery(() => db?.covers.toArray() ?? [])
  const t = useTranslation('home')
  const [sortField, setSortField] = useState<SortField>('title')
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc')

  const [select, toggleSelect] = useBoolean(false)
  const [selectedBookIds, { add, has, toggle, reset }] = useSet<string>()

  const { groups } = useReaderSnapshot()

  useEffect(() => {
    if (!select) reset()
  }, [reset, select])

  const sortedBooks = useMemo(
    () => sortBooks(books ?? [], sortField, sortDirection),
    [books, sortDirection, sortField],
  )

  if (groups.length) return null
  if (!books) return null

  const allSelected = selectedBookIds.size === books.length

  return (
    <DropZone
      className="scroll-parent h-full p-4"
      onDrop={(e) => {
        const bookId = e.dataTransfer.getData('text/plain')
        const book = books.find((b) => b.id === bookId)
        if (book) reader.addTab(book)

        handleFiles(e.dataTransfer.files)
      }}
    >
      <div className="mb-4 space-y-2.5">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            {!!books.length && !select && (
              <>
                <Select
                  value={sortField}
                  onChange={(e) => setSortField(e.target.value as SortField)}
                >
                  {sortFieldOptions.map((field) => (
                    <option key={field} value={field}>
                      {t(`sort.${field}`)}
                    </option>
                  ))}
                </Select>
                <Select
                  value={sortDirection}
                  onChange={(e) =>
                    setSortDirection(e.target.value as SortDirection)
                  }
                >
                  <option value="asc">{t('sort.asc')}</option>
                  <option value="desc">{t('sort.desc')}</option>
                </Select>
              </>
            )}
            {!!books.length && (
              <Button variant="secondary" onClick={toggleSelect}>
                {t(select ? 'cancel' : 'select')}
              </Button>
            )}
            {select &&
              (allSelected ? (
                <Button variant="secondary" onClick={reset}>
                  {t('deselect_all')}
                </Button>
              ) : (
                <Button
                  variant="secondary"
                  onClick={() => books.forEach((b) => add(b.id))}
                >
                  {t('select_all')}
                </Button>
              ))}
          </div>

          <div className="space-x-2">
            {select ? (
              <Button
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
              <>
                <Button
                  variant="secondary"
                  disabled={!books.length}
                  onClick={pack}
                >
                  {t('export')}
                </Button>
                <Button className="relative">
                  <input
                    type="file"
                    accept="application/epub+zip,application/epub,application/zip"
                    className="absolute inset-0 cursor-pointer opacity-0"
                    onChange={(e) => {
                      const files = e.target.files
                      if (files) handleFiles(files)
                    }}
                    multiple
                  />
                  {t('import')}
                </Button>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="scroll h-full">
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
}
const Book: React.FC<BookProps> = ({
  book,
  covers,
  select,
  selected,
  toggle,
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
