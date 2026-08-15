import { invoke } from '@tauri-apps/api/core'

import type { AnnotationExportFormat } from './annotationExport'
import { getBookDisplayTitle } from './book'
import type { BookRecord } from './storage'

export async function saveAnnotationExport(book: BookRecord, format: AnnotationExportFormat, contents: string) {
  const { save } = await import('@tauri-apps/plugin-dialog')
  const outputPath = await save({
    defaultPath: annotationExportDefaultPath(book, format),
    filters: [
      format === 'markdown' ? { name: 'Markdown', extensions: ['md'] } : { name: 'JSON', extensions: ['json'] },
    ],
  })
  if (!outputPath) return

  await invoke('write_annotation_export', { outputPath, contents })
  return outputPath
}

function annotationExportDefaultPath(book: BookRecord, format: AnnotationExportFormat) {
  const extension = format === 'markdown' ? 'md' : 'json'
  const title = sanitizeFilename(getBookDisplayTitle(book)) || 'annotations'
  const separatorIndex = Math.max(book.sourcePath.lastIndexOf('/'), book.sourcePath.lastIndexOf('\\'))
  const directory = separatorIndex >= 0 ? book.sourcePath.slice(0, separatorIndex + 1) : ''
  return `${directory}${title}.${extension}`
}

function sanitizeFilename(value: string) {
  return value
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
}
