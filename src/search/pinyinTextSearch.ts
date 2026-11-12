import { pinyin, polyphonic } from 'pinyin-pro'

import { createTextSearchUnits, type TextSearchCandidate, type TextSearchIndex } from './textSearch'

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
