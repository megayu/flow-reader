import { convertFileSrc, invoke as invokeNative } from '@tauri-apps/api/core'

export const storageCommand = {
  checkBookSourceStatuses: 'check_book_source_statuses',
  cleanupAllExternalBooks: 'cleanup_all_external_books',
  cleanupExternalBook: 'cleanup_external_book',
  createTag: 'create_tag',
  deleteBooks: 'delete_books',
  deleteExternalBook: 'delete_external_book',
  deleteTag: 'delete_tag',
  exportBook: 'export_book',
  flushStorage: 'flush_storage',
  getBook: 'get_book',
  getBookPackagePath: 'get_book_package_path',
  getBookReaderSource: 'get_book_reader_source',
  getCover: 'get_cover',
  getSettings: 'get_settings',
  getTextImportEncodings: 'get_text_import_encodings',
  importEpubPaths: 'import_epub_paths',
  importTextPaths: 'import_text_paths',
  listBooks: 'list_books',
  listCovers: 'list_covers',
  listTags: 'list_tags',
  loadBookImageIndex: 'load_book_image_index',
  openBookDirectory: 'open_book_directory',
  openExternalEpubPaths: 'open_external_epub_paths',
  previewTextImportPaths: 'preview_text_import_paths',
  recordReadingPosition: 'record_reading_position',
  replaceBookText: 'replace_book_text',
  revealBookSource: 'reveal_book_source',
  revealExportedFile: 'reveal_exported_file',
  searchBookText: 'search_book_text',
  storeBookImageIndex: 'store_book_image_index',
  unloadBookSearchText: 'unload_book_search_text',
  updateBook: 'update_book',
  updateBookTags: 'update_book_tags',
  updateCover: 'update_cover',
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

export async function storagePathToUrl(path: string) {
  try {
    return convertFileSrc(path.replace(/\\/g, '/'))
  } catch {
    return path
  }
}
