import { CopyIcon, FoldVerticalIcon, UnfoldVerticalIcon } from 'lucide-react'
import React, { useMemo, useState } from 'react'

import { Annotation, getAnnotationSpineTitle } from '@/annotation'
import { useList } from '@/hooks/useList'
import { useTranslation } from '@/hooks/useTranslation'
import { reader, useReaderSnapshot } from '@/models/reader'
import { copy, group, keys } from '@/utils'

import { Row } from '../Row'
import { Pane, PaneView, PaneViewProps } from '../base/PaneView'

export const AnnotationView: React.FC<PaneViewProps> = (props) => {
  const active = props.active ?? true

  return (
    <PaneView {...props}>
      {active && (
        <>
          <DefinitionPane />
          <AnnotationPane />
        </>
      )}
    </PaneView>
  )
}

const DefinitionPane: React.FC = () => {
  const { focusedBookTab } = useReaderSnapshot()
  const t = useTranslation('annotation')
  const definitions = focusedBookTab?.overlayState.definitions ?? []
  const { outerRef, items, scrollbar, totalSize } = useList(definitions)

  return (
    <Pane
      headline={t('definitions')}
      minSize={72}
      overlayScroll
      preferredSize={120}
      ref={outerRef}
      reserveScrollbarWidth
      scrollbar={{ ...scrollbar, scrollRef: outerRef }}
      storageKey="flow-reader:pane:annotation:definitions"
    >
      <div className="relative" style={{ height: totalSize }}>
        {items.map(({ index, start, size }) => {
          const definition = definitions[index]
          if (!definition) return null

          return (
            <div
              key={definition}
              className="absolute top-0 right-0 left-0"
              style={{
                height: size,
                transform: `translateY(${start}px)`,
              }}
            >
              <Row
                onDelete={() => {
                  reader.focusedBookTab?.undefine(definition)
                }}
              >
                {definition}
              </Row>
            </div>
          )
        })}
      </div>
    </Pane>
  )
}

type AnnotationRow =
  | {
      annotations: Annotation[]
      expanded: boolean
      id: string
      type: 'section'
    }
  | {
      annotation: Annotation
      type: 'annotation'
    }
  | {
      annotation: Annotation
      type: 'note'
    }

const AnnotationPane: React.FC = () => {
  const { focusedBookTab } = useReaderSnapshot()
  const t = useTranslation()
  const annotationT = useTranslation('annotation')
  const [collapsedSections, setCollapsedSections] = useState(
    () => new Set<string>(),
  )
  const [activeRowKey, setActiveRowKey] = useState<string>()

  const annotations = useMemo(
    () => (focusedBookTab?.overlayState.annotations as Annotation[]) ?? [],
    [focusedBookTab?.overlayState.annotations],
  )

  const groupedAnnotation = useMemo(() => {
    return group(annotations ?? [], (a) => a.spine.index)
  }, [annotations])
  const sectionIds = useMemo(() => keys(groupedAnnotation), [groupedAnnotation])
  const expanded = sectionIds.some((id) => !collapsedSections.has(id))
  const rows = useMemo(
    () =>
      sectionIds.flatMap((id): AnnotationRow[] => {
        const annotations = groupedAnnotation[id] ?? []
        const sectionExpanded = !collapsedSections.has(id)

        if (!sectionExpanded) {
          return [
            {
              annotations,
              expanded: false,
              id,
              type: 'section',
            },
          ]
        }

        return [
          {
            annotations,
            expanded: true,
            id,
            type: 'section',
          },
          ...annotations.flatMap((annotation): AnnotationRow[] => [
            {
              annotation,
              type: 'annotation',
            },
            ...(annotation.notes
              ? [
                  {
                    annotation,
                    type: 'note' as const,
                  },
                ]
              : []),
          ]),
        ]
      }),
    [collapsedSections, groupedAnnotation, sectionIds],
  )
  const { outerRef, items, scrollbar, totalSize } = useList(rows)
  const toggleSections = () => {
    setCollapsedSections(() => (expanded ? new Set(sectionIds) : new Set()))
  }
  const toggleSection = (id: string) => {
    setCollapsedSections((current) => {
      const next = new Set(current)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  const exportAnnotations = () => {
    // process annotations to be under each section
    // group annotations by title
    const grouped = group(annotations, (a) => getAnnotationSpineTitle(a.spine))
    const exported: Record<string, any[]> = {}
    for (const chapter in grouped) {
      const annotations =
        grouped[chapter]?.map((a) => {
          const annotation: Record<string, any> = {}
          if (a.notes !== undefined) annotation.notes = a.notes
          if (a.text !== undefined) annotation.text = a.text
          return annotation
        }) ?? []
      exported[chapter] = annotations
    }

    // Copy to clipboard as markdown
    const exportedAnnotationsMd = Object.entries(exported)
      .map(([chapter, annotations]) => {
        return `## ${chapter}\n${annotations
          .map((a) => `- ${a.text} ${a.notes ? `(${a.notes})` : ''}`)
          .join('\n')}`
      })
      .join('\n\n')
    copy(exportedAnnotationsMd)
  }

  return (
    <Pane
      headline={annotationT('annotations')}
      minSize={160}
      overlayScroll
      ref={outerRef}
      reserveScrollbarWidth
      scrollbar={{ ...scrollbar, scrollRef: outerRef }}
      storageKey="flow-reader:pane:annotation:annotations"
      actions={
        annotations.length > 0
          ? [
              {
                id: 'copy-all',
                title: annotationT('copy_as_markdown'),
                Icon: CopyIcon,
                handle() {
                  exportAnnotations()
                },
              },
              {
                id: expanded ? 'collapse-all' : 'expand-all',
                title: t(
                  expanded ? 'action.collapse_all' : 'action.expand_all',
                ),
                Icon: expanded ? FoldVerticalIcon : UnfoldVerticalIcon,
                handle() {
                  toggleSections()
                },
              },
            ]
          : undefined
      }
    >
      <div className="relative" style={{ height: totalSize }}>
        {items.map(({ index, start, size }) => {
          const row = rows[index]
          if (!row) return null
          const rowKey = annotationRowKey(row)
          const activeKey = `${focusedBookTab?.id}:${rowKey}`

          return (
            <div
              key={rowKey}
              className="absolute top-0 right-0 left-0"
              style={{
                height: size,
                transform: `translateY(${start}px)`,
              }}
            >
              {row.type === 'section' ? (
                <Row
                  depth={1}
                  badge
                  expanded={row.expanded}
                  toggle={() => toggleSection(row.id)}
                  subitems={row.annotations}
                >
                  {row.annotations[0]
                    ? getAnnotationSpineTitle(row.annotations[0].spine)
                    : undefined}
                </Row>
              ) : row.type === 'annotation' ? (
                <Row
                  active={activeRowKey === activeKey}
                  depth={2}
                  onClick={() => {
                    setActiveRowKey(activeKey)
                    reader.focusedBookTab?.display(row.annotation.cfi)
                  }}
                  onDelete={() => {
                    reader.focusedBookTab?.removeAnnotation(row.annotation.cfi)
                  }}
                >
                  {row.annotation.text}
                </Row>
              ) : (
                <Row
                  active={activeRowKey === activeKey}
                  depth={3}
                  onClick={() => {
                    setActiveRowKey(activeKey)
                    reader.focusedBookTab?.display(row.annotation.cfi)
                  }}
                >
                  <span className="text-muted-foreground">
                    {row.annotation.notes}
                  </span>
                </Row>
              )}
            </div>
          )
        })}
      </div>
    </Pane>
  )
}

function annotationRowKey(row: AnnotationRow) {
  if (row.type === 'section') return `section:${row.id}`
  return `${row.type}:${row.annotation.id}`
}
