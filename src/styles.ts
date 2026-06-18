import { CSSProperties } from 'react'

import { Contents } from '@flow/epubjs'

import { Settings } from './state'
import { keys } from './utils'

export const activeClass = 'bg-primary70'
export const notePopoverClass = 'flow-note-popover'

const bodyTextAttribute = 'data-flow-body-text'
const bodyTextSelector = `[${bodyTextAttribute}="true"]`
const bodyTextCandidateSelector = 'p, blockquote > p, div'
const bodyTextDetectedAttribute = 'data-flow-body-text-detected'

const readerLinkSelector = [
  'body > a:any-link',
  `body > :not(.${notePopoverClass}) a:any-link`,
].join(',\n')

const notePopoverListSelector = [
  `.${notePopoverClass} ol`,
  `.${notePopoverClass} ul`,
  `.${notePopoverClass} li`,
].join(',\n')

export const defaultStyle = {
  html: {
    padding: '0 !important',
  },
  body: {
    background: 'transparent',
  },
  [readerLinkSelector]: {
    color: '#3b82f6 !important',
    'text-decoration': 'none !important',
  },
  '::selection': {
    'background-color': 'rgba(3, 102, 214, 0.2)',
  },
  [notePopoverListSelector]: {
    'list-style-type': 'none !important',
  },
  [`.${notePopoverClass} li::marker`]: {
    content: '"" !important',
  },
}

const camelToSnake = (str: string) =>
  str.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)

function mapToCss(o: CSSProperties) {
  return keys(o)
    .filter((k) => o[k] !== undefined)
    .map((k) => `${camelToSnake(k)}: ${o[k]} !important;`)
    .join('\n')
}

enum Style {
  Custom = 'custom',
}

export interface BodyTextDetectionCacheEntry {
  candidateCount: number
  bodyIndexes: number[]
}

export type BodyTextDetectionCache = Map<string, BodyTextDetectionCacheEntry>

export function updateCustomStyle(
  contents: Contents | undefined,
  settings: Settings | undefined,
  bodyTextCache?: BodyTextDetectionCache,
) {
  if (!contents || !settings) return

  const { zoom } = settings
  const bodyTypography = pickBodyTypography(settings)
  const hasBodyTypography = keys(bodyTypography).length > 0
  let css = ' '

  if (hasBodyTypography) {
    ensureBodyTextMarkers(contents, bodyTextCache)
    css += `${bodyTextSelector} {
      ${mapToCss(bodyTypography)}
    }`
  }

  if (zoom) {
    const body = contents.content as HTMLBodyElement
    const scale = (p: keyof CSSStyleDeclaration) => ({
      [p]: `${parseInt(body.style[p] as string) / zoom}px`,
    })
    css += `body {
      ${mapToCss({
        transformOrigin: 'top left',
        transform: `scale(${zoom})`,
        ...scale('width'),
        ...scale('height'),
        ...scale('columnWidth'),
        ...scale('columnGap'),
        ...scale('paddingTop'),
        ...scale('paddingBottom'),
        ...scale('paddingLeft'),
        ...scale('paddingRight'),
      })}
    }`
  }

  return contents.addStylesheetCss(css, Style.Custom)
}

function pickBodyTypography(settings: Settings) {
  return removeDefaultCssValues({
    fontFamily: settings.fontFamily,
    fontSize: settings.fontSize,
    fontWeight: settings.fontWeight,
    lineHeight: settings.lineHeight,
    textIndent:
      settings.textIndent === undefined
        ? undefined
        : `${settings.textIndent}em`,
    textAlign: settings.textAlign,
  })
}

function removeDefaultCssValues<T extends CSSProperties>(styles: T) {
  return Object.fromEntries(
    Object.entries(styles).filter(([, value]) => {
      return value !== undefined && value !== null && value !== ''
    }),
  ) as T
}

function ensureBodyTextMarkers(
  contents: Contents,
  bodyTextCache?: BodyTextDetectionCache,
) {
  const document = contents.document
  const body = document?.body
  if (!document || !body) return

  if (body.getAttribute(bodyTextDetectedAttribute) === 'true') {
    return
  }

  const candidates = getBodyTextCandidates(document)
  const cacheKey = getBodyTextCacheKey(contents)
  const cached = cacheKey ? bodyTextCache?.get(cacheKey) : undefined

  clearBodyTextMarkers(candidates)

  if (cached && cached.candidateCount === candidates.length) {
    applyBodyTextIndexes(candidates, cached.bodyIndexes)
    body.setAttribute(bodyTextDetectedAttribute, 'true')
    return
  }

  const bodyIndexes = detectBodyTextIndexes(contents, candidates)
  applyBodyTextIndexes(candidates, bodyIndexes)
  body.setAttribute(bodyTextDetectedAttribute, 'true')

  if (cacheKey) {
    bodyTextCache?.set(cacheKey, {
      candidateCount: candidates.length,
      bodyIndexes,
    })
  }
}

function getBodyTextCacheKey(contents: Contents) {
  const sectionIndex = (contents as any).sectionIndex
  return sectionIndex === undefined || sectionIndex === null
    ? undefined
    : String(sectionIndex)
}

function getBodyTextCandidates(document: Document) {
  return [...document.querySelectorAll<HTMLElement>(bodyTextCandidateSelector)]
}

function clearBodyTextMarkers(candidates: HTMLElement[]) {
  candidates.forEach((el) => {
    el.removeAttribute(bodyTextAttribute)
  })
}

function applyBodyTextIndexes(
  candidates: HTMLElement[],
  bodyIndexes: number[],
) {
  bodyIndexes.forEach((index) => {
    candidates[index]?.setAttribute(bodyTextAttribute, 'true')
  })
}

function detectBodyTextIndexes(contents: Contents, candidates: HTMLElement[]) {
  const window = contents.window
  const bodyTextCandidates = candidates.flatMap((el, index) => {
    const text = normalizeText(el.textContent)
    if (!text) return []
    if (isFactuallyExcludedElement(el)) return []
    if (isImageOnlyElement(el)) return []
    if (isStructuralDiv(el)) return []

    const style = window.getComputedStyle(el)
    if (isInvisible(style)) return []

    return [
      {
        index,
        textLength: text.length,
        signature: createBodyTextSignature(el, style),
      },
    ]
  })

  if (!bodyTextCandidates.length) return []

  const clusters = createBodyTextClusters(bodyTextCandidates)
  const bodyClusters = selectBodyTextClusters(clusters)
  const selectedSignatures = new Set(
    bodyClusters.map((cluster) => cluster.signature),
  )

  return bodyTextCandidates.flatMap((candidate) =>
    selectedSignatures.has(candidate.signature) ? [candidate.index] : [],
  )
}

interface BodyTextCandidate {
  index: number
  textLength: number
  signature: string
}

interface BodyTextCluster {
  signature: string
  indexes: number[]
  count: number
  totalText: number
  avgText: number
  score: number
}

function isFactuallyExcludedElement(el: HTMLElement) {
  return !!el.closest(
    [
      `.${notePopoverClass}`,
      '[role="doc-footnote"]',
      '[role="doc-endnote"]',
      '[epub\\:type*="footnote"]',
      '[epub\\:type*="endnote"]',
      '[epub\\:type*="rearnote"]',
      '[type*="footnote"]',
      '[type*="endnote"]',
      '[type*="rearnote"]',
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

  return !!el.querySelector(
    [
      'p',
      'div',
      'blockquote',
      'table',
      'figure',
      'img',
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
      'h6',
      'ol',
      'ul',
    ].join(','),
  )
}

function createBodyTextSignature(el: HTMLElement, style: CSSStyleDeclaration) {
  return [
    el.tagName.toLowerCase(),
    normalizedClassName(el),
    style.fontFamily,
    style.fontSize,
    style.fontWeight,
    style.lineHeight,
    style.color,
    style.backgroundColor,
    style.textAlign,
    style.textIndent,
    style.marginTop,
    style.marginBottom,
  ].join('|')
}

function normalizedClassName(el: HTMLElement) {
  return [...el.classList].sort().join(' ')
}

function createBodyTextClusters(candidates: BodyTextCandidate[]) {
  const clusters = new Map<string, BodyTextCluster>()

  candidates.forEach((candidate) => {
    const cluster = clusters.get(candidate.signature) ?? {
      signature: candidate.signature,
      indexes: [],
      count: 0,
      totalText: 0,
      avgText: 0,
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
  const viable = clusters.filter(
    (cluster) => cluster.count >= 2 || cluster.totalText >= 80,
  )
  const candidates = viable.length ? viable : clusters
  const winner = selectBodyTextWinner(candidates)

  if (!winner) return clusters

  const selected = [winner]
  const rest = candidates
    .filter((cluster) => cluster !== winner)
    .sort((a, b) => b.score - a.score)

  for (const cluster of rest) {
    if (selected.length >= 3) break

    const totalTextRatio = cluster.totalText / winner.totalText
    const countRatio = cluster.count / winner.count
    const avgTextRatio = cluster.avgText / winner.avgText
    if (
      shouldIncludeBodyTextCluster(
        cluster,
        winner,
        totalTextRatio,
        countRatio,
        avgTextRatio,
      )
    ) {
      selected.push(cluster)
    }
  }

  return selected
}

function shouldIncludeBodyTextCluster(
  cluster: BodyTextCluster,
  winner: BodyTextCluster,
  totalTextRatio: number,
  countRatio: number,
  avgTextRatio: number,
) {
  if (totalTextRatio >= 0.35) return true

  if (cluster.totalText < 100 || totalTextRatio < 0.2) return false

  return countRatio >= 0.35 && avgTextRatio >= 0.5
}

function selectBodyTextWinner(clusters: BodyTextCluster[]) {
  if (!clusters.length) return
  if (clusters.length === 1) return clusters[0]

  const byTotalText = [...clusters].sort((a, b) => b.totalText - a.totalText)
  const totalTextWinner = byTotalText[0]!
  const totalTextRunnerUp = byTotalText[1]!
  if (
    totalTextWinner.totalText >= totalTextRunnerUp.totalText * 2 &&
    totalTextWinner.count >= 2
  ) {
    return totalTextWinner
  }

  const byCount = [...clusters].sort((a, b) => b.count - a.count)
  const countWinner = byCount[0]!
  const countRunnerUp = byCount[1]!
  if (
    countWinner.count >= countRunnerUp.count * 2 &&
    countWinner.totalText >= 200
  ) {
    return countWinner
  }

  const byScore = [...clusters].sort((a, b) => b.score - a.score)
  const scoreWinner = byScore[0]!
  const scoreRunnerUp = byScore[1]!
  if (scoreWinner.score >= scoreRunnerUp.score * 1.35) {
    return scoreWinner
  }
}

function isElementWithTag(node: Node, tagName: string) {
  return (
    node.nodeType === 1 && (node as Element).tagName?.toLowerCase() === tagName
  )
}

function isInvisible(style: CSSStyleDeclaration) {
  return style.display === 'none' || style.visibility === 'hidden'
}

function normalizeText(value: string | null | undefined) {
  return value?.replace(/\s+/g, '') ?? ''
}

export function lock(l: number, r: number, unit = 'px') {
  const minw = 400
  const maxw = 2560

  return `calc(${l}${unit} + ${r - l} * (100vw - ${minw}px) / ${maxw - minw})`
}
