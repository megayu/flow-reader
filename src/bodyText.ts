import type { Contents } from '@flow/epub-engine'

import { getNoteIndex } from './noteIndex'
import { isNoteMarkerText } from './noteSemantics'

export const notePopoverClass = 'flow-note-popover'

export const bodyTextAttribute = 'data-flow-body-text'
export const bodyTextSelector = `[${bodyTextAttribute}="true"]`
export const bodyTextPreserveFontAttribute = 'data-flow-body-text-preserve-font'
export const bodyTextFontSizeRatioAttribute = 'data-flow-body-text-font-size-ratio'
export const bodyTextFontFallbackAttribute = 'data-flow-body-text-font-fallback'
export const bodyTextInlineFollowFontAttribute = 'data-flow-body-text-inline-follow-font'
export const bodyTextInlineSecondaryFontAttribute = 'data-flow-body-text-inline-secondary-font'
export const bodyTextFontWeightOffsetAttribute = 'data-flow-body-text-font-weight-offset'
export const bodyTextFontSelector = `${bodyTextSelector}:not([${bodyTextPreserveFontAttribute}="true"])`
export const bodyTextCandidateSelector = 'p, blockquote > p, div'
const bodyTextStructuralDescendantSelector = 'p, div, blockquote, table, figure, img, h1, h2, h3, h4, h5, h6, ol, ul'
const bodyTextDetectedAttribute = 'data-flow-body-text-detected'
export const noteTextAttribute = 'data-flow-note-text'
export const noteTextSelector = `[${noteTextAttribute}="true"]`
export const noteContentAttribute = 'data-flow-note-content'
export const noteContentSelector = `[${noteContentAttribute}="true"]`
const noteTextDetectedAttribute = 'data-flow-note-text-detected'

export function createHiddenNoteContentSelector(excludedClass: string) {
  return [`body > ${noteContentSelector}`, `body > :not(.${excludedClass}) ${noteContentSelector}`].join(',\n')
}

export interface BodyTextDetectionCacheEntry {
  candidateCount: number
  bodyMarkers: BodyTextMarker[]
}

export type BodyTextDetectionCache = Map<string, BodyTextDetectionCacheEntry>

export interface BodyTextMarker {
  index: number
  preserveFont: boolean
  primaryFontFamily?: string
  fontFallback: BodyTextFontFallback
  fontSizeRatio?: number
  fontWeightOffset?: number
}

export type BodyTextFontFallback = 'serif' | 'sans-serif' | 'monospace'

export interface BodyTypographyBaseline {
  fontSize?: number
  fontWeight?: number
  lineHeight?: number
}

interface OriginalBodyTypography extends BodyTypographyBaseline {
  fontFamily: string
}

const originalBodyTypography = new WeakMap<Document, OriginalBodyTypography>()

export function getOriginalBodyTypography(document: Document) {
  return originalBodyTypography.get(document)
}

export function getBodyTypographyBaseline(
  contents: Contents | undefined,
  _bodyTextCache?: BodyTextDetectionCache,
): BodyTypographyBaseline {
  if (!contents) return {}

  const candidates = getBodyTextCandidates(contents.document)
  const bodyMarkers = detectBodyTextMarkers(contents, candidates)
  const marker = bodyMarkers.find((marker) => !marker.preserveFont) ?? bodyMarkers[0]
  const el = (marker ? candidates[marker.index] : undefined) ?? contents.document.body
  if (!el) return {}

  const style = contents.window.getComputedStyle(el)
  const originalSize = parseCssPixel(style.fontSize)
  const originalWeight = parseCssFontWeight(style.fontWeight)
  const fontSize =
    originalSize !== undefined && marker?.fontSizeRatio ? originalSize / marker.fontSizeRatio : originalSize
  const fontWeight = originalWeight !== undefined ? originalWeight - (marker?.fontWeightOffset ?? 0) : undefined
  const lineHeight = parseCssLineHeight(style.lineHeight, originalSize)

  return {
    fontSize,
    fontWeight,
    lineHeight,
  }
}

export function ensureBodyTextMarkers(contents: Contents, bodyTextCache?: BodyTextDetectionCache) {
  const document = contents.document
  const body = document?.body
  if (!document || !body) return

  const bodyTextDetected = body.getAttribute(bodyTextDetectedAttribute) === 'true'
  const noteTextDetected = body.getAttribute(noteTextDetectedAttribute) === 'true'
  if (bodyTextDetected && noteTextDetected) return

  if (!noteTextDetected) {
    applyNoteTextMarkers(document)
    body.setAttribute(noteTextDetectedAttribute, 'true')
  }

  if (!bodyTextDetected) {
    const candidates = getBodyTextCandidates(document)
    const cacheKey = getBodyTextCacheKey(contents)
    const cached = cacheKey ? bodyTextCache?.get(cacheKey) : undefined

    clearBodyTextMarkers(candidates)

    if (cached && cached.candidateCount === candidates.length && cached.bodyMarkers.length) {
      applyBodyTextMarkers(contents, candidates, cached.bodyMarkers)
      body.setAttribute(bodyTextDetectedAttribute, 'true')
    } else {
      const bodyMarkers = detectBodyTextMarkers(contents, candidates)
      applyBodyTextMarkers(contents, candidates, bodyMarkers)
      body.setAttribute(bodyTextDetectedAttribute, 'true')
      if (bodyMarkers.length) {
        if (cacheKey) {
          bodyTextCache?.set(cacheKey, {
            candidateCount: candidates.length,
            bodyMarkers,
          })
        }
      }
    }
  }
}

export function getBodyTextCandidates(document: Document) {
  return [...document.querySelectorAll<HTMLElement>(bodyTextCandidateSelector)]
}

export function detectBodyTextIndexes(contents: Contents, candidates: HTMLElement[]) {
  return detectBodyTextMarkers(contents, candidates).map((marker) => marker.index)
}

function detectBodyTextMarkers(contents: Contents, candidates: HTMLElement[]) {
  const window = contents.window
  const bodyTextCandidates = candidates.flatMap((el, index) => {
    if (isFactuallyExcludedElement(el)) return []
    if (isStructuralDiv(el)) return []
    const rootStyle = window.getComputedStyle(el)
    if (isInvisible(rootStyle)) return []
    const readable = getReadableParagraphStyle(contents, el, rootStyle)
    if (!readable) return []
    const { style, textLength } = readable

    return [
      {
        fontFallback: getBodyTextFontFallback(style.fontFamily),
        fontSignature: createBodyTextFontSignature(style),
        index,
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        rootStyle,
        textLength,
        signature: createBodyTextSignature(el, style),
      },
    ]
  })

  if (!bodyTextCandidates.length) return []

  const clusters = createBodyTextClusters(bodyTextCandidates)
  // Statistics choose this section's baseline, not which readable paragraphs
  // receive typography. Short and uncommon styles retain their relative sizes.
  const winner = selectBodyTextWinner(clusters)
  const baselineFontSize = parseCssPixel(winner?.fontSize ?? '')
  const baselineFontWeight = parseCssFontWeight(winner?.fontWeight ?? '')

  return bodyTextCandidates.map((candidate) => ({
    fontFallback: candidate.fontFallback,
    index: candidate.index,
    preserveFont: !!winner && createBodyTextFontSignature(candidate.rootStyle) !== winner.fontSignature,
    primaryFontFamily: winner?.fontSignature,
    ...getRelativeTypography(candidate.rootStyle, baselineFontSize, baselineFontWeight),
  }))
}

function getBodyTextCacheKey(contents: Contents) {
  const sectionIndex = (contents as any).sectionIndex
  return sectionIndex === undefined || sectionIndex === null ? undefined : String(sectionIndex)
}

function clearBodyTextMarkers(candidates: HTMLElement[]) {
  candidates.forEach((el) => {
    el.removeAttribute(bodyTextAttribute)
    el.removeAttribute(bodyTextPreserveFontAttribute)
    el.removeAttribute(bodyTextFontSizeRatioAttribute)
    el.removeAttribute(bodyTextFontFallbackAttribute)
    el.removeAttribute(bodyTextFontWeightOffsetAttribute)
    walkBodyTextInlineElements(el, (inline) => {
      inline.removeAttribute(bodyTextFontSizeRatioAttribute)
      inline.removeAttribute(bodyTextFontFallbackAttribute)
      inline.removeAttribute(bodyTextInlineFollowFontAttribute)
      inline.removeAttribute(bodyTextInlineSecondaryFontAttribute)
      inline.removeAttribute(bodyTextFontWeightOffsetAttribute)
    })
  })
}

function applyBodyTextMarkers(contents: Contents, candidates: HTMLElement[], bodyMarkers: BodyTextMarker[]) {
  const primaryMarker = bodyMarkers[0]
  const primaryElement = primaryMarker === undefined ? undefined : candidates[primaryMarker.index]
  const primaryFontFamily =
    primaryMarker?.primaryFontFamily ??
    (primaryElement ? normalizeFontFamily(contents.window.getComputedStyle(primaryElement).fontFamily) : undefined)
  bodyMarkers.forEach((marker) => {
    const candidate = candidates[marker.index]
    if (!candidate) return

    candidate.setAttribute(bodyTextAttribute, 'true')
    candidate.setAttribute(bodyTextFontFallbackAttribute, marker.fontFallback)
    if (marker.preserveFont) {
      candidate.setAttribute(bodyTextPreserveFontAttribute, 'true')
    }
    applyRelativeTypographyMarkers(candidate, marker)
    applyBodyTextInlineTypographyMarkers(contents, candidate, marker, primaryFontFamily)
  })
  const baselineElement = primaryElement ?? contents.document.body
  if (baselineElement) {
    const style = contents.window.getComputedStyle(baselineElement)
    const size = parseCssPixel(style.fontSize)
    const weight = parseCssFontWeight(style.fontWeight)
    originalBodyTypography.set(contents.document, {
      fontFamily: primaryFontFamily ?? normalizeFontFamily(style.fontFamily),
      fontSize: size !== undefined && primaryMarker?.fontSizeRatio ? size / primaryMarker.fontSizeRatio : size,
      fontWeight: weight !== undefined ? weight - (primaryMarker?.fontWeightOffset ?? 0) : undefined,
    })
    applyNoteTypographyMarkers(
      contents,
      primaryFontFamily ?? normalizeFontFamily(style.fontFamily),
      size !== undefined && primaryMarker?.fontSizeRatio ? size / primaryMarker.fontSizeRatio : size,
      weight !== undefined ? weight - (primaryMarker?.fontWeightOffset ?? 0) : undefined,
    )
  }
}

function getRelativeTypography(
  style: { fontSize: string; fontWeight: string },
  baselineFontSize: number | undefined,
  baselineFontWeight: number | undefined,
) {
  const fontSize = parseCssPixel(style.fontSize)
  const fontWeight = parseCssFontWeight(style.fontWeight)
  return {
    fontSizeRatio: baselineFontSize && fontSize !== undefined ? fontSize / baselineFontSize : undefined,
    fontWeightOffset:
      baselineFontWeight !== undefined && fontWeight !== undefined ? fontWeight - baselineFontWeight : undefined,
  }
}

function applyRelativeTypographyMarkers(
  el: HTMLElement,
  typography: Pick<BodyTextMarker, 'fontSizeRatio' | 'fontWeightOffset'>,
) {
  if (typography.fontSizeRatio !== undefined) {
    el.setAttribute(bodyTextFontSizeRatioAttribute, formatTypographyRatio(typography.fontSizeRatio))
  }
  if (typography.fontWeightOffset !== undefined) {
    el.setAttribute(bodyTextFontWeightOffsetAttribute, String(typography.fontWeightOffset))
  }
}

function applyBodyTextInlineTypographyMarkers(
  contents: Contents,
  candidate: HTMLElement,
  marker: BodyTextMarker,
  primaryFontFamily: string | undefined,
) {
  const parentStyle = contents.window.getComputedStyle(candidate)
  const parentFontSize = parseCssPixel(parentStyle.fontSize)
  const parentFontWeight = parseCssFontWeight(parentStyle.fontWeight)
  // Cached paragraph ratios reconstruct the same section baseline in a fresh
  // iframe. Read authored styles before custom CSS; never compound adjustments.
  const baselineFontSize =
    parentFontSize !== undefined && marker.fontSizeRatio ? parentFontSize / marker.fontSizeRatio : undefined
  const baselineFontWeight =
    parentFontWeight !== undefined && marker.fontWeightOffset !== undefined
      ? parentFontWeight - marker.fontWeightOffset
      : undefined

  walkBodyTextInlineElements(candidate, (inline) => {
    const style = contents.window.getComputedStyle(inline)
    applyRelativeTypographyMarkers(inline, getRelativeTypography(style, baselineFontSize, baselineFontWeight))
    const family = normalizeFontFamily(style.fontFamily)
    const primary = family === primaryFontFamily
    inline.setAttribute(bodyTextFontFallbackAttribute, getBodyTextFontFallback(style.fontFamily))
    inline.setAttribute(primary ? bodyTextInlineFollowFontAttribute : bodyTextInlineSecondaryFontAttribute, 'true')
  })
}

function walkBodyTextInlineElements(root: HTMLElement, visit: (el: HTMLElement) => void) {
  const walk = (node: Node) => {
    if (!isHTMLElement(node)) return
    if (isInlineTypographyExcludedElement(node)) return

    if (hasNonWhitespaceText(node.textContent)) visit(node)
    node.childNodes.forEach(walk)
  }

  root.childNodes.forEach(walk)
}

function isInlineTypographyExcludedElement(el: HTMLElement) {
  return isFactuallyExcludedElement(el) || inlineTypographyExcludedTags.has(el.tagName.toLowerCase())
}

function normalizeFontFamily(value: string) {
  return value
    .split(',')
    .map((family) =>
      family
        .trim()
        .replace(/^['"]|['"]$/g, '')
        .toLowerCase(),
    )
    .join(',')
}

function getBodyTextFontFallback(value: string): BodyTextFontFallback {
  const families = normalizeFontFamily(value).split(',')
  for (let index = families.length - 1; index >= 0; index--) {
    const family = families[index]
    if (family === 'sans-serif' || family === 'ui-sans-serif' || family === 'system-ui') return 'sans-serif'
    if (family === 'serif' || family === 'ui-serif' || family === 'fangsong') return 'serif'
    if (family === 'monospace' || family === 'ui-monospace') return 'monospace'
  }
  return 'sans-serif'
}

function formatTypographyRatio(value: number) {
  return String(Math.round(value * 10000) / 10000)
}

const protectedTypographySelector =
  'h1,h2,h3,h4,h5,h6,pre,code,table,thead,tbody,tfoot,tr,td,th,caption,figure,figcaption,nav,script,style'
const noteTypographyExcludedTags = new Set(`${protectedTypographySelector},aside,ol,ul`.split(','))
const inlineTypographyExcludedTags = new Set(['br', 'img', 'svg', 'math', 'ruby', 'rt', 'rp', 'sup', 'sub'])

export function applyNoteTypographyMarkers(
  contents: Contents,
  primaryFontFamily: string,
  baselineFontSize: number | undefined,
  baselineFontWeight: number | undefined,
  roots = getNoteIndex(contents.document).getTextTargets(),
) {
  const protectedSubtrees = new Map<HTMLElement, boolean>()
  for (const root of roots) {
    if (root.closest(protectedTypographySelector)) continue
    const walk = (el: HTMLElement): boolean => {
      const cached = protectedSubtrees.get(el)
      if (cached !== undefined) return cached
      if (el !== root && noteTypographyExcludedTags.has(el.tagName.toLowerCase())) {
        protectedSubtrees.set(el, true)
        return true
      }
      if (inlineTypographyExcludedTags.has(el.tagName.toLowerCase())) return false
      const style = contents.window.getComputedStyle(el)
      if (isInvisible(style)) return false
      let hasProtectedContent = false
      let hasOwnText = false
      for (const child of el.childNodes) {
        if (isHTMLElement(child)) hasProtectedContent = walk(child) || hasProtectedContent
        else if (child.nodeType === 3 && hasNonWhitespaceText(child.textContent)) hasOwnText = true
      }
      // A mixed container must not pass forced typography into protected structures.
      // Its ordinary child paragraphs remain eligible; paragraph layout stays authored.
      if (hasOwnText && !hasProtectedContent) {
        applyRelativeTypographyMarkers(el, getRelativeTypography(style, baselineFontSize, baselineFontWeight))
        el.setAttribute(bodyTextFontFallbackAttribute, getBodyTextFontFallback(style.fontFamily))
        const primary = normalizeFontFamily(style.fontFamily) === primaryFontFamily
        el.setAttribute(primary ? bodyTextInlineFollowFontAttribute : bodyTextInlineSecondaryFontAttribute, 'true')
      }
      protectedSubtrees.set(el, hasProtectedContent)
      return hasProtectedContent
    }
    walk(root)
  }
}

function applyNoteTextMarkers(document: Document) {
  document
    .querySelectorAll<HTMLElement>(`[${noteTextAttribute}]`)
    .forEach((el) => el.removeAttribute(noteTextAttribute))
  document
    .querySelectorAll<HTMLElement>(`[${noteContentAttribute}]`)
    .forEach((el) => el.removeAttribute(noteContentAttribute))

  const noteIndex = getNoteIndex(document)

  noteIndex.getHideTargets().forEach((el) => {
    el.setAttribute(noteContentAttribute, 'true')
  })
  noteIndex.getTextTargets().forEach((el) => {
    el.setAttribute(noteTextAttribute, 'true')
  })
}

interface BodyTextCandidate {
  fontFallback: BodyTextFontFallback
  fontSignature: string
  index: number
  fontSize: string
  fontWeight: string
  textLength: number
  signature: string
}

interface BodyTextCluster {
  fontSignature: string
  count: number
  totalText: number
  fontSize: string
  fontWeight: string
  score: number
}

function isFactuallyExcludedElement(el: HTMLElement) {
  if (
    el.closest(
      [
        `.${notePopoverClass}`,
        noteContentSelector,
        'h1',
        'h2',
        'h3',
        'h4',
        'h5',
        'h6',
        'pre',
        'code',
        'table',
        'thead',
        'tbody',
        'tfoot',
        'tr',
        'td',
        'th',
        'caption',
        'figure',
        'figcaption',
        'nav',
        'aside',
        'ol',
        'ul',
      ].join(','),
    )
  ) {
    return true
  }

  return hasNoteBacklinkContentAncestor(el)
}

function hasNoteBacklinkContentAncestor(el: HTMLElement) {
  let cur: HTMLElement | null = el

  while (cur && cur !== cur.ownerDocument.body) {
    if (isNoteBacklinkContentElement(cur)) return true
    cur = cur.parentElement
  }

  return false
}

function isNoteBacklinkContentElement(el: HTMLElement) {
  if (!isElementWithTag(el, 'p') && !isElementWithTag(el, 'li')) return false

  const marker = findLeadingNoteMarkerAnchor(el)
  if (!marker) return false

  const [, hash = ''] = marker.getAttribute('href')?.split('#') ?? []
  return !!hash
}

function findLeadingNoteMarkerAnchor(el: HTMLElement) {
  const first = getFirstMeaningfulChild(el)
  if (!first || !isHTMLElement(first)) return

  return findLeadingNoteMarkerAnchorInElement(first)
}

function findLeadingNoteMarkerAnchorInElement(el: HTMLElement): HTMLAnchorElement | undefined {
  if (isElementWithTag(el, 'a')) {
    return isNoteMarkerAnchor(el) ? (el as HTMLAnchorElement) : undefined
  }

  if (isElementWithTag(el, 'sup') || isElementWithTag(el, 'sub')) return
  if (!isElementWithTag(el, 'span')) return

  const first = getFirstMeaningfulChild(el)
  if (!first || !isHTMLElement(first)) return

  return findLeadingNoteMarkerAnchorInElement(first)
}

function isNoteMarkerAnchor(el: HTMLElement) {
  const href = el.getAttribute('href')?.trim()
  if (!href || href.startsWith('mailto:') || href.includes('://')) return false

  return isNoteMarkerText(el.textContent)
}

function getFirstMeaningfulChild(el: HTMLElement) {
  return [...el.childNodes].find((node) => {
    if (isHTMLElement(node)) return true
    return hasNonWhitespaceText(node.textContent)
  })
}

function isHTMLElement(node: Node): node is HTMLElement {
  return node.nodeType === 1 && typeof (node as HTMLElement).tagName === 'string'
}

function isStructuralDiv(el: HTMLElement) {
  if (el.tagName.toLowerCase() !== 'div') return false

  return !!el.querySelector(bodyTextStructuralDescendantSelector)
}

function createBodyTextSignature(el: HTMLElement, style: CSSStyleDeclaration) {
  return [
    el.tagName.toLowerCase(),
    style.fontFamily,
    style.fontSize,
    style.fontWeight,
    style.fontStyle,
    style.lineHeight,
    style.color,
    style.backgroundColor,
    style.textAlign,
    style.textIndent,
    style.marginLeft,
    style.marginRight,
  ].join('|')
}

function createBodyTextFontSignature(style: CSSStyleDeclaration) {
  return normalizeFontFamily(style.fontFamily)
}

function getReadableParagraphStyle(contents: Contents, root: HTMLElement, rootStyle: CSSStyleDeclaration) {
  const groups = new Map<string, { style: CSSStyleDeclaration; textLength: number }>()
  let textLength = 0
  const walk = (el: HTMLElement) => {
    if (el !== root && isInlineTypographyExcludedElement(el)) return
    const style = el === root ? rootStyle : contents.window.getComputedStyle(el)
    if (isInvisible(style)) return
    let ownLength = 0
    for (const child of el.childNodes) {
      if (child.nodeType === 3) ownLength += (child.textContent ?? '').replace(/\s+/g, '').length
      else if (isHTMLElement(child)) walk(child)
    }
    if (!ownLength) return
    const key = [normalizeFontFamily(style.fontFamily), style.fontSize, style.fontWeight].join('|')
    const group = groups.get(key) ?? { style, textLength: 0 }
    group.textLength += ownLength
    groups.set(key, group)
    textLength += ownLength
  }
  walk(root)
  let winner: { style: CSSStyleDeclaration; textLength: number } | undefined
  for (const group of groups.values()) {
    if (!winner || group.textLength > winner.textLength) winner = group
  }
  return winner ? { style: winner.style, textLength } : undefined
}

function createBodyTextClusters(candidates: BodyTextCandidate[]) {
  const clusters = new Map<string, BodyTextCluster>()

  candidates.forEach((candidate) => {
    const cluster = clusters.get(candidate.signature) ?? {
      fontSignature: candidate.fontSignature,
      count: 0,
      totalText: 0,
      fontSize: candidate.fontSize,
      fontWeight: candidate.fontWeight,
      score: 0,
    }

    cluster.count += 1
    cluster.totalText += candidate.textLength
    cluster.score = cluster.totalText + cluster.count * 80
    clusters.set(candidate.signature, cluster)
  })

  return [...clusters.values()]
}

function selectBodyTextWinner(clusters: BodyTextCluster[]) {
  if (!clusters.length) return
  if (clusters.length === 1) return clusters[0]

  const byTotalText = [...clusters].sort((a, b) => b.totalText - a.totalText)
  const totalTextWinner = byTotalText[0]!
  const totalTextRunnerUp = byTotalText[1]!
  if (totalTextWinner.totalText >= totalTextRunnerUp.totalText * 2 && totalTextWinner.count >= 2) {
    return totalTextWinner
  }

  const byCount = [...clusters].sort((a, b) => b.count - a.count)
  const countWinner = byCount[0]!
  const countRunnerUp = byCount[1]!
  if (countWinner.count >= countRunnerUp.count * 2 && countWinner.totalText >= 200) {
    return countWinner
  }

  const byScore = [...clusters].sort((a, b) => b.score - a.score)
  const scoreWinner = byScore[0]!

  return scoreWinner
}

function isElementWithTag(node: Node, tagName: string) {
  return node.nodeType === 1 && (node as Element).tagName?.toLowerCase() === tagName
}

function isInvisible(style: CSSStyleDeclaration) {
  return style.display === 'none' || style.visibility === 'hidden'
}

function hasNonWhitespaceText(value: string | null | undefined) {
  return /\S/.test(value ?? '')
}

function parseCssPixel(value: string) {
  const number = parseFloat(value)
  return Number.isFinite(number) ? number : undefined
}

function parseCssFontWeight(value: string) {
  if (value === 'normal') return 400
  if (value === 'bold') return 700

  const number = parseFloat(value)
  if (!Number.isFinite(number)) return undefined

  return Math.min(1000, Math.max(1, number))
}

function parseCssLineHeight(value: string, fontSize?: number) {
  if (value === 'normal') return 1.2

  const lineHeight = parseCssPixel(value)
  if (!lineHeight || !fontSize) return undefined

  return Math.round((lineHeight / fontSize) * 10) / 10
}
