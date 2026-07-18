import type { DictionaryProvider } from '../coordinator'
import { cancelDictionarySession, fetchZdic } from '../native'
import type {
  DictionaryEntry,
  DictionaryResult,
  DictionarySense,
  DictionaryText,
} from '../types'

const SOURCE_ID = 'zdic'
const SOURCE_NAME = '汉典'
let nextNativeSessionId = 1

export class ZdicParseError extends Error {
  externalUrl: string

  constructor(externalUrl: string) {
    super('Could not parse this entry.')
    this.name = 'ZdicParseError'
    this.externalUrl = externalUrl
  }
}

class ZdicLookupError extends Error {
  externalUrl: string

  constructor(message: string, externalUrl: string) {
    super(message)
    this.name = 'ZdicLookupError'
    this.externalUrl = externalUrl
  }
}

export const zdicProvider: DictionaryProvider = {
  externalUrl: (query) => zdicExternalUrl(query.text),
  id: SOURCE_ID,
  name: SOURCE_NAME,
  scope: 'online',
  sourceLanguages: ['zh'],
  async lookup(query, { signal }) {
    const sessionId = nextNativeSessionId++
    const cancel = () => {
      void cancelDictionarySession(sessionId).catch(() => undefined)
    }
    if (signal.aborted) {
      cancel()
      throw new DOMException('Request cancelled', 'AbortError')
    }

    signal.addEventListener('abort', cancel, { once: true })
    try {
      const response = await fetchZdic(query.text, sessionId)
      if (signal.aborted) {
        throw new DOMException('Request cancelled', 'AbortError')
      }
      return parseZdicHtml(response.body, query.text)
    } catch (error) {
      if (signal.aborted || error instanceof ZdicParseError) throw error
      if (isNotFoundError(error)) return null
      const message = error instanceof Error ? error.message : String(error)
      throw new ZdicLookupError(message, zdicExternalUrl(query.text))
    } finally {
      signal.removeEventListener('abort', cancel)
    }
  },
}

function isNotFoundError(error: unknown) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'not_found'
  )
}

export function zdicExternalUrl(query: string) {
  return `https://zdic.net/hans/${encodeURIComponent(query)}`
}

export function parseZdicHtml(html: string, query: string): DictionaryResult {
  const externalUrl = zdicExternalUrl(query)
  const document = new DOMParser().parseFromString(html, 'text/html')
  document
    .querySelectorAll('script, style, noscript, template')
    .forEach((element) => element.remove())

  const entries =
    Array.from(query).length === 1
      ? parseCharacterEntries(document, query)
      : parseWordEntries(document, query)

  if (!entries.length || entries.every((entry) => !entry.senses.length)) {
    throw new ZdicParseError(externalUrl)
  }

  return {
    content: { entries, kind: 'entries' },
    externalUrl,
    sourceId: SOURCE_ID,
    sourceName: SOURCE_NAME,
  }
}

function parseCharacterEntries(document: Document, headword: string) {
  const section = document.querySelector(
    'section#jbjs[data-section="基本解释"]',
  )
  if (!section) return []

  const readings = Array.from(section.querySelectorAll('.jbjs-reading'))
  const groups = readings.length ? readings : [section]

  return groups
    .map<DictionaryEntry>((group) => ({
      headword,
      pronunciation: cleanElementText(group.querySelector('.jbjs-reading__py')),
      senses: parseSenseItems(
        group.querySelectorAll('ol.jbjs-list > li.jbjs-item'),
        'jbjs',
      ),
    }))
    .filter((entry) => entry.senses.length > 0)
}

function parseWordEntries(document: Document, headword: string) {
  const section = document.querySelector(
    'section#xxjs[data-section="词语解释"]',
  )
  if (!section) return []

  const lists = Array.from(
    section.querySelectorAll<HTMLOListElement>('ol.xxjs-list'),
  )

  return lists
    .map<DictionaryEntry>((list) => {
      const reading = list.previousElementSibling?.matches('.xxjs-reading-head')
        ? list.previousElementSibling
        : undefined

      return {
        headword,
        pronunciation:
          cleanElementText(reading?.querySelector('.xxjs-reading__py')) ??
          cleanElementText(reading),
        senses: parseSenseItems(list.querySelectorAll(':scope > li'), 'xxjs'),
      }
    })
    .filter((entry) => entry.senses.length > 0)
}

function parseSenseItems(items: NodeListOf<Element>, variant: 'jbjs' | 'xxjs') {
  return Array.from(items).flatMap<DictionarySense>((item, index) => {
    const definitionClass =
      variant === 'jbjs' ? '.jbjs-item__def' : '.xxjs-item__def'
    const exampleSelector =
      variant === 'jbjs' ? '.jbjs-item__eg' : '.xxjs-item__eg, .xxjs-also__text'
    const definition = cleanElementText(item.querySelector(definitionClass))
    const examples = Array.from(item.querySelectorAll(exampleSelector))
      .map(cleanElementText)
      .filter((text): text is string => Boolean(text))
      .map(plainText)
    const excludedFallbackContent =
      variant === 'xxjs' ? `${exampleSelector}, .xxjs-english` : exampleSelector
    const fallback =
      definition ?? fallbackItemText(item, excludedFallbackContent)
    if (!fallback) return []

    return [
      {
        definition: plainText(fallback),
        examples: examples.length ? examples : undefined,
        marker:
          variant === 'xxjs' && item.classList.contains('xxjs-item--nonum')
            ? undefined
            : String(index + 1),
      },
    ]
  })
}

function fallbackItemText(item: Element, excludedSelector: string) {
  const clone = item.cloneNode(true) as Element
  clone
    .querySelectorAll(`${excludedSelector}, script, style, noscript, template`)
    .forEach((element) => element.remove())
  return cleanText(clone.textContent)
}

function cleanElementText(element?: Element | null) {
  return cleanText(element?.textContent)
}

function cleanText(text?: string | null) {
  const cleaned = text?.replace(/\s+/gu, ' ').trim()
  return cleaned || undefined
}

function plainText(text: string): DictionaryText {
  return { kind: 'plain', text }
}
