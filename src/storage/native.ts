import { convertFileSrc, invoke as invokeNative } from '@tauri-apps/api/core'

export const storageCommand = {
  applyFolderImportTags: 'apply_folder_import_tags',
  checkBookSourceStatuses: 'check_book_source_statuses',
  checkBookContentModeSwitch: 'check_book_content_mode_switch',
  clearBookCaches: 'clear_book_caches',
  cleanupExternalBook: 'cleanup_external_book',
  createTag: 'create_tag',
  deleteBooks: 'delete_books',
  deleteTags: 'delete_tags',
  exportBook: 'export_book',
  flushSettings: 'flush_settings',
  getBook: 'get_book',
  getBookReaderSource: 'get_book_reader_source',
  getLibraryPins: 'get_library_pins',
  getRecentBookIds: 'get_recent_book_ids',
  getSettings: 'get_settings',
  getTextImportEncodings: 'get_text_import_encodings',
  importEpubPaths: 'import_epub_paths',
  importTextPaths: 'import_text_paths',
  listBooks: 'list_books',
  listCovers: 'list_covers',
  listTags: 'list_tags',
  mergeTags: 'merge_tags',
  loadBookImageIndex: 'load_book_image_index',
  openBookDirectory: 'open_book_directory',
  openExternalEpubPaths: 'open_external_epub_paths',
  previewTextImportPaths: 'preview_text_import_paths',
  persistBookOnClose: 'persist_book_on_close',
  persistBookState: 'persist_book_state',
  replaceBookText: 'replace_book_text',
  resetTextImportRule: 'reset_text_import_rule',
  revealBookSource: 'reveal_book_source',
  revealExportedFile: 'reveal_exported_file',
  scanImportFolder: 'scan_import_folder',
  searchBookText: 'search_book_text',
  setBookCacheActive: 'set_book_cache_active',
  switchBookContentMode: 'switch_book_content_mode',
  updateBook: 'update_book',
  updateBookReadingStatus: 'update_book_reading_status',
  updateBookTags: 'update_book_tags',
  updateLibraryPin: 'update_library_pin',
  updateSettings: 'update_settings',
  updateTag: 'update_tag',
} as const

export type StorageCommand = (typeof storageCommand)[keyof typeof storageCommand]

export async function invokeStorage<T>(command: StorageCommand, args?: Record<string, unknown>) {
  if (typeof window === 'undefined') {
    throw new Error('Native storage is not available on the server')
  }

  return invokeNative<T>(command, args)
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
