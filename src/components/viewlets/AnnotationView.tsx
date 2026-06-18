import React, { Fragment, useMemo, useState } from 'react'
import { VscCollapseAll, VscCopy, VscExpandAll } from 'react-icons/vsc'

import { Annotation } from '@flow/reader/annotation'
import { useTranslation } from '@flow/reader/hooks'
import { reader, useReaderSnapshot } from '@flow/reader/models'
import { copy, group, keys } from '@flow/reader/utils'

import { Row } from '../Row'
import { PaneViewProps, PaneView, Pane } from '../base'

export const AnnotationView: React.FC<PaneViewProps> = (props) => {
  return (
    <PaneView {...props}>
      <DefinitionPane />
      <AnnotationPane />
    </PaneView>
  )
}

const DefinitionPane: React.FC = () => {
  const { focusedBookTab } = useReaderSnapshot()
  const t = useTranslation('annotation')

  return (
    <Pane headline={t('definitions')} preferredSize={120}>
      {focusedBookTab?.book.definitions.map((d) => {
        return (
          <Row
            key={d}
            onDelete={() => {
              reader.focusedBookTab?.undefine(d)
            }}
          >
            {d}
          </Row>
        )
      })}
    </Pane>
  )
}

const AnnotationPane: React.FC = () => {
  const { focusedBookTab } = useReaderSnapshot()
  const t = useTranslation()
  const annotationT = useTranslation('annotation')
  const [collapsedSections, setCollapsedSections] = useState(
    () => new Set<string>(),
  )

  const annotations = useMemo(
    () => (focusedBookTab?.book.annotations as Annotation[]) ?? [],
    [focusedBookTab?.book.annotations],
  )

  const groupedAnnotation = useMemo(() => {
    return group(annotations ?? [], (a) => a.spine.index)
  }, [annotations])
  const sectionIds = useMemo(() => keys(groupedAnnotation), [groupedAnnotation])
  const expanded = sectionIds.some((id) => !collapsedSections.has(id))
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
    const grouped = group(annotations, (a) => a.spine.title)
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
      actions={
        annotations.length > 0
          ? [
              {
                id: 'copy-all',
                title: annotationT('copy_as_markdown'),
                Icon: VscCopy,
                handle() {
                  exportAnnotations()
                },
              },
              {
                id: expanded ? 'collapse-all' : 'expand-all',
                title: t(
                  expanded ? 'action.collapse_all' : 'action.expand_all',
                ),
                Icon: expanded ? VscCollapseAll : VscExpandAll,
                handle() {
                  toggleSections()
                },
              },
            ]
          : undefined
      }
    >
      {sectionIds.map((k) => (
        <AnnotationBlock
          key={k}
          annotations={groupedAnnotation[k]!}
          expanded={!collapsedSections.has(k)}
          toggle={() => toggleSection(k)}
        />
      ))}
    </Pane>
  )
}

interface AnnotationBlockProps {
  annotations: Annotation[]
  expanded: boolean
  toggle: () => void
}
const AnnotationBlock: React.FC<AnnotationBlockProps> = ({
  annotations,
  expanded,
  toggle,
}) => {
  return (
    <div>
      <Row
        depth={1}
        badge
        expanded={expanded}
        toggle={toggle}
        subitems={annotations}
      >
        {annotations[0]?.spine.title}
      </Row>

      {expanded && (
        <div>
          {annotations.map((a) => (
            <Fragment key={a.id}>
              <Row
                depth={2}
                onClick={() => {
                  reader.focusedBookTab?.display(a.cfi)
                }}
                onDelete={() => {
                  reader.focusedBookTab?.removeAnnotation(a.cfi)
                }}
              >
                {a.text}
              </Row>
              {a.notes && (
                <Row
                  depth={3}
                  onClick={() => {
                    reader.focusedBookTab?.display(a.cfi)
                  }}
                >
                  <span className="text-outline">{a.notes}</span>
                </Row>
              )}
            </Fragment>
          ))}
        </div>
      )}
    </div>
  )
}
