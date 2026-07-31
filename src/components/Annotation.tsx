import { useEffect, useMemo, useRef } from 'react'
import { useSnapshot } from 'valtio'

import { colorMap, type Annotation as IAnnotation } from '../annotation'
import { useColorScheme } from '../hooks/theme/useColorScheme'
import type { BookTab } from '../models/reader'

const definitionPalette = [
  { light: '#dc2626', dark: '#ff4d4d' },
  { light: '#ea580c', dark: '#ff8a00' },
  { light: '#ca8a04', dark: '#fde047' },
  { light: '#16a34a', dark: '#8cff00' },
  { light: '#0891b2', dark: '#22d3ee' },
  { light: '#2563eb', dark: '#4d7cff' },
  { light: '#9333ea', dark: '#c084fc' },
  { light: '#111827', dark: '#f8fafc' },
]

const clickableMarkStyle = {
  cursor: 'pointer',
}

function definitionUnderlineStyle(index: number, dark: boolean) {
  const color = definitionPalette[index % definitionPalette.length]!

  return {
    ...clickableMarkStyle,
    'data-underline-style': 'wavy',
    'data-wave-amplitude': 2,
    'data-wave-gap': 1.5,
    'data-wave-period': 7,
    stroke: dark ? color.dark : color.light,
    'stroke-opacity': 1,
    'stroke-width': 2.2,
  }
}

interface FindMatchProps {
  active: boolean
  tab: BookTab
}
const FindMatches: React.FC<FindMatchProps> = ({ active, tab }) => {
  const { rendition, results, keyword, paginationVersion, viewVersion } = useSnapshot(tab)

  useEffect(() => {
    const query = keyword.trim()
    if (!active || !query || !results?.length) return

    const matches = renderedSearchMatches(tab, query)
    matches.forEach((m) => {
      try {
        rendition?.annotations.highlight(m.cfi, undefined, () => {}, undefined, {
          // tailwind yellow-500
          fill: 'rgba(234, 179, 8, 0.3)',
          'fill-opacity': 'unset',
        })
      } catch (_error) {
        // ignore matched text in `<title>`
      }
    })

    return () => {
      matches.forEach((m) => {
        try {
          rendition?.annotations.remove(m.cfi, 'highlight')
        } catch (_error) {
          // ignore removed views
        }
      })
    }
  }, [active, keyword, paginationVersion, rendition?.annotations, results, tab, viewVersion])

  return null
}

function renderedSearchMatches(tab: BookTab, keyword: string) {
  const views = tab.rendition?.manager?.views?.displayed?.() ?? tab.rendition?.manager?.views?._views ?? []
  const seen = new Set<string>()
  const matches: Array<{ cfi: string }> = []

  views.forEach((view: any) => {
    try {
      ;(view.section.find(keyword) as Array<{ cfi?: string }>).forEach((match) => {
        if (!match.cfi || seen.has(match.cfi)) return

        seen.add(match.cfi)
        matches.push({ cfi: match.cfi })
      })
    } catch (_error) {
      // ignore matched text in unsupported nodes
    }
  })

  return matches
}

interface DefinitionItem {
  definition: string
  index: number
}

interface DefinitionMatch {
  cfi: string
  index: number
}

const DEFINITION_MATCH_CACHE_LIMIT = 64

function getCachedDefinitionMatches(cache: Map<string, DefinitionMatch[]>, key: string) {
  const matches = cache.get(key)
  if (!matches) return

  cache.delete(key)
  cache.set(key, matches)
  return matches
}

function setCachedDefinitionMatches(cache: Map<string, DefinitionMatch[]>, key: string, matches: DefinitionMatch[]) {
  cache.set(key, matches)

  while (cache.size > DEFINITION_MATCH_CACHE_LIMIT) {
    const oldestKey = cache.keys().next().value
    if (oldestKey === undefined) break
    cache.delete(oldestKey)
  }
}

interface DefinitionsProps {
  active: boolean
  definitions: readonly string[]
  tab: BookTab
  dark: boolean
}
const Definitions: React.FC<DefinitionsProps> = ({ active, definitions, tab, dark }) => {
  const { book, rendition, rendered, visibleSectionIndexes, paginationVersion, viewVersion, overlayVersion } =
    useSnapshot(tab)
  const matchCacheRef = useRef<Map<string, DefinitionMatch[]> | undefined>(undefined)
  const matchCacheScopeRef = useRef<string | undefined>(undefined)
  matchCacheRef.current ??= new Map()
  const definitionItems = useMemo(
    () =>
      definitions.reduce<DefinitionItem[]>((items, definition, index) => {
        const normalized = definition.trim()
        if (normalized) items.push({ definition: normalized, index })
        return items
      }, []),
    [definitions],
  )
  const definitionKey = useMemo(() => definitionItems.map((item) => item.definition).join('\u0000'), [definitionItems])
  const matchCacheScope = `${book.id}:${book.contentVersion}:${definitionKey}`
  const visibleSectionKey = visibleSectionIndexes.join('|')

  useEffect(() => {
    if (matchCacheScopeRef.current === matchCacheScope) return

    matchCacheScopeRef.current = matchCacheScope
    matchCacheRef.current?.clear()
  }, [matchCacheScope])

  useEffect(() => {
    const annotations = rendition?.annotations
    let cancelled = false
    const drawnCfis: string[] = []
    const currentSections = tab.visibleSections.filter((section) => visibleSectionIndexes.includes(section.index))

    if (!active || !rendered || !annotations || !currentSections.length || !definitionItems.length) {
      return
    }

    void (async () => {
      const matchesBySection = await Promise.all(
        currentSections.map(async (currentSection) => {
          const cacheKey = `${currentSection.index}:${definitionKey}`
          let sectionMatches = matchCacheRef.current
            ? getCachedDefinitionMatches(matchCacheRef.current, cacheKey)
            : undefined

          if (!sectionMatches) {
            await tab.ensureSectionInfo(currentSection)
            if (cancelled) return [] as DefinitionMatch[]

            sectionMatches = definitionItems.flatMap(({ definition, index }) => {
              const result = tab.searchInSection(definition, currentSection)
              return result?.subitems.flatMap((match) => (match.cfi ? [{ cfi: match.cfi, index }] : [])) ?? []
            })
            if (matchCacheRef.current) {
              setCachedDefinitionMatches(matchCacheRef.current, cacheKey, sectionMatches)
            }
          }

          return sectionMatches
        }),
      )

      if (cancelled) return

      const matches = matchesBySection.flat()

      matches.forEach((match) => {
        const styles = definitionUnderlineStyle(match.index, dark)

        try {
          annotations.underline(
            match.cfi,
            undefined,
            (event?: Event) => {
              event?.preventDefault()
              event?.stopPropagation()
              tab.setAnnotationRange(match.cfi, event?.currentTarget)
            },
            'flow-definition-underline',
            styles,
          )
          drawnCfis.push(match.cfi)
        } catch (_error) {
          // ignore matched text in `<title>`
        }
      })
    })().catch((error) => {
      if (!cancelled) console.error(error)
    })

    return () => {
      cancelled = true
      drawnCfis.forEach((cfi) => {
        try {
          annotations.remove(cfi, 'underline')
        } catch (_error) {
          // ignore removed views
        }
      })
    }
  }, [
    active,
    dark,
    definitionItems,
    definitionKey,
    overlayVersion,
    paginationVersion,
    rendered,
    rendition?.annotations,
    tab,
    visibleSectionKey,
    visibleSectionIndexes,
    viewVersion,
  ])

  return null
}

interface AnnotationProps {
  tab: BookTab
  annotation: IAnnotation
}
const Annotation: React.FC<AnnotationProps> = ({ tab, annotation }) => {
  const { rendition, viewVersion, overlayVersion } = useSnapshot(tab)

  useEffect(() => {
    rendition?.annotations[annotation.type](
      annotation.cfi,
      undefined,
      (event?: Event) => {
        event?.preventDefault()
        event?.stopPropagation()
        tab.setAnnotationRange(annotation.cfi, event?.currentTarget)
      },
      undefined,
      {
        ...clickableMarkStyle,
        fill: colorMap[annotation.color],
        'fill-opacity': 'unset',
      },
    )

    return () => {
      rendition?.annotations.remove(annotation.cfi, annotation.type)
    }
  }, [annotation.cfi, annotation.color, annotation.type, overlayVersion, rendition?.annotations, tab, viewVersion])

  return null
}

interface AnnotationsProps {
  active: boolean
  tab: BookTab
}
export const Annotations: React.FC<AnnotationsProps> = ({ active, tab }) => {
  const { overlayState, visibleSectionIndexes, overlayVersion } = useSnapshot(tab)
  const { dark } = useColorScheme()
  void overlayVersion
  const visibleSectionIndexSet = new Set(visibleSectionIndexes)

  return (
    <>
      <FindMatches active={active} tab={tab} />
      {/* with `key`, react will mount/unmount it automatically */}
      {active &&
        overlayState.annotations.flatMap((annotation) =>
          // seems to fix annotation flash when executing `next()` and `display()`
          visibleSectionIndexSet.has(annotation.spine.index)
            ? [<Annotation key={annotation.id} tab={tab} annotation={annotation} />]
            : [],
        )}
      <Definitions active={active} definitions={overlayState.definitions} tab={tab} dark={!!dark} />
    </>
  )
}
