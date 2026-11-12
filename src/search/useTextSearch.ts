import { useEffect, useMemo, useState } from 'react'

import { createTextSearchQuery, createTextSearchUnits, matchesTextSearch, type TextSearchIndex } from './textSearch'

type PinyinSearch = typeof import('./pinyinTextSearch')

export function getSearchName(item: { name: string }) {
  return item.name
}

function searchField(value: string) {
  const units = createTextSearchUnits(value)
  const hasHan = units.some((unit) => unit.kind === 'han')
  let pinyinIndex: TextSearchIndex | undefined
  return {
    hasHan,
    literal: units.map((unit) => unit.text).join(''),
    // Prevent word initials on opposite sides of a Han character from matching across it.
    wordInitials: units.map((unit) => (unit.kind === 'han' ? '\0' : Array.from(unit.text)[0])).join(''),
    matchesPinyin(word: string, pinyin: PinyinSearch) {
      if (!hasHan) return false
      pinyinIndex ??= pinyin.createTextSearchIndex([value])
      return matchesTextSearch(pinyinIndex, [word])
    },
  }
}

export function useTextSearch<T>(
  items: readonly T[],
  input: string,
  valuesFor: (item: T) => string | readonly string[],
) {
  const query = useMemo(() => createTextSearchQuery(input), [input])
  const active = query.length > 0
  const rows = useMemo(() => {
    if (!active) return undefined
    return items.map((item) => {
      const values = valuesFor(item)
      return { item, fields: (typeof values === 'string' ? [values] : values).map(searchField) }
    })
  }, [active, items, valuesFor])
  const [pinyin, setPinyin] = useState<PinyinSearch>()
  const { matches, needsPinyin } = useMemo(() => {
    if (!rows) return { matches: items, needsPinyin: false }
    const matches: T[] = []
    let needsPinyin = false
    for (const { item, fields } of rows) {
      const missing = query.filter(
        (word) => !fields.some((f) => f.literal.includes(word) || f.wordInitials.includes(word)),
      )
      if (missing.length) {
        if (!missing.every((word) => /[a-z]/.test(word)) || !fields.some((f) => f.hasHan)) continue
        if (!pinyin) {
          needsPinyin = true
          continue
        }
        if (!missing.every((word) => fields.some((field) => field.matchesPinyin(word, pinyin)))) continue
      }
      matches.push(item)
    }
    return { matches, needsPinyin }
  }, [items, pinyin, query, rows])

  useEffect(() => {
    if (!needsPinyin) return
    let current = true
    void import('./pinyinTextSearch')
      .then((module) => {
        if (current) setPinyin(module)
      })
      .catch(console.error)
    return () => {
      current = false
    }
  }, [needsPinyin, query])

  return matches
}
