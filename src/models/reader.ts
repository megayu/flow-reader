import { debounce } from '@github/mini-throttle/decorators'
import { IS_SERVER } from '@literal-ui/hooks'
import React from 'react'
import { proxy, ref, snapshot, useSnapshot } from 'valtio'

import ePub, { Rendition as EpubRendition } from '@flow/epubjs'
import type { Rendition, Location, Book } from '@flow/epubjs'
import Navigation, { NavItem } from '@flow/epubjs/types/navigation'
import Section from '@flow/epubjs/types/section'

import { AnnotationColor, AnnotationType } from '../annotation'
import {
  BookRecord,
  ReadingSpreadPageRecord,
  ReadingSpreadRecord,
  db,
} from '../db'
import { createId } from '../id'
import { BodyTextDetectionCache, defaultStyle } from '../styles'

import { dfs, find, INode } from './tree'

function updateIndex(array: any[], deletedItemIndex: number) {
  const last = array.length - 1
  return deletedItemIndex > last ? last : deletedItemIndex
}

export function compareHref(
  sectionHref: string | undefined,
  navitemHref: string | undefined,
) {
  if (sectionHref && navitemHref) {
    const [target] = navitemHref.split('#')

    return (
      sectionHref.endsWith(target!) ||
      // fix for relative nav path `../Text/example.html`
      target?.endsWith(sectionHref)
    )
  }
}

function compareDefinition(d1: string, d2: string) {
  return d1.toLowerCase() === d2.toLowerCase()
}

function isReadingPositionOnlyUpdate(changes: Partial<BookRecord>) {
  const keys = Object.keys(changes)
  return (
    keys.some((key) => key === 'cfi' || key === 'percentage') &&
    keys.every((key) =>
      ['cfi', 'percentage', 'updatedAt', 'lastReadAt'].includes(key),
    )
  )
}

function displayLocationPercentage(location?: Location['end']) {
  const percentage = location?.percentage
  if (typeof percentage !== 'number' || !Number.isFinite(percentage)) return
  if (percentage < 0 || percentage > 1) return
  return percentage
}

function estimatePercentageFromSpine(
  location: Location['end'],
  sectionCount: number,
) {
  if (!sectionCount) return 0

  const sectionIndex = Math.max(0, Math.min(location.index, sectionCount - 1))
  const totalPages = Math.max(1, location.displayed.total || 1)
  const page = Math.max(1, Math.min(location.displayed.page || 1, totalPages))
  const sectionProgress = page / totalPages

  return Math.max(
    0,
    Math.min(1, (sectionIndex + sectionProgress) / sectionCount),
  )
}

function calculateReadingPercentage({
  location,
  sections,
  totalLength,
}: {
  location: Location
  sections: ISection[]
  totalLength?: number
}) {
  if (location.atStart) return 0
  if (location.atEnd) return 1

  const end = location.end ?? location.start
  const sectionIndex = sections.findIndex((s) => s.href === end.href)
  const activeSection = sectionIndex >= 0 ? sections[sectionIndex] : undefined

  if (activeSection && totalLength && activeSection.length) {
    const previousSectionsLength = sections
      .slice(0, sectionIndex)
      .reduce((acc, s) => acc + s.length, 0)
    const previousSectionsPercentage = previousSectionsLength / totalLength
    const currentSectionPercentage = activeSection.length / totalLength
    const displayedPercentage =
      end.displayed.total > 0 ? end.displayed.page / end.displayed.total : 0

    return Math.max(
      0,
      Math.min(
        1,
        previousSectionsPercentage +
          currentSectionPercentage * displayedPercentage,
      ),
    )
  }

  const estimated = estimatePercentageFromSpine(end, sections.length)
  if (estimated > 0) return estimated

  return displayLocationPercentage(end) ?? 0
}

export interface INavItem extends NavItem, INode {
  subitems?: INavItem[]
}

export interface IMatch extends INode {
  excerpt: string
  description?: string
  cfi?: string
  subitems?: IMatch[]
}

export interface ISection extends Section {
  length: number
  images: string[]
  navitem?: INavItem
}

interface SectionNavIndex {
  nav: Navigation
  sections: ISection[]
  exactBySectionHref: Map<string, INavItem>
  entries: Array<{
    item: INavItem
    order: number
    sectionIndex: number
  }>
}

function snapshotReflowablePage(
  page: any,
): ReadingSpreadPageRecord | undefined {
  if (
    !page?.section ||
    typeof page.section.index !== 'number' ||
    typeof page.pageIndex !== 'number'
  ) {
    return
  }

  return {
    sectionIndex: page.section.index,
    pageIndex: page.pageIndex,
  }
}

function snapshotReflowableSpread(
  manager: any,
  layoutStyleSignature?: string,
): ReadingSpreadRecord | undefined {
  const spread = manager?.currentReflowableSpread
  if (!manager?.canUseLogicalReflowableSpread?.() || !spread) return

  const left = snapshotReflowablePage(spread.left)
  const right = snapshotReflowablePage(spread.right)
  const page = left ?? right
  if (!page) return

  return {
    ...page,
    version: 1,
    anchor: left ? 'left' : 'right',
    ...(layoutStyleSignature ? { layoutStyleSignature } : {}),
  }
}

function hydrateReflowablePage(
  page: ReadingSpreadPageRecord | undefined,
  sections: ISection[] | undefined,
) {
  if (!page || !sections) return
  const section = sections.find(
    (candidate) => candidate.index === page.sectionIndex,
  )
  if (!section) return

  return {
    section,
    pageIndex: page.pageIndex,
  }
}

function hydrateReflowableSpread(
  spread: ReadingSpreadRecord | undefined,
  sections: ISection[] | undefined,
  layoutStyleSignature?: string,
) {
  if (!spread || spread.version !== 1 || !sections) return
  if (
    spread.layoutStyleSignature &&
    spread.layoutStyleSignature !== layoutStyleSignature
  ) {
    return
  }

  const page = hydrateReflowablePage(spread, sections)
  if (!page) return

  return spread.anchor === 'right'
    ? {
        exact: true,
        anchor: 'right',
        right: page,
      }
    : {
        left: page,
        anchor: 'left',
      }
}

function mergeConfigurationWithSpread(
  configuration: BookRecord['configuration'],
  spread: ReadingSpreadRecord | undefined,
) {
  const next = { ...(configuration ?? {}) }

  if (spread) {
    next.spread = spread
  } else {
    delete next.spread
  }

  return next
}

class BaseTab {
  constructor(public readonly id: string, public readonly title = id) {}

  get isBook(): boolean {
    return this instanceof BookTab
  }

  get isPage(): boolean {
    return this instanceof PageTab
  }
}

// https://github.com/pmndrs/valtio/blob/92f3311f7f1a9fe2a22096cd30f9174b860488ed/src/vanilla.ts#L6
type AsRef = { $$valtioRef: true }

export class BookTab extends BaseTab {
  epub?: Book
  iframe?: Window & AsRef
  iframes: (Window & AsRef)[] = []
  rendition?: Rendition & { manager?: any }
  nav?: Navigation
  locationsToReturn: Location[] = []
  section?: ISection
  sections?: ISection[]
  results?: IMatch[]
  activeResultID?: string
  bodyTextCache: BodyTextDetectionCache = ref(new Map())
  rendered = false
  turning = false
  private sectionInfoPromises = new Map<number, Promise<void>>()
  private pendingBookUpdate?: Partial<BookRecord>
  private pendingBookUpdateTimer?: ReturnType<typeof setTimeout>
  private destroyPromise?: Promise<void>
  private navigationPromise?: Promise<void>
  private renderGeneration = 0
  private sectionNavIndex?: SectionNavIndex
  private currentSpreadState?: ReadingSpreadRecord

  get container() {
    return this?.rendition?.manager?.container as HTMLDivElement | undefined
  }

  currentLocation?: Location
  get location() {
    return this.currentLocation
  }
  get locationToReturn() {
    return this.locationsToReturn[this.locationsToReturn.length - 1]
  }

  display(target?: string, returnable = true) {
    this.rendition?.display(target)
    if (returnable) this.showPrevLocation()
  }
  async pageIndexForCfi(sectionIndex: number, cfi: string) {
    const section = this.sections?.find((s) => s.index === sectionIndex)
    const manager = this.rendition?.manager
    if (!section || !manager?.reflowablePageForTarget) return 0

    const page = await manager.reflowablePageForTarget(section, cfi)
    return page?.pageIndex ?? 0
  }
  async displayReflowableTarget(sectionIndex: number, cfi: string) {
    const section = this.sections?.find((s) => s.index === sectionIndex)
    const manager = this.rendition?.manager

    if (section && manager?.canUseLogicalReflowableSpread?.()) {
      await manager.displayReflowableTarget(section, cfi)
      await this.rendition?.reportLocation()
      return
    }

    this.display(cfi, false)
  }
  async displaySectionStart(section: ISection) {
    return this.displayTarget(section)
  }
  async displayTarget(section: ISection, target?: string) {
    const manager = this.rendition?.manager

    if (
      manager?.canUseLogicalReflowableSpread?.() &&
      manager.reflowablePageForTarget &&
      manager.reflowableSpreadFromLeft &&
      manager.renderReflowableSpread
    ) {
      const page = await manager.reflowablePageForTarget(section, target)
      const spread = await manager.reflowableSpreadFromLeft(page)
      if (spread) {
        await manager.renderReflowableSpread(spread)
        await this.rendition?.reportLocation()
        return
      }
    }

    this.display(target ?? section.href, false)
  }

  async displayFromSelector(
    selector: string,
    section: ISection,
    returnable = true,
  ) {
    try {
      await this.ensureSectionInfo(section)
      const el = section.document.querySelector(selector)
      if (el) {
        const cfi = section.cfiFromElement(el)
        if (returnable) this.showPrevLocation()
        await this.displayTarget(section, cfi)
      } else {
        await this.displaySectionStart(section)
      }
    } catch (err) {
      this.display(section.href, returnable)
    }
  }
  async prev() {
    if (this.turning) return

    return this.runNavigation(async () => {
      await this.rendition?.prev()
      // avoid content flash
      if (
        !this.rendition?.manager?.canUseLogicalReflowableSpread?.() &&
        this.container?.scrollLeft === 0 &&
        !this.location?.atStart
      ) {
        this.rendered = false
      }
    })
  }
  async next() {
    if (this.turning) return

    return this.runNavigation(async () => {
      await this.rendition?.next()
    })
  }
  private sectionPositionFromLocation(
    location?: Pick<Location['start'], 'index' | 'href'>,
  ) {
    if (!this.sections || !location) return -1

    return this.sections.findIndex(
      (section) =>
        section.index === location.index || section.href === location.href,
    )
  }
  private async navigateSection(direction: -1 | 1) {
    if (this.turning || !this.sections?.length || !this.location) return

    const location = direction > 0 ? this.location.end : this.location.start
    const currentPosition = this.sectionPositionFromLocation(location)
    if (currentPosition === -1) return

    const target = this.sections[currentPosition + direction]
    if (!target) return

    return this.runNavigation(async () => {
      await this.displaySectionStart(target)
    })
  }
  prevSection() {
    return this.navigateSection(-1)
  }
  nextSection() {
    return this.navigateSection(1)
  }

  updateBook(changes: Partial<BookRecord>) {
    changes = {
      ...changes,
      updatedAt: Date.now(),
    }
    // don't wait promise resolve to make valtio batch updates
    this.book = { ...this.book, ...changes }
    db.books.remember(this.book)

    if (isReadingPositionOnlyUpdate(changes)) {
      void db.books.update(this.book.id, changes).catch((error) => {
        console.error(error)
      })
      return
    }

    this.flushPendingBookUpdate()
    void db.books.update(this.book.id, changes).catch((error) => {
      console.error(error)
    })
  }

  private schedulePendingBookUpdate() {
    if (this.pendingBookUpdateTimer) return

    this.pendingBookUpdateTimer = setTimeout(() => {
      this.flushPendingBookUpdate()
    }, 15_000)
  }

  flushPendingBookUpdate({ flushStorage = true } = {}) {
    if (this.pendingBookUpdateTimer) {
      clearTimeout(this.pendingBookUpdateTimer)
      this.pendingBookUpdateTimer = undefined
    }

    const changes = this.pendingBookUpdate
    if (!changes) return Promise.resolve()

    this.pendingBookUpdate = undefined
    return db.books
      .update(this.book.id, changes)
      .then(() => {
        if (flushStorage) return db.flush()
      })
      .catch((error) => {
        console.error(error)
      })
  }

  private createCurrentPositionUpdate(): Partial<BookRecord> | undefined {
    if (!this.currentLocation || !this.sections) return

    const percentage = calculateReadingPercentage({
      location: this.currentLocation,
      sections: this.sections,
      totalLength: this.totalLength,
    })

    return {
      cfi: this.currentLocation.start.cfi,
      percentage,
      configuration: mergeConfigurationWithSpread(
        this.book.configuration,
        this.currentSpreadState,
      ),
    }
  }

  async flushForClose({ flushStorage = true } = {}) {
    try {
      await this.navigationPromise
    } catch (error) {
      console.error(error)
    }

    const positionUpdate = this.createCurrentPositionUpdate()
    if (positionUpdate) {
      const changes = {
        ...positionUpdate,
        updatedAt: Date.now(),
      }
      this.book = { ...this.book, ...changes }
      db.books.remember(this.book)
      await db.books.update(this.book.id, changes)
    }

    await this.flushPendingBookUpdate({ flushStorage: false })
    if (flushStorage) await db.flush()
  }

  private async runNavigation(action: () => Promise<void>) {
    if (this.turning) return

    this.turning = true
    const navigation = (async () => {
      try {
        await action()
      } finally {
        this.turning = false
      }
    })()

    this.navigationPromise = navigation
    try {
      await navigation
    } finally {
      if (this.navigationPromise === navigation) {
        this.navigationPromise = undefined
      }
    }
  }

  annotationRange?: Range
  annotationCfi?: string
  setAnnotationRange(cfi: string) {
    const range = this.view?.contents.range(cfi)
    if (range) {
      this.annotationRange = ref(range)
      this.annotationCfi = cfi
    }
  }

  define(def: string[]) {
    this.updateBook({ definitions: [...this.book.definitions, ...def] })
  }
  undefine(def: string) {
    this.updateBook({
      definitions: this.book.definitions.filter(
        (d) => !compareDefinition(d, def),
      ),
    })
  }
  isDefined(def: string) {
    return this.book.definitions.some((d) => compareDefinition(d, def))
  }

  rangeToCfi(range: Range) {
    const doc =
      range.commonAncestorContainer.ownerDocument ??
      (range.commonAncestorContainer as Document)
    const win = doc.defaultView
    const view = this.viewForWindow(win) ?? this.view
    if (!view) throw new Error('No active view for selected range')
    return view.contents.cfiFromRange(range)
  }
  putAnnotation(
    type: AnnotationType,
    cfi: string,
    color: AnnotationColor,
    text: string,
    notes?: string,
  ) {
    const spine = this.section
    if (!spine?.navitem) return

    const i = this.book.annotations.findIndex((a) => a.cfi === cfi)
    let annotation = this.book.annotations[i]

    const now = Date.now()
    if (!annotation) {
      annotation = {
        id: createId(),
        bookId: this.book.id,
        cfi,
        spine: {
          index: spine.index,
          title: spine.navitem.label,
        },
        createAt: now,
        updatedAt: now,
        type,
        color,
        notes,
        text,
      }

      this.updateBook({
        // DataCloneError: Failed to execute 'put' on 'IDBObjectStore': #<Object> could not be cloned.
        annotations: [...snapshot(this.book.annotations), annotation],
      })
    } else {
      annotation = {
        ...this.book.annotations[i]!,
        type,
        updatedAt: now,
        color,
        notes,
        text,
      }
      this.book.annotations.splice(i, 1, annotation)
      this.updateBook({
        annotations: [...snapshot(this.book.annotations)],
      })
    }
  }
  removeAnnotation(cfi: string) {
    return this.updateBook({
      annotations: snapshot(this.book.annotations).filter((a) => a.cfi !== cfi),
    })
  }

  keyword = ''
  setKeyword(keyword: string) {
    if (this.keyword === keyword) return
    this.keyword = keyword
    this.onKeywordChange()
  }

  // only use throttle/debounce for side effects
  @debounce(1000)
  async onKeywordChange() {
    this.results = await this.search()
  }

  get totalLength() {
    return this.sections?.reduce((acc, s) => acc + s.length, 0) ?? 0
  }

  toggle(id: string) {
    const item = find(this.nav?.toc, id) as INavItem
    if (item) item.expanded = !item.expanded
  }

  toggleNavItem(target: Pick<INavItem, 'id' | 'href'> & Partial<INavItem>) {
    if ('expanded' in target) {
      target.expanded = !target.expanded
      return
    }

    const item = this.findNavItem(target)
    if (item) item.expanded = !item.expanded
  }

  findNavItem(
    target: Pick<INavItem, 'id' | 'href'>,
    nodes = this.nav?.toc,
  ): INavItem | undefined {
    if (!target.id && !target.href) return
    if (!nodes) return

    for (const item of nodes as INavItem[]) {
      if (target.id ? item.id === target.id : item.href === target.href) {
        return item
      }

      const child = this.findNavItem(target, item.subitems)
      if (child) return child
    }
  }

  toggleResult(id: string) {
    const item = find(this.results, id)
    if (item) item.expanded = !item.expanded
  }

  showPrevLocation() {
    if (this.location) {
      this.locationsToReturn.push(this.location)
    }
  }

  returnToPreviousLocation() {
    const location = this.locationsToReturn.pop()
    if (!location) return false

    this.display(location.end.cfi, false)
    return true
  }

  returnToFirstLocation() {
    const location = this.locationsToReturn[0]
    if (!location) return false

    this.locationsToReturn = []
    this.display(location.end.cfi, false)
    return true
  }

  hidePrevLocation(all = true) {
    if (all) {
      this.locationsToReturn = []
    } else {
      this.locationsToReturn.pop()
    }
  }

  private getSectionNavIndex(sections = this.sections) {
    if (!this.nav || !sections) return
    if (
      this.sectionNavIndex?.nav === this.nav &&
      this.sectionNavIndex.sections === sections
    ) {
      return this.sectionNavIndex
    }

    const exactBySectionHref = new Map<string, INavItem>()
    const entries: SectionNavIndex['entries'] = []
    let order = 0

    this.nav.toc.forEach((item) =>
      dfs(item as INavItem, (navItem) => {
        const matchedSection = sections.find((section) =>
          compareHref(section.href, navItem.href),
        )

        if (matchedSection) {
          exactBySectionHref.set(
            matchedSection.href,
            exactBySectionHref.get(matchedSection.href) ?? navItem,
          )
          entries.push({
            item: navItem,
            order,
            sectionIndex: matchedSection.index,
          })
        }

        order++
      }),
    )

    entries.sort((a, b) => a.sectionIndex - b.sectionIndex || a.order - b.order)
    this.sectionNavIndex = {
      nav: this.nav,
      sections,
      exactBySectionHref,
      entries,
    }

    return this.sectionNavIndex
  }

  mapSectionToNavItem(sectionHref: string, sections = this.sections) {
    if (!sectionHref || !sections) return

    const index = this.getSectionNavIndex(sections)
    const section = sections.find(
      (s) => s.href === sectionHref || compareHref(s.href, sectionHref),
    )
    if (!section || !index) return

    const exact = index.exactBySectionHref.get(section.href)
    if (exact) return exact

    for (let i = index.entries.length - 1; i >= 0; i--) {
      const entry = index.entries[i]!
      if (entry.sectionIndex <= section.index) {
        return entry.item
      }
    }
  }

  get currentHref() {
    return this.location?.start.href
  }

  get currentSection() {
    const index = this.location?.start.index
    return (
      this.sections?.find((s) => s.index === index) ??
      this.sections?.find((s) => s.href === this.currentHref) ??
      this.section
    )
  }

  get currentNavItem() {
    return (
      this.currentSection?.navitem ??
      (this.currentHref
        ? this.mapSectionToNavItem(this.currentHref)
        : undefined)
    )
  }

  get currentSectionHeading() {
    const heading = this.currentSection?.document.querySelector(
      'h1, h2, h3, h4, h5, h6',
    )
    return heading?.textContent?.trim()
  }

  getHeaderPath() {
    const path = this.getNavPath()
    const heading = this.currentSectionHeading

    if (!heading) return path
    if (!path.length) return [{ id: heading, label: heading } as INavItem]

    const last = path[path.length - 1]
    if (last?.label === heading) return path

    return [
      ...path.slice(0, -1),
      {
        ...last,
        id: last?.id ?? heading,
        label: heading,
      } as INavItem,
    ]
  }

  get view() {
    return (
      this.rendition?.manager?.current?.() ??
      this.rendition?.manager?.views._views[0]
    )
  }

  viewForWindow(win: Window | null) {
    return this.rendition?.manager?.views._views.find(
      (view: any) => view.window === win,
    )
  }

  syncFrames() {
    const views = this.rendition?.manager?.views?._views ?? []
    const windows: Window[] = views
      .map((view: any) => view.window as Window | undefined)
      .filter((win: Window | undefined): win is Window => !!win)
    const sameFrames =
      windows.length === this.iframes.length &&
      windows.every((win, index) => this.iframes[index] === win)

    if (sameFrames) return

    const iframes = windows.map((win: Window) => ref(win) as Window & AsRef)

    this.iframes = iframes
    this.iframe = iframes[0]
  }

  destroy() {
    if (this.destroyPromise) return this.destroyPromise

    this.destroyPromise = this.destroyAfterFlush()
    return this.destroyPromise
  }

  private async destroyAfterFlush() {
    this.renderGeneration++

    try {
      await this.flushForClose()
    } catch (error) {
      console.error(error)
    } finally {
      this.destroyRendering()
    }
  }

  private destroyRendering() {
    try {
      this.rendition?.destroy?.()
    } catch (error) {
      console.error(error)
    }

    try {
      ;(this.epub as any)?.destroy?.()
    } catch (error) {
      console.error(error)
    }

    this.epub = undefined
    this.iframe = undefined
    this.iframes = []
    this.rendition = undefined
    this.section = undefined
    this.sections = undefined
    this.sectionNavIndex = undefined
    this.rendered = false
    this._el = undefined
    this.renderingEl = undefined
    this.sectionInfoPromises.clear()
    this.bodyTextCache = ref(new Map())
  }

  getNavPath(navItem = this.currentNavItem) {
    const path: INavItem[] = []

    if (this.nav) {
      while (navItem) {
        path.unshift(navItem)
        const parentId = navItem.parent
        if (!parentId) {
          navItem = undefined
        } else {
          const index = this.nav.tocById[parentId]!
          navItem = this.nav.getByIndex(parentId, index, this.nav.toc)
        }
      }
    }

    return path
  }

  expandNavPath(navItem = this.currentNavItem) {
    const path = this.getNavPath(navItem)

    path.slice(0, -1).forEach((item) => {
      item.expanded = true
    })
  }

  searchInSection(keyword = this.keyword, section = this.section) {
    if (!section) return

    const subitems = section.find(keyword) as unknown as IMatch[]
    if (!subitems.length) return

    const navItem = section.navitem
    if (navItem) {
      const path = this.getNavPath(navItem)
      path.pop()
      return {
        id: navItem.href,
        excerpt: navItem.label,
        description: path.map((i) => i.label).join(' / '),
        subitems: subitems.map((i) => ({ ...i, id: i.cfi! })),
        expanded: true,
      }
    }
  }

  async searchInSectionAsync(keyword = this.keyword, section = this.section) {
    if (!section) return

    await this.ensureSectionInfo(section)
    return this.searchInSection(keyword, section)
  }

  search(keyword = this.keyword) {
    // avoid blocking input
    return new Promise<IMatch[] | undefined>((resolve) => {
      requestIdleCallback(async () => {
        if (!keyword) {
          resolve(undefined)
          return
        }

        const results: IMatch[] = []

        // The callback itself is idle, but each section is still loaded
        // sequentially to avoid the old all-spine load spike.
        for (const s of this.sections ?? []) {
          const result = await this.searchInSectionAsync(keyword, s)
          if (result) results.push(result)
        }

        resolve(results)
      })
    })
  }

  private assignSectionNavItem(section: ISection, sections = this.sections) {
    const navitem = this.mapSectionToNavItem(section.href, sections)
    if (navitem) section.navitem = navitem
  }

  async ensureSectionInfo(section: ISection) {
    if (!this.epub) return

    if (section.document?.body && section.length !== undefined) {
      this.assignSectionNavItem(section)
      return
    }

    const index = section.index ?? this.sections?.indexOf(section) ?? -1
    const cached = this.sectionInfoPromises.get(index)
    if (cached) return cached

    const promise = Promise.resolve(
      section.load(this.epub.load.bind(this.epub)),
    )
      .then(() => {
        section.length = section.document?.body?.textContent?.length ?? 0
        section.images = [
          ...(section.document?.querySelectorAll('img') ?? []),
        ].map((el) => el.src)
        this.assignSectionNavItem(section)
      })
      .catch((error) => {
        console.error('Failed to load section info', error)
      })

    if (index >= 0) this.sectionInfoPromises.set(index, promise)
    return promise
  }

  private _el?: HTMLDivElement
  private renderingEl?: HTMLDivElement
  onBeforeLayout?: (contents?: any) => void
  private layoutStyleSignature?: string

  setBeforeLayout(
    beforeLayout?: (contents?: any) => void,
    layoutStyleSignature?: string,
  ) {
    if (beforeLayout) {
      this.onBeforeLayout = beforeLayout
    }
    if (layoutStyleSignature !== undefined) {
      this.layoutStyleSignature = layoutStyleSignature
    }

    const manager = this.rendition?.manager
    if (!manager) return

    manager.viewSettings ??= {}
    manager.viewSettings.layoutStyleSignature = this.layoutStyleSignature
    manager.viewSettings.beforeLayout = (contents: any) => {
      this.onBeforeLayout?.(contents)
    }
  }

  resetLayoutPageState() {
    const manager = this.rendition?.manager
    if (!manager) return

    manager.reflowablePageCountCache = {}
    manager.currentReflowableSpread = undefined
  }

  private async displayInitialPosition() {
    const manager = this.rendition?.manager
    const spread = hydrateReflowableSpread(
      this.book.configuration?.spread,
      this.sections,
      this.layoutStyleSignature,
    )

    if (
      spread &&
      manager?.canUseLogicalReflowableSpread?.() &&
      manager.renderReflowableSpread
    ) {
      await manager.renderReflowableSpread(spread)
      await this.rendition?.reportLocation()
      return
    }

    await this.rendition?.display(
      this.location?.start.cfi ?? this.book.cfi ?? undefined,
    )
  }

  async render(
    el: HTMLDivElement,
    initialSpread?: string,
    beforeLayout?: (contents?: any) => void,
    layoutStyleSignature?: string,
  ) {
    this.setBeforeLayout(beforeLayout, layoutStyleSignature)
    if (el === this._el) return
    if (el === this.renderingEl) return
    if (el.getBoundingClientRect().width === 0) return

    this.renderingEl = ref(el)
    const generation = ++this.renderGeneration
    const clearRendering = () => {
      if (el === this.renderingEl) this.renderingEl = undefined
    }

    const loadedBook = await db.books.get(this.book.id)
    if (generation !== this.renderGeneration) {
      clearRendering()
      return
    }
    if (loadedBook) {
      this.book = loadedBook
    }

    const fileUrl = await db.files.getPackageUrl(this.book.id)
    if (generation !== this.renderGeneration) {
      clearRendering()
      return
    }
    if (!fileUrl) {
      clearRendering()
      return
    }

    let epub: Book
    try {
      epub = ref(await ePub(fileUrl))
    } catch (error) {
      console.error(error)
      clearRendering()
      return
    }

    if (generation !== this.renderGeneration) {
      try {
        ;(epub as any)?.destroy?.()
      } catch (error) {
        console.error(error)
      }
      clearRendering()
      return
    }

    if (el.getBoundingClientRect().width === 0) {
      try {
        ;(epub as any)?.destroy?.()
      } catch (error) {
        console.error(error)
      }
      clearRendering()
      return
    }

    let rendition: Rendition
    try {
      rendition = ref(
        new EpubRendition(epub, {
          width: '100%',
          height: '100%',
          allowScriptedContent: true,
        }),
      )
      ;(epub as any).rendition = rendition
      await rendition.attachTo(el)
    } catch (error) {
      console.error(error)
      try {
        ;(epub as any)?.destroy?.()
      } catch (destroyError) {
        console.error(destroyError)
      }
      clearRendering()
      return
    }

    if (generation !== this.renderGeneration) {
      try {
        ;(rendition as any)?.destroy?.()
        ;(epub as any)?.destroy?.()
      } catch (error) {
        console.error(error)
      }
      clearRendering()
      return
    }

    this.epub = epub
    this.rendition = rendition
    this._el = ref(el)
    clearRendering()
    this.epub.loaded.navigation.then((nav) => {
      if (generation !== this.renderGeneration) return
      this.nav = nav
    })
    try {
      const spine = await this.epub.loaded.spine
      if (generation !== this.renderGeneration) return
      const sections = (spine as any).spineItems as ISection[]
      sections.forEach((s) => {
        s.length ??= 0
        s.images ??= []
      })
      this.sections = ref(sections)
    } catch (error) {
      if (generation === this.renderGeneration) {
        console.error(error)
      }
      return
    }
    this.setBeforeLayout()
    this.rendition.themes.default(defaultStyle)
    this.rendition.hooks.render.register(() => {
      this.syncFrames()
    })
    if (initialSpread) {
      this.rendition.spread(initialSpread)
    }

    this.rendition.on('relocated', (loc: Location) => {
      this.syncFrames()
      this.currentLocation = loc
      this.currentSpreadState = snapshotReflowableSpread(
        this.rendition?.manager,
        this.layoutStyleSignature,
      )

      // calculate percentage
      if (this.sections) {
        const start = loc.start
        const end = loc.end ?? loc.start
        const activeSection =
          this.sections.find((s) => s.index === start.index) ??
          this.sections.find((s) => s.href === start.href) ??
          this.section
        if (activeSection) this.section = ref(activeSection)
        const activeNavItem =
          activeSection?.navitem ?? this.mapSectionToNavItem(start.href)
        if (activeSection && activeNavItem) {
          activeSection.navitem = activeNavItem
        }
        this.expandNavPath(activeNavItem)

        if (!this.sections.some((s) => s.href === end.href)) {
          this.rendered = true
          return
        }

        const percentage = calculateReadingPercentage({
          location: loc,
          sections: this.sections,
          totalLength: this.totalLength,
        })
        this.updateBook({ cfi: loc.start.cfi, percentage })
      }

      this.rendered = true
    })

    this.rendition.on('rendered', (section: ISection) => {
      if (!this.section) this.section = ref(section)
      void this.ensureSectionInfo(section)
      this.syncFrames()
    })
    this.rendition.on('removed', () => {
      this.syncFrames()
    })

    try {
      await this.displayInitialPosition()
    } catch (error) {
      if (generation === this.renderGeneration) {
        console.error(error)
      }
    }
  }

  constructor(public book: BookRecord) {
    super(book.id, book.name)

    // don't subscribe `db.books` in `constructor`, it will
    // 1. update the unproxied instance, which is not reactive
    // 2. update unnecessary state (e.g. percentage) of all tabs with the same book
  }
}

class PageTab extends BaseTab {
  constructor(public readonly Component: React.FC<any>) {
    super(Component.displayName ?? 'untitled')
  }
}

type Tab = BookTab | PageTab
type TabParam = ConstructorParameters<typeof BookTab | typeof PageTab>[0]

function resolveTabParam(param: TabParam | Tab) {
  if (param instanceof BookTab || param instanceof PageTab) return param
  if (typeof param === 'function') return param

  return db.books.peek(param.id) ?? param
}

function disposeTab(tab?: Tab) {
  if (tab instanceof BookTab) return tab.destroy()
  return Promise.resolve()
}

export class Group {
  id = createId()
  tabs: Tab[] = []

  constructor(
    tabs: Array<Tab | TabParam> = [],
    public selectedIndex = tabs.length - 1,
  ) {
    this.tabs = tabs.map((tabParam) => {
      const t = resolveTabParam(tabParam)
      if (t instanceof BookTab || t instanceof PageTab) return t
      const isPage = typeof t === 'function'
      return isPage ? new PageTab(t) : new BookTab(t)
    })
  }

  get selectedTab() {
    return this.tabs[this.selectedIndex]
  }

  get bookTabs() {
    return this.tabs.filter((t) => t instanceof BookTab) as BookTab[]
  }

  removeTab(index: number) {
    const tab = this.tabs.splice(index, 1)
    this.selectedIndex = updateIndex(this.tabs, index)
    return tab[0]
  }

  addTab(param: TabParam | Tab) {
    const resolved = resolveTabParam(param)
    const isTab = resolved instanceof BookTab || resolved instanceof PageTab
    const isPage = typeof resolved === 'function'

    const id = isTab ? resolved.id : isPage ? resolved.displayName : resolved.id

    const index = this.tabs.findIndex((t) => t.id === id)
    if (index > -1) {
      this.selectTab(index)
      return this.tabs[index]
    }

    const tab = isTab
      ? resolved
      : isPage
      ? new PageTab(resolved)
      : new BookTab(resolved)

    this.tabs.splice(++this.selectedIndex, 0, tab)
    return tab
  }

  replaceTab(param: TabParam, index = this.selectedIndex) {
    this.addTab(param)
    this.removeTab(index)
  }

  selectTab(index: number) {
    if (index < 0 || index >= this.tabs.length) return

    this.selectedIndex = index
  }

  selectLastTab() {
    this.selectTab(this.tabs.length - 1)
  }

  selectAdjacentTab(delta: -1 | 1, loop = false) {
    if (!this.tabs.length) return

    let index = this.selectedIndex + delta

    if (loop) {
      index = (index + this.tabs.length) % this.tabs.length
    }

    this.selectTab(index)
  }
}

export class Reader {
  groups: Group[] = []
  focusedIndex = -1
  private pendingDisposals = new Set<Promise<unknown>>()

  get focusedGroup() {
    return this.groups[this.focusedIndex]
  }

  get focusedTab() {
    return this.focusedGroup?.selectedTab
  }

  get focusedBookTab() {
    return this.focusedTab instanceof BookTab ? this.focusedTab : undefined
  }

  addTab(param: TabParam | Tab, groupIdx = this.focusedIndex) {
    let group = this.groups[groupIdx]
    if (group) {
      this.focusedIndex = groupIdx
    } else {
      group = this.addGroup([])
    }
    return group.addTab(param)
  }

  removeTab(index: number, groupIdx = this.focusedIndex) {
    const group = this.groups[groupIdx]
    if (group?.tabs.length === 1) {
      const tab = group.tabs[0]
      this.removeGroup(groupIdx)
      this.trackDisposal(disposeTab(tab))
      return tab
    }
    const tab = group?.removeTab(index)
    this.trackDisposal(disposeTab(tab))
    return tab
  }

  closeFocusedTab() {
    const group = this.focusedGroup
    if (!group) return

    return this.removeTab(group.selectedIndex, this.focusedIndex)
  }

  closeAllTabs() {
    this.clear()
  }

  selectFocusedTab(index: number) {
    this.focusedGroup?.selectTab(index)
  }

  selectLastFocusedTab() {
    this.focusedGroup?.selectLastTab()
  }

  selectAdjacentFocusedTab(delta: -1 | 1, loop = false) {
    this.focusedGroup?.selectAdjacentTab(delta, loop)
  }

  replaceTab(
    param: TabParam,
    index = this.focusedIndex,
    groupIdx = this.focusedIndex,
  ) {
    const group = this.groups[groupIdx]
    group?.replaceTab(param, index)
  }

  removeGroup(index: number) {
    this.groups.splice(index, 1)
    this.focusedIndex = updateIndex(this.groups, index)
  }

  addGroup(tabs: Array<Tab | TabParam>, index = this.focusedIndex + 1) {
    const group = proxy(new Group(tabs))
    this.groups.splice(index, 0, group)
    this.focusedIndex = index
    return group
  }

  selectGroup(index: number) {
    this.focusedIndex = index
  }

  clear() {
    this.groups.forEach(({ tabs }) =>
      tabs.forEach((tab) => this.trackDisposal(disposeTab(tab))),
    )
    this.groups = []
    this.focusedIndex = -1
  }

  resize() {
    this.groups.forEach(({ bookTabs }) => {
      bookTabs.forEach(({ rendition }) => {
        try {
          rendition?.resize()
        } catch (error) {
          console.error(error)
        }
      })
    })
  }

  flushPendingBookUpdates() {
    return Promise.all([
      ...Array.from(this.pendingDisposals),
      ...this.groups.flatMap(({ bookTabs }) =>
        bookTabs.map((tab) => tab.flushForClose({ flushStorage: false })),
      ),
    ]).then(() => db.flush())
  }

  private trackDisposal(promise: Promise<unknown>) {
    const tracked = promise.finally(() => {
      this.pendingDisposals.delete(tracked)
    })

    this.pendingDisposals.add(tracked)
    return tracked
  }
}

export const reader = proxy(new Reader())

export function useReaderSnapshot() {
  return useSnapshot(reader)
}

declare global {
  interface Window {
    reader: Reader
  }
}

if (!IS_SERVER) {
  window.reader = reader
}
