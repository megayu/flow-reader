import { pinyin } from 'pinyin-pro'

type TitleSearchUnit =
  | {
      kind: 'han'
      text: string
    }
  | {
      kind: 'word'
      text: string
    }

const hanCharacterPattern = /\p{Script=Han}/u
const wordCharacterPattern = /[\p{Letter}\p{Number}]/u

function createTitleSearchUnits(value: string) {
  const units: TitleSearchUnit[] = []
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

function compactSearchText(value: string) {
  return createTitleSearchUnits(value)
    .map((unit) => unit.text)
    .join('')
}

export function createLibraryTitleSearchCandidates(title: string) {
  const units = createTitleSearchUnits(title)
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

  return [...new Set([literal, hybrid, initials].filter(Boolean))]
}

export function matchesLibraryTitleSearch(candidates: readonly string[], query: string) {
  const keywords = query.normalize('NFKC').toLowerCase().trim().split(/\s+/u).map(compactSearchText).filter(Boolean)

  return keywords.every((keyword) => candidates.some((candidate) => candidate.includes(keyword)))
}
