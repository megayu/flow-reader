import { pinyin, polyphonic } from 'pinyin-pro'

type TextSearchUnit =
  | {
      kind: 'han'
      text: string
    }
  | {
      kind: 'word'
      text: string
    }

type TextSearchCandidate = string | readonly string[]

export type TextSearchIndex = readonly TextSearchCandidate[]
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

  const candidates: TextSearchCandidate[] = [literal, hybrid, initials].filter(Boolean)
  if (!hanText) return candidates
  const alternatives = polyphonic(hanText, { pattern: 'first', toneType: 'none', type: 'array' }).map((options) =>
    [...new Set(options)].join(''),
  )
  if (alternatives.some((options) => options.length > 1)) {
    for (const abbreviateWords of [false, true]) {
      hanIndex = 0
      candidates.push(
        units.flatMap((unit) => {
          if (unit.kind === 'han') return [alternatives[hanIndex++] || unit.text]
          const characters = Array.from(unit.text)
          return abbreviateWords ? characters.slice(0, 1) : characters
        }),
      )
      if (hybrid === initials) break
    }
  }
  return candidates
}

export function createTextSearchIndex(values: readonly string[]): TextSearchIndex {
  return [...new Set(values.flatMap(createTextSearchCandidates))]
}

export function createTextSearchQuery(value: string): TextSearchQuery {
  return value.normalize('NFKC').toLowerCase().trim().split(/\s+/u).map(compactTextSearchValue).filter(Boolean)
}

export function matchesTextSearch(index: TextSearchIndex, query: string | TextSearchQuery) {
  const keywords = typeof query === 'string' ? createTextSearchQuery(query) : query

  return keywords.every((keyword) => {
    if (index.some((candidate) => typeof candidate === 'string' && candidate.includes(keyword))) return true
    if (index.every((candidate) => typeof candidate === 'string')) return false

    // Shift-And tracks all matching prefixes without expanding polyphonic combinations.
    const masks = new Map<string, bigint>()
    let bit = 1n
    for (const character of keyword) {
      masks.set(character, (masks.get(character) ?? 0n) | bit)
      bit <<= 1n
    }
    const complete = bit >> 1n
    return index.some((candidate) => {
      if (typeof candidate === 'string') return false
      let matched = 0n
      for (const options of candidate) {
        let mask = 0n
        for (const character of options) mask |= masks.get(character) ?? 0n
        matched = ((matched << 1n) | 1n) & mask
        if ((matched & complete) !== 0n) return true
      }
      return false
    })
  })
}
