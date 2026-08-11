import type { PackagingMetadataObject } from '@flow/epubjs/packaging'

import type { Annotation } from '../annotation'
import type { TypographyConfiguration } from '../reader/configuration'

export interface CoverRecord {
  id: string
  cover: string | null
}

export interface TextImportEncodingOption {
  id: string
  label: string
}

export interface TextImportChapterPreview {
  title: string
  level: number
  role: 'group' | 'chapter'
}

export interface TextImportPreview {
  path: string
  filename: string
  title: string
  creator?: string
  encoding: string
  encodingLabel: string
  confidence: 'high' | 'medium' | 'low' | 'failed'
  status: 'ready' | 'needsReview' | 'error' | 'skipped'
  selected: boolean
  message?: string | null
  sample: string
  chapters: TextImportChapterPreview[]
}

export interface TextImportSelection {
  path: string
  encoding?: string
  title?: string
  creator?: string
}

export type BookSourceFormat = 'epub' | 'txt'
export type BookExportFormat = 'epub' | 'txt'
export type BookSourceStorage = 'managed' | 'referenced'
export type BookSourceStatus = 'available' | 'changed' | 'missing' | 'unreadable'
export type BookContentMode = 'normal' | 'archiveOnly'
export interface BookReaderSource {
  mode: 'opf' | 'epub'
  url: string
  rootUrl?: string
}

export interface BookTextReplaceTarget {
  sectionHref: string
  textNodeIndex: number
  textNodeText: string
  startOffset: number
  endOffset: number
  paragraphIndex?: number
}

export interface BookTextReplaceResult {
  book: BookRecord
  sectionHref: string
  changed: boolean
}

export interface ReadingSpreadPageRecord {
  sectionIndex: number
  pageIndex: number
}

export interface ReadingSpreadRecord extends ReadingSpreadPageRecord {
  version: 1
  anchor: 'left' | 'right'
  exact?: boolean
  left?: ReadingSpreadPageRecord
  right?: ReadingSpreadPageRecord
  endsAtSectionEnd?: boolean
  layoutStyleSignature?: string
}

export type ReadingStatus = 'toRead' | 'reading' | 'read'

export interface LibraryTagRecord {
  id: string
  name: string
  createdAt: number
  updatedAt?: number
}

export interface LibraryPins {
  authors: string[]
  tagIds: string[]
}

export interface BookRecord {
  id: string
  name: string
  size: number
  scope?: 'library' | 'external'
  readingStatus?: ReadingStatus | null
  sourceFormat: BookSourceFormat
  generatedCover: boolean
  contentEditedAt?: number
  metadata: PackagingMetadataObject
  createdAt: number
  updatedAt?: number
  lastReadAt?: number
  cfi?: string
  percentage?: number
  tagIds?: string[]
  definitions: string[]
  annotations: Annotation[]
  configuration?: {
    typography?: TypographyConfiguration
    spread?: ReadingSpreadRecord
  }
  contentHash?: string
  contentVersion?: number
  contentMode?: BookContentMode
  sourceStorage?: BookSourceStorage
  sourcePath?: string
  stateLoaded?: boolean
}

export interface BookSourceStatusRecord {
  id: string
  status: BookSourceStatus
}

export interface BookImportFailure {
  path: string
  filename: string
  error: string
}

export interface BookImportResult {
  books: BookRecord[]
  failures: BookImportFailure[]
}

export interface BookImportProgress {
  importId: string
  total: number
  completed: number
  imported: number
  failed: number
  book?: BookRecord | null
  cover?: CoverRecord | null
}

export interface FolderImportCandidate {
  path: string
  format: BookSourceFormat
  rootDirectory: string | null
  intermediateDirectories: string[]
  directDirectory: string | null
}

export interface FolderImportTagAssignment {
  bookId: string
  tagNames: string[]
}

export interface FolderImportTagResult {
  books: BookRecord[]
  tags: LibraryTagRecord[]
}

export interface BookCacheClearProgress {
  total: number
  completed: number
}

export interface ReadingPositionInput {
  bookId: string
  cfi?: string
  percentage?: number
  spread?: ReadingSpreadRecord | null
  lastReadAt: number
}

export interface BookSearchHit {
  id: string
  excerpt: string
  cfi?: string | null
  occurrence: number
}

export interface BookSearchResult {
  id: string
  excerpt: string
  description?: string | null
  sectionIndex: number
  subitems: BookSearchHit[]
  expanded: boolean
}

export type ImageFilterReason = 'decorative' | 'duplicate' | 'icon' | 'inlineGlyph' | 'titleArt'

export interface BookImageIndexEntry {
  src: string
  index: number
  hiddenByDefault: boolean
  reason?: ImageFilterReason | null
}

export interface BookImageIndexSection {
  sectionIndex: number
  href: string
  images: BookImageIndexEntry[]
}

export interface BookImageIndexCache {
  version: number
  contentVersion: number
  sections: BookImageIndexSection[]
}
