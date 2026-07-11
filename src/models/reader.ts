import { debounce } from '@github/mini-throttle/decorators'
import React from 'react'
import { proxy, ref, snapshot, useSnapshot } from 'valtio'

import ePub, { Rendition as EpubRendition } from '@flow/epubjs'
import type { Rendition, Location, Book } from '@flow/epubjs'
import epubRequest from '@flow/epubjs/src/utils/request'
import Navigation, { NavItem } from '@flow/epubjs/types/navigation'
import Section from '@flow/epubjs/types/section'
import { IS_SERVER } from '@flow/reader/env'

import {
  AnnotationColor,
  AnnotationType,
  compareDefinition,
  createAnnotationSpine,
  normalizeDefinition,
} from '../annotation'
import { getBookDisplayTitle } from '../book'
import {
  BookReaderSource,
  BookTextReplaceTarget,
  BookRecord,
  ReadingSpreadPageRecord,
  ReadingSpreadRecord,
  cleanupExternalBook,
  db,
  searchBookText,
  unloadBookSearchText,
} from '../db'
import { openSupportedExternalUrl } from '../externalLink'
import { createId } from '../id'
import { normalizeHrefPath, sameHref } from '../noteLinks'
import {
  emitReaderOpenError,
  type ReaderOpenErrorStage,
} from '../readerErrorEvents'
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
  return sameHref(sectionHref, navitemHref)
}

function splitHrefTarget(href: string | undefined) {
  const [path = '', hash] = href?.split('#') ?? []
  return { hash, path }
}

function safeDecode(value: string | undefined) {
  if (!value) return value

  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
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
  return (
    document.body ??
    document.getElementsByTagName('body')[0] ??
    document.documentElement
  )
}

function patchTextNode(
  textNode: Text | undefined,
  target: BookTextReplaceTarget,
  oldText: string,
  newText: string,
) {
  if (!textNode?.isConnected) return false
  const text = textNode.textContent ?? ''
  if (text !== target.textNodeText) return false
  if (text.slice(target.startOffset, target.endOffset) !== oldText) {
    return false
  }

  const updatedText =
    text.slice(0, target.startOffset) + newText + text.slice(target.endOffset)
  textNode.textContent = updatedText

  const parent = textNode.parentElement
  const title = parent?.ownerDocument.querySelector('title')
  if (parent?.closest('h2.flow-txt-chapter') && title?.textContent === text) {
    title.textContent = updatedText
  }
  return true
}

function matchingTextNodeInElement(
  element: Element | undefined,
  targetText: string,
) {
  if (!element) return undefined
  const walker = element.ownerDocument.createTreeWalker(
    element,
    NodeFilter.SHOW_TEXT,
  )
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
    body.querySelectorAll<HTMLElement>(
      '[data-flow-body-text="true"] > p, p[data-flow-body-text="true"]',
    ),
  )
  if (target.paragraphIndex !== undefined) {
    const paragraph = generatedParagraphs[target.paragraphIndex]
    const textNode = matchingTextNodeInElement(paragraph, target.textNodeText)
    if (patchTextNode(textNode, target, oldText, newText)) return true
    return false
  } else {
    const heading = body.querySelector<HTMLElement>('h2.flow-txt-chapter')
    const textNode = matchingTextNodeInElement(
      heading ?? undefined,
      target.textNodeText,
    )
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

function createVersionedEpubRequest(contentVersion?: number) {
  if (!contentVersion) return undefined

  return (
    url: string,
    type?: string | null,
    withCredentials?: boolean,
    headers?: Record<string, string>,
  ) =>
    epubRequest(
      appendUrlQuery(url, 'flowContentVersion', contentVersion),
      type,
      withCredentials,
      headers,
    )
}

function normalizeImageSource(src: string) {
  try {
    return decodeURI(src)
  } catch {
    return src
  }
}

function imageSourcesMatch(a: string | undefined, b: string | undefined) {
  if (!a || !b) return false
  if (a === b) return true

  const normalizedA = normalizeImageSource(a)
  const normalizedB = normalizeImageSource(b)
  return (
    normalizedA === normalizedB ||
    normalizedA.includes(normalizedB) ||
    normalizedB.includes(normalizedA)
  )
}

const imageArtifactSelector = [
  'sup',
  'sub',
  'ruby',
  'rt',
  'rp',
  'small',
  'aside',
  'footer',
  'header',
  'nav',
  '[role="doc-noteref"]',
  '[role="note"]',
  '[epub\\:type~="noteref"]',
  '[epub\\:type~="footnote"]',
  '[epub\\:type~="endnote"]',
  '[epub\\:type~="annotation"]',
  '[class*="note" i]',
  '[class*="footnote" i]',
  '[class*="endnote" i]',
  '[class*="annotation" i]',
].join(',')

const imageTitleSelector = [
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'title',
  '[epub\\:type~="titlepage"]',
  '[epub\\:type~="chapter"] > header',
].join(',')

const decorativeImagePattern =
  /(cover|decor|divider|flower|glyph|icon|note|ornament|title|zhu|注|题|章|節|节)/i
const metadataElementTags = new Set(['LINK', 'META', 'SCRIPT', 'STYLE'])

function textLength(value: string | null | undefined) {
  return value?.replace(/\s+/g, '').length ?? 0
}

function elementName(element: Element) {
  return element.localName.toUpperCase()
}

const NON_TEXT_SIBLING_TAGS = new Set(['IMG', 'SVG', 'PICTURE'])
const SECTION_DOCUMENT_HIGH_WATERMARK = 48
const SECTION_DOCUMENT_LOW_WATERMARK = 32
const SECTION_DOCUMENT_TRIM_DELAY_MS = 5000

function siblingTextLength(element: Element) {
  let length = 0

  for (const node of element.parentElement?.childNodes ?? []) {
    if (node === element) continue
    if (node.nodeType === Node.TEXT_NODE) {
      length += textLength(node.textContent)
    } else if (
      node instanceof Element &&
      !NON_TEXT_SIBLING_TAGS.has(elementName(node))
    ) {
      length += textLength(node.textContent)
    }
  }

  return length
}

function numericDimension(value: string | null) {
  if (!value) return
  const match = value.match(/[\d.]+/)
  if (!match) return

  const numeric = Number(match[0])
  return Number.isFinite(numeric) ? numeric : undefined
}

function imageDeclaredSize(image: HTMLImageElement) {
  const width =
    numericDimension(image.getAttribute('width')) ??
    numericDimension(image.style.width)
  const height =
    numericDimension(image.getAttribute('height')) ??
    numericDimension(image.style.height)

  return { height, width }
}

export function isNearDocumentStart(element: Element) {
  const body = documentBody(element.ownerDocument)
  if (!body) return false

  const walker = element.ownerDocument.createTreeWalker(
    body,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        if (node.nodeType === Node.TEXT_NODE) {
          return textLength(node.textContent)
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_REJECT
        }

        const current = node as Element
        if (current === element) return NodeFilter.FILTER_ACCEPT
        if (current.closest('script, style')) return NodeFilter.FILTER_REJECT
        if (['IMG', 'SVG', 'PICTURE'].includes(elementName(current))) {
          return NodeFilter.FILTER_ACCEPT
        }

        return NodeFilter.FILTER_SKIP
      },
    },
  )

  let meaningful = 0
  let node = walker.nextNode()
  while (node && meaningful < 8) {
    if (node === element) return meaningful <= 3
    meaningful += 1
    node = walker.nextNode()
  }

  return false
}

function nextHeadingTextLength(element: Element) {
  const container = element.closest('div,p,figure,section') ?? element
  let sibling = container.nextElementSibling
  let scanned = 0

  while (sibling && scanned < 8) {
    if (metadataElementTags.has(elementName(sibling))) {
      sibling = sibling.nextElementSibling
      continue
    }

    if (/^H[1-6]$/.test(elementName(sibling))) {
      return textLength(sibling.textContent)
    }
    const heading = sibling.querySelector('h1,h2,h3,h4,h5,h6')
    if (heading) return textLength(heading.textContent)
    if (textLength(sibling.textContent)) scanned += 1
    sibling = sibling.nextElementSibling
  }

  return 0
}

function isImageOnlyBlock(image: HTMLImageElement) {
  const block = image.closest('div,p,figure,section') ?? image.parentElement
  if (!block) return true

  const mediaCount = block.querySelectorAll('img,svg,picture').length
  return mediaCount > 0 && textLength(block.textContent) === 0
}

function isLeadingTitleImage(image: HTMLImageElement) {
  return (
    isNearDocumentStart(image) &&
    isImageOnlyBlock(image) &&
    nextHeadingTextLength(image) > 0
  )
}

function collectSectionImages(section: ISection): ImageEntry[] {
  return [...(section.document?.querySelectorAll('img') ?? [])].map(
    (el, index) => classifyImage(el, index),
  )
}

function classifyImage(image: HTMLImageElement, index: number): ImageEntry {
  const src = image.currentSrc || image.src || image.getAttribute('src') || ''
  const { height, width } = imageDeclaredSize(image)
  const sourceText = [
    src,
    image.getAttribute('alt'),
    image.getAttribute('class'),
    image.getAttribute('id'),
    image.parentElement?.getAttribute('class'),
  ]
    .filter(Boolean)
    .join(' ')
  const siblingText = siblingTextLength(image)
  const parentText = textLength(image.parentElement?.textContent)
  const inlineParent = !!image.closest('p, span, a, em, strong, b, i')
  const likelyInlineBySize =
    (height !== undefined && height <= 48) ||
    (width !== undefined && width <= 48)
  const likelySmallIcon =
    (height !== undefined &&
      height <= 72 &&
      width !== undefined &&
      width <= 72) ||
    (likelyInlineBySize && decorativeImagePattern.test(sourceText))

  let reason: ImageFilterReason | undefined

  if (image.closest(imageArtifactSelector) || likelySmallIcon) {
    reason = 'icon'
  } else if (
    inlineParent &&
    (siblingText > 0 || parentText >= 8) &&
    (likelyInlineBySize || siblingText > 0)
  ) {
    reason = 'inlineGlyph'
  } else if (
    image.closest(imageTitleSelector) ||
    isLeadingTitleImage(image) ||
    (isNearDocumentStart(image) && decorativeImagePattern.test(sourceText))
  ) {
    reason = 'titleArt'
  } else if (
    decorativeImagePattern.test(sourceText) &&
    isNearDocumentStart(image)
  ) {
    reason = 'decorative'
  }

  return {
    hiddenByDefault: !!reason,
    index,
    ...(reason ? { reason } : {}),
    src,
  }
}

function withoutReadingSpread(
  configuration: BookRecord['configuration'] | undefined,
) {
  const { spread, ...rest } = configuration ?? {}
  return rest
}

function isSpreadOnlyConfigurationUpdate(
  changes: Partial<BookRecord>,
  currentBook: BookRecord,
) {
  if (!('configuration' in changes)) return true

  return (
    JSON.stringify(withoutReadingSpread(changes.configuration)) ===
    JSON.stringify(withoutReadingSpread(currentBook.configuration))
  )
}

function isReadingPositionOnlyUpdate(
  changes: Partial<BookRecord>,
  currentBook: BookRecord,
) {
  const keys = Object.keys(changes)
  return (
    keys.some((key) => key === 'cfi' || key === 'percentage') &&
    isSpreadOnlyConfigurationUpdate(changes, currentBook) &&
    keys.every((key) =>
      [
        'cfi',
        'percentage',
        'updatedAt',
        'lastReadAt',
        'configuration',
      ].includes(key),
    )
  )
}

function reassignAnnotationBookIds(
  annotations: BookRecord['annotations'],
  bookId: string,
) {
  return annotations.map((annotation) => ({
    ...annotation,
    bookId,
  }))
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

function fallbackReadingPercentage(location: Location) {
  if (location.atStart) return 0
  if (location.atEnd) return 1

  return displayLocationPercentage(location.end ?? location.start)
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
  length: number
  images: ImageEntry[]
  navitem?: INavItem
  resourceAvailable?: boolean
}

export type ImageFilterReason =
  | 'decorative'
  | 'duplicate'
  | 'icon'
  | 'inlineGlyph'
  | 'titleArt'

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

export type BookTypographyConfiguration = NonNullable<
  BookRecord['configuration']
>['typography']

export interface PaginationSnapshot {
  location: Location
  percentage?: number
  spreadDivisor: number
  writingMode?: string
  pageProgressionDirection?: 'ltr' | 'rtl'
  spreadSlotOrder?: 'left-first' | 'right-first'
  layoutVersion: number
  paginationVersion: number
  headerPath: HeaderPathItem[]
  visibleSectionIndexes: number[]
}

interface ReadingOrderSpread {
  left?: { section?: { index?: number } }
  right?: { section?: { index?: number } }
}

export function readingOrderStartSectionIndex(
  spread: ReadingOrderSpread | undefined,
  spreadSlotOrder: PaginationSnapshot['spreadSlotOrder'],
  fallback?: number,
) {
  const primary =
    spreadSlotOrder === 'right-first' ? spread?.right : spread?.left
  const secondary =
    spreadSlotOrder === 'right-first' ? spread?.left : spread?.right

  return primary?.section?.index ?? secondary?.section?.index ?? fallback
}

export interface HeaderPathItem {
  id?: string
  href?: string
  label: string
}

interface RelocatedEventMeta {
  requestId?: number
}

interface LocationRequestIntent {
  anchorTarget?: string
  layoutKey?: string
  updateAnchor: boolean
}

interface SectionNavEntry {
  href: string
  hash?: string
  item: INavItem
  order: number
  sectionIndex: number
}

interface SectionNavAnchorEntry extends SectionNavEntry {
  cfi: string
}

interface SectionNavIndex {
  nav: Navigation
  sections: ISection[]
  exactBySectionHref: Map<string, INavItem>
  firstNavItemById: Map<string, INavItem>
  entriesBySectionIndex: Map<number, SectionNavEntry[]>
  anchorEntriesBySectionIndex: Map<number, SectionNavAnchorEntry[]>
  anchorPromisesBySectionIndex: Map<number, Promise<SectionNavAnchorEntry[]>>
  entries: SectionNavEntry[]
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

function locationEndsAtDisplayedPageEnd(location?: Location) {
  const displayed = location?.end?.displayed
  return (
    typeof displayed?.page === 'number' &&
    typeof displayed.total === 'number' &&
    displayed.total > 0 &&
    displayed.page >= displayed.total
  )
}

function snapshotReflowableSpread(
  manager: any,
  layoutStyleSignature?: string,
  location?: Location,
): ReadingSpreadRecord | undefined {
  const spread = manager?.currentReflowableSpread
  if (!manager?.canUseLogicalReflowableSpread?.() || !spread) return

  const left = snapshotReflowablePage(spread.left)
  const right = snapshotReflowablePage(spread.right)
  const endsAtSectionEnd =
    Boolean(spread.endsAtSectionEnd) || locationEndsAtDisplayedPageEnd(location)
  const endAnchoredPage = endsAtSectionEnd ? (right ?? left) : undefined
  const anchor =
    endAnchoredPage || (spread.anchor === 'right' && right)
      ? 'right'
      : spread.anchor === 'left' && left
        ? 'left'
        : left
          ? 'left'
          : 'right'
  const page =
    endAnchoredPage ?? (anchor === 'right' ? (right ?? left) : (left ?? right))
  if (!page) return

  return {
    ...page,
    version: 1,
    anchor,
    exact: !endsAtSectionEnd,
    ...(left ? { left } : {}),
    ...((endAnchoredPage ?? right) ? { right: endAnchoredPage ?? right } : {}),
    ...(endsAtSectionEnd ? { endsAtSectionEnd: true } : {}),
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

  if (spread.left || spread.right) {
    const left = hydrateReflowablePage(spread.left, sections)
    const right = hydrateReflowablePage(spread.right, sections)
    const anchor = spread.anchor === 'right' ? 'right' : 'left'
    const anchorPage = anchor === 'right' ? right : left
    if (!anchorPage) return

    return {
      exact: spread.exact ?? true,
      anchor,
      ...(left ? { left } : {}),
      ...(right ? { right } : {}),
      ...(spread.endsAtSectionEnd ? { endsAtSectionEnd: true } : {}),
    }
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

function readingSpreadSectionIndexes(spread: ReadingSpreadRecord) {
  const pages =
    spread.left || spread.right ? [spread.left, spread.right] : [spread]

  return pages
    .filter((page): page is ReadingSpreadPageRecord => Boolean(page))
    .map((page) => page.sectionIndex)
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
  private pendingBookUpdate?: Partial<BookRecord>
  private pendingBookUpdateTimer?: ReturnType<typeof setTimeout>
  private destroyPromise?: Promise<void>
  private navigationPromise?: Promise<void>
  private renderGeneration = 0
  private sectionNavIndex?: SectionNavIndex
  private currentSpreadState?: ReadingSpreadRecord
  private preferredSectionIndex?: number
  private allowLocationJump = false
  private navigationDirection?: -1 | 1
  private relayoutAnchorSectionIndexes?: number[]
  private acceptedLocationRequests = new Map<number, LocationRequestIntent>()
  private runtimeAnchorCfi?: string
  private runtimeSpreadAnchor?: ReadingSpreadRecord
  private contentReloadTarget?: string
  private spreadAnchorsByLayout = new Map<string, ReadingSpreadRecord>()
  private navRefreshGeneration = 0
  private layoutOperationId = 0
  private layoutOperationPromise = Promise.resolve()
  private readingPositionSequence = 0
  private sectionDocumentAccessSeq = 0
  private sectionDocumentAccess = new Map<number, number>()
  private pendingSectionInfoIndexes = new Set<number>()
  private sectionDocumentTrimTimer?: ReturnType<typeof setTimeout>
  rejectedLocationEventCount = 0

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

  private sectionForDisplayTarget(target?: string) {
    if (!target) return

    try {
      return this.epub?.spine?.get(target) as ISection | undefined
    } catch (error) {
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

  private committedDisplayTarget() {
    const target = this.currentAnchorCfi()
    return this.sectionForDisplayTarget(target) ? target : undefined
  }

  private initialDisplayTarget() {
    const candidates = [
      this.currentAnchorCfi(),
      this.book.cfi,
      (this.epub?.spine?.get() as ISection | undefined)?.href,
    ]

    return candidates.find((target) => this.sectionForDisplayTarget(target))
  }

  getCurrentDisplayTarget() {
    return this.committedDisplayTarget()
  }

  resizeRendition(width: number, height: number) {
    const operationId = ++this.layoutOperationId

    this.layoutOperationPromise = this.layoutOperationPromise
      .catch(() => undefined)
      .then(() => this.runResizeRendition(operationId, width, height))
  }

  private async runResizeRendition(
    operationId: number,
    width: number,
    height: number,
  ) {
    if (operationId !== this.layoutOperationId) return

    const target = this.committedDisplayTarget()
    if (!target) return

    this.rememberCurrentLayoutSpread()
    this.allowLocationJump = false
    this.navigationDirection = undefined
    this.relayoutAnchorSectionIndexes = [...this.visibleSectionIndexes]
    const rendition = this.rendition as any
    const manager = rendition?.manager
    const layoutKey = this.layoutAnchorKey(width, height)
    const spread =
      this.storedSpreadForLayout(width, height) ??
      hydrateReflowableSpread(
        this.runtimeSpreadAnchor,
        this.sections,
        this.layoutStyleSignature,
      )

    if (!rendition || !manager) return

    rendition._flowSuppressResizeRedisplay = true
    try {
      rendition.resize(width, height, target)
    } finally {
      rendition._flowSuppressResizeRedisplay = false
    }

    try {
      if (spread && manager.renderReflowableSpread) {
        const requestId = this.createManualLocationRequest({
          layoutKey,
          updateAnchor: false,
        })
        await manager.renderReflowableSpread(spread)
        await (this.rendition as any)?.reportLocation(requestId)
        this.commitPendingRenditionLocation(requestId)
        return
      }

      const previousRequestId = this.currentRenditionLocationRequestId()
      const display = this.rendition?.display(target)
      const requestId = this.trackRenditionLocationRequest(previousRequestId, {
        layoutKey,
        updateAnchor: false,
      })
      await display
      this.commitPendingRenditionLocation(requestId)
    } catch (error) {
      console.error(error)
    }
  }

  private resolveDisplayTarget(
    target?: string,
    fallback: 'current' | 'initial' | false = 'current',
  ) {
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
    const resolvedTarget = this.resolveDisplayTarget(
      target,
      target ? false : 'current',
    )
    if (!resolvedTarget || !this.rendition) return

    const resolvedSection =
      preferredSection ?? this.sectionForDisplayTarget(resolvedTarget)
    this.preferredSectionIndex = resolvedSection?.index
    this.allowLocationJump = true
    this.navigationDirection = undefined
    this.relayoutAnchorSectionIndexes = undefined
    if (returnable) this.showPrevLocation()

    try {
      const previousRequestId = this.currentRenditionLocationRequestId()
      const display = this.rendition.display(resolvedTarget, {
        alignTargetAsSpreadStart,
      })
      const requestId = this.trackRenditionLocationRequest(previousRequestId, {
        anchorTarget: resolvedTarget,
        updateAnchor: true,
      })
      await display
      this.commitPendingRenditionLocation(requestId)
    } catch (error) {
      console.error(error)
    }
  }

  display(target?: string, returnable = true) {
    void this.displayResolvedTarget(target, { returnable })
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
  async displayTarget(
    section: ISection,
    target?: string,
    { alignTargetAsSpreadStart = false } = {},
  ) {
    await this.displayResolvedTarget(
      target?.startsWith('#')
        ? `${section.href}${target}`
        : (target ?? section.href),
      {
        alignTargetAsSpreadStart,
        preferredSection: section,
        returnable: false,
      },
    )
  }

  async displayFromSelector(
    selector: string,
    section: ISection,
    returnable = true,
    alignTargetAsSpreadStart = false,
  ) {
    try {
      await this.ensureSectionInfo(section)
      const el = section.document.querySelector(selector)
      if (el) {
        const cfi = selector.startsWith('#')
          ? selector
          : section.cfiFromElement(el)
        if (returnable) this.showPrevLocation()
        await this.displayTarget(section, cfi, { alignTargetAsSpreadStart })
      } else {
        await this.displaySectionStart(section)
      }
    } catch (err) {
      this.display(section.href, returnable)
    }
  }

  async displayImage(
    section: ISection,
    src: string,
    index: number,
    returnable = true,
  ) {
    try {
      await this.ensureSectionInfo(section)
      const images = [
        ...(section.document?.querySelectorAll('img') ?? []),
      ] as HTMLImageElement[]
      const el =
        images.find((image) => imageSourcesMatch(image.src, src)) ??
        images[index]

      if (el) {
        const cfi = section.cfiFromElement(el)
        if (returnable) this.showPrevLocation()
        await this.displayTarget(section, cfi)
        return
      }

      await this.displaySectionStart(section)
    } catch (err) {
      this.display(section.href, returnable)
    }
  }

  async displaySearchResult(result: IMatch, keyword = this.keyword) {
    if (result.cfi) {
      const section =
        this.sections?.find((s) => s.index === result.sectionIndex) ??
        this.sections?.find((s) => s.href === result.href)

      if (section) {
        this.showPrevLocation()
        await this.displayTarget(section, result.cfi)
      } else {
        this.display(result.cfi)
      }
      return
    }

    const section =
      this.sections?.find((s) => s.index === result.sectionIndex) ??
      this.sections?.find((s) => s.href === result.href)

    if (!section) {
      this.display(result.href)
      return
    }

    try {
      await this.ensureSectionInfo(section)
      const matches = section.find(keyword) as Array<{
        cfi?: string
      }>
      const match = matches[result.occurrence ?? 0] ?? matches[0]
      if (match?.cfi) {
        result.cfi = match.cfi
        this.showPrevLocation()
        await this.displayTarget(section, match.cfi)
        return
      }
    } catch (error) {
      console.error(error)
    }

    this.showPrevLocation()
    await this.displaySectionStart(section)
  }
  async prev() {
    if (this.turning) return

    return this.runNavigation(async () => {
      this.preferredSectionIndex = undefined
      this.navigationDirection = -1
      this.allowLocationJump = false
      this.relayoutAnchorSectionIndexes = undefined
      const previousRequestId = this.currentRenditionLocationRequestId()
      const navigation = this.rendition?.prev()
      const requestId = this.trackRenditionLocationRequest(previousRequestId, {
        updateAnchor: true,
      })
      await navigation
      this.commitPendingRenditionLocation(requestId)
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
      this.preferredSectionIndex = undefined
      this.navigationDirection = 1
      this.allowLocationJump = false
      this.relayoutAnchorSectionIndexes = undefined
      const previousRequestId = this.currentRenditionLocationRequestId()
      const navigation = this.rendition?.next()
      const requestId = this.trackRenditionLocationRequest(previousRequestId, {
        updateAnchor: true,
      })
      await navigation
      this.commitPendingRenditionLocation(requestId)
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

  private async displayCurrentSectionStartBeforePreviousSection() {
    const manager = this.rendition?.manager
    const spread = manager?.currentReflowableSpread

    if (manager?.canUseLogicalReflowableSpread?.() && spread) {
      const page =
        manager.reflowableSpreadEarlierPage?.(spread) ??
        spread.left ??
        spread.right
      if (page?.section && page.pageIndex > 0) {
        await this.displaySectionStart(page.section)
        return true
      }

      return false
    }

    const start = this.location?.start
    const pageNumber = start?.displayed?.page
    if (!start || typeof pageNumber !== 'number' || pageNumber <= 1) {
      return false
    }

    const currentPosition = this.sectionPositionFromLocation(start)
    const section = this.sections?.[currentPosition]
    if (!section) return false

    await this.displaySectionStart(section)
    return true
  }

  private async navigateNavItem(direction: -1 | 1) {
    const point = direction > 0 ? this.location?.end : this.location?.start
    const navIndex = this.getSectionNavIndex()
    const entries = navIndex?.entries
    if (!entries?.length) return false

    const anchor = await this.navAnchorForLocationPoint(point)
    const pointSection = this.sectionFromLocationPoint(point)
    const singleSectionEntry = pointSection
      ? navIndex?.entriesBySectionIndex.get(pointSection.index)?.length === 1
        ? navIndex.entriesBySectionIndex.get(pointSection.index)?.[0]
        : undefined
      : undefined
    const anchorItem = anchor?.item ?? singleSectionEntry?.item
    if (!anchorItem) return false

    const index = entries.findIndex((entry) => entry.item === anchorItem)
    const target = index < 0 ? undefined : entries[index + direction]
    if (!target) return false

    const section = this.sections?.find(
      (section) => section.index === target.sectionIndex,
    )
    if (!section) return false

    await this.displayTarget(
      section,
      target.hash ? `#${target.hash}` : undefined,
      { alignTargetAsSpreadStart: true },
    )
    return true
  }

  private async navigateSection(direction: -1 | 1) {
    if (this.turning || !this.sections?.length || !this.location) return

    return this.runNavigation(async () => {
      if (await this.navigateNavItem(direction)) return

      if (
        direction < 0 &&
        (await this.displayCurrentSectionStartBeforePreviousSection())
      ) {
        return
      }

      const location = direction > 0 ? this.location?.end : this.location?.start
      const currentPosition = this.sectionPositionFromLocation(location)
      if (currentPosition === -1) return

      const target = this.sections?.[currentPosition + direction]
      if (!target) return

      await this.displaySectionStart(target)
    })
  }
  prevSection() {
    return this.navigateSection(-1)
  }
  nextSection() {
    return this.navigateSection(1)
  }

  private setBook(book: BookRecord) {
    this.book = book
    this.overlayState = {
      annotations: book.annotations,
      definitions: book.definitions,
    }
    this.typographyConfiguration = book.configuration?.typography
  }

  reloadContentAfterEdit(book: BookRecord, target?: string) {
    this.setBook(book)
    this.annotationRange = undefined
    this.annotationCfi = undefined
    this.runtimeAnchorCfi = undefined
    this.runtimeSpreadAnchor = undefined
    this.spreadAnchorsByLayout.clear()
    this.destroyRendering()
    this.contentReloadTarget = target
    this.bumpViewVersion()
  }

  async promoteExternalBook(libraryBook: BookRecord) {
    if (this.book.scope !== 'external') return
    if (
      !this.book.contentHash ||
      this.book.contentHash !== libraryBook.contentHash
    ) {
      return
    }

    const reloadTarget = this.getCurrentDisplayTarget()
    await this.flushForClose({
      flushStorage: false,
      recordReadingPosition: false,
    })

    const stateChanges: Partial<BookRecord> = {
      annotations: reassignAnnotationBookIds(
        this.book.annotations,
        libraryBook.id,
      ),
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
    const manager = this.rendition?.manager as any
    const views = manager?.views?._views as
      | Array<{
          section?: ISection
          document?: Document
          contents?: { document?: Document }
          window?: Window
          layout?: { format?: (...args: any[]) => void }
          axis?: string
          expand?: () => void
          _contentPageCount?: number
        }>
      | undefined
    const selectionView = selectionDocument?.defaultView
      ? this.viewForWindow(selectionDocument.defaultView)
      : undefined
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

    const frameDocuments = [
      selectionDocument,
      view.contents?.document,
      view.window?.document,
      view.document,
    ].filter((document, index, documents): document is Document => {
      return !!document && documents.indexOf(document) === index
    })
    const patchedFrame = frameDocuments.some((document) =>
      patchDocumentTextNode(
        document,
        target,
        oldText,
        newText,
        selectionTextNode,
      ),
    )
    if (!patchedFrame) return false

    const sectionDocument = (view.section as any)?.document as
      | Document
      | undefined
    if (sectionDocument && !frameDocuments.includes(sectionDocument)) {
      patchDocumentTextNode(sectionDocument, target, oldText, newText)
    }

    this.setBook(book)
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
      await (this.rendition as any)?.reportLocation(requestId)
      this.commitPendingRenditionLocation(requestId)
    } catch (error) {
      console.error(error)
    }
    this.bumpViewVersion()
    return true
  }

  private syncOverlayState(changes: Partial<BookRecord>) {
    if (!('annotations' in changes) && !('definitions' in changes)) return

    this.overlayState = {
      annotations: changes.annotations ?? this.overlayState.annotations,
      definitions: changes.definitions ?? this.overlayState.definitions,
    }
  }

  private syncTypographyConfiguration(changes: Partial<BookRecord>) {
    if (!('configuration' in changes)) return

    const typography = changes.configuration?.typography
    if (typography === this.typographyConfiguration) return

    this.typographyConfiguration = typography
  }

  updateBook(changes: Partial<BookRecord>) {
    const readingPositionOnly = isReadingPositionOnlyUpdate(changes, this.book)
    const updatedAt = Date.now()

    changes = {
      ...changes,
      updatedAt,
      ...(readingPositionOnly ? { lastReadAt: updatedAt } : {}),
    }
    // don't wait promise resolve to make valtio batch updates
    this.book = { ...this.book, ...changes }
    this.syncOverlayState(changes)
    this.syncTypographyConfiguration(changes)
    db.books.remember(this.book)

    if (readingPositionOnly) {
      void this.recordReadingPosition(changes).catch((error) => {
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

  private createCurrentPositionUpdate(
    percentage?: number,
  ): Partial<BookRecord> | undefined {
    if (!this.currentLocation || !this.sections) return

    percentage ??= calculateReadingPercentage({
      location: this.currentLocation,
      sections: this.sections,
      totalLength: this.totalLength,
    })

    const cfi = this.locationAnchorCfi(this.currentLocation)

    return {
      cfi,
      percentage,
      configuration: mergeConfigurationWithSpread(
        this.book.configuration,
        this.currentSpreadState,
      ),
    }
  }

  private recordReadingPosition(changes: Partial<BookRecord>) {
    return db.books.recordReadingPosition({
      bookId: this.book.id,
      cfi: changes.cfi,
      percentage: changes.percentage,
      spread: changes.configuration?.spread ?? null,
      updatedAt: changes.updatedAt ?? Date.now(),
      sequence: ++this.readingPositionSequence,
    })
  }

  async flushForClose({
    flushStorage = true,
    recordReadingPosition = true,
  } = {}) {
    try {
      await this.navigationPromise
    } catch (error) {
      console.error(error)
    }

    const positionUpdate = this.createCurrentPositionUpdate()
    if (positionUpdate) {
      const updatedAt = Date.now()
      const changes = {
        ...positionUpdate,
        updatedAt,
        lastReadAt: updatedAt,
      }
      this.setBook({ ...this.book, ...changes })
      db.books.remember(this.book)
      if (recordReadingPosition) await this.recordReadingPosition(changes)
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
  setAnnotationRange(cfi: string, target?: EventTarget | null) {
    const doc =
      target && 'ownerDocument' in target
        ? (target.ownerDocument as Document | undefined)
        : undefined
    const targetView = doc?.defaultView
      ? this.viewForWindow(doc.defaultView)
      : undefined
    const views = this.rendition?.manager?.views?._views ?? []
    const candidates = [targetView, this.view, ...views].filter(Boolean)

    for (const view of [...new Set(candidates)] as any[]) {
      try {
        const range = view?.contents?.range(cfi)
        if (range) {
          this.annotationRange = ref(range)
          this.annotationCfi = cfi
          return true
        }
      } catch (error) {
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

  private commitPaginationSnapshot(
    location: Location,
    percentage?: number,
    activeSection = this.section,
  ) {
    const manager = this.rendition?.manager
    const divisor = manager?.layout?.divisor
    const paginationModel = manager?.paginationModel?.()

    this.paginationVersion++
    this.paginationSnapshot = {
      location,
      percentage,
      spreadDivisor:
        typeof divisor === 'number' && Number.isFinite(divisor) && divisor > 0
          ? divisor
          : 1,
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

  private currentRenditionLocationRequestId() {
    const requestId = (this.rendition as any)?._locationRequestId
    return typeof requestId === 'number' ? requestId : undefined
  }

  private trackRenditionLocationRequest(
    previousRequestId: number | undefined,
    intent: LocationRequestIntent,
  ) {
    const requestId = this.currentRenditionLocationRequestId()
    if (requestId === undefined || requestId === previousRequestId) return

    this.acceptedLocationRequests.set(requestId, intent)
    return requestId
  }

  private createManualLocationRequest(intent: LocationRequestIntent) {
    const rendition = this.rendition as any
    if (!rendition) return

    const requestId =
      typeof rendition._locationRequestId === 'number'
        ? rendition._locationRequestId + 1
        : 1
    rendition._locationRequestId = requestId
    this.acceptedLocationRequests.set(requestId, intent)
    return requestId
  }

  private commitPendingRenditionLocation(requestId: number | undefined) {
    if (
      typeof requestId !== 'number' ||
      !this.acceptedLocationRequests.has(requestId)
    ) {
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

        const currentSpreadState = snapshotReflowableSpread(
          this.rendition?.manager,
          this.layoutStyleSignature,
          loc,
        )
        this.currentLocation = loc
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
        void this.refreshVisibleNavItems(
          loc,
          activeSection,
          ++this.navRefreshGeneration,
        )
        this.commitPaginationSnapshot(loc, percentage, activeSection)
        this.clearLocationIntent()
        this.rendered = true
        return
      }

      percentage = calculateReadingPercentage({
        location: loc,
        sections: this.sections,
        totalLength: this.totalLength,
      })
    }

    if (!this.shouldAcceptRelocatedLocation(percentage, visibleSections)) {
      this.rejectedLocationEventCount++
      return
    }

    const currentSpreadState = snapshotReflowableSpread(
      this.rendition?.manager,
      this.layoutStyleSignature,
      loc,
    )
    this.currentLocation = loc
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
      const activeNavItem =
        activeSection?.navitem ??
        this.mapSectionToNavItem(activeSection?.href ?? start.href)
      if (activeSection && activeNavItem) {
        activeSection.navitem = activeNavItem
      }
      this.expandNavPath(activeNavItem)
      void this.refreshVisibleNavItems(
        loc,
        activeSection,
        ++this.navRefreshGeneration,
      )

      const positionUpdate = this.createCurrentPositionUpdate(percentage)
      if (positionUpdate) {
        this.updateBook(positionUpdate)
      }
    }

    this.commitPaginationSnapshot(loc, percentage, activeSection)
    this.clearLocationIntent()
    this.rendered = true
  }

  private updateRuntimeAnchorCfi(
    location: Location,
    intent: LocationRequestIntent,
  ) {
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
  }

  define(def: string[]) {
    const definitions = [...this.book.definitions]
    let changed = false

    def.forEach((item) => {
      const definition = normalizeDefinition(item)
      if (!definition) return
      if (
        definitions.some((current) => compareDefinition(current, definition))
      ) {
        return
      }

      definitions.push(definition)
      changed = true
    })

    if (!changed) return

    this.updateBook({ definitions })
    this.bumpOverlayVersion()
  }
  undefine(def: string) {
    const definitions = this.book.definitions.filter(
      (d) => !compareDefinition(d, def),
    )
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
        id: createId(),
        bookId: this.book.id,
        cfi,
        spine: annotationSpine,
        createAt: now,
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
    const annotations = snapshot(this.book.annotations).filter(
      (a) => a.cfi !== cfi,
    )
    if (annotations.length === this.book.annotations.length) return

    this.updateBook({ annotations })
    this.bumpOverlayVersion()
  }

  keyword = ''
  tocVersion = 0
  setKeyword(keyword: string) {
    if (this.keyword === keyword) return
    this.keyword = keyword
    this.activeResultID = undefined
    this.onKeywordChange()
  }

  // only use throttle/debounce for side effects
  @debounce(1000)
  async onKeywordChange() {
    const keyword = this.keyword
    const results = await this.search(keyword)
    if (this.keyword === keyword) {
      this.results = results
    }
  }

  get totalLength() {
    return this.sections?.reduce((acc, s) => acc + s.length, 0) ?? 0
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
            entry.href &&
            (entry.href.endsWith(`/${normalizedHref}`) ||
              normalizedHref.endsWith(`/${entry.href}`)),
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

          exactBySectionHref.set(
            matchedSection.href,
            exactBySectionHref.get(matchedSection.href) ?? navItem,
          )
          entries.push(entry)

          const sectionEntries =
            entriesBySectionIndex.get(matchedSection.index) ?? []
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
    } catch (error) {
      return nextIndex
    }
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

  private sectionHasMultipleNavItems(section: ISection | undefined) {
    if (!section) return false

    const entries = this.getSectionNavIndex()?.entriesBySectionIndex.get(
      section.index,
    )
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

  private async createNavAnchorsForSection(
    section: ISection,
    entries: SectionNavEntry[],
  ) {
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
      } catch (error) {
        return []
      }
    })

    anchors.sort((a, b) => this.compareCfi(a.cfi, b.cfi) || a.order - b.order)
    this.getSectionNavIndex()?.anchorEntriesBySectionIndex.set(
      section.index,
      anchors,
    )
    return anchors
  }

  private findNavAnchorElement(section: ISection, hash: string | undefined) {
    const document = section.document
    if (!document) return

    const decoded = safeDecode(hash)
    if (!hash) return document.body

    return (
      document.getElementById(hash) ??
      (decoded && decoded !== hash
        ? document.getElementById(decoded)
        : undefined)
    )
  }

  private compareCfi(a: string, b: string) {
    try {
      return this.rendition?.epubcfi?.compare(a, b) ?? 0
    } catch {
      return 0
    }
  }

  private navItemFromCachedSectionCfi(
    section: ISection | undefined,
    cfi: string | undefined,
  ) {
    if (!section || !cfi) return

    const anchors = this.getSectionNavIndex()?.anchorEntriesBySectionIndex.get(
      section.index,
    )
    if (!anchors?.length) return

    return this.pickNavAnchorForCfi(anchors, cfi)?.item
  }

  private pickNavAnchorForCfi(
    anchors: SectionNavAnchorEntry[],
    cfi: string | undefined,
  ) {
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

  private sameNavAnchorTarget(
    a: SectionNavAnchorEntry,
    b: SectionNavAnchorEntry,
  ) {
    return (
      a.sectionIndex === b.sectionIndex &&
      a.href === b.href &&
      a.hash === b.hash
    )
  }

  private async navAnchorForLocationPoint(
    point: Pick<Location['start'], 'index' | 'href' | 'cfi'> | undefined,
  ) {
    const section = this.sectionFromLocationPoint(point)
    if (!section || !this.sectionHasMultipleNavItems(section)) return

    const anchors = await this.navAnchorsForSection(section)
    return this.pickNavAnchorForCfi(anchors, point?.cfi)
  }

  get currentHref() {
    return this.location?.start.href
  }

  private sectionFromLocationPoint(
    point?: Pick<Location['start'], 'index' | 'href'>,
  ) {
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

  private commitVisibleSections(
    location: Location,
    visibleSections = this.visibleSectionsForLocation(location),
  ) {
    this.visibleSections = markSectionsRuntime(visibleSections)
    this.visibleSectionIndexes = visibleSections.map((section) => section.index)

    const preferredSection =
      this.preferredSectionIndex === undefined
        ? undefined
        : visibleSections.find(
            (section) => section.index === this.preferredSectionIndex,
          )
    const startSection = this.sectionFromLocationPoint(location.start)
    const activeSection =
      preferredSection ?? startSection ?? visibleSections[0] ?? this.section

    if (activeSection) {
      markSectionRuntime(activeSection)
      this.assignSectionNavItem(activeSection)
      this.section = activeSection
    }

    return activeSection
  }

  private async refreshVisibleNavItems(
    location: Location,
    activeSection: ISection | undefined,
    generation: number,
  ) {
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

  private shouldAcceptRelocatedLocation(
    percentage: number | undefined,
    visibleSections: ISection[],
  ) {
    if (this.relayoutAnchorSectionIndexes?.length) {
      const nextIndexes = new Set(
        visibleSections.map((section) => section.index),
      )
      const stillAnchored = this.relayoutAnchorSectionIndexes.some((index) =>
        nextIndexes.has(index),
      )
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

    const nextIndexes = visibleSections
      .map((section) => section.index)
      .filter((index) => typeof index === 'number')
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
      this.navItemFromCachedSectionCfi(
        currentSection,
        this.location?.start.cfi,
      ) ??
      currentSection?.navitem ??
      (this.currentHref
        ? this.mapSectionToNavItem(this.currentHref)
        : undefined)
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
    const navItem =
      section?.navitem ??
      (section?.href ? this.mapSectionToNavItem(section.href) : undefined)
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

  viewForRange(range: Range) {
    const doc =
      range.commonAncestorContainer.ownerDocument ??
      (range.commonAncestorContainer as Document)

    return this.viewForWindow(doc.defaultView) ?? this.view
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
    const windows: Window[] = views
      .map((view: any) => view.window as Window | undefined)
      .filter((win: Window | undefined): win is Window => !!win)
    const iframes = this.iframes

    if (
      windows.length === iframes.length &&
      windows.every((win, index) => iframes[index] === win)
    ) {
      return false
    }

    const nextIframes = windows.map(
      (win: Window) => ref(win) as unknown as Window & AsRef,
    )

    this.iframes = nextIframes
    this.iframe = nextIframes[0]
    this.bumpViewVersion()
    return true
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
      void unloadBookSearchText(this.book.id).catch(console.error)
      this.destroyRendering()
      if (this.book.scope === 'external') {
        await cleanupExternalBook(this.book.id).catch(console.error)
      }
    }
  }

  private destroyRendering() {
    this.layoutOperationId++

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
          const firstParent =
            this.getSectionNavIndex()?.firstNavItemById.get(parentId)
          if (firstParent) {
            if (
              firstParent === navItem ||
              (firstParent.id === navItem.id &&
                firstParent.parent === navItem.parent)
            ) {
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
    const query = keyword.trim()
    if (!query || !section?.document?.body) return

    const subitems = section.find(query) as unknown as IMatch[]
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

  async search(keyword = this.keyword) {
    if (!keyword.trim()) return undefined

    try {
      return (await searchBookText(this.book.id, keyword)) as IMatch[]
    } catch (error) {
      console.error(error)
      return []
    }
  }

  private assignSectionNavItem(section: ISection, sections = this.sections) {
    const navitem = this.mapSectionToNavItem(section.href, sections)
    if (navitem) section.navitem = navitem
  }

  private assignSectionNavItems(sections = this.sections) {
    if (!this.nav || !sections) return

    const index = this.getSectionNavIndex(sections)
    if (!index) return

    const orderedSections = [...sections].sort(
      (a, b) => (a.index ?? 0) - (b.index ?? 0),
    )
    let entryIndex = 0
    let nearestNavItem: INavItem | undefined

    orderedSections.forEach((section) => {
      const exact = index.exactBySectionHref.get(section.href)
      if (exact) {
        section.navitem = exact
        return
      }

      while (
        entryIndex < index.entries.length &&
        index.entries[entryIndex]!.sectionIndex <= section.index
      ) {
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
    return (
      this.sections?.filter((section) => !!section.document?.body).length ?? 0
    )
  }

  private protectedSectionDocumentIndexes() {
    const indexes = new Set<number>([
      ...this.visibleSectionIndexes,
      ...this.pendingSectionInfoIndexes,
    ])

    if (this.section?.index !== undefined) {
      indexes.add(this.section.index)
    }

    const views = this.rendition?.manager?.views?._views as
      | Array<{ section?: ISection }>
      | undefined
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
      .sort(
        (a, b) =>
          (this.sectionDocumentAccess.get(a.index) ?? 0) -
          (this.sectionDocumentAccess.get(b.index) ?? 0),
      )

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
      section.length = 0
      section.images = []
      section.imageInfoLoaded = true
      return
    }

    if (section.document?.body && section.length !== undefined) {
      if (!section.imageInfoLoaded) {
        section.images = collectSectionImages(section)
        section.imageInfoLoaded = true
      }
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
        section.length = section.document?.body?.textContent?.length ?? 0
        if (!section.imageInfoLoaded) {
          section.images = collectSectionImages(section)
          section.imageInfoLoaded = true
        }
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
  onBeforeLayout?: (contents?: any, view?: any) => void
  private layoutStyleSignature?: string

  setBeforeLayout(
    beforeLayout?: (contents?: any, view?: any) => void,
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
    manager.viewSettings.beforeLayout = (contents: any, view: any) => {
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

  private layoutAnchorKey(width?: number, height?: number) {
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
      (this.rendition as any)?.settings?.spread ?? '',
    ].join(':')
  }

  private rememberCurrentLayoutSpread(
    key = this.layoutAnchorKey(),
    {
      replace = true,
      spread,
    }: { replace?: boolean; spread?: ReadingSpreadRecord } = {},
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

  private storedSpreadForLayout(width: number, height: number) {
    const key = this.layoutAnchorKey(width, height)
    if (!key) return

    return hydrateReflowableSpread(
      this.spreadAnchorsByLayout.get(key),
      this.sections,
      this.layoutStyleSignature,
    )
  }

  relayoutCurrentView(target = this.committedDisplayTarget()) {
    const operationId = ++this.layoutOperationId
    const operation = this.layoutOperationPromise
      .catch(() => undefined)
      .then(() => this.runRelayoutCurrentView(operationId, target))

    this.layoutOperationPromise = operation.then(
      () => undefined,
      () => undefined,
    )
    return operation
  }

  private async runRelayoutCurrentView(
    operationId: number,
    target: string | undefined,
  ) {
    if (operationId !== this.layoutOperationId) return

    const generation = this.renderGeneration
    const resolvedTarget = this.resolveDisplayTarget(target)
    if (!resolvedTarget) return

    this.resetLayoutPageState()
    this.allowLocationJump = false
    this.navigationDirection = undefined
    this.relayoutAnchorSectionIndexes = [...this.visibleSectionIndexes]

    try {
      if (resolvedTarget) {
        const previousRequestId = this.currentRenditionLocationRequestId()
        const display = this.rendition?.display(resolvedTarget)
        const requestId = this.trackRenditionLocationRequest(
          previousRequestId,
          {
            updateAnchor: false,
          },
        )
        await display
        this.commitPendingRenditionLocation(requestId)
        return
      }

      const requestId = this.createManualLocationRequest({
        updateAnchor: false,
      })
      await (this.rendition as any)?.reportLocation(requestId)
      this.commitPendingRenditionLocation(requestId)
    } catch (error) {
      if (generation === this.renderGeneration) console.error(error)
    }
  }

  private async displayInitialPosition() {
    const contentReloadTarget = this.contentReloadTarget
    this.contentReloadTarget = undefined
    const manager = this.rendition?.manager
    const spread = contentReloadTarget
      ? undefined
      : hydrateReflowableSpread(
          this.book.configuration?.spread,
          this.sections,
          this.layoutStyleSignature,
        )

    if (
      spread &&
      manager?.canUseLogicalReflowableSpread?.() &&
      manager.renderReflowableSpread
    ) {
      const requestId = this.createManualLocationRequest({ updateAnchor: true })
      await manager.renderReflowableSpread(spread)
      await (this.rendition as any)?.reportLocation(requestId)
      this.commitPendingRenditionLocation(requestId)
      return
    }

    const target = this.resolveDisplayTarget(
      contentReloadTarget ??
        this.location?.start.cfi ??
        this.book.cfi ??
        undefined,
      'initial',
    )
    const previousRequestId = this.currentRenditionLocationRequestId()
    const display = this.rendition?.display(target)
    const requestId = this.trackRenditionLocationRequest(previousRequestId, {
      anchorTarget: target,
      updateAnchor: true,
    })
    await display
    this.commitPendingRenditionLocation(requestId)
  }

  async render(
    el: HTMLDivElement,
    initialSpread?: string,
    beforeLayout?: (contents?: any, view?: any) => void,
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
    if (source.mode === 'epub' && this.book.contentMode !== 'archiveOnly') {
      const refreshedBook = await db.books.get(this.book.id)
      if (generation !== this.renderGeneration) {
        clearRendering()
        return
      }
      if (refreshedBook) {
        this.setBook(refreshedBook)
      }
    }

    let epub: Book
    try {
      const options =
        source.mode === 'epub'
          ? { openAs: 'epub' }
          : {
              requestMethod: createVersionedEpubRequest(
                this.book.contentVersion,
              ),
            }
      epub = ref(await ePub(source.url, options as any))
    } catch (error) {
      this.reportOpenError('open', error)
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

    const initialRect = el.getBoundingClientRect()
    const initialWidth = Math.round(initialRect.width)
    const initialHeight = Math.round(initialRect.height)
    if (initialWidth <= 0 || initialHeight <= 0) {
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
          width: initialWidth,
          height: initialHeight,
          allowScriptedContent: true,
        }),
      )
      ;(epub as any).rendition = rendition
      await rendition.attachTo(el)
      const renditionManager = (rendition as any).manager
      if (renditionManager) {
        renditionManager.suspendResize = true
      }
    } catch (error) {
      this.reportOpenError('render', error)
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
      const previousTocVersion = this.tocVersion
      this.nav = markRuntimeObject(nav)
      this.expandNavPath(this.currentNavItem)
      this.assignSectionNavItems()
      if (this.tocVersion === previousTocVersion) this.tocVersion++
    })
    try {
      const spine = await this.epub.loaded.spine
      if (generation !== this.renderGeneration) return
      const sections = (spine as any).spineItems as ISection[]
      sections.forEach((s) => {
        s.length ??= 0
        s.images ??= []
      })
      const runtimeSections = markSectionsRuntime(sections)
      this.assignSectionNavItems(sections)
      this.sections = runtimeSections
    } catch (error) {
      if (generation === this.renderGeneration) {
        this.reportOpenError('spine', error)
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
      if (generation === this.renderGeneration) {
        this.reportOpenError('position', error)
      }
    }
  }

  private reportOpenError(stage: ReaderOpenErrorStage, error: unknown) {
    console.error(error)
    emitReaderOpenError({
      bookTitle: getBookDisplayTitle(this.book),
      error,
      stage,
    })
  }

  constructor(public book: BookRecord) {
    super(book.id, book.name)
    this.overlayState = {
      annotations: book.annotations,
      definitions: book.definitions,
    }
    this.typographyConfiguration = book.configuration?.typography

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
    const wasSelected = index === this.selectedIndex
    const tab = this.tabs.splice(index, 1)
    setTabRuntimeActive(tab[0], false)
    this.selectedIndex = updateIndex(this.tabs, index)
    if (wasSelected) this.setSelectedRuntimeActive(true)
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

    this.setSelectedRuntimeActive(false)
    this.tabs.splice(++this.selectedIndex, 0, tab)
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

  closeBookTabs(bookId: string) {
    for (
      let groupIndex = this.groups.length - 1;
      groupIndex >= 0;
      groupIndex--
    ) {
      const group = this.groups[groupIndex]
      if (!group) continue

      for (let tabIndex = group.tabs.length - 1; tabIndex >= 0; tabIndex--) {
        const tab = group.tabs[tabIndex]
        if (!(tab instanceof BookTab) || tab.book.id !== bookId) continue

        this.removeTab(tabIndex, groupIndex)
      }
    }
  }

  async applyBookContentEdit(
    book: BookRecord,
    reloadTarget?: string,
    editedTab?: BookTab,
    patch?: BookContentEditPatch,
  ) {
    db.books.remember(book)
    const patchTasks: Array<Promise<void>> = []
    for (const group of this.groups) {
      for (const tab of group.bookTabs) {
        if (tab.book.id === book.id) {
          if (tab === editedTab && patch) {
            patchTasks.push(
              tab
                .applyRenderedTextEdit(
                  book,
                  patch.target,
                  patch.oldText,
                  patch.newText,
                  patch.document,
                  patch.textNode,
                )
                .then((patched) => {
                  if (!patched) {
                    throw new Error('TEXT_REPLACE_RENDER_PATCH_FAILED')
                  }
                }),
            )
            continue
          }

          tab.reloadContentAfterEdit(
            book,
            !editedTab || tab === editedTab ? reloadTarget : undefined,
          )
        }
      }
    }
    await Promise.all(patchTasks)
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
            tab.book.scope === 'external' && tab.book.contentHash
              ? booksByHash.get(tab.book.contentHash)
              : undefined
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
    this.groups.forEach(({ tabs }) =>
      tabs.forEach((tab) => this.trackDisposal(disposeTab(tab))),
    )
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
