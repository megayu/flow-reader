import type { Contents } from '@flow/epubjs'

import { getNoteIndex } from './noteIndex'
import { isNoteMarkerText } from './noteSemantics'

export const notePopoverClass = 'flow-note-popover'

export const bodyTextAttribute = 'data-flow-body-text'
export const bodyTextSelector = `[${bodyTextAttribute}="true"]`
export const bodyTextPreserveFontAttribute = 'data-flow-body-text-preserve-font'
export const bodyTextInlineFontSizeRatioAttribute = 'data-flow-body-text-inline-font-size-ratio'
export const bodyTextInlineFollowFontAttribute = 'data-flow-body-text-inline-follow-font'
export const bodyTextInlineFollowWeightAttribute = 'data-flow-body-text-inline-follow-weight'
export const bodyTextFontSelector = `${bodyTextSelector}:not([${bodyTextPreserveFontAttribute}="true"])`
export const bodyTextCandidateSelector = 'p, blockquote > p, div'
const bodyTextStructuralDescendantSelector = 'p, div, blockquote, table, figure, img, h1, h2, h3, h4, h5, h6, ol, ul'
const bodyTextInlineWrapperTags = new Set(['span', 'b', 'strong', 'em', 'i'])
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
}

export interface BodyTypographyBaseline {
  fontSize?: number
  fontWeight?: number
  lineHeight?: number
}

export function getBodyTypographyBaseline(
  contents: Contents | undefined,
  _bodyTextCache?: BodyTextDetectionCache,
): BodyTypographyBaseline {
  if (!contents) return {}

  const candidates = getBodyTextCandidates(contents.document)
  const bodyIndexes = detectBodyTextIndexes(contents, candidates)
  const firstBodyIndex = bodyIndexes[0]

  const el = (firstBodyIndex === undefined ? undefined : candidates[firstBodyIndex]) ?? contents.document.body
  if (!el) return {}

  const style = contents.window.getComputedStyle(el)
  const fontSize = parseCssPixel(style.fontSize)
  const fontWeight = parseCssFontWeight(style.fontWeight)
  const lineHeight = parseCssLineHeight(style.lineHeight, fontSize)

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
      if (bodyMarkers.length) {
        applyBodyTextMarkers(contents, candidates, bodyMarkers)
        body.setAttribute(bodyTextDetectedAttribute, 'true')

        if (cacheKey) {
          bodyTextCache?.set(cacheKey, {
            candidateCount: candidates.length,
            bodyMarkers,
          })
        }
      }
    }
  }

  if (!noteTextDetected) {
    applyNoteTextMarkers(document)
    body.setAttribute(noteTextDetectedAttribute, 'true')
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
    const text = getBodyTextCandidateText(el)
    if (!text) return []
    if (isFactuallyExcludedElement(el)) return []
    if (isImageOnlyElement(el)) return []
    if (isStructuralDiv(el)) return []

    const style = window.getComputedStyle(el)
    if (isInvisible(style)) return []

    return [
      {
        baseSignature: createBodyTextBaseSignature(el, style),
        fontSignature: createBodyTextFontSignature(style),
        index,
        inlineMargin: getInlineMargin(style),
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        textAlign: style.textAlign,
        textIndent: style.textIndent,
        textLength: text.length,
        signature: createBodyTextSignature(el, style),
      },
    ]
  })

  if (!bodyTextCandidates.length) return []

  const clusters = createBodyTextClusters(bodyTextCandidates)
  const bodyClusters = selectBodyTextClusters(clusters)
  const clusterCounts = new Map(clusters.map((cluster) => [cluster.signature, cluster.count]))
  const selectedSignatures = new Set(bodyClusters.map((cluster) => cluster.signature))
  const fontTypographySignature = selectFontTypographySignature(bodyClusters)
  const selectedBaseSignatures = new Set(
    bodyTextCandidates.flatMap((candidate) =>
      selectedSignatures.has(candidate.signature) ? [candidate.baseSignature] : [],
    ),
  )

  return bodyTextCandidates.flatMap((candidate) =>
    selectedSignatures.has(candidate.signature) ||
    (selectedBaseSignatures.has(candidate.baseSignature) && clusterCounts.get(candidate.signature) === 1)
      ? [
          {
            index: candidate.index,
            preserveFont: !!fontTypographySignature && candidate.fontSignature !== fontTypographySignature,
          },
        ]
      : [],
  )
}

function getBodyTextCacheKey(contents: Contents) {
  const sectionIndex = (contents as any).sectionIndex
  return sectionIndex === undefined || sectionIndex === null ? undefined : String(sectionIndex)
}

function clearBodyTextMarkers(candidates: HTMLElement[]) {
  candidates.forEach((el) => {
    el.removeAttribute(bodyTextAttribute)
    el.removeAttribute(bodyTextPreserveFontAttribute)
    walkBodyTextInlineElements(el, (inline) => {
      inline.removeAttribute(bodyTextInlineFontSizeRatioAttribute)
      inline.removeAttribute(bodyTextInlineFollowFontAttribute)
      inline.removeAttribute(bodyTextInlineFollowWeightAttribute)
    })
  })
}

function applyBodyTextMarkers(contents: Contents, candidates: HTMLElement[], bodyMarkers: BodyTextMarker[]) {
  bodyMarkers.forEach((marker) => {
    const candidate = candidates[marker.index]
    if (!candidate) return

    candidate.setAttribute(bodyTextAttribute, 'true')
    if (marker.preserveFont) {
      candidate.setAttribute(bodyTextPreserveFontAttribute, 'true')
    }
    applyBodyTextInlineTypographyMarkers(contents, candidate)
  })
}

function applyBodyTextInlineTypographyMarkers(contents: Contents, candidate: HTMLElement) {
  const parentStyle = contents.window.getComputedStyle(candidate)
  const parentFontSize = parseCssPixel(parentStyle.fontSize)
  const parentFontFamily = normalizeFontFamily(parentStyle.fontFamily)
  const parentFontWeight = parseCssFontWeight(parentStyle.fontWeight)
  const inlineWrapperChildren = getBodyTextInlineWrapperChildren(candidate)

  walkBodyTextInlineElements(candidate, (inline) => {
    const style = contents.window.getComputedStyle(inline)
    const fontSize = parseCssPixel(style.fontSize)
    const fontWeight = parseCssFontWeight(style.fontWeight)

    if (parentFontSize && fontSize) {
      inline.setAttribute(bodyTextInlineFontSizeRatioAttribute, formatTypographyRatio(fontSize / parentFontSize))
    }
    if (inlineWrapperChildren?.has(inline) || normalizeFontFamily(style.fontFamily) === parentFontFamily) {
      inline.setAttribute(bodyTextInlineFollowFontAttribute, 'true')
    }
    if (fontWeight !== undefined && fontWeight === parentFontWeight) {
      inline.setAttribute(bodyTextInlineFollowWeightAttribute, 'true')
    }
  })
}

function getBodyTextInlineWrapperChildren(root: HTMLElement) {
  if (!isElementWithTag(root, 'p')) return

  // Direct wrappers that carry the whole paragraph are body containers, while
  // nested or mixed-content inline elements can still represent authored emphasis.
  let wrappers: Set<HTMLElement> | undefined

  for (const node of root.childNodes) {
    if (node.nodeType === 3) {
      if (normalizeText(node.textContent)) return
      continue
    }
    if (!isHTMLElement(node)) continue
    if (isElementWithTag(node, 'br')) continue
    if (!bodyTextInlineWrapperTags.has(node.tagName.toLowerCase()) || !normalizeText(node.textContent)) return
    if (!wrappers) wrappers = new Set()
    wrappers.add(node)
  }

  return wrappers
}

function walkBodyTextInlineElements(root: HTMLElement, visit: (el: HTMLElement) => void) {
  const walk = (node: Node) => {
    if (!isHTMLElement(node)) return
    if (isInlineTypographyExcludedElement(node)) return

    if (normalizeText(node.textContent)) visit(node)
    node.childNodes.forEach(walk)
  }

  root.childNodes.forEach(walk)
}

function isInlineTypographyExcludedElement(el: HTMLElement) {
  return (
    isFactuallyExcludedElement(el) ||
    ['br', 'img', 'svg', 'math', 'ruby', 'rt', 'rp', 'sup', 'sub'].some((tagName) => isElementWithTag(el, tagName))
  )
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

function formatTypographyRatio(value: number) {
  return String(Math.round(value * 10000) / 10000)
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
  baseSignature: string
  fontSignature: string
  index: number
  inlineMargin: number
  fontSize: string
  fontWeight: string
  textAlign: string
  textIndent: string
  textLength: number
  signature: string
}

interface BodyTextCluster {
  signature: string
  fontSignature: string
  indexes: number[]
  count: number
  totalText: number
  avgText: number
  inlineMargin: number
  fontSize: string
  fontWeight: string
  textAlign: string
  textIndent: string
  score: number
}

function isFactuallyExcludedElement(el: HTMLElement) {
  if (
    el.closest(
      [
        `.${notePopoverClass}`,
        noteContentSelector,
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
    return !!normalizeText(node.textContent)
  })
}

function isHTMLElement(node: Node): node is HTMLElement {
  return node.nodeType === 1 && typeof (node as HTMLElement).tagName === 'string'
}

function isImageOnlyElement(el: HTMLElement) {
  const meaningfulChildren = [...el.childNodes].filter((node) => {
    if (node.nodeType === 3) {
      return !!normalizeText(node.textContent)
    }

    if (isElementWithTag(node, 'br')) {
      return false
    }

    return true
  })

  return (
    meaningfulChildren.length > 0 &&
    meaningfulChildren.every((node) => {
      return isElementWithTag(node, 'img') || isElementWithTag(node, 'svg')
    })
  )
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
  return style.fontFamily
}

function createBodyTextBaseSignature(el: HTMLElement, style: CSSStyleDeclaration) {
  return [
    el.tagName.toLowerCase(),
    style.fontFamily,
    style.fontSize,
    style.fontWeight,
    style.lineHeight,
    style.color,
    style.backgroundColor,
    style.textAlign,
  ].join('|')
}

function getInlineMargin(style: CSSStyleDeclaration) {
  return (parseCssPixel(style.marginLeft) ?? 0) + (parseCssPixel(style.marginRight) ?? 0)
}

function getBodyTextCandidateText(el: HTMLElement) {
  return collectBodyTextCandidateText(el, {
    root: el,
  })
}

function collectBodyTextCandidateText(node: Node, options: { root: HTMLElement }): string {
  if (node.nodeType === 3) {
    return normalizeText(node.textContent)
  }

  if (node.nodeType !== 1) return ''

  const el = node as HTMLElement
  if (el !== options.root) {
    if (isElementWithTag(el, 'br')) return ''
    if (isElementWithTag(el, 'img') || isElementWithTag(el, 'svg')) return ''
    if (isFactuallyExcludedElement(el)) return ''
  }

  return [...el.childNodes].map((child) => collectBodyTextCandidateText(child, options)).join('')
}

function createBodyTextClusters(candidates: BodyTextCandidate[]) {
  const clusters = new Map<string, BodyTextCluster>()

  candidates.forEach((candidate) => {
    const cluster = clusters.get(candidate.signature) ?? {
      signature: candidate.signature,
      fontSignature: candidate.fontSignature,
      indexes: [],
      count: 0,
      totalText: 0,
      avgText: 0,
      inlineMargin: candidate.inlineMargin,
      fontSize: candidate.fontSize,
      fontWeight: candidate.fontWeight,
      textAlign: candidate.textAlign,
      textIndent: candidate.textIndent,
      score: 0,
    }

    cluster.indexes.push(candidate.index)
    cluster.count += 1
    cluster.totalText += candidate.textLength
    clusters.set(candidate.signature, cluster)
  })

  return [...clusters.values()].map((cluster) => {
    const avgText = cluster.totalText / cluster.count
    return {
      ...cluster,
      avgText,
      score: cluster.totalText + cluster.count * 80,
    }
  })
}

function selectBodyTextClusters(clusters: BodyTextCluster[]) {
  const viable = clusters.filter((cluster) => cluster.count >= 2 || cluster.totalText >= 80)
  const candidates = viable.length ? viable : clusters
  const winner = selectBodyTextWinner(candidates)

  if (!winner) return clusters

  const selected = [winner]
  const rest = candidates.filter((cluster) => cluster !== winner).sort((a, b) => b.score - a.score)
  const sameFontRest = rest.filter((cluster) => cluster.fontSignature === winner.fontSignature)
  const differentFontRest = rest.filter((cluster) => cluster.fontSignature !== winner.fontSignature)

  // Same-font clusters are treated as the winner's body family. Their margins,
  // size, weight, or indentation may differ by publisher style, but applying the
  // full reader typography will not erase a distinct font-family design.
  selected.push(...sameFontRest)

  // The strongest different-font groups usually cover the main alternate body
  // streams in a section: letters, bilingual text, inset narration, or quoted
  // passages. Include the first two directly; if they are short headings, the
  // section lacks enough competing body evidence for a safer distinction.
  selected.push(...differentFontRest.slice(0, 2))

  for (const cluster of differentFontRest.slice(2)) {
    if (shouldIncludeAdditionalBodyTextCluster(cluster, winner)) {
      selected.push(cluster)
    }
  }

  return selected
}

function shouldIncludeAdditionalBodyTextCluster(cluster: BodyTextCluster, winner: BodyTextCluster) {
  const totalTextRatio = cluster.totalText / winner.totalText
  const countRatio = cluster.count / winner.count
  const avgTextRatio = cluster.avgText / winner.avgText

  // Long independent content blocks are usually real reading material: letters,
  // extended quotations, inserts, or another body-text style. At this size,
  // preserving font-family is enough protection; excluding it would leave a
  // visibly small or cramped run inside otherwise reader-controlled text.
  if (cluster.totalText >= Math.max(600, winner.totalText * 0.25)) return true

  // Parallel body flows appear repeatedly with paragraph lengths near the
  // winner: bilingual text, Q&A, alternating narration, or translation/commentary
  // blocks. They may not dominate total text, but their recurrence and length
  // show they are a body stream rather than a decorative fragment.
  if (cluster.count >= Math.max(3, winner.count * 0.35) && avgTextRatio >= 0.45) {
    return true
  }

  // Short-line books need a different shape test. Only when the winner itself is
  // short-line body text do other repeated short-line groups look like poetry,
  // aphorisms, scripts, or list-like prose that should share reader sizing.
  if (winner.avgText < 35 && cluster.count >= 3 && cluster.avgText < 60) {
    return true
  }

  return countRatio >= 0.35 && avgTextRatio >= 0.5 && totalTextRatio >= 0.2
}

function selectFontTypographySignature(clusters: BodyTextCluster[]) {
  return clusters[0]?.fontSignature
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

  // A weak winner is still safer than widening back to every raw cluster:
  // selected related clusters can still be added below, but non-viable single
  // chapter titles stay excluded from body text.
  return scoreWinner
}

function isElementWithTag(node: Node, tagName: string) {
  return node.nodeType === 1 && (node as Element).tagName?.toLowerCase() === tagName
}

function isInvisible(style: CSSStyleDeclaration) {
  return style.display === 'none' || style.visibility === 'hidden'
}

function normalizeText(value: string | null | undefined) {
  return value?.replace(/\s+/g, '') ?? ''
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

  return Math.min(900, Math.max(100, Math.round(number / 100) * 100))
}

function parseCssLineHeight(value: string, fontSize?: number) {
  if (value === 'normal') return 1.2

  const lineHeight = parseCssPixel(value)
  if (!lineHeight || !fontSize) return undefined

  return Math.round((lineHeight / fontSize) * 10) / 10
}
