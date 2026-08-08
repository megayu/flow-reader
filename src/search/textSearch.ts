import { pinyin } from 'pinyin-pro'

type TextSearchUnit =
  | {
      kind: 'han'
      text: string
    }
  | {
      kind: 'word'
      text: string
    }

export type TextSearchIndex = readonly string[]
export type TextSearchQuery = readonly string[]

const hanCharacterPattern = /\p{Script=Han}/u
const wordCharacterPattern = /[\p{Letter}\p{Number}]/u

function createTextSearchUnits(value: string) {
  const units: TextSearchUnit[] = []
  let word = ''

  const finishWord = () => {
    if (!word) return
    units.push({ kind: 'word', text: word })
    word = ''
  }

  for (const character of value.normalize('NFKC').toLowerCase()) {
    if (hanCharacterPattern.test(character)) {
      finishWord()
      units.push({ kind: 'han', text: character })
      continue
    }

    if (wordCharacterPattern.test(character)) {
      word += character
      continue
    }

    finishWord()
  }
  finishWord()

  return units
}

function compactTextSearchValue(value: string) {
  return createTextSearchUnits(value)
    .map((unit) => unit.text)
    .join('')
}

function createTextSearchCandidates(value: string) {
  const units = createTextSearchUnits(value)
  if (!units.length) return []

  const hanText = units
    .filter((unit) => unit.kind === 'han')
    .map((unit) => unit.text)
    .join('')
  const hanInitials = hanText
    ? pinyin(hanText, {
        pattern: 'first',
        toneType: 'none',
        type: 'array',
      })
    : []
  let hanIndex = 0
  const literal = units.map((unit) => unit.text).join('')
  const hybrid = units.map((unit) => (unit.kind === 'word' ? unit.text : hanInitials[hanIndex++] || unit.text)).join('')
  hanIndex = 0
  const initials = units
    .map((unit) => (unit.kind === 'word' ? Array.from(unit.text)[0] : hanInitials[hanIndex++] || unit.text))
    .join('')

  return [literal, hybrid, initials].filter(Boolean)
}

export function createTextSearchIndex(values: readonly string[]): TextSearchIndex {
  return [...new Set(values.flatMap(createTextSearchCandidates))]
}

export function createTextSearchQuery(value: string): TextSearchQuery {
  return value.normalize('NFKC').toLowerCase().trim().split(/\s+/u).map(compactTextSearchValue).filter(Boolean)
}

export function matchesTextSearch(index: TextSearchIndex, query: string | TextSearchQuery) {
  const keywords = typeof query === 'string' ? createTextSearchQuery(query) : query

  return keywords.every((keyword) => index.some((candidate) => candidate.includes(keyword)))
}
