import type React from 'react'
import { proxy, ref, snapshot, useSnapshot } from 'valtio'

import type { Book, Contents, Location, Rendition } from '@flow/epubjs'
import ePub, { Rendition as EpubRendition } from '@flow/epubjs'
import type Navigation from '@flow/epubjs/navigation'
import type { NavItem } from '@flow/epubjs/navigation'
import type { RenditionManagerView, RenditionSpread } from '@flow/epubjs/rendition'
import epubRequest from '@flow/epubjs/request'
import type Section from '@flow/epubjs/section'
import { type AnnotationColor, type AnnotationType, createAnnotationSpine } from '@/annotation'
import { getBookDisplayTitle } from '@/book'
import { IS_SERVER } from '@/env'
import { openSupportedExternalUrl } from '@/externalLink'
import { createId } from '@/id'
import { normalizeHrefPath, safeDecodeHref, sameHref } from '@/noteLinks'
import { emitReaderOpenError, type ReaderOpenErrorStage } from '@/reader/errorEvents'
import { isRecentReadingEnabled } from '@/state'
import {
  type BookReaderSource,
  type BookRecord,
  type BookTextReplaceTarget,
  cleanupExternalBook,
  db,
  type ReadingMetrics,
  type ReadingSpreadRecord,
  setBookCacheActive,
} from '@/storage'
import { type BodyTextDetectionCache, defaultStyle } from '@/styles'

import { dfs, find, type INode } from '../tree'

import { BookLayoutTransactionController } from './layoutTransaction'
import { BookNavigationController, displayFromSelector, displayImage, pageIndexForCfi } from './navigation'
import {
  calculateReadingPercentage,
  fallbackReadingPercentage,
  type HeaderPathItem,
  hydrateReflowableSpread,
  type LocationRequestIntent,
  mergeConfigurationWithSpread,
  type PaginationSnapshot,
  type RelocatedEventMeta,
  readingSpreadSectionIndexes,
  type SectionNavAnchorEntry,
  type SectionNavEntry,
  type SectionNavIndex,
  snapshotReflowableSpread,
} from './pagination'
import type { BookPersistenceHost } from './persistence'
import { BookPersistenceController } from './persistence'
import { BookSearchController, displaySearchResult, searchBook, searchInSection, searchInSectionAsync } from './search'

export type { HeaderPathItem, PaginationSnapshot } from './pagination'
export { readingOrderStartSectionIndex } from './pagination'

function updateIndex<T>(array: readonly T[], deletedItemIndex: number) {
  const last = array.length - 1
  return deletedItemIndex > last ? last : deletedItemIndex
}

export function compareHref(sectionHref: string | undefined, navitemHref: string | undefined) {
  return sameHref(sectionHref, navitemHref)
}

function splitHrefTarget(href: string | undefined) {
  const [path = '', hash] = href?.split('#') ?? []
  return { hash, path }
}

function appendUrlQuery(url: string, name: string, value: string | number) {
  if (/^(?:blob|data|javascript):/i.test(url)) return url

  const hashIndex = url.indexOf('#')
  const base = hashIndex >= 0 ? url.slice(0, hashIndex) : url
  const hash = hashIndex >= 0 ? url.slice(hashIndex) : ''
  const joiner = base.includes('?') ? '&' : '?'

  return `${base}${joiner}${name}=${encodeURIComponent(String(value))}${hash}`
}

function documentBody(document: Document) {
  return document.body ?? document.getElementsByTagName('body')[0] ?? document.documentElement
}

function patchTextNode(textNode: Text | undefined, target: BookTextReplaceTarget, oldText: string, newText: string) {
  if (!textNode?.isConnected) return false
  const text = textNode.textContent ?? ''
  if (text !== target.textNodeText) return false
  if (text.slice(target.startOffset, target.endOffset) !== oldText) {
    return false
  }

  const updatedText = text.slice(0, target.startOffset) + newText + text.slice(target.endOffset)
  textNode.textContent = updatedText

  const parent = textNode.parentElement
  const title = parent?.ownerDocument.querySelector('title')
  if (parent?.closest('h1.flow-txt-volume, h2.flow-txt-chapter') && title?.textContent === text) {
    title.textContent = updatedText
  }
  return true
}

function matchingTextNodeInElement(element: Element | undefined, targetText: string) {
  if (!element) return undefined
  const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT)
  const matches: Text[] = []
  let current = walker.nextNode()
  while (current) {
    if ((current.textContent ?? '') === targetText) {
      matches.push(current as Text)
      if (matches.length > 1) return undefined
    }
    current = walker.nextNode()
  }
  return matches[0]
}

function patchDocumentTextNode(
  document: Document | undefined,
  target: BookTextReplaceTarget,
  oldText: string,
  newText: string,
  selectedTextNode?: Text,
) {
  const body = document && documentBody(document)
  const view = document?.defaultView ?? window
  if (!body || !view) return false

  if (selectedTextNode?.ownerDocument === document) {
    if (patchTextNode(selectedTextNode, target, oldText, newText)) return true
  }

  const generatedParagraphs = Array.from(
    body.querySelectorAll<HTMLElement>('[data-flow-body-text="true"] > p, p[data-flow-body-text="true"]'),
  )
  if (target.paragraphIndex !== undefined) {
    const paragraph = generatedParagraphs[target.paragraphIndex]
    const textNode = matchingTextNodeInElement(paragraph, target.textNodeText)
    if (patchTextNode(textNode, target, oldText, newText)) return true
    return false
  } else {
    const heading = body.querySelector<HTMLElement>('h1.flow-txt-volume, h2.flow-txt-chapter')
    const textNode = matchingTextNodeInElement(heading ?? undefined, target.textNodeText)
    if (patchTextNode(textNode, target, oldText, newText)) return true

    if (heading) return false
  }

  const walker = document.createTreeWalker(body, view.NodeFilter.SHOW_TEXT)
  let textNodeIndex = 0
  let current = walker.nextNode()
  while (current) {
    if (textNodeIndex === target.textNodeIndex) {
      return patchTextNode(current as Text, target, oldText, newText)
    }

    textNodeIndex += 1
    current = walker.nextNode()
  }

  return false
}

function markSectionRuntime(section: ISection | undefined) {
  return section ? ref(section) : section
}

function markSectionsRuntime(sections: ISection[]) {
  sections.forEach(markSectionRuntime)
  return ref(sections)
}

function markRuntimeObject<T extends object>(value: T) {
  return ref(value)
}

type RuntimeRef<T extends object> = T & {
  $$valtioSnapshot: T
}

function createRevisionedEpubRequest(revision?: number) {
  if (!revision) return undefined

  return (url: string, type?: string | null, withCredentials?: boolean, headers?: Record<string, string>) =>
    epubRequest(appendUrlQuery(url, 'flowRevision', revision), type, withCredentials, headers)
}

const SECTION_DOCUMENT_HIGH_WATERMARK = 48
const SECTION_DOCUMENT_LOW_WATERMARK = 32
const SECTION_DOCUMENT_TRIM_DELAY_MS = 5000

function compareDefinition(d1: string, d2: string) {
  return d1.toLowerCase() === d2.toLowerCase()
}

export interface INavItem extends NavItem, INode {
  subitems?: INavItem[]
}

export interface IMatch extends INode {
  excerpt: string
  description?: string
  cfi?: string
  sectionIndex?: number
  href?: string
  occurrence?: number
  offset?: number
  subitems?: IMatch[]
}

export interface ISection extends Section {
  imageInfoLoaded?: boolean
  images: ImageEntry[]
  navitem?: INavItem
  resourceAvailable?: boolean
}

export type ImageFilterReason = 'decorative' | 'duplicate' | 'icon' | 'inlineGlyph' | 'titleArt'

export interface ImageEntry {
  hiddenByDefault: boolean
  index: number
  reason?: ImageFilterReason
  src: string
}

export interface BookOverlayState {
  annotations: BookRecord['annotations']
  definitions: BookRecord['definitions']
}

export type BookBeforeLayout = (contents?: Contents, view?: RenditionManagerView) => void

export type BookTypographyConfiguration = NonNullable<BookRecord['configuration']>['typography']

class BaseTab {
  constructor(
    public readonly id: string,
    public readonly title = id,
  ) {}

  get isBook(): boolean {
    return this instanceof BookTab
  }

  get isPage(): boolean {
    return this instanceof PageTab
  }
}

// Frame Windows are runtime-only: the non-enumerable identity and prototype
// accessors keep host objects out of Valtio's enumerable snapshots.
const frameRuntimeIdentity = Symbol('bookTabFrameRuntime')
const frameWindowsByRuntime = new WeakMap<object, readonly Window[]>()
const pendingImportedBooksByRuntime = new WeakMap<object, BookRecord>()

function getFrameRuntimeIdentity(tab: BookTab) {
  return (tab as unknown as { [frameRuntimeIdentity]: object })[frameRuntimeIdentity]
}

export function getBookTabFrameWindows(tab: BookTab): readonly Window[] {
  return frameWindowsByRuntime.get(getFrameRuntimeIdentity(tab)) ?? []
}

export class BookTab extends BaseTab {
  epub?: RuntimeRef<Book>
  get iframe(): Window | undefined {
    return frameWindowsByRuntime.get(getFrameRuntimeIdentity(this))?.[0]
  }
  get iframes(): readonly Window[] {
    return frameWindowsByRuntime.get(getFrameRuntimeIdentity(this)) ?? []
  }
  rendition?: RuntimeRef<Rendition>
  nav?: Navigation
  locationsToReturn: Location[] = []
  section?: ISection
  sections?: ISection[]
  readingMetrics?: ReadingMetrics
  visibleSections: ISection[] = []
  visibleSectionIndexes: number[] = []
  results?: IMatch[]
  activeResultID?: string
  bodyTextCache: BodyTextDetectionCache = ref(new Map())
  overlayState: BookOverlayState = {
    annotations: [],
    definitions: [],
  }
  typographyConfiguration: BookTypographyConfiguration
  paginationSnapshot?: PaginationSnapshot
  rendered = false
  turning = false
  layoutVersion = 0
  viewVersion = 0
  paginationVersion = 0
  overlayVersion = 0
  active = false
  private sectionInfoPromises = new Map<number, Promise<void>>()
  private readonly cacheActivation: Promise<void>
  private destroyPromise?: Promise<void>
  private readonly navigation = ref(new BookNavigationController())
  private readonly searchController = ref(new BookSearchController())
  renderGeneration = 0
  private sectionNavIndex?: SectionNavIndex
  private currentSpreadState?: ReadingSpreadRecord
  preferredSectionIndex?: number
  allowLocationJump = false
  navigationDirection?: -1 | 1
  relayoutAnchorSectionIndexes?: number[]
  private acceptedLocationRequests = new Map<number, LocationRequestIntent>()
  private runtimeAnchorCfi?: string
  runtimeSpreadAnchor?: ReadingSpreadRecord
  contentReloadTarget?: string
  private spreadAnchorsByLayout = new Map<string, ReadingSpreadRecord>()
  private navRefreshGeneration = 0
  private readonly layoutTransactions = ref(new BookLayoutTransactionController())
  private readonly persistence = ref(new BookPersistenceController())
  private sectionDocumentAccessSeq = 0
  private sectionDocumentAccess = new Map<number, number>()
  private pendingSectionInfoIndexes = new Set<number>()
  private sectionDocumentTrimTimer?: ReturnType<typeof setTimeout>
  rejectedLocationEventCount = 0

  get container() {
    return this?.rendition?.manager?.container as HTMLDivElement | undefined
  }

  get isScrolledDocument() {
    return this.rendition?.settings.globalLayoutProperties?.flow === 'scrolled-doc'
  }

  currentLocation?: Location
  get location() {
    return this.currentLocation
  }
  get locationToReturn() {
    return this.locationsToReturn[this.locationsToReturn.length - 1]
  }

  private sectionForDisplayTarget(target?: string) {
    if (!target) return

    try {
      return this.epub?.spine?.get(target) as ISection | undefined
    } catch (_error) {
      // Invalid CFIs are ignored so callers can fall back to the current flow.
    }
  }

  private locationAnchorCfi(location = this.currentLocation) {
    return location?.start.cfi
  }

  private currentAnchorCfi() {
    if (this.sectionForDisplayTarget(this.runtimeAnchorCfi)) {
      return this.runtimeAnchorCfi
    }

    return this.locationAnchorCfi()
  }

  committedDisplayTarget() {
    const target = this.currentAnchorCfi()
    return this.sectionForDisplayTarget(target) ? target : undefined
  }

  private initialDisplayTarget() {
    const candidates = [this.currentAnchorCfi(), this.book.cfi, (this.epub?.spine?.get() as ISection | undefined)?.href]

    return candidates.find((target) => this.sectionForDisplayTarget(target))
  }

  getCurrentDisplayTarget() {
    return this.committedDisplayTarget()
  }

  waitForPendingNavigation() {
    return this.navigation.waitForPending()
  }

  resizeRendition(width: number, height: number) {
    this.layoutTransactions.resize(this, width, height)
  }

  resolveDisplayTarget(target?: string, fallback: 'current' | 'initial' | false = 'current') {
    if (target && this.sectionForDisplayTarget(target)) return target
    if (target && /^\d*\.?\d+$/.test(target)) return target

    if (fallback === 'current') return this.committedDisplayTarget()
    if (fallback === 'initial') return this.initialDisplayTarget()
  }

  private async displayResolvedTarget(
    target?: string,
    {
      alignTargetAsSpreadStart = false,
      preferredSection,
      returnable = true,
    }: {
      alignTargetAsSpreadStart?: boolean
      preferredSection?: ISection
      returnable?: boolean
    } = {},
  ) {
    const resolvedTarget = this.resolveDisplayTarget(target, target ? false : 'current')
    if (!resolvedTarget || !this.rendition) return

    const resolvedSection = preferredSection ?? this.sectionForDisplayTarget(resolvedTarget)
    this.preferredSectionIndex = resolvedSection?.index
    this.allowLocationJump = true
    this.navigationDirection = undefined
    this.relayoutAnchorSectionIndexes = undefined
    if (returnable) this.showPrevLocation()

    const operation = (async () => {
      try {
        const previousRequestId = this.currentRenditionLocationRequestId()
        const display = this.rendition!.display(resolvedTarget, {
          alignTargetAsSpreadStart,
        })
        const requestId = this.trackRenditionLocationRequest(previousRequestId, {
          anchorTarget: resolvedTarget,
          updateAnchor: true,
          userNavigation: true,
        })
        await display
        this.commitPendingRenditionLocation(requestId)
      } catch (error) {
        console.error(error)
      }
    })()

    await this.navigation.trackDisplay(operation)
  }

  display(target?: string, returnable = true) {
    void this.displayResolvedTarget(target, { returnable })
  }
  async pageIndexForCfi(sectionIndex: number, cfi: string) {
    return pageIndexForCfi(this, sectionIndex, cfi)
  }
  async displayReflowableTarget(sectionIndex: number, cfi: string) {
    const section = this.sections?.find((s) => s.index === sectionIndex)
    await this.displayResolvedTarget(cfi, {
      preferredSection: section,
      returnable: false,
    })
  }
  async displaySectionStart(section: ISection) {
    return this.displayTarget(section, undefined, {
      alignTargetAsSpreadStart: true,
    })
  }
  async displayTarget(section: ISection, target?: string, { alignTargetAsSpreadStart = false } = {}) {
    await this.displayResolvedTarget(target?.startsWith('#') ? `${section.href}${target}` : (target ?? section.href), {
      alignTargetAsSpreadStart,
      preferredSection: section,
      returnable: false,
    })
  }

  async displayFromSelector(selector: string, section: ISection, returnable = true, alignTargetAsSpreadStart = false) {
    return displayFromSelector(this, selector, section, returnable, alignTargetAsSpreadStart)
  }

  async displayImage(section: ISection, src: string, index: number, returnable = true) {
    return displayImage(this, section, src, index, returnable)
  }

  async displaySearchResult(
    result: IMatch,
    keyword = this.keyword,
    sectionContext?: Pick<IMatch, 'sectionIndex' | 'href'>,
  ) {
    return displaySearchResult(this, result, keyword, sectionContext)
  }
  async prev() {
    return this.navigation.prev(this)
  }
  async next() {
    return this.navigation.next(this)
  }
  prevSection() {
    return this.navigation.navigateSection(this, -1)
  }
  nextSection() {
    return this.navigation.navigateSection(this, 1)
  }

  private setBook(book: BookRecord) {
    this.book = book
    this.overlayState = {
      annotations: book.annotations,
      definitions: book.definitions,
    }
    this.typographyConfiguration = book.configuration?.typography
  }

  mergeRuntimeState(book: BookRecord) {
    return {
      ...book,
      annotations: this.book.annotations,
      cfi: this.book.cfi,
      configuration: this.book.configuration,
      definitions: this.book.definitions,
      lastReadAt: this.book.lastReadAt,
      percentage: this.book.percentage,
    }
  }

  private applyBookUpdate(book: BookRecord, changes: Partial<BookRecord>) {
    this.book = book
    if ('annotations' in changes || 'definitions' in changes) {
      this.overlayState = {
        annotations: changes.annotations ?? this.overlayState.annotations,
        definitions: changes.definitions ?? this.overlayState.definitions,
      }
    }
    if ('configuration' in changes) {
      const typography = changes.configuration?.typography
      if (typography !== this.typographyConfiguration) {
        this.typographyConfiguration = typography
      }
    }
  }

  private persistenceHost(): BookPersistenceHost {
    return {
      getBook: () => this.book,
      applyBookUpdate: (book, changes) => this.applyBookUpdate(book, changes),
      replaceBook: (book) => this.setBook(book),
      createCurrentPositionUpdate: () => this.createCurrentPositionUpdate(),
      waitForNavigation: () => this.navigation.pending,
    }
  }

  reloadContentAfterEdit(book: BookRecord, target?: string) {
    this.setBook(this.mergeRuntimeState(book))
    this.annotationRange = undefined
    this.annotationCfi = undefined
    this.runtimeAnchorCfi = undefined
    this.runtimeSpreadAnchor = undefined
    this.spreadAnchorsByLayout.clear()
    this.destroyRendering()
    this.contentReloadTarget = target
    this.bumpViewVersion()
  }

  refreshImportedBook(book: BookRecord) {
    const runtime = getFrameRuntimeIdentity(this)
    const currentBook = pendingImportedBooksByRuntime.get(runtime) ?? this.book
    const currentRevision = currentBook.revision
    const importedRevision = book.revision
    if (importedRevision < currentRevision) return
    const contentChanged =
      importedRevision > currentRevision ||
      (importedRevision === currentRevision && book.contentHash !== currentBook.contentHash)
    if (!contentChanged) {
      if (pendingImportedBooksByRuntime.has(runtime)) {
        pendingImportedBooksByRuntime.set(runtime, book)
      } else {
        this.setBook(this.mergeRuntimeState(book))
      }
      return
    }

    if (!this.active) {
      pendingImportedBooksByRuntime.set(runtime, book)
      return
    }

    pendingImportedBooksByRuntime.delete(runtime)
    this.reloadContentAfterEdit(book, this.getCurrentDisplayTarget())
  }

  private refreshPendingImportedBook() {
    const runtime = getFrameRuntimeIdentity(this)
    const book = pendingImportedBooksByRuntime.get(runtime)
    if (!book) return

    pendingImportedBooksByRuntime.delete(runtime)
    this.reloadContentAfterEdit(book, this.getCurrentDisplayTarget())
  }

  async promoteExternalBook(libraryBook: BookRecord) {
    if (this.book.scope !== 'external') return
    if (!this.book.contentHash || this.book.contentHash !== libraryBook.contentHash) {
      return
    }

    const reloadTarget = this.getCurrentDisplayTarget()
    await this.flushForClose({
      flushStorage: false,
      recordReadingPosition: false,
    })

    const stateChanges: Partial<BookRecord> = {
      annotations: this.book.annotations,
      cfi: this.book.cfi,
      configuration: this.book.configuration,
      definitions: this.book.definitions,
      percentage: this.book.percentage,
    }
    const promotedBook = {
      ...libraryBook,
      ...stateChanges,
      scope: 'library' as const,
    }
    db.books.remember(promotedBook)
    await db.books.update(libraryBook.id, stateChanges)
    this.reloadContentAfterEdit(promotedBook, reloadTarget)
  }

  async applyRenderedTextEdit(
    book: BookRecord,
    target: BookTextReplaceTarget,
    oldText: string,
    newText: string,
    selectionDocument?: Document,
    selectionTextNode?: Text,
  ) {
    const manager = this.rendition?.manager
    const views = manager?.views._views
    const selectionView = selectionDocument?.defaultView ? this.viewForWindow(selectionDocument.defaultView) : undefined
    const view =
      selectionView ??
      views?.find(
        (view) =>
          view.section?.href &&
          (view.section.href === target.sectionHref ||
            compareHref(view.section.href, target.sectionHref) ||
            compareHref(target.sectionHref, view.section.href)),
      )
    if (!view) return false

    const frameDocuments = [selectionDocument, view.contents?.document, view.window?.document, view.document].filter(
      (document, index, documents): document is Document => {
        return !!document && documents.indexOf(document) === index
      },
    )
    const patchedFrame = frameDocuments.some((document) =>
      patchDocumentTextNode(document, target, oldText, newText, selectionTextNode),
    )
    if (!patchedFrame) return false

    const sectionDocument = view.section.document
    if (sectionDocument && !frameDocuments.includes(sectionDocument)) {
      patchDocumentTextNode(sectionDocument, target, oldText, newText)
    }

    if (book.sourceFormat === 'txt' && target.paragraphIndex === undefined) {
      const updatedHeading =
        target.textNodeText.slice(0, target.startOffset) + newText + target.textNodeText.slice(target.endOffset)
      const navItem = (view.section as ISection).navitem ?? this.mapSectionToNavItem(target.sectionHref)
      if (navItem?.label === target.textNodeText) navItem.label = updatedHeading
      this.tocVersion++
    }

    this.setBook(this.mergeRuntimeState(book))
    this.annotationRange = undefined
    this.annotationCfi = undefined
    this.runtimeAnchorCfi = undefined
    this.runtimeSpreadAnchor = undefined
    this.spreadAnchorsByLayout.clear()
    view._contentPageCount = undefined
    try {
      manager?.deleteReflowablePageCountCache?.(view.section)
      view.layout?.format?.(view.contents, view.section, view.axis)
      view.expand?.()
      const requestId = this.createManualLocationRequest({
        updateAnchor: true,
      })
      await this.rendition?.reportLocation(requestId)
      this.commitPendingRenditionLocation(requestId)
    } catch (error) {
      console.error(error)
    }
    this.bumpViewVersion()
    return true
  }

  updateBook(changes: Partial<BookRecord>) {
    this.persistence.updateBook(this.persistenceHost(), changes)
  }

  private hasRecordedOpen = false

  recordOpened(force = false) {
    if (this.hasRecordedOpen && !force) return false
    this.hasRecordedOpen = true
    this.persistence.recordOpened(this.persistenceHost())
    return true
  }

  private createCurrentPositionUpdate(percentage?: number): Partial<BookRecord> | undefined {
    if (!this.currentLocation || !this.sections) return

    percentage ??= calculateReadingPercentage({
      location: this.currentLocation,
      readingMetrics: this.readingMetrics,
      sectionCount: this.sections.length,
      sectionAsPage: this.isScrolledDocument || this.rendition?.manager?.layout?.name === 'pre-paginated',
    })

    const cfi = this.locationAnchorCfi(this.currentLocation)

    return {
      cfi,
      percentage,
      configuration: mergeConfigurationWithSpread(this.book.configuration, this.currentSpreadState),
    }
  }

  async flushForClose({ flushStorage = true, recordReadingPosition = true } = {}) {
    return this.persistence.flushForClose({
      host: this.persistenceHost(),
      flushStorage,
      recordReadingPosition,
    })
  }

  prepareForAppClose() {
    return this.persistence.captureReadingPositionForClose(this.persistenceHost())
  }

  annotationRange?: Range
  annotationCfi?: string
  setAnnotationRange(cfi: string, target?: EventTarget | null) {
    const views = this.rendition?.manager?.views?._views ?? []
    const targetNode = target && 'nodeType' in target ? (target as unknown as Node) : undefined
    const doc = target && 'ownerDocument' in target ? (target.ownerDocument as Document | undefined) : undefined
    // epubjs mark callbacks originate from SVG overlays beside the iframe.
    const targetView =
      (targetNode ? views.find((view) => view.element?.contains(targetNode)) : undefined) ??
      (doc?.defaultView ? this.viewForWindow(doc.defaultView) : undefined)
    const candidates = targetView ? [targetView] : [this.view, ...views]

    for (const view of [...new Set(candidates)]) {
      try {
        const range = view?.contents?.range(cfi)
        if (range) {
          this.annotationRange = ref(range)
          this.annotationCfi = cfi
          return true
        }
      } catch (_error) {
        // The CFI only resolves in the view that owns the annotation.
      }
    }

    return false
  }

  private bumpOverlayVersion() {
    this.overlayVersion++
  }

  private bumpViewVersion() {
    this.viewVersion++
    this.bumpOverlayVersion()
  }

  private commitPaginationSnapshot(location: Location, percentage?: number, activeSection = this.section) {
    const manager = this.rendition?.manager
    const divisor = manager?.layout?.divisor
    const paginationModel = manager?.paginationModel?.()

    this.paginationVersion++
    this.paginationSnapshot = {
      location,
      percentage,
      spreadDivisor: typeof divisor === 'number' && Number.isFinite(divisor) && divisor > 0 ? divisor : 1,
      writingMode: paginationModel?.writingMode,
      pageProgressionDirection: paginationModel?.pageProgressionDirection,
      spreadSlotOrder: paginationModel?.spreadSlotOrder,
      layoutVersion: this.layoutVersion,
      paginationVersion: this.paginationVersion,
      headerPath: this.snapshotHeaderPath(activeSection),
      visibleSectionIndexes: [...this.visibleSectionIndexes],
    }
  }

  markLayoutChanged() {
    this.layoutVersion++
  }

  currentRenditionLocationRequestId() {
    const requestId = this.rendition?._locationRequestId
    return typeof requestId === 'number' ? requestId : undefined
  }

  trackRenditionLocationRequest(previousRequestId: number | undefined, intent: LocationRequestIntent) {
    const requestId = this.currentRenditionLocationRequestId()
    if (requestId === undefined || requestId === previousRequestId) return

    this.acceptedLocationRequests.set(requestId, intent)
    return requestId
  }

  createManualLocationRequest(intent: LocationRequestIntent) {
    const rendition = this.rendition
    if (!rendition) return

    const requestId = typeof rendition._locationRequestId === 'number' ? rendition._locationRequestId + 1 : 1
    rendition._locationRequestId = requestId
    this.acceptedLocationRequests.set(requestId, intent)
    return requestId
  }

  commitPendingRenditionLocation(requestId: number | undefined) {
    if (typeof requestId !== 'number' || !this.acceptedLocationRequests.has(requestId)) {
      return
    }

    if (requestId !== this.currentRenditionLocationRequestId()) {
      this.acceptedLocationRequests.delete(requestId)
      this.rejectedLocationEventCount++
      return
    }

    const loc = this.rendition?.location
    if (!loc) {
      this.acceptedLocationRequests.delete(requestId)
      this.rejectedLocationEventCount++
      return
    }

    this.commitRelocatedLocation(loc, { requestId })
  }

  private consumeLocationEventIntent(meta?: RelocatedEventMeta) {
    const requestId = meta?.requestId

    if (typeof requestId === 'number') {
      const intent = this.acceptedLocationRequests.get(requestId)
      if (intent) {
        this.acceptedLocationRequests.delete(requestId)
        return intent
      }

      this.rejectedLocationEventCount++
      return
    }

    this.rejectedLocationEventCount++
  }

  private commitRelocatedLocation(loc: Location, meta?: RelocatedEventMeta) {
    const locationIntent = this.consumeLocationEventIntent(meta)
    if (!locationIntent) return

    this.syncFrames()
    let percentage = fallbackReadingPercentage(loc)
    const visibleSections = this.visibleSectionsForLocation(loc)

    // calculate percentage
    if (this.sections) {
      const end = loc.end ?? loc.start

      if (!this.sections.some((s) => s.href === end.href)) {
        if (!this.shouldAcceptRelocatedLocation(percentage, visibleSections)) {
          this.rejectedLocationEventCount++
          return
        }

        const currentSpreadState = snapshotReflowableSpread(this.rendition?.manager, this.layoutStyleSignature, loc)
        this.currentLocation = loc
        this.observeRecentReadingLocation(loc, locationIntent)
        this.currentSpreadState = currentSpreadState
        if (locationIntent.updateAnchor) {
          this.spreadAnchorsByLayout.clear()
          this.runtimeSpreadAnchor = currentSpreadState
        }
        this.rememberCurrentLayoutSpread(locationIntent.layoutKey, {
          replace: locationIntent.updateAnchor,
          spread: currentSpreadState,
        })
        const activeSection = this.commitVisibleSections(loc, visibleSections)
        this.updateRuntimeAnchorCfi(loc, locationIntent)
        void this.refreshVisibleNavItems(loc, activeSection, ++this.navRefreshGeneration)
        this.commitPaginationSnapshot(loc, percentage, activeSection)
        this.clearLocationIntent()
        this.rendered = true
        return
      }

      percentage = calculateReadingPercentage({
        location: loc,
        readingMetrics: this.readingMetrics,
        sectionCount: this.sections.length,
        sectionAsPage: this.isScrolledDocument || this.rendition?.manager?.layout?.name === 'pre-paginated',
      })
    }

    if (!this.shouldAcceptRelocatedLocation(percentage, visibleSections)) {
      this.rejectedLocationEventCount++
      return
    }

    const currentSpreadState = snapshotReflowableSpread(this.rendition?.manager, this.layoutStyleSignature, loc)
    this.currentLocation = loc
    this.observeRecentReadingLocation(loc, locationIntent)
    this.currentSpreadState = currentSpreadState
    if (locationIntent.updateAnchor) {
      this.spreadAnchorsByLayout.clear()
      this.runtimeSpreadAnchor = currentSpreadState
    }
    this.rememberCurrentLayoutSpread(locationIntent.layoutKey, {
      replace: locationIntent.updateAnchor,
      spread: currentSpreadState,
    })
    const activeSection = this.commitVisibleSections(loc, visibleSections)
    this.updateRuntimeAnchorCfi(loc, locationIntent)

    if (this.sections) {
      const start = loc.start
      const activeNavItem = activeSection?.navitem ?? this.mapSectionToNavItem(activeSection?.href ?? start.href)
      if (activeSection && activeNavItem) {
        activeSection.navitem = activeNavItem
      }
      this.expandNavPath(activeNavItem)
      void this.refreshVisibleNavItems(loc, activeSection, ++this.navRefreshGeneration)

      const positionUpdate = this.createCurrentPositionUpdate(percentage)
      if (positionUpdate) {
        this.updateBook(positionUpdate)
      }
    }

    this.commitPaginationSnapshot(loc, percentage, activeSection)
    this.clearLocationIntent()
    this.rendered = true
  }

  beginRecentReadingSession() {
    if (!isRecentReadingEnabled()) {
      db.recentBooks.cancelSession(this.book.id)
      return
    }
    const baselineCfi = this.rendered ? this.locationAnchorCfi() : undefined
    db.recentBooks.beginSession(this.book.id, baselineCfi)
  }

  private observeRecentReadingLocation(location: Location, intent: LocationRequestIntent) {
    if (!isRecentReadingEnabled()) {
      db.recentBooks.cancelSession(this.book.id)
      return
    }
    db.recentBooks.observePosition(this.book.id, this.locationAnchorCfi(location), intent.userNavigation === true)
  }

  private updateRuntimeAnchorCfi(location: Location, intent: LocationRequestIntent) {
    if (!intent.updateAnchor) return

    const anchor = this.sectionForDisplayTarget(intent.anchorTarget)
      ? intent.anchorTarget
      : this.locationAnchorCfi(location)
    if (this.sectionForDisplayTarget(anchor)) {
      this.runtimeAnchorCfi = anchor
    }
  }

  setActive(active: boolean) {
    this.active = active

    const manager = this.rendition?.manager
    if (manager) {
      manager.suspendResize = true
    }
    if (active) this.refreshPendingImportedBook()
  }

  define(def: string[]) {
    this.updateBook({ definitions: [...this.book.definitions, ...def] })
    this.bumpOverlayVersion()
  }
  undefine(def: string) {
    const definitions = this.book.definitions.filter((d) => !compareDefinition(d, def))
    if (definitions.length === this.book.definitions.length) return

    this.updateBook({ definitions })
    this.bumpOverlayVersion()
  }
  isDefined(def: string) {
    return this.book.definitions.some((d) => compareDefinition(d, def))
  }

  rangeToCfi(range: Range) {
    const view = this.viewForRange(range)
    if (!view) throw new Error('No active view for selected range')

    return view.contents.cfiFromRange(range)
  }
  putAnnotation(
    type: AnnotationType,
    cfi: string,
    color: AnnotationColor,
    text: string,
    notes?: string,
    section = this.section,
  ) {
    const spine = section ?? this.section
    if (!spine) return

    const navitem = spine.navitem ?? this.mapSectionToNavItem(spine.href)
    if (navitem) spine.navitem = navitem
    const annotationSpine = createAnnotationSpine(spine)
    if (!annotationSpine) return

    const annotations = [...snapshot(this.book.annotations)]
    const i = annotations.findIndex((a) => a.cfi === cfi)
    let annotation = annotations[i]

    const now = Date.now()
    if (!annotation) {
      annotation = {
        cfi,
        spine: annotationSpine,
        createdAt: now,
        updatedAt: now,
        type,
        color,
        notes,
        text,
      }

      this.updateBook({ annotations: [...annotations, annotation] })
    } else {
      annotation = {
        ...annotation,
        type,
        updatedAt: now,
        color,
        notes,
        text,
      }
      annotations.splice(i, 1, annotation)
      this.updateBook({ annotations })
    }

    this.bumpOverlayVersion()
  }
  removeAnnotation(cfi: string) {
    const annotations = snapshot(this.book.annotations).filter((a) => a.cfi !== cfi)
    if (annotations.length === this.book.annotations.length) return

    this.updateBook({ annotations })
    this.bumpOverlayVersion()
  }

  keyword = ''
  tocVersion = 0
  setKeyword(keyword: string) {
    this.searchController.setKeyword(this, keyword)
  }

  async searchKeywordImmediately(keyword: string) {
    await this.searchController.searchImmediately(this, keyword)
  }

  toggle(id: string) {
    const item = find(this.nav?.toc, id) as INavItem
    if (item) {
      item.expanded = !item.expanded
      this.tocVersion++
    }
  }

  toggleNavItem(target: Pick<INavItem, 'id' | 'href'> & Partial<INavItem>) {
    const item = this.findNavItem(target)
    if (item) {
      item.expanded = !item.expanded
      this.tocVersion++
      return
    }

    if ('expanded' in target) {
      target.expanded = !target.expanded
      this.tocVersion++
    }
  }

  setNavExpanded(expanded: boolean) {
    let changed = false

    this.nav?.toc?.forEach((root) =>
      dfs(root as INavItem, (item) => {
        if (item.expanded === expanded) return
        item.expanded = expanded
        changed = true
      }),
    )

    if (changed) this.tocVersion++
  }

  findNavItem(target: Pick<INavItem, 'id' | 'href'>, nodes = this.nav?.toc): INavItem | undefined {
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

  getSectionNavIndex(sections = this.sections) {
    if (!this.nav || !sections) return

    if (this.sectionNavIndex?.nav === this.nav && this.sectionNavIndex.sections === sections) {
      return this.sectionNavIndex
    }

    markSectionsRuntime(sections)

    const exactBySectionHref = new Map<string, INavItem>()
    const firstNavItemById = new Map<string, INavItem>()
    const entriesBySectionIndex = new Map<number, SectionNavEntry[]>()
    const entries: SectionNavIndex['entries'] = []
    let order = 0
    const normalizedSections = sections.map((section) => ({
      href: normalizeHrefPath(section.href),
      section,
    }))
    const sectionsByHref = new Map<string, ISection>()
    normalizedSections.forEach((entry) => {
      if (entry.href && !sectionsByHref.has(entry.href)) {
        sectionsByHref.set(entry.href, entry.section)
      }
    })

    const matchSection = (href: string | undefined) => {
      const normalizedHref = normalizeHrefPath(href)
      if (!normalizedHref) return

      return (
        sectionsByHref.get(normalizedHref) ??
        normalizedSections.find(
          (entry) =>
            entry.href && (entry.href.endsWith(`/${normalizedHref}`) || normalizedHref.endsWith(`/${entry.href}`)),
        )?.section
      )
    }

    this.nav.toc.forEach((item) =>
      dfs(item as INavItem, (navItem) => {
        if (navItem.id && !firstNavItemById.has(navItem.id)) {
          firstNavItemById.set(navItem.id, navItem)
        }

        const matchedSection = matchSection(navItem.href)

        if (matchedSection) {
          const { hash, path } = splitHrefTarget(navItem.href)
          const entry = {
            href: path,
            hash,
            item: navItem,
            order,
            sectionIndex: matchedSection.index,
          }

          exactBySectionHref.set(matchedSection.href, exactBySectionHref.get(matchedSection.href) ?? navItem)
          entries.push(entry)

          const sectionEntries = entriesBySectionIndex.get(matchedSection.index) ?? []
          sectionEntries.push(entry)
          entriesBySectionIndex.set(matchedSection.index, sectionEntries)
        }

        order++
      }),
    )

    entries.sort((a, b) => a.sectionIndex - b.sectionIndex || a.order - b.order)
    const nextIndex = {
      anchorEntriesBySectionIndex: new Map(),
      anchorPromisesBySectionIndex: new Map(),
      entriesBySectionIndex,
      nav: this.nav,
      sections,
      exactBySectionHref,
      firstNavItemById,
      entries,
    }

    try {
      this.sectionNavIndex = markRuntimeObject(nextIndex)
      return nextIndex
    } catch (_error) {
      return nextIndex
    }
  }

  mapSectionToNavItem(sectionHref: string, sections = this.sections) {
    if (!sectionHref || !sections) return

    const index = this.getSectionNavIndex(sections)
    const section = sections.find((s) => s.href === sectionHref || compareHref(s.href, sectionHref))
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

  private sectionHasMultipleNavItems(section: ISection | undefined) {
    if (!section) return false

    const entries = this.getSectionNavIndex()?.entriesBySectionIndex.get(section.index)
    return !!entries && entries.length > 1
  }

  private async navAnchorsForSection(section: ISection) {
    const index = this.getSectionNavIndex()
    const entries = index?.entriesBySectionIndex.get(section.index)
    if (!index || !entries || entries.length <= 1) return []

    const cached = index.anchorEntriesBySectionIndex.get(section.index)
    if (cached) return cached

    const pending = index.anchorPromisesBySectionIndex.get(section.index)
    if (pending) return pending

    const promise = this.createNavAnchorsForSection(section, entries)
    index.anchorPromisesBySectionIndex.set(section.index, promise)
    return promise
  }

  private async createNavAnchorsForSection(section: ISection, entries: SectionNavEntry[]) {
    await this.ensureSectionInfo(section)

    const anchors = entries.flatMap((entry) => {
      const element = this.findNavAnchorElement(section, entry.hash)
      if (!element) return []

      try {
        return [
          {
            ...entry,
            cfi: section.cfiFromElement(element),
          },
        ]
      } catch (_error) {
        return []
      }
    })

    anchors.sort((a, b) => this.compareCfi(a.cfi, b.cfi) || a.order - b.order)
    this.getSectionNavIndex()?.anchorEntriesBySectionIndex.set(section.index, anchors)
    return anchors
  }

  private findNavAnchorElement(section: ISection, hash: string | undefined) {
    const document = section.document
    if (!document) return

    if (!hash) return document.body
    const decoded = safeDecodeHref(hash)

    return document.getElementById(hash) ?? (decoded !== hash ? document.getElementById(decoded) : undefined)
  }

  private compareCfi(a: string, b: string) {
    try {
      return this.rendition?.epubcfi?.compare(a, b) ?? 0
    } catch {
      return 0
    }
  }

  private navItemFromCachedSectionCfi(section: ISection | undefined, cfi: string | undefined) {
    if (!section || !cfi) return

    const anchors = this.getSectionNavIndex()?.anchorEntriesBySectionIndex.get(section.index)
    if (!anchors?.length) return

    return this.pickNavAnchorForCfi(anchors, cfi)?.item
  }

  private pickNavAnchorForCfi(anchors: SectionNavAnchorEntry[], cfi: string | undefined) {
    if (!cfi) return anchors[0]

    let selected = anchors[0]
    for (const anchor of anchors) {
      const comparison = this.compareCfi(anchor.cfi, cfi)
      if (comparison > 0) break
      if (selected && this.sameNavAnchorTarget(selected, anchor)) continue
      selected = anchor
    }

    return selected
  }

  private sameNavAnchorTarget(a: SectionNavAnchorEntry, b: SectionNavAnchorEntry) {
    return a.sectionIndex === b.sectionIndex && a.href === b.href && a.hash === b.hash
  }

  async navAnchorForLocationPoint(point: Pick<Location['start'], 'index' | 'href' | 'cfi'> | undefined) {
    const section = this.sectionFromLocationPoint(point)
    if (!section || !this.sectionHasMultipleNavItems(section)) return

    const anchors = await this.navAnchorsForSection(section)
    return this.pickNavAnchorForCfi(anchors, point?.cfi)
  }

  get currentHref() {
    return this.location?.start.href
  }

  sectionFromLocationPoint(point?: Pick<Location['start'], 'index' | 'href'>) {
    if (!point) return

    return (
      this.sections?.find((section) => section.index === point.index) ??
      this.sections?.find((section) => section.href === point.href) ??
      this.sections?.find((section) => compareHref(section.href, point.href))
    )
  }

  private visibleSectionsForLocation(location: Location) {
    const sections: ISection[] = []
    const seen = new Set<number>()
    const add = (section?: ISection) => {
      if (!section || seen.has(section.index)) return

      this.assignSectionNavItem(section)
      seen.add(section.index)
      sections.push(section)
    }

    const spread = this.rendition?.manager?.currentReflowableSpread
    add(spread?.left?.section as ISection | undefined)
    add(spread?.right?.section as ISection | undefined)
    add(this.sectionFromLocationPoint(location.start))
    add(this.sectionFromLocationPoint(location.end))

    return sections
  }

  private commitVisibleSections(location: Location, visibleSections = this.visibleSectionsForLocation(location)) {
    this.visibleSections = markSectionsRuntime(visibleSections)
    this.visibleSectionIndexes = visibleSections.map((section) => section.index)

    const preferredSection =
      this.preferredSectionIndex === undefined
        ? undefined
        : visibleSections.find((section) => section.index === this.preferredSectionIndex)
    const startSection = this.sectionFromLocationPoint(location.start)
    const activeSection = preferredSection ?? startSection ?? visibleSections[0] ?? this.section

    if (activeSection) {
      markSectionRuntime(activeSection)
      this.assignSectionNavItem(activeSection)
      this.section = activeSection
    }

    return activeSection
  }

  private async refreshVisibleNavItems(location: Location, activeSection: ISection | undefined, generation: number) {
    if (!this.sections) return

    const [startAnchor, endAnchor] = await Promise.all([
      this.navAnchorForLocationPoint(location.start),
      this.navAnchorForLocationPoint(location.end),
    ])

    if (this.navRefreshGeneration !== generation) return

    if (activeSection && startAnchor?.item) {
      if (activeSection.navitem !== startAnchor.item) {
        activeSection.navitem = startAnchor.item
        this.tocVersion++
      }
    }

    ;[startAnchor?.item, endAnchor?.item].forEach((item) => {
      if (item) this.expandNavPath(item)
    })
  }

  private shouldAcceptRelocatedLocation(percentage: number | undefined, visibleSections: ISection[]) {
    if (this.relayoutAnchorSectionIndexes?.length) {
      const nextIndexes = new Set(visibleSections.map((section) => section.index))
      const stillAnchored = this.relayoutAnchorSectionIndexes.some((index) => nextIndexes.has(index))
      if (!stillAnchored) return false
    }

    if (this.isNavigationSectionProgressConsistent(visibleSections)) {
      return true
    }

    const currentPercentage = this.paginationSnapshot?.percentage
    if (
      !this.allowLocationJump &&
      typeof currentPercentage === 'number' &&
      Number.isFinite(currentPercentage) &&
      typeof percentage === 'number' &&
      Number.isFinite(percentage)
    ) {
      const delta = percentage - currentPercentage

      if (this.navigationDirection === 1 && delta < -0.01) return false
      if (this.navigationDirection === -1 && delta > 0.01) return false
      if (!this.navigationDirection && delta < -0.2) return false
    }

    return true
  }

  private isNavigationSectionProgressConsistent(visibleSections: ISection[]) {
    if (!this.navigationDirection) return false

    const nextIndexes = visibleSections.map((section) => section.index).filter((index) => typeof index === 'number')
    const currentIndexes = this.paginationSnapshot?.visibleSectionIndexes.length
      ? this.paginationSnapshot.visibleSectionIndexes
      : this.visibleSectionIndexes

    if (!nextIndexes.length || !currentIndexes.length) return false

    const nextMin = Math.min(...nextIndexes)
    const nextMax = Math.max(...nextIndexes)
    const currentMin = Math.min(...currentIndexes)
    const currentMax = Math.max(...currentIndexes)

    if (this.navigationDirection === 1) {
      return nextMax > currentMax && nextMin >= currentMin
    }

    return nextMin < currentMin && nextMax <= currentMax
  }

  private clearLocationIntent() {
    this.allowLocationJump = false
    this.navigationDirection = undefined
    this.relayoutAnchorSectionIndexes = undefined
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
    const currentSection = this.currentSection

    return (
      this.navItemFromCachedSectionCfi(currentSection, this.location?.start.cfi) ??
      currentSection?.navitem ??
      (this.currentHref ? this.mapSectionToNavItem(this.currentHref) : undefined)
    )
  }

  private sectionHeading(section = this.currentSection) {
    const heading = section?.document?.querySelector('h1, h2, h3, h4, h5, h6')
    return heading?.textContent?.trim()
  }

  get currentSectionHeading() {
    return this.sectionHeading()
  }

  getHeaderPath(section = this.currentSection) {
    const navItem = section?.navitem ?? (section?.href ? this.mapSectionToNavItem(section.href) : undefined)
    const path = this.getNavPath(navItem)
    const heading = this.sectionHeading(section)

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

  private snapshotHeaderPath(section = this.currentSection): HeaderPathItem[] {
    return this.getHeaderPath(section).map((item) => ({
      id: item.id,
      href: item.href,
      label: item.label,
    }))
  }

  get view() {
    return this.rendition?.manager?.current?.() ?? this.rendition?.manager?.views._views[0]
  }

  viewForWindow(win: Window | null) {
    return this.rendition?.manager?.views._views.find((view) => view.window === win)
  }

  viewForRange(range: Range) {
    const doc = range.commonAncestorContainer.ownerDocument ?? (range.commonAncestorContainer as Document)

    return this.viewForWindow(doc.defaultView) ?? this.view
  }

  private replaceFrameWindows(windows: readonly Window[]) {
    const current = getBookTabFrameWindows(this)

    if (windows.length === current.length && windows.every((win, index) => current[index] === win)) {
      return false
    }

    if (windows.length) {
      frameWindowsByRuntime.set(getFrameRuntimeIdentity(this), windows)
    } else {
      frameWindowsByRuntime.delete(getFrameRuntimeIdentity(this))
    }
    this.bumpViewVersion()
    return true
  }

  sectionForRange(range: Range) {
    const section = this.viewForRange(range)?.section as ISection | undefined
    if (section) {
      this.assignSectionNavItem(section)
      return section
    }

    return this.section
  }

  syncFrames() {
    const views = this.rendition?.manager?.views?._views ?? []
    const windows: Window[] = views.map((view) => view.window).filter((win: Window | undefined): win is Window => !!win)
    const current = getBookTabFrameWindows(this)

    if (windows.length === current.length && windows.every((win, index) => current[index] === win)) {
      return false
    }

    return this.replaceFrameWindows(windows)
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
      db.recentBooks.cancelSession(this.book.id)
      await this.cacheActivation
      await setBookCacheActive(this.book.id, false).catch(console.error)
      this.destroyRendering()
      if (this.book.scope === 'external') {
        await cleanupExternalBook(this.book.id).catch(console.error)
      }
    }
  }

  private destroyRendering() {
    this.layoutTransactions.invalidate()

    try {
      this.rendition?.destroy?.()
    } catch (error) {
      console.error(error)
    }

    try {
      this.epub?.destroy()
    } catch (error) {
      console.error(error)
    }

    this.epub = undefined
    this.replaceFrameWindows([])
    this.rendition = undefined
    this.section = undefined
    this.sections = undefined
    this.readingMetrics = undefined
    this.sectionNavIndex = undefined
    this.annotationRange = undefined
    this.annotationCfi = undefined
    this.visibleSections = []
    this.visibleSectionIndexes = []
    this.preferredSectionIndex = undefined
    this.runtimeAnchorCfi = undefined
    this.runtimeSpreadAnchor = undefined
    this.contentReloadTarget = undefined
    this.acceptedLocationRequests.clear()
    this.spreadAnchorsByLayout.clear()
    this.rendered = false
    this._el = undefined
    this.renderingEl = undefined
    if (this.sectionDocumentTrimTimer) {
      clearTimeout(this.sectionDocumentTrimTimer)
      this.sectionDocumentTrimTimer = undefined
    }
    this.sectionInfoPromises.clear()
    this.sectionDocumentAccess.clear()
    this.pendingSectionInfoIndexes.clear()
    this.bodyTextCache = ref(new Map())
  }

  getNavPath(navItem = this.currentNavItem) {
    const path: INavItem[] = []

    if (this.nav) {
      const seenItems = new Set<INavItem>()
      const seenIds = new Set<string>()
      while (navItem) {
        const itemId = navItem.id
        if (seenItems.has(navItem)) break
        seenItems.add(navItem)
        if (itemId) seenIds.add(itemId)

        path.unshift(navItem)
        const parentId = navItem.parent
        if (!parentId) {
          navItem = undefined
        } else {
          const firstParent = this.getSectionNavIndex()?.firstNavItemById.get(parentId)
          if (firstParent) {
            if (firstParent === navItem || (firstParent.id === navItem.id && firstParent.parent === navItem.parent)) {
              break
            }
            navItem = firstParent
          } else {
            const index = this.nav.tocById[parentId]!
            const parent = this.nav.getByIndex(parentId, index, this.nav.toc)
            if (parent?.id && seenIds.has(parent.id)) break
            navItem = parent
          }
        }
      }
    }

    return path
  }

  expandNavPath(navItem = this.currentNavItem) {
    const path = this.getNavPath(navItem)
    let changed = false

    path.slice(0, -1).forEach((item) => {
      if (!item.expanded) changed = true
      item.expanded = true
    })

    if (changed) this.tocVersion++
  }

  searchInSection(keyword = this.keyword, section = this.section) {
    return searchInSection(this, keyword, section)
  }

  async searchInSectionAsync(keyword = this.keyword, section = this.section) {
    return searchInSectionAsync(this, keyword, section)
  }

  async search(keyword = this.keyword) {
    return searchBook(this, keyword)
  }

  private assignSectionNavItem(section: ISection, sections = this.sections) {
    const navitem = this.mapSectionToNavItem(section.href, sections)
    if (navitem) section.navitem = navitem
  }

  private assignSectionNavItems(sections = this.sections) {
    if (!this.nav || !sections) return

    const index = this.getSectionNavIndex(sections)
    if (!index) return

    const orderedSections = [...sections].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    let entryIndex = 0
    let nearestNavItem: INavItem | undefined

    orderedSections.forEach((section) => {
      const exact = index.exactBySectionHref.get(section.href)
      if (exact) {
        section.navitem = exact
        return
      }

      while (entryIndex < index.entries.length && index.entries[entryIndex]!.sectionIndex <= section.index) {
        nearestNavItem = index.entries[entryIndex]!.item
        entryIndex++
      }

      if (nearestNavItem) section.navitem = nearestNavItem
    })
  }

  private sectionInfoIndex(section: ISection) {
    return section.index ?? this.sections?.indexOf(section) ?? -1
  }

  private markSectionDocumentAccess(section: ISection) {
    if (!section.document?.body) return

    const index = this.sectionInfoIndex(section)
    if (index < 0) return

    this.sectionDocumentAccess.set(index, ++this.sectionDocumentAccessSeq)
    this.scheduleSectionDocumentTrim()
  }

  private loadedSectionDocumentCount() {
    return this.sections?.filter((section) => !!section.document?.body).length ?? 0
  }

  private protectedSectionDocumentIndexes() {
    const indexes = new Set<number>([...this.visibleSectionIndexes, ...this.pendingSectionInfoIndexes])

    if (this.section?.index !== undefined) {
      indexes.add(this.section.index)
    }

    const views = this.rendition?.manager?.views?._views as Array<{ section?: ISection }> | undefined
    views?.forEach((view) => {
      if (view.section?.index !== undefined) {
        indexes.add(view.section.index)
      }
    })

    return indexes
  }

  private scheduleSectionDocumentTrim() {
    if (this.sectionDocumentTrimTimer) return
    if (this.loadedSectionDocumentCount() <= SECTION_DOCUMENT_HIGH_WATERMARK) {
      return
    }

    this.sectionDocumentTrimTimer = setTimeout(() => {
      this.sectionDocumentTrimTimer = undefined
      this.trimSectionDocuments()
    }, SECTION_DOCUMENT_TRIM_DELAY_MS)
  }

  private trimSectionDocuments() {
    const sections = this.sections
    if (!sections) return

    const loaded = sections.filter((section) => !!section.document?.body)
    if (loaded.length <= SECTION_DOCUMENT_HIGH_WATERMARK) return

    const protectedIndexes = this.protectedSectionDocumentIndexes()
    const candidates = loaded
      .filter((section) => !protectedIndexes.has(section.index))
      .sort((a, b) => (this.sectionDocumentAccess.get(a.index) ?? 0) - (this.sectionDocumentAccess.get(b.index) ?? 0))

    let loadedCount = loaded.length
    for (const section of candidates) {
      if (loadedCount <= SECTION_DOCUMENT_LOW_WATERMARK) break

      try {
        section.unload()
      } catch (error) {
        console.error(error)
        continue
      }

      this.sectionInfoPromises.delete(section.index)
      this.sectionDocumentAccess.delete(section.index)
      loadedCount -= 1
    }
  }

  async ensureSectionInfo(section: ISection) {
    if (!this.epub) return

    if (section.resourceAvailable === false || !section.url) {
      section.images = []
      section.imageInfoLoaded = true
      return
    }

    if (section.document?.body) {
      this.assignSectionNavItem(section)
      this.markSectionDocumentAccess(section)
      return
    }

    const index = this.sectionInfoIndex(section)
    const cached = this.sectionInfoPromises.get(index)
    if (cached) return cached

    if (index >= 0) this.pendingSectionInfoIndexes.add(index)
    let loaded = false
    const promise = Promise.resolve()
      .then(() => section.load(this.epub!.load.bind(this.epub)))
      .then(() => {
        loaded = true
        this.assignSectionNavItem(section)
        this.markSectionDocumentAccess(section)
      })
      .catch((error) => {
        console.error('Failed to load section info', error)
      })
      .finally(() => {
        if (index >= 0) {
          this.pendingSectionInfoIndexes.delete(index)
          if (!loaded) this.sectionInfoPromises.delete(index)
        }
      })

    if (index >= 0) this.sectionInfoPromises.set(index, promise)
    return promise
  }

  private _el?: HTMLDivElement
  private renderingEl?: HTMLDivElement
  onBeforeLayout?: BookBeforeLayout
  layoutStyleSignature?: string

  setBeforeLayout(beforeLayout?: BookBeforeLayout, layoutStyleSignature?: string) {
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
    manager.viewSettings.beforeLayout = (contents, view) => {
      this.onBeforeLayout?.(contents, view)
    }
  }

  resetLayoutPageState() {
    const manager = this.rendition?.manager
    if (!manager) return

    manager.reflowablePageCountCache = {}
    manager.currentReflowableSpread = undefined
    this.markLayoutChanged()
  }

  layoutAnchorKey(width?: number, height?: number) {
    const manager = this.rendition?.manager
    const resolvedWidth =
      width ??
      manager?._stageSize?.width ??
      manager?.viewSettings?.width ??
      this.container?.getBoundingClientRect().width
    const resolvedHeight =
      height ??
      manager?._stageSize?.height ??
      manager?.viewSettings?.height ??
      this.container?.getBoundingClientRect().height

    if (!resolvedWidth || !resolvedHeight) return

    return [
      Math.round(resolvedWidth),
      Math.round(resolvedHeight),
      this.layoutStyleSignature ?? '',
      this.rendition?.settings.spread ?? '',
    ].join(':')
  }

  rememberCurrentLayoutSpread(
    key = this.layoutAnchorKey(),
    { replace = true, spread }: { replace?: boolean; spread?: ReadingSpreadRecord } = {},
  ) {
    if (!key) return
    if (!replace && this.spreadAnchorsByLayout.has(key)) return

    const currentSpread =
      spread ??
      snapshotReflowableSpread(
        this.rendition?.manager,
        this.layoutStyleSignature,
        this.rendition?.location ?? this.currentLocation,
      )
    if (
      currentSpread &&
      this.visibleSectionIndexes.length &&
      !readingSpreadSectionIndexes(currentSpread).some((sectionIndex) =>
        this.visibleSectionIndexes.includes(sectionIndex),
      )
    ) {
      return
    }
    if (currentSpread) {
      this.spreadAnchorsByLayout.set(key, currentSpread)
    }
  }

  storedSpreadForLayout(width: number, height: number) {
    const key = this.layoutAnchorKey(width, height)
    if (!key) return

    return hydrateReflowableSpread(this.spreadAnchorsByLayout.get(key), this.sections, this.layoutStyleSignature)
  }

  relayoutCurrentView(target?: string) {
    return this.layoutTransactions.relayout(this, target)
  }

  private async displayInitialPosition() {
    await this.layoutTransactions.displayInitialPosition(this)
  }

  async render(
    el: HTMLDivElement,
    initialSpread?: RenditionSpread,
    beforeLayout?: BookBeforeLayout,
    layoutStyleSignature?: string,
  ) {
    this.setBeforeLayout(beforeLayout, layoutStyleSignature)
    if (el === this._el) return
    if (el === this.renderingEl) return
    if (el.getBoundingClientRect().width === 0) return

    this.renderingEl = ref(el)
    const generation = ++this.renderGeneration
    if (this.recordOpened()) this.beginRecentReadingSession()
    const clearRendering = () => {
      if (el === this.renderingEl) this.renderingEl = undefined
    }

    let loadedBook: BookRecord | undefined
    if (this.book.stateLoaded) {
      loadedBook = this.book
    } else {
      try {
        loadedBook = await db.books.get(this.book.id)
      } catch (error) {
        this.reportOpenError('source', error)
        clearRendering()
        return
      }
    }
    if (generation !== this.renderGeneration) {
      clearRendering()
      return
    }
    if (loadedBook) {
      this.setBook(loadedBook)
    }

    let source: BookReaderSource
    try {
      source = await db.files.getReaderSource(this.book.id)
    } catch (error) {
      this.reportOpenError('source', error)
      clearRendering()
      return
    }
    if (generation !== this.renderGeneration) {
      clearRendering()
      return
    }
    if (!source.url) {
      clearRendering()
      return
    }
    this.readingMetrics = source.readingMetrics ? markRuntimeObject(source.readingMetrics) : undefined
    if (source.mode === 'epub' && !this.book.archive) {
      let refreshedBook: BookRecord | undefined
      try {
        refreshedBook = await db.books.get(this.book.id)
      } catch (error) {
        this.reportOpenError('source', error)
        clearRendering()
        return
      }
      if (generation !== this.renderGeneration) {
        clearRendering()
        return
      }
      if (refreshedBook) {
        this.setBook(refreshedBook)
      }
    }

    let epub: RuntimeRef<Book>
    let openingBook: Book | undefined
    try {
      if (source.mode === 'epub') {
        openingBook = ePub()
        await openingBook.open(source.url, 'epub')
        epub = ref(openingBook)
        openingBook = undefined
      } else {
        epub = ref(
          await ePub(source.url, {
            requestMethod: createRevisionedEpubRequest(this.book.revision),
            containerRootUrl: source.rootUrl,
          }),
        )
      }
    } catch (error) {
      try {
        openingBook?.destroy()
      } catch (destroyError) {
        console.error(destroyError)
      }
      this.reportOpenError('open', error)
      clearRendering()
      return
    }

    if (generation !== this.renderGeneration) {
      try {
        epub.destroy()
      } catch (error) {
        console.error(error)
      }
      clearRendering()
      return
    }

    if (el.getBoundingClientRect().width === 0) {
      try {
        epub.destroy()
      } catch (error) {
        console.error(error)
      }
      clearRendering()
      return
    }

    const initialRect = el.getBoundingClientRect()
    const initialWidth = Math.round(initialRect.width)
    const initialHeight = Math.round(initialRect.height)
    if (initialWidth <= 0 || initialHeight <= 0) {
      try {
        epub.destroy()
      } catch (error) {
        console.error(error)
      }
      clearRendering()
      return
    }

    let rendition: RuntimeRef<Rendition>
    try {
      rendition = ref(
        new EpubRendition(epub, {
          width: initialWidth,
          height: initialHeight,
        }),
      )
      epub.rendition = rendition
      await rendition.attachTo(el)
      const renditionManager = rendition.manager
      if (renditionManager) {
        renditionManager.suspendResize = true
      }
    } catch (error) {
      this.reportOpenError('render', error)
      try {
        epub.destroy()
      } catch (destroyError) {
        console.error(destroyError)
      }
      clearRendering()
      return
    }

    if (generation !== this.renderGeneration) {
      try {
        rendition.destroy()
        epub.destroy()
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
    void this.epub.loaded.navigation
      .then((nav) => {
        if (generation !== this.renderGeneration) return
        const previousTocVersion = this.tocVersion
        this.nav = markRuntimeObject(nav)
        this.expandNavPath(this.currentNavItem)
        this.assignSectionNavItems()
        if (this.tocVersion === previousTocVersion) this.tocVersion++
      })
      .catch((error) => {
        this.failCommittedRender(generation, 'spine', error)
      })
    try {
      const spine = await this.epub.loaded.spine
      if (generation !== this.renderGeneration) return
      const sections = spine.spineItems as ISection[]
      sections.forEach((s) => {
        s.images ??= []
      })
      const runtimeSections = markSectionsRuntime(sections)
      this.assignSectionNavItems(sections)
      this.sections = runtimeSections
    } catch (error) {
      this.failCommittedRender(generation, 'spine', error)
      return
    }
    this.setBeforeLayout()
    this.rendition.themes.default(defaultStyle)
    this.rendition.hooks.render.register(() => {
      this.syncFrames()
    })
    if (initialSpread) {
      this.rendition.spread(this.isScrolledDocument ? 'none' : initialSpread)
    }

    this.rendition.on('relocated', (loc: Location, meta?: RelocatedEventMeta) =>
      this.commitRelocatedLocation(loc, meta),
    )

    this.rendition.on('rendered', (section: ISection) => {
      markSectionRuntime(section)
      if (!this.section) this.section = section
      if (!this.visibleSections.length) {
        this.visibleSections = markSectionsRuntime([section])
        this.visibleSectionIndexes = [section.index]
      }
      void this.ensureSectionInfo(section)
      if (!this.syncFrames()) this.bumpViewVersion()
    })
    this.rendition.on('removed', () => {
      if (!this.syncFrames()) this.bumpViewVersion()
    })
    this.rendition.on('externalLinkClicked', (href: string) => {
      void openSupportedExternalUrl(href).catch((error) => {
        console.error(error)
      })
    })

    try {
      await this.displayInitialPosition()
    } catch (error) {
      this.failCommittedRender(generation, 'position', error)
      return
    }
    if (!this.book.managed && this.book.archive) {
      this.rendition.on('displayError', (error: unknown) => {
        if (generation === this.renderGeneration) {
          this.reportOpenError('render', error)
        }
      })
    }
  }

  private failCommittedRender(generation: number, stage: ReaderOpenErrorStage, error: unknown) {
    if (generation !== this.renderGeneration) return

    this.reportOpenError(stage, error)
    this.renderGeneration++
    this.destroyRendering()
  }

  private reportOpenError(stage: ReaderOpenErrorStage, error: unknown) {
    console.error(error)
    emitReaderOpenError({
      bookId: this.book.id,
      bookTitle: getBookDisplayTitle(this.book),
      closeTab: !this.book.managed && this.book.archive === true,
      error,
      stage,
    })
  }

  constructor(public book: BookRecord) {
    super(book.id, book.name)
    Object.defineProperty(this, frameRuntimeIdentity, {
      value: ref({}),
    })
    this.overlayState = {
      annotations: book.annotations,
      definitions: book.definitions,
    }
    this.typographyConfiguration = book.configuration?.typography
    this.cacheActivation = setBookCacheActive(book.id, true).catch(console.error)

    // The constructor instance is not proxied yet, so subscribing here would update a non-reactive object.
  }
}

class PageTab extends BaseTab {
  constructor(public readonly Component: React.FC<any>) {
    super(Component.displayName ?? 'untitled')
  }
}

type Tab = BookTab | PageTab
type TabParam = ConstructorParameters<typeof BookTab | typeof PageTab>[0]

interface BookContentEditPatch {
  target: BookTextReplaceTarget
  oldText: string
  newText: string
  document?: Document
  textNode?: Text
}

function resolveTabParam(param: TabParam | Tab) {
  if (param instanceof BookTab || param instanceof PageTab) return param
  if (typeof param === 'function') return param

  return db.books.peek(param.id) ?? param
}

function disposeTab(tab?: Tab) {
  if (tab instanceof BookTab) return tab.destroy()
  return Promise.resolve()
}

function setTabRuntimeActive(tab: Tab | undefined, active: boolean) {
  if (tab instanceof BookTab) tab.setActive(active)
}

export class Group {
  id = createId()
  paneTabs: Tab[] = []
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
    this.paneTabs = [...this.tabs]
    this.setSelectedRuntimeActive(true)
  }

  get selectedTab() {
    return this.tabs[this.selectedIndex]
  }

  get bookTabs() {
    return this.tabs.filter((t) => t instanceof BookTab) as BookTab[]
  }

  setSelectedRuntimeActive(active: boolean) {
    setTabRuntimeActive(this.selectedTab, active)
  }

  removeTab(index: number) {
    const previousSelectedIndex = this.selectedIndex
    const wasSelected = index === this.selectedIndex
    const tab = this.tabs.splice(index, 1)
    const paneIndex = this.paneTabs.findIndex((item) => item.id === tab[0]?.id)
    if (paneIndex > -1) this.paneTabs.splice(paneIndex, 1)
    setTabRuntimeActive(tab[0], false)
    if (wasSelected) {
      this.selectedIndex = updateIndex(this.tabs, index)
      this.setSelectedRuntimeActive(true)
    } else if (index < previousSelectedIndex) {
      this.selectedIndex = previousSelectedIndex - 1
    }
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

    const tab = isTab ? resolved : isPage ? new PageTab(resolved) : new BookTab(resolved)

    this.setSelectedRuntimeActive(false)
    this.tabs.splice(++this.selectedIndex, 0, tab)
    this.paneTabs.push(tab)
    setTabRuntimeActive(tab, true)
    return tab
  }

  replaceTab(param: TabParam, index = this.selectedIndex) {
    this.addTab(param)
    this.removeTab(index)
  }

  selectTab(index: number) {
    if (index < 0 || index >= this.tabs.length) return
    if (index === this.selectedIndex) return

    this.setSelectedRuntimeActive(false)
    this.selectedIndex = index
    this.setSelectedRuntimeActive(true)
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

  moveTab(fromIndex: number, toIndex: number) {
    if (
      fromIndex < 0 ||
      fromIndex >= this.tabs.length ||
      toIndex < 0 ||
      toIndex >= this.tabs.length ||
      fromIndex === toIndex
    ) {
      return
    }

    const selectedTabId = this.selectedTab?.id
    const [tab] = this.tabs.splice(fromIndex, 1)
    if (!tab) return

    this.tabs.splice(toIndex, 0, tab)
    this.selectedIndex = this.tabs.findIndex((item) => item.id === selectedTabId)
  }

  moveSelectedTab(delta: -1 | 1) {
    const toIndex = this.selectedIndex + delta
    this.moveTab(this.selectedIndex, toIndex)
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

  getOpenBookIds() {
    return [...new Set(this.groups.flatMap(({ bookTabs }) => bookTabs.map((tab) => tab.book.id)))]
  }

  private findBookTab(bookId: string) {
    for (let groupIndex = 0; groupIndex < this.groups.length; groupIndex++) {
      const group = this.groups[groupIndex]
      if (!group) continue
      const tabIndex = group.tabs.findIndex((tab) => tab instanceof BookTab && tab.book.id === bookId)
      if (tabIndex >= 0) {
        return { group, groupIndex, tab: group.tabs[tabIndex] as BookTab, tabIndex }
      }
    }
  }

  private focusBookTab({ group, groupIndex, tab, tabIndex }: NonNullable<ReturnType<Reader['findBookTab']>>) {
    if (groupIndex === this.focusedIndex) {
      group.selectTab(tabIndex)
    } else {
      this.focusedGroup?.setSelectedRuntimeActive(false)
      group.selectedIndex = tabIndex
      this.focusedIndex = groupIndex
      group.setSelectedRuntimeActive(true)
    }
    return tab
  }

  openBookTab(book: BookRecord) {
    return this.addTab(book)
  }

  openBookFromLibrary(book: BookRecord) {
    const existing = this.findBookTab(book.id)
    const tab = this.addTab(book)
    if (tab instanceof BookTab && existing) {
      tab.beginRecentReadingSession()
      tab.recordOpened(true)
    }
    return tab
  }

  addTab(param: TabParam | Tab, groupIdx = this.focusedIndex) {
    const resolved = resolveTabParam(param)
    const bookId =
      resolved instanceof BookTab
        ? resolved.book.id
        : resolved instanceof PageTab || typeof resolved === 'function'
          ? undefined
          : resolved.id
    const existing = bookId ? this.findBookTab(bookId) : undefined
    if (existing) return this.focusBookTab(existing)

    let group = this.groups[groupIdx]
    if (group) {
      this.focusedIndex = groupIdx
    } else {
      group = this.addGroup([])
    }
    return group.addTab(resolved)
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

  closeBookTab(bookId: string) {
    const located = this.findBookTab(bookId)
    if (located) this.removeTab(located.tabIndex, located.groupIndex)
  }

  async applyBookContentEdit(
    book: BookRecord,
    reloadTarget?: string,
    editedTab?: BookTab,
    patch?: BookContentEditPatch,
  ) {
    const tab = this.findBookTab(book.id)?.tab
    const currentBook = tab?.mergeRuntimeState(book) ?? book
    db.books.remember(currentBook)
    if (!tab) return
    if (tab === editedTab && patch) {
      const patched = await tab.applyRenderedTextEdit(
        currentBook,
        patch.target,
        patch.oldText,
        patch.newText,
        patch.document,
        patch.textNode,
      )
      if (!patched) throw new Error('TEXT_REPLACE_RENDER_PATCH_FAILED')
      return
    }
    tab.reloadContentAfterEdit(currentBook, reloadTarget)
  }

  refreshImportedBooks(books: BookRecord[]) {
    const booksById = new Map(books.map((book) => [book.id, book]))
    const openBookIds = new Set<string>()
    if (!booksById.size) return openBookIds

    this.groups.forEach(({ bookTabs }) => {
      bookTabs.forEach((tab) => {
        const book = booksById.get(tab.book.id)
        if (!book) return

        openBookIds.add(book.id)
        const currentBook = tab.mergeRuntimeState(book)
        db.books.remember(currentBook)
        tab.refreshImportedBook(currentBook)
      })
    })
    return openBookIds
  }

  promoteExternalBooks(libraryBooks: BookRecord[]) {
    const booksByHash = new Map(
      libraryBooks
        .filter((book) => book.scope !== 'external' && book.contentHash)
        .map((book) => [book.contentHash, book]),
    )
    if (!booksByHash.size) return Promise.resolve(new Set<string>())

    const promotedBookIds = new Set<string>()
    const tasks = this.groups.flatMap(({ bookTabs }) =>
      bookTabs
        .map((tab) => {
          const book =
            tab.book.scope === 'external' && tab.book.contentHash ? booksByHash.get(tab.book.contentHash) : undefined
          if (!book) return

          promotedBookIds.add(book.id)
          return tab.promoteExternalBook(book)
        })
        .filter((task): task is Promise<void> => !!task),
    )

    return Promise.all(tasks).then(() => promotedBookIds)
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

  moveFocusedTab(delta: -1 | 1) {
    this.focusedGroup?.moveSelectedTab(delta)
  }

  replaceTab(param: TabParam, index = this.focusedIndex, groupIdx = this.focusedIndex) {
    const group = this.groups[groupIdx]
    group?.replaceTab(param, index)
  }

  removeGroup(index: number) {
    this.groups.splice(index, 1)
    this.focusedIndex = updateIndex(this.groups, index)
  }

  addGroup(tabs: Array<Tab | TabParam>, index = this.focusedIndex + 1) {
    this.focusedGroup?.setSelectedRuntimeActive(false)
    const group = proxy(new Group(tabs))
    this.groups.splice(index, 0, group)
    this.focusedIndex = index
    group.setSelectedRuntimeActive(true)
    return group
  }

  selectGroup(index: number) {
    if (index === this.focusedIndex) return

    this.focusedGroup?.setSelectedRuntimeActive(false)
    this.focusedIndex = index
    this.focusedGroup?.setSelectedRuntimeActive(true)
  }

  clear() {
    this.groups.forEach(({ tabs }) => tabs.forEach((tab) => this.trackDisposal(disposeTab(tab))))
    this.groups = []
    this.focusedIndex = -1
  }

  resize() {
    this.groups.forEach(({ bookTabs }) => {
      bookTabs.forEach((tab) => {
        if (!tab.active) return

        try {
          tab.rendition?.resize()
        } catch (error) {
          console.error(error)
        }
      })
    })
  }

  async collectAppCloseReadingPositions() {
    await Promise.all(this.pendingDisposals)
    const positions = await Promise.all(
      this.groups.flatMap(({ bookTabs }) => bookTabs.map((tab) => tab.prepareForAppClose())),
    )
    await db.waitForPendingWrites()
    return positions.filter((position) => position !== undefined)
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
