type TextSearchUnit =
  | {
      kind: 'han'
      text: string
    }
  | {
      kind: 'word'
      text: string
    }

export type TextSearchCandidate = string | readonly string[]

export type TextSearchIndex = readonly TextSearchCandidate[]
export type TextSearchQuery = readonly string[]

const hanCharacterPattern = /\p{Script=Han}/u
const wordCharacterPattern = /[\p{Letter}\p{Number}]/u

export function createTextSearchUnits(value: string) {
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
