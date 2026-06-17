import { v4 as uuidv4 } from 'uuid'

import ePub, { Book } from '@flow/epubjs'

import { unpack } from './backup'
import { BookRecord, db } from './db'
import { mapExtToMimes } from './mime'

export async function fileToEpub(file: File) {
  const data = await file.arrayBuffer()
  return ePub(data)
}

export async function handleFiles(files: Iterable<File>) {
  const books = await db?.books.toArray()
  const newBooks = []

  for (const file of files) {
    console.log(file)

    if (mapExtToMimes['.zip'].includes(file.type)) {
      unpack(file)
      continue
    }

    if (!mapExtToMimes['.epub'].includes(file.type)) {
      console.error(`Unsupported file type: ${file.type}`)
      continue
    }

    let book = books?.find((b) => b.name === file.name)

    if (!book) {
      book = await addBook(file)
    } else {
      await ensureBookCover(book, file)
    }

    newBooks.push(book)
  }

  return newBooks
}

export async function addBook(file: File) {
  const epub = await fileToEpub(file)
  const metadata = await epub.loaded.metadata

  const book: BookRecord = {
    id: uuidv4(),
    name: file.name || `${metadata.title}.epub`,
    size: file.size,
    metadata,
    createdAt: Date.now(),
    definitions: [],
    annotations: [],
  }
  db?.books.add(book)
  await addFile(book.id, file, epub, book)
  return book
}

export async function addFile(
  id: string,
  file: File,
  epub?: Book,
  book?: CoverBook,
) {
  await db?.files.put({ id, file })
  await ensureBookCover(book ?? { id }, file, epub)
}

export async function ensureBookCover(
  book: CoverBook,
  file?: File,
  epub?: Book,
) {
  const existing = await db?.covers.get(book.id)
  if (existing?.cover) return existing.cover

  if (!epub) {
    const record = file ? undefined : await db?.files.get(book.id)
    file = file ?? record?.file
    if (!file) return null

    epub = await fileToEpub(file)
  }

  const url = await epub.coverUrl()
  let cover = url ? await toDataUrl(url).catch(() => null) : null

  if (!cover) {
    const metadata = book.metadata ?? (await epub.loaded.metadata)
    cover = createTextCover(metadata, book.name ?? file?.name)
  }

  await db?.covers.put({ id: book.id, cover })
  return cover
}

export function readBlob(fn: (reader: FileReader) => void) {
  return new Promise<string>((resolve) => {
    const reader = new FileReader()
    reader.addEventListener('load', () => {
      resolve(reader.result as string)
    })
    fn(reader)
  })
}

async function toDataUrl(url: string) {
  const res = await fetch(url)
  const buffer = await res.blob()
  return readBlob((r) => r.readAsDataURL(buffer))
}

type CoverBook = Pick<BookRecord, 'id'> &
  Partial<Pick<BookRecord, 'name' | 'metadata'>>

function createTextCover(
  metadata?: Partial<BookRecord['metadata']>,
  filename?: string,
) {
  const title = cleanText(metadata?.title) || stripFileExtension(filename) || ''
  const creator = cleanText(metadata?.creator)

  const titleLines = wrapCoverText(title, creator ? 9 : 8, creator ? 3 : 4)
  const titleSize = titleLines.length > 2 ? 92 : 112
  const titleLineHeight = titleSize * 1.28
  const creatorSize = 72
  const creatorLineHeight = 86
  const creatorLines = creator ? wrapCoverText(creator, 10, 2) : []
  const contentHeight =
    titleLines.length * titleLineHeight +
    (creatorLines.length ? 72 + creatorLines.length * creatorLineHeight : 0)
  let y = 512 - contentHeight / 2 + titleSize

  const titleSvg = titleLines
    .map((line) => {
      const text = svgText(line)
      const node = `<text x="384" y="${Math.round(
        y,
      )}" text-anchor="middle" font-size="${titleSize}" font-weight="800">${text}</text>`
      y += titleLineHeight
      return node
    })
    .join('')

  y += creatorLines.length ? 72 : 0

  const creatorSvg = creatorLines
    .map((line) => {
      const text = svgText(line)
      const node = `<text x="384" y="${Math.round(
        y,
      )}" text-anchor="middle" font-size="${creatorSize}" font-weight="700">${text}</text>`
      y += creatorLineHeight
      return node
    })
    .join('')

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 768 1024">
  <rect width="768" height="1024" fill="#ead7b5"/>
  <g fill="#3d3122" font-family="Noto Serif CJK SC, Source Han Serif SC, STSong, SimSun, serif" dominant-baseline="alphabetic">
    ${titleSvg}
    ${creatorSvg}
  </g>
</svg>`

  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

function cleanText(value?: string) {
  return value?.replace(/\s+/g, ' ').trim() ?? ''
}

function stripFileExtension(filename?: string) {
  return cleanText(filename).replace(/\.[^.]+$/, '')
}

function wrapCoverText(
  text: string,
  maxUnitsPerLine: number,
  maxLines: number,
) {
  const chars = [...text]
  const lines: string[] = []
  let line = ''
  let units = 0

  chars.forEach((char) => {
    const width = char.charCodeAt(0) <= 0xff ? 0.55 : 1
    if (line && units + width > maxUnitsPerLine) {
      lines.push(line)
      line = char
      units = width
      return
    }

    line += char
    units += width
  })

  if (line) lines.push(line)

  if (lines.length <= maxLines) return lines

  const visible = lines.slice(0, maxLines)
  visible[maxLines - 1] = `${visible[maxLines - 1]!.replace(/…+$/, '')}…`
  return visible
}

function svgText(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

export async function fetchBook(url: string) {
  const filename = decodeURIComponent(/\/([^/]*\.epub)$/i.exec(url)?.[1] ?? '')
  const books = await db?.books.toArray()
  const book = books?.find((b) => b.name === filename)

  return (
    book ??
    fetch(url)
      .then((res) => res.blob())
      .then((blob) => addBook(new File([blob], filename)))
  )
}
