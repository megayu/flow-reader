import { useEffect, useMemo, useRef } from 'react'
import { useSnapshot } from 'valtio'

import { colorMap, Annotation as IAnnotation } from '../annotation'
import { useColorScheme } from '../hooks/theme/useColorScheme'
import { BookTab } from '../models/reader'

// avoid click penetration
let clickedAnnotation = false

export const getClickedAnnotation = () => clickedAnnotation
export const setClickedAnnotation = (v: boolean) => (clickedAnnotation = v)

const definitionPalette = [
  { light: '#2563eb', dark: '#60a5fa' },
  { light: '#dc2626', dark: '#f87171' },
  { light: '#16a34a', dark: '#4ade80' },
  { light: '#9333ea', dark: '#c084fc' },
  { light: '#ea580c', dark: '#fb923c' },
  { light: '#0891b2', dark: '#22d3ee' },
  { light: '#db2777', dark: '#f472b6' },
  { light: '#65a30d', dark: '#a3e635' },
  { light: '#4f46e5', dark: '#818cf8' },
  { light: '#0d9488', dark: '#2dd4bf' },
]

function definitionUnderlineStyle(index: number, dark: boolean) {
  const color = definitionPalette[index % definitionPalette.length]!

  return {
    'data-underline-style': 'wavy',
    'data-wave-amplitude': 2,
    'data-wave-gap': 1.5,
    'data-wave-period': 7,
    stroke: dark ? color.dark : color.light,
    'stroke-opacity': dark ? 0.95 : 0.9,
    'stroke-width': 1.8,
  }
}

interface FindMatchProps {
  active: boolean
  tab: BookTab
}
const FindMatches: React.FC<FindMatchProps> = ({ active, tab }) => {
  const { rendition, results, keyword, currentLocation, iframes } =
    useSnapshot(tab)

  useEffect(() => {
    const query = keyword.trim()
    if (!active || !query || !results?.length) return

    const matches = renderedSearchMatches(tab, query)
    matches.forEach((m) => {
      try {
        rendition?.annotations.highlight(
          m.cfi,
          undefined,
          () => {
            setClickedAnnotation(true)
          },
          undefined,
          {
            // tailwind yellow-500
            fill: 'rgba(234, 179, 8, 0.3)',
            'fill-opacity': 'unset',
          },
        )
      } catch (error) {
        // ignore matched text in `<title>`
      }
    })

    return () => {
      matches.forEach((m) => {
        try {
          rendition?.annotations.remove(m.cfi, 'highlight')
        } catch (error) {
          // ignore removed views
        }
      })
    }
  }, [
    currentLocation,
    active,
    iframes.length,
    keyword,
    rendition?.annotations,
    results,
    tab,
  ])

  return null
}

function renderedSearchMatches(tab: BookTab, keyword: string) {
  const views =
    tab.rendition?.manager?.views?.displayed?.() ??
    tab.rendition?.manager?.views?._views ??
    []
  const seen = new Set<string>()
  const matches: Array<{ cfi: string }> = []

  views.forEach((view: any) => {
    try {
      ;(view.section.find(keyword) as Array<{ cfi?: string }>).forEach(
        (match) => {
          if (!match.cfi || seen.has(match.cfi)) return

          seen.add(match.cfi)
          matches.push({ cfi: match.cfi })
        },
      )
    } catch (error) {
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

interface DefinitionsProps {
  active: boolean
  definitions: readonly string[]
  tab: BookTab
  dark: boolean
}
const Definitions: React.FC<DefinitionsProps> = ({
  active,
  definitions,
  tab,
  dark,
}) => {
  const { rendition, currentHref, rendered, section } = useSnapshot(tab)
  const matchCacheRef = useRef(new Map<string, DefinitionMatch[]>())
  const definitionItems = useMemo(
    () =>
      definitions
        .map(
          (definition, index): DefinitionItem => ({
            definition: definition.trim(),
            index,
          }),
        )
        .filter((item) => item.definition),
    [definitions],
  )
  const definitionKey = useMemo(
    () => definitionItems.map((item) => item.definition).join('\u0000'),
    [definitionItems],
  )

  useEffect(() => {
    const annotations = rendition?.annotations
    let cancelled = false
    const drawnCfis: string[] = []
    const currentSection = tab.section
    const sectionIndex = currentSection?.index

    if (
      !active ||
      !rendered ||
      !annotations ||
      !currentSection ||
      sectionIndex === undefined ||
      !definitionItems.length
    ) {
      return
    }

    const cacheKey = `${sectionIndex}:${definitionKey}`

    void (async () => {
      let matches = matchCacheRef.current.get(cacheKey)

      if (!matches) {
        await tab.ensureSectionInfo(currentSection)
        if (cancelled || tab.section?.index !== sectionIndex) return

        matches = definitionItems.flatMap(({ definition, index }) => {
          const result = tab.searchInSection(definition, currentSection)
          return (
            result?.subitems.flatMap((match) =>
              match.cfi ? [{ cfi: match.cfi, index }] : [],
            ) ?? []
          )
        })
        matchCacheRef.current.set(cacheKey, matches)
      }

      if (cancelled || tab.section?.index !== sectionIndex) return

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
              setClickedAnnotation(true)
            },
            'flow-definition-underline',
            styles,
          )
          drawnCfis.push(match.cfi)
        } catch (error) {
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
        } catch (error) {
          // ignore removed views
        }
      })
    }
  }, [
    active,
    currentHref,
    dark,
    definitionItems,
    definitionKey,
    rendered,
    rendition?.annotations,
    section?.index,
    tab,
  ])

  return null
}

interface AnnotationProps {
  tab: BookTab
  annotation: IAnnotation
}
const Annotation: React.FC<AnnotationProps> = ({ tab, annotation }) => {
  const { rendition } = useSnapshot(tab)

  useEffect(() => {
    rendition?.annotations[annotation.type](
      annotation.cfi,
      undefined,
      (event?: Event) => {
        event?.preventDefault()
        event?.stopPropagation()
        tab.setAnnotationRange(annotation.cfi, event?.currentTarget)
        setClickedAnnotation(true)
      },
      undefined,
      {
        fill: colorMap[annotation.color],
        'fill-opacity': '0.5',
      },
    )

    return () => {
      rendition?.annotations.remove(annotation.cfi, annotation.type)
    }
  }, [
    annotation.cfi,
    annotation.color,
    annotation.type,
    rendition?.annotations,
    tab,
  ])

  return null
}

interface AnnotationsProps {
  active: boolean
  tab: BookTab
}
export const Annotations: React.FC<AnnotationsProps> = ({ active, tab }) => {
  const { book, section } = useSnapshot(tab)
  const { dark } = useColorScheme()

  return (
    <>
      <FindMatches active={active} tab={tab} />
      {/* with `key`, react will mount/unmount it automatically */}
      {active &&
        book.annotations
          // seems to fix annotation flash when executing `next()` and `display()`
          .filter((a) => a.spine.index === section?.index)
          .map((annotation) => (
            <Annotation key={annotation.id} tab={tab} annotation={annotation} />
          ))}
      <Definitions
        active={active}
        definitions={book.definitions}
        tab={tab}
        dark={!!dark}
      />
    </>
  )
}
