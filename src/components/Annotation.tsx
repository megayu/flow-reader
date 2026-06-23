import { useEffect } from 'react'
import { useSnapshot } from 'valtio'

import { colorMap, Annotation as IAnnotation } from '../annotation'
import { useColorScheme } from '../hooks/theme/useColorScheme'
import { BookTab, compareHref } from '../models/reader'

// avoid click penetration
let clickedAnnotation = false

export const getClickedAnnotation = () => clickedAnnotation
export const setClickedAnnotation = (v: boolean) => (clickedAnnotation = v)

const definitionPalette = [
  { light: '37, 99, 235', dark: '147, 197, 253' },
  { light: '124, 58, 237', dark: '196, 181, 253' },
  { light: '190, 24, 93', dark: '244, 114, 182' },
  { light: '194, 65, 12', dark: '251, 146, 60' },
  { light: '15, 118, 110', dark: '94, 234, 212' },
  { light: '5, 150, 105', dark: '110, 231, 183' },
  { light: '180, 83, 9', dark: '252, 211, 77' },
  { light: '8, 145, 178', dark: '103, 232, 249' },
]

function definitionColorIndex(definition: string) {
  let hash = 0
  const text = definition.trim().toLowerCase()

  for (let i = 0; i < text.length; i++) {
    hash = (hash * 31 + text.charCodeAt(i)) >>> 0
  }

  return hash % definitionPalette.length
}

function definitionHighlightStyle(definition: string, dark: boolean) {
  const color = definitionPalette[definitionColorIndex(definition)]!

  return {
    fill: `rgba(${dark ? color.dark : color.light}, ${dark ? 0.26 : 0.18})`,
    'fill-opacity': 'unset',
  }
}

interface FindMatchProps {
  tab: BookTab
}
const FindMatches: React.FC<FindMatchProps> = ({ tab }) => {
  const { rendition, results, currentHref } = useSnapshot(tab)

  useEffect(() => {
    const result = results?.find((r) => compareHref(currentHref, r.id))

    const matches = result?.subitems
    matches?.forEach((m) => {
      try {
        rendition?.annotations.highlight(
          m.cfi!,
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
      matches?.forEach((m) => {
        rendition?.annotations.remove(m.cfi!, 'highlight')
      })
    }
  }, [currentHref, rendition?.annotations, results])

  return null
}

interface DefinitionProps {
  tab: BookTab
  definition: string
  dark: boolean
}
const Definition: React.FC<DefinitionProps> = ({ tab, definition, dark }) => {
  const { rendition, currentHref } = useSnapshot(tab)

  useEffect(() => {
    const result = tab.searchInSection(definition)
    const matches = result?.subitems
    const styles = definitionHighlightStyle(definition, dark)

    matches?.forEach((m) => {
      try {
        rendition?.annotations.highlight(
          m.cfi!,
          undefined,
          (event?: Event) => {
            event?.preventDefault()
            event?.stopPropagation()
            tab.setAnnotationRange(m.cfi!)
            setClickedAnnotation(true)
          },
          undefined,
          styles,
        )
      } catch (error) {
        // ignore matched text in `<title>`
      }
    })

    return () => {
      matches?.forEach((m) =>
        rendition?.annotations.remove(m.cfi!, 'highlight'),
      )
    }
  }, [currentHref, dark, definition, rendition?.annotations, tab])

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
        tab.setAnnotationRange(annotation.cfi)
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
  tab: BookTab
}
export const Annotations: React.FC<AnnotationsProps> = ({ tab }) => {
  const { book, section } = useSnapshot(tab)
  const { dark } = useColorScheme()

  return (
    <>
      <FindMatches tab={tab} />
      {/* with `key`, react will mount/unmount it automatically */}
      {book.annotations
        // seems to fix annotation flash when executing `next()` and `display()`
        .filter((a) => a.spine.index === section?.index)
        .map((annotation) => (
          <Annotation key={annotation.id} tab={tab} annotation={annotation} />
        ))}
      {book.definitions.map((definition) => (
        <Definition
          key={definition}
          tab={tab}
          definition={definition}
          dark={!!dark}
        />
      ))}
    </>
  )
}
