import { describe, expect, test } from 'vitest'

import type { Annotation } from '../../src/annotation'
import { createAnnotationExport, serializeAnnotationsAsMarkdown } from '../../src/annotationExport'
import type { BookRecord } from '../../src/storage'

describe('annotation export', () => {
  test('preserves reading order while embedding isolated Markdown notes below their source text', () => {
    const book = {
      id: 'book-id',
      name: 'fallback.epub',
      sourceFormat: 'epub',
      sourceHash: 'book-hash',
      metadata: {
        title: 'Book *Title*',
        creator: 'Author_Name',
      },
    } as BookRecord
    const annotations: Annotation[] = [
      annotation({
        cfi: 'epubcfi(/6/4!/4/8)',
        color: 'blue',
        notes: '# Later note\n\n```js\nconst later = true',
        spine: { index: 2, href: 'second.xhtml', title: 'Repeated chapter' },
        text: 'Later *source*',
      }),
      annotation({
        cfi: 'epubcfi(/6/2!/4/4)',
        color: 'orange',
        notes: '# Main thought\n\n## Detail\n\n- first\n- second',
        spine: { index: 1, href: 'first.xhtml', title: 'Repeated chapter' },
        text: 'Earlier # source',
      }),
    ]

    const exported = createAnnotationExport(book, annotations, (left, right) => left.localeCompare(right), 123)

    expect(serializeAnnotationsAsMarkdown(exported, book.id)).toBe(`# Book \\*Title\\*

*Author\\_Name*

## Repeated chapter

> [🟠](flow-reader://book-id?cfi=epubcfi%28%2F6%2F2%21%2F4%2F4%29) Earlier # source

\`\`\`\`markdown
# Main thought

## Detail

- first
- second
\`\`\`\`

## Repeated chapter

> [🔵](flow-reader://book-id?cfi=epubcfi%28%2F6%2F4%21%2F4%2F8%29) Later \\*source\\*

\`\`\`\`markdown
# Later note

\`\`\`js
const later = true
\`\`\`\`
`)
    expect(serializeAnnotationsAsMarkdown(exported)).not.toContain('flow-reader://')
  })
})

function annotation(overrides: Partial<Annotation>): Annotation {
  return {
    cfi: 'epubcfi(/6/2!/4/2)',
    spine: { index: 1, href: 'chapter.xhtml', title: 'Chapter' },
    createdAt: 100,
    updatedAt: 200,
    color: 'yellow',
    text: 'Source',
    ...overrides,
  }
}
