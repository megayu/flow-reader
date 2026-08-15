import {
  type Annotation,
  type AnnotationColor,
  annotationColorIcons,
  annotationColors,
  getAnnotationSpineTitle,
} from './annotation'
import {
  type AnnotationFilterValue,
  type AnnotationNoteFilter,
  createDefaultAnnotationFilter,
  filterAnnotations,
} from './annotationFilter'
import { cleanBookText, getBookDisplayTitle } from './book'
import { createFlowReaderDeepLink } from './deepLink'
import type { BookRecord } from './storage'

export type AnnotationExportFormat = 'json' | 'markdown'

export interface AnnotationExport {
  schemaVersion: 1
  format: 'flow-reader.annotations'
  exportedAt: number
  book: {
    title: string
    author?: string
    contentHash: string
    sourceFormat: BookRecord['sourceFormat']
  }
  selection: {
    colors: AnnotationColor[]
    notes: AnnotationNoteFilter
  }
  annotations: Annotation[]
}

export function createAnnotationExport(
  book: BookRecord,
  annotations: readonly Annotation[],
  compareCfi: (left: string, right: string) => number,
  exportedAt = Date.now(),
  filter: AnnotationFilterValue = createDefaultAnnotationFilter(),
): AnnotationExport {
  const author = cleanBookText(book.metadata.creator)

  return {
    schemaVersion: 1,
    format: 'flow-reader.annotations',
    exportedAt,
    book: {
      title: getBookDisplayTitle(book),
      ...(author ? { author } : {}),
      contentHash: book.contentHash,
      sourceFormat: book.sourceFormat,
    },
    selection: {
      colors: annotationColors.filter((color) => filter.colors.has(color)),
      notes: filter.notes,
    },
    annotations: sortAnnotationsInReadingOrder(filterAnnotations(annotations, filter), compareCfi),
  }
}

export function sortAnnotationsInReadingOrder(
  annotations: readonly Annotation[],
  compareCfi: (left: string, right: string) => number,
) {
  return [...annotations].sort((left, right) => left.spine.index - right.spine.index || compareCfi(left.cfi, right.cfi))
}

export function serializeAnnotationsAsJson(exported: AnnotationExport) {
  return `${JSON.stringify(exported, null, 2)}\n`
}

export function serializeAnnotationsAsMarkdown(exported: AnnotationExport, deepLinkBookId?: string) {
  const blocks = [`# ${escapeMarkdownText(exported.book.title)}`]

  if (exported.book.author) {
    blocks.push(`*${escapeMarkdownText(exported.book.author)}*`)
  }

  let sectionIndex: number | undefined
  for (const annotation of exported.annotations) {
    if (annotation.spine.index !== sectionIndex) {
      sectionIndex = annotation.spine.index
      blocks.push(`## ${escapeMarkdownText(getAnnotationSpineTitle(annotation.spine))}`)
    }

    const icon = annotationColorIcons[annotation.color]
    const linkedIcon = deepLinkBookId
      ? `[${icon}](${createFlowReaderDeepLink({ bookId: deepLinkBookId, cfi: annotation.cfi })})`
      : icon
    blocks.push(quotePlainText(annotation.text, linkedIcon))

    if (annotation.notes?.trim()) {
      blocks.push(formatNoteMarkdown(annotation.notes))
    }
  }

  return `${blocks.join('\n\n')}\n`
}

function escapeMarkdownText(value: string) {
  return value.replace(/([\\`*_[\]<>])/g, '\\$1')
}

function escapeQuotedText(value: string) {
  return value.replace(/([\\`*_[\]<>])/g, '\\$1').replace(/^(\s*)(#{1,6}\s|>|[-+*]\s|\d+[.)]\s)/, '$1\\$2')
}

function quotePlainText(value: string, icon: string) {
  return value
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line, index) => (line ? `> ${index === 0 ? `${icon} ` : ''}${escapeQuotedText(line)}` : '>'))
    .join('\n')
}

function formatNoteMarkdown(markdown: string) {
  const hasHeading = markdown.split(/\r\n|\r|\n/).some((line) => /^#+ /.test(line.trim()))
  if (!hasHeading) return markdown

  const closingLineBreak = /[\r\n]$/.test(markdown) ? '' : '\n'
  return `\`\`\`\`markdown\n${markdown}${closingLineBreak}\`\`\`\``
}
