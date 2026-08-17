import type { BookRecord } from '../../src/storage'

type TestBookOverrides = Omit<Partial<BookRecord>, 'metadata'> & {
  metadata?: Partial<BookRecord['metadata']>
}

export function createTestBook({ metadata = {}, ...overrides }: TestBookOverrides = {}): BookRecord {
  return {
    id: 'test-book',
    scope: 'library',
    name: 'Test Book.epub',
    size: 1,
    sourceFormat: 'epub',
    sourceHash: 'test-source-hash',
    sourceRevision: 1,
    revision: 1,
    editable: true,
    sourcePath: 'Test Book.epub',
    generatedCover: false,
    metadata: {
      title: 'Test Book',
      creator: '',
      description: '',
      pubdate: '',
      publisher: '',
      identifier: '',
      language: '',
      rights: '',
      modified_date: '',
      layout: '',
      orientation: '',
      flow: '',
      viewport: '',
      spread: '',
      ...metadata,
    },
    createdAt: 1,
    definitions: [],
    annotations: [],
    ...overrides,
  }
}
