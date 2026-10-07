import type { Page } from '@playwright/test'

import type { Reader } from '../../src/models/reader/model'

// Passed to page.evaluate: keep browser-side reads self-contained and return only copied values.
export function captureReaderTabStates(scope: 'focused' | 'all') {
  const reader: Reader = window.reader
  const tabs = scope === 'all' ? reader.tabs : [reader.focusedBookTab]
  return tabs.map((tab) => {
    const location = tab?.paginationSnapshot?.location
    return {
      id: tab?.id,
      tabId: tab?.id,
      bookId: tab?.book.id,
      rendered: !!tab?.rendered,
      turning: !!tab?.turning,
      atEnd: !!location?.atEnd,
      footerPercentage: tab?.paginationSnapshot?.percentage,
      header: tab?.paginationSnapshot?.headerPath?.map((item) => item.label ?? '').join(' '),
      bookCfi: tab?.book.cfi,
      currentTarget: tab?.getCurrentDisplayTarget(),
      renditionStartCfi: tab?.rendition?.location?.start?.cfi,
      renditionEndCfi: tab?.rendition?.location?.end?.cfi,
      rejectedLocationEventCount: tab?.rejectedLocationEventCount ?? 0,
      startCfi: location?.start?.cfi,
      endCfi: location?.end?.cfi,
      startIndex: location?.start?.index,
      endIndex: location?.end?.index,
      visibleSectionIndexes: [...(tab?.visibleSectionIndexes ?? [])] as readonly number[],
    } as const
  })
}

export async function readFocusedTabState(page: Page) {
  const [state] = await page.evaluate(captureReaderTabStates, 'focused' as const)
  if (!state) throw new Error('Missing focused reader snapshot')
  return state
}

export async function readAllBookTabStates(
  page: Page,
): Promise<readonly ReturnType<typeof captureReaderTabStates>[number][]> {
  return page.evaluate(captureReaderTabStates, 'all' as const)
}
