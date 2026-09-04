import { debounce } from '@github/mini-throttle/decorators'

import { searchBookText } from '../../storage'

import type { BookTab, IMatch } from './model'

export class BookSearchController {
  private requestVersion = 0
  private pending?: AbortController

  cancel() {
    this.nextRequestVersion()
  }

  setKeyword(tab: BookTab, keyword: string) {
    const requestVersion = this.nextRequestVersion()
    this.onKeywordChange(tab, keyword, requestVersion)
  }

  async searchImmediately(tab: BookTab, keyword: string) {
    if (tab.keyword !== keyword) {
      tab.keyword = keyword
      tab.activeResultID = undefined
    }
    tab.results = undefined
    const requestVersion = this.nextRequestVersion()
    await this.updateResults(tab, keyword, requestVersion)
  }

  // only use throttle/debounce for side effects
  @debounce(500)
  private async onKeywordChange(tab: BookTab, keyword: string, requestVersion: number) {
    if (this.requestVersion !== requestVersion) return
    tab.keyword = keyword
    tab.results = undefined
    tab.activeResultID = undefined
    await this.updateResults(tab, keyword, requestVersion)
  }

  private nextRequestVersion() {
    this.pending?.abort()
    this.pending = undefined
    return ++this.requestVersion
  }

  private isCurrent(tab: BookTab, keyword: string, requestVersion: number) {
    return tab.keyword === keyword && this.requestVersion === requestVersion
  }

  private async updateResults(tab: BookTab, keyword: string, requestVersion: number) {
    const controller = new AbortController()
    this.pending = controller
    try {
      const results = await searchBook(tab, keyword, controller.signal)
      if (this.isCurrent(tab, keyword, requestVersion)) {
        tab.results = results
      }
    } catch (error) {
      console.error('Failed to update book search results', error)
      if (this.isCurrent(tab, keyword, requestVersion)) {
        tab.results = []
      }
    } finally {
      if (this.pending === controller) this.pending = undefined
    }
  }
}

export function searchInSection(tab: BookTab, keyword = tab.keyword, section = tab.section) {
  const query = keyword.trim()
  if (!query || !section?.document?.body) return

  const subitems = section.find(query) as unknown as IMatch[]
  if (!subitems.length) return

  const navItem = section.navitem
  const path = navItem ? tab.getNavPath(navItem) : []
  path.pop()

  return {
    id: navItem?.href ?? section.href,
    excerpt: navItem?.label ?? section.href,
    ...(navItem ? { description: path.map((item) => item.label).join(' / ') } : {}),
    subitems: subitems.map((item) => ({ ...item, id: item.cfi! })),
    expanded: true,
  }
}

export async function searchInSectionAsync(tab: BookTab, keyword = tab.keyword, section = tab.section) {
  if (!section) return

  await tab.ensureSectionInfo(section)
  return searchInSection(tab, keyword, section)
}

export async function searchBook(tab: BookTab, keyword = tab.keyword, signal?: AbortSignal) {
  if (!keyword.trim()) return undefined

  try {
    return (await searchBookText(tab.book.id, keyword, undefined, signal)) as IMatch[]
  } catch (error) {
    console.error(error)
    return []
  }
}

export async function displaySearchResult(
  tab: BookTab,
  result: IMatch,
  keyword = tab.keyword,
  sectionContext?: Pick<IMatch, 'sectionIndex' | 'href'>,
) {
  const sectionIndex = result.sectionIndex ?? sectionContext?.sectionIndex
  const href = result.href ?? sectionContext?.href
  if (result.cfi) {
    const section =
      tab.sections?.find((item) => item.index === sectionIndex) ?? tab.sections?.find((item) => item.href === href)

    if (section) {
      await tab.displayTarget(section, result.cfi, { returnable: true })
    } else {
      tab.display(result.cfi)
    }
    return
  }

  const section =
    tab.sections?.find((item) => item.index === sectionIndex) ?? tab.sections?.find((item) => item.href === href)

  if (!section) {
    if (href) tab.display(href)
    return
  }

  try {
    await tab.ensureSectionInfo(section)
    const cfi = section.findOccurrence(keyword, result.occurrence ?? 0)
    if (cfi) {
      result.cfi = cfi
      await tab.displayTarget(section, cfi, { returnable: true })
      return
    }
  } catch (error) {
    console.error(error)
  }

  await tab.displaySectionStart(section, true)
}
