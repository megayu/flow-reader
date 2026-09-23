import { convertFileSrc, invoke as invokeNative } from '@tauri-apps/api/core'

export type StorageCommand =
  | 'apply_folder_import_tags'
  | 'cancel_book_text_search'
  | 'check_book_source_statuses'
  | 'check_book_content_mode_switch'
  | 'clear_book_caches'
  | 'cleanup_external_book'
  | 'create_tag'
  | 'delete_books'
  | 'delete_tags'
  | 'export_book'
  | 'flush_settings'
  | 'get_book'
  | 'get_book_word_count'
  | 'get_book_reader_source'
  | 'get_library_pins'
  | 'get_recent_book_ids'
  | 'get_settings'
  | 'get_text_import_encodings'
  | 'import_epub_paths'
  | 'import_text_paths'
  | 'list_books'
  | 'list_covers'
  | 'list_tags'
  | 'merge_tags'
  | 'load_book_image_index'
  | 'open_book_directory'
  | 'open_external_epub_paths'
  | 'preview_text_import_paths'
  | 'persist_book_state'
  | 'replace_book_text'
  | 'reset_text_import_rule'
  | 'reveal_book_source'
  | 'reveal_exported_file'
  | 'scan_import_folder'
  | 'search_book_text'
  | 'set_book_cache_active'
  | 'switch_book_content_mode'
  | 'update_book'
  | 'update_book_reading_status'
  | 'update_book_tags'
  | 'update_library_pin'
  | 'update_settings'
  | 'update_tag'

export async function invokeStorage<T>(command: StorageCommand, args?: Record<string, unknown>) {
  if (typeof window === 'undefined') {
    throw new Error('Native storage is not available on the server')
  }

  try {
    return await invokeNative<T>(command, args)
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
