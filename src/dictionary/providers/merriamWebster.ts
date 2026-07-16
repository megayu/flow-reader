import type { DictionaryProvider } from '../coordinator'
import { cancelDictionarySession, fetchMerriamWebster } from '../native'
import type {
  DictionaryEntry,
  DictionaryResult,
  DictionarySense,
  DictionaryText,
  DictionaryTextRun,
} from '../types'

const SOURCE_ID = 'merriam-webster'
const SOURCE_NAME = 'Merriam-Webster'
const MAX_RESPONSE_LENGTH = 2_000_000
const MAX_WALK_DEPTH = 32
const MAX_WALK_NODES = 5_000
let nextNativeSessionId = 1

export class MerriamWebsterParseError extends Error {
  externalUrl: string

  constructor(externalUrl: string) {
    super('Could not parse this entry.')
    this.name = 'MerriamWebsterParseError'
    this.externalUrl = externalUrl
  }
}

class MerriamWebsterLookupError extends Error {
  externalUrl: string

  constructor(message: string, externalUrl: string) {
    super(message)
    this.name = 'MerriamWebsterLookupError'
    this.externalUrl = externalUrl
  }
}

export function createMerriamWebsterProvider(
  apiKey: string,
): DictionaryProvider {
  return {
    id: SOURCE_ID,
    name: SOURCE_NAME,
    scope: 'online',
    sourceLanguage: 'en',
    async lookup(query, { signal }) {
      const externalUrl = merriamWebsterExternalUrl(query.text)
      const key = apiKey.trim()
      if (!key) {
        throw new MerriamWebsterLookupError(
          'Merriam-Webster API key is not configured.',
          externalUrl,
        )
      }

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
        const response = await fetchMerriamWebster(query.text, key, sessionId)
        if (signal.aborted) {
          throw new DOMException('Request cancelled', 'AbortError')
        }
        return parseMerriamWebsterResponse(response.body, query.text)
      } catch (error) {
        if (signal.aborted || error instanceof MerriamWebsterParseError) {
          throw error
        }
        const message = error instanceof Error ? error.message : String(error)
        throw new MerriamWebsterLookupError(message, externalUrl)
      } finally {
        signal.removeEventListener('abort', cancel)
      }
    },
  }
}

export function merriamWebsterExternalUrl(query: string) {
  return `https://www.merriam-webster.com/dictionary/${encodeURIComponent(query)}`
}

export function parseMerriamWebsterResponse(
  body: string,
  query: string,
): DictionaryResult | null {
  const externalUrl = merriamWebsterExternalUrl(query)
  if (!body || body.length > MAX_RESPONSE_LENGTH) {
    throw new MerriamWebsterParseError(externalUrl)
  }

  let value: unknown
  try {
    value = JSON.parse(body)
  } catch {
    throw new MerriamWebsterParseError(externalUrl)
  }

  if (!Array.isArray(value)) throw new MerriamWebsterParseError(externalUrl)
  if (value.every((item) => typeof item === 'string')) return null

  const entries = value.flatMap<DictionaryEntry>((entry) => {
    try {
      const parsed = parseEntry(entry)
      return parsed ? [parsed] : []
    } catch {
      return []
    }
  })
  if (!entries.length) throw new MerriamWebsterParseError(externalUrl)

  return {
    content: { entries, kind: 'entries' },
    externalUrl,
    sourceId: SOURCE_ID,
    sourceName: SOURCE_NAME,
  }
}

function parseEntry(value: unknown): DictionaryEntry | undefined {
  if (!isRecord(value)) return

  const context: WalkContext = { nodes: 0, senses: [] }
  const definitions = Array.isArray(value.def) ? value.def : []
  definitions.forEach((definition) => {
    if (!isRecord(definition)) return
    walkSenseTree(definition.sseq, 0, context)
  })
  if (!context.senses.length) return

  const hwi = isRecord(value.hwi) ? value.hwi : undefined
  const rawHeadword = typeof hwi?.hw === 'string' ? hwi.hw : undefined

  return {
    headword: rawHeadword?.replaceAll('*', ''),
    homograph:
      typeof value.hom === 'number' && Number.isFinite(value.hom)
        ? value.hom
        : undefined,
    partOfSpeech: typeof value.fl === 'string' ? value.fl : undefined,
    senses: context.senses,
  }
}

interface WalkContext {
  nodes: number
  senses: DictionarySense[]
}

function walkSenseTree(value: unknown, depth: number, context: WalkContext) {
  context.nodes += 1
  if (depth > MAX_WALK_DEPTH || context.nodes > MAX_WALK_NODES) {
    throw new Error('Merriam-Webster definition tree is too complex')
  }

  if (!Array.isArray(value)) return
  if (typeof value[0] === 'string') {
    const [kind, payload] = value
    if (kind === 'sense' || kind === 'sen') {
      parseSense(payload).forEach((sense) => context.senses.push(sense))
      return
    }
    if (kind === 'bs' && isRecord(payload)) {
      parseSense(payload.sense).forEach((sense) => context.senses.push(sense))
      return
    }
    if (kind === 'pseq') {
      walkSenseTree(payload, depth + 1, context)
      return
    }
  }

  value.forEach((child) => walkSenseTree(child, depth + 1, context))
}

function parseSense(value: unknown): DictionarySense[] {
  if (!isRecord(value)) return []

  const definition = parseDefiningText(value.dt)
  const labels = senseLabels(value)
  const senses: DictionarySense[] = []
  if (definition) {
    senses.push({
      definition: prependLabels(definition, labels),
      marker: typeof value.sn === 'string' ? value.sn : undefined,
    })
  }

  if (isRecord(value.sdsense)) {
    const divided = parseDefiningText(value.sdsense.dt)
    if (divided) {
      const divider =
        typeof value.sdsense.sd === 'string' ? [value.sdsense.sd] : []
      senses.push({
        definition: prependLabels(divided, [
          ...divider,
          ...senseLabels(value.sdsense),
        ]),
      })
    }
  }

  return senses
}

function senseLabels(value: Record<string, unknown>) {
  const labels = [value.sls, value.lbs]
    .flatMap((item) => (Array.isArray(item) ? item : []))
    .filter((item): item is string => typeof item === 'string')
  if (typeof value.sgram === 'string') labels.push(value.sgram)
  return labels
}

function parseDefiningText(value: unknown): DictionaryText | undefined {
  if (!Array.isArray(value)) return

  const runs = value.flatMap<DictionaryTextRun>((item) => {
    if (!Array.isArray(item) || item[0] !== 'text') return []
    return typeof item[1] === 'string' ? parseMwTokens(item[1]) : []
  })
  if (!runs.some((run) => run.text.trim())) return
  return { kind: 'runs', runs: mergeRuns(runs) }
}

function parseMwTokens(value: string): DictionaryTextRun[] {
  const runs: DictionaryTextRun[] = []
  const tokenPattern = /\{([^{}]+)\}/gu
  let emphasisDepth = 0
  let position = 0

  const push = (kind: DictionaryTextRun['kind'], text: string) => {
    if (text) runs.push({ kind, text })
  }

  for (const match of value.matchAll(tokenPattern)) {
    const index = match.index ?? position
    push(emphasisDepth ? 'emphasis' : 'plain', value.slice(position, index))
    const token = match[1] ?? ''
    const [rawName, ...fields] = token.split('|')
    const name = rawName ?? ''

    if (['it', 'b', 'wi', 'sc', 'sup', 'inf'].includes(name)) {
      emphasisDepth += 1
    } else if (/^\/(?:it|b|wi|sc|sup|inf)$/u.test(name)) {
      emphasisDepth = Math.max(0, emphasisDepth - 1)
    } else if (name === 'bc') {
      if (runs.some((run) => run.text.trim())) push('plain', ': ')
    } else if (
      ['a_link', 'd_link', 'i_link', 'et_link', 'mat', 'sx', 'dxt'].includes(
        name,
      )
    ) {
      push('reference', fields[0] ?? '')
    } else if (name === 'ldquo') {
      push('plain', '“')
    } else if (name === 'rdquo') {
      push('plain', '”')
    } else if (name === 'phrase') {
      push('plain', fields[0] ?? '')
    }

    position = index + match[0].length
  }
  push(emphasisDepth ? 'emphasis' : 'plain', value.slice(position))
  return mergeRuns(runs)
}

function prependLabels(text: DictionaryText, labels: string[]): DictionaryText {
  if (!labels.length) return text
  const runs =
    text.kind === 'runs'
      ? text.runs
      : [{ kind: 'plain' as const, text: text.text }]
  return {
    kind: 'runs',
    runs: mergeRuns([
      { kind: 'label', text: labels.join(', ') },
      { kind: 'plain', text: ' ' },
      ...runs,
    ]),
  }
}

function mergeRuns(runs: DictionaryTextRun[]) {
  return runs.reduce<DictionaryTextRun[]>((merged, run) => {
    const previous = merged.at(-1)
    if (previous?.kind === run.kind) previous.text += run.text
    else merged.push({ ...run })
    return merged
  }, [])
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
