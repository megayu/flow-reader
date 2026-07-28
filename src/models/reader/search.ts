import { debounce } from '@github/mini-throttle/decorators'

import { searchBookText } from '../../storage'

import type { BookTab, IMatch } from './model'

export class BookSearchController {
  private requestVersion = 0

  setKeyword(tab: BookTab, keyword: string) {
    if (tab.keyword === keyword) return
    tab.keyword = keyword
    tab.activeResultID = undefined
    const requestVersion = this.nextRequestVersion()
    this.onKeywordChange(tab, keyword, requestVersion)
  }

  async searchImmediately(tab: BookTab, keyword: string) {
    if (tab.keyword !== keyword) {
      tab.keyword = keyword
      tab.activeResultID = undefined
    }
    const requestVersion = this.nextRequestVersion()
    await this.updateResults(tab, keyword, requestVersion)
  }

  // only use throttle/debounce for side effects
  @debounce(500)
  private async onKeywordChange(
    tab: BookTab,
    keyword: string,
    requestVersion: number,
  ) {
    if (!this.isCurrent(tab, keyword, requestVersion)) return
    await this.updateResults(tab, keyword, requestVersion)
  }

  private nextRequestVersion() {
    return ++this.requestVersion
  }

  private isCurrent(tab: BookTab, keyword: string, requestVersion: number) {
    return tab.keyword === keyword && this.requestVersion === requestVersion
  }

  private async updateResults(
    tab: BookTab,
    keyword: string,
    requestVersion: number,
  ) {
    const results = await searchBook(tab, keyword)
    if (this.isCurrent(tab, keyword, requestVersion)) {
      tab.results = results
    }
  }
}

export function searchInSection(
  tab: BookTab,
  keyword = tab.keyword,
  section = tab.section,
) {
  const query = keyword.trim()
  if (!query || !section?.document?.body) return

  const subitems = section.find(query) as unknown as IMatch[]
  if (!subitems.length) return

  const navItem = section.navitem
  if (navItem) {
    const path = tab.getNavPath(navItem)
    path.pop()
    return {
      id: navItem.href,
      excerpt: navItem.label,
      description: path.map((item) => item.label).join(' / '),
      subitems: subitems.map((item) => ({ ...item, id: item.cfi! })),
      expanded: true,
    }
  }
}

export async function searchInSectionAsync(
  tab: BookTab,
  keyword = tab.keyword,
  section = tab.section,
) {
  if (!section) return

  await tab.ensureSectionInfo(section)
  return searchInSection(tab, keyword, section)
}

export async function searchBook(tab: BookTab, keyword = tab.keyword) {
  if (!keyword.trim()) return undefined

  try {
    return (await searchBookText(tab.book.id, keyword)) as IMatch[]
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
      tab.sections?.find((item) => item.index === sectionIndex) ??
      tab.sections?.find((item) => item.href === href)

    if (section) {
      tab.showPrevLocation()
      await tab.displayTarget(section, result.cfi)
    } else {
      tab.display(result.cfi)
    }
    return
  }

  const section =
    tab.sections?.find((item) => item.index === sectionIndex) ??
    tab.sections?.find((item) => item.href === href)

  if (!section) {
    if (href) tab.display(href)
    return
  }

  try {
    await tab.ensureSectionInfo(section)
    const matches = section.find(keyword) as Array<{ cfi?: string }>
    const match = matches[result.occurrence ?? 0] ?? matches[0]
    if (match?.cfi) {
      result.cfi = match.cfi
      tab.showPrevLocation()
      await tab.displayTarget(section, match.cfi)
      return
    }
  } catch (error) {
    console.error(error)
  }

  tab.showPrevLocation()
  await tab.displaySectionStart(section)
}
