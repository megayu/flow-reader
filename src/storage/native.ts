import { type Channel, convertFileSrc, invoke as invokeNative } from '@tauri-apps/api/core'

import type { Settings } from '../settings/configuration'
import type { SettingsBootstrap, TextImportRuleKind } from '../settings/sync'

import type {
  BookCacheClearProgress,
  BookExportFormat,
  BookImageIndexCache,
  BookImportProgress,
  BookImportResult,
  BookModeSwitchConflict,
  BookModeSwitchResolution,
  BookModeSwitchResult,
  BookReaderSource,
  BookRecord,
  BookSearchResult,
  BookSourceStatusRecord,
  BookStateCheckpointInput,
  BookTextReplaceResult,
  BookTextReplaceTarget,
  CoverRecord,
  FolderImportCandidate,
  FolderImportTagAssignment,
  FolderImportTagResult,
  LibraryPins,
  LibraryTagRecord,
  ReadingStatus,
  TextImportEncodingOption,
  TextImportPreview,
  TextImportSelection,
} from './types'

interface NativeBookReaderPreparation {
  mode: BookReaderSource['mode']
  path: string
  rootPath?: string
  updatedBook?: BookRecord
  readingMetrics?: BookReaderSource['readingMetrics']
}

type ImportProgressChannel = Channel<Omit<BookImportProgress, 'importId'>>

// Keep the wire contract next to the only storage invoke boundary. These types
// are erased at build time; native commands still own validation and failures.
interface StorageCommands {
  apply_folder_import_tags(args: { assignments: FolderImportTagAssignment[] }): FolderImportTagResult
  cancel_book_text_search(args: { requestId: string }): void
  check_book_source_statuses(args: { ids: string[] }): BookSourceStatusRecord[]
  check_book_content_mode_switch(args: { id: string; editable: boolean }): BookModeSwitchConflict | null
  clear_book_caches(args: {
    discardUnexportedEdits: boolean
    preservedUnpackedBookIds: string[]
    onProgress: Channel<BookCacheClearProgress>
  }): BookRecord[]
  cleanup_external_book(args: { id: string }): void
  create_tag(args: { name: string }): LibraryTagRecord | null
  delete_books(args: { ids: string[] }): void
  delete_tags(args: { ids: string[] }): BookRecord[]
  export_book(args: { id: string; format: BookExportFormat; outputPath: string }): BookRecord | null
  flush_settings(): void
  get_book(args: { id: string }): BookRecord | null
  get_book_word_count(args: { id: string }): number
  get_book_reader_source(args: { id: string }): NativeBookReaderPreparation
  get_library_pins(): LibraryPins
  get_recent_book_ids(): string[]
  get_settings(): SettingsBootstrap
  get_text_import_encodings(): TextImportEncodingOption[]
  import_epub_paths(args: { paths: string[]; onProgress: ImportProgressChannel }): BookImportResult
  import_text_paths(args: {
    imports: TextImportSelection[]
    copySourceFiles?: boolean
    onProgress: ImportProgressChannel
  }): BookImportResult
  list_books(): BookRecord[]
  list_covers(args: { ids: string[] | null }): CoverRecord[]
  list_tags(): LibraryTagRecord[]
  merge_tags(args: { ids: string[]; targetId?: string; targetName?: string }): {
    tag: LibraryTagRecord
    books: BookRecord[]
  }
  load_book_image_index(args: { id: string }): BookImageIndexCache
  open_book_directory(args: { id: string }): void
  open_external_epub_paths(args: { paths: string[] }): BookImportResult
  preview_text_import_paths(args: { paths: string[]; encodings: Record<string, string> }): TextImportPreview[]
  persist_book_state(args: { checkpoint: BookStateCheckpointInput; flush: boolean }): void
  replace_book_text(args: {
    id: string
    target: BookTextReplaceTarget
    oldText: string
    newText: string
  }): BookTextReplaceResult
  reset_text_import_rule(args: { kind: TextImportRuleKind }): void
  reveal_book_source(args: { id: string }): boolean
  reveal_exported_file(args: { path: string }): void
  scan_import_folder(args: { root: string; recursive: boolean }): FolderImportCandidate[]
  set_book_cache_active(args: { id: string; active: boolean }): void
  switch_book_content_mode(args: {
    id: string
    editable: boolean
    resolution?: BookModeSwitchResolution
  }): BookModeSwitchResult
  update_book(args: { id: string; changes: Pick<BookRecord, 'metadata'> & { updatedAt?: number } }): CoverRecord | null
  update_book_reading_status(args: { ids: string[]; readingStatus: ReadingStatus | null }): void
  update_book_tags(args: { ids: string[]; addTagIds: string[]; removeTagIds: string[] }): BookRecord[]
  update_library_pin(args: { kind: 'author' | 'tag'; id: string; pinned: boolean }): LibraryPins
  update_settings(args: { settings: Settings; flush: boolean }): void
  update_tag(args: { id: string; name: string }): LibraryTagRecord | null
}

export type StorageCommand = keyof StorageCommands | 'search_book_text'

export function invokeStorage<K extends keyof StorageCommands>(
  command: K,
  ...args: Parameters<StorageCommands[K]>
): Promise<ReturnType<StorageCommands[K]>>
// The native search command returns excerpts only when positions are supplied.
export function invokeStorage(
  command: 'search_book_text',
  args: { id: string; query: { keyword: string; positions: [number, number][] } },
): Promise<string[]>
export function invokeStorage(
  command: 'search_book_text',
  args: {
    id: string
    query: { keyword: string; limit?: number; positions?: never }
    request?: { id: string; onStarted: Channel<null> }
  },
): Promise<BookSearchResult[]>
export async function invokeStorage(command: StorageCommand, args?: unknown): Promise<unknown> {
  if (typeof window === 'undefined') {
    throw new Error('Native storage is not available on the server')
  }

  try {
    return await invokeNative<unknown>(command, args as Record<string, unknown> | undefined)
  } catch (error) {
    if (import.meta.env.DEV) {
      console.error('[Flow Reader] Native storage command failed', { command }, error)
    }
    throw error
  }
}

export function storagePathToUrl(path: string) {
  if (path.startsWith('http://epub.localhost/') || path.startsWith('epub://localhost/')) {
    return path
  }
  try {
    return convertFileSrc(path.replace(/\\/g, '/'))
  } catch {
    return path
  }
}
