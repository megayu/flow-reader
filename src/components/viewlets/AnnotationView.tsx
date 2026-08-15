import { DownloadIcon, FilterIcon, FoldVerticalIcon, LocateFixedIcon, UnfoldVerticalIcon } from 'lucide-react'
import type React from 'react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import { type Annotation, annotationColorIcons, getAnnotationSpineTitle } from '@/annotation'
import {
  type AnnotationExportFormat,
  createAnnotationExport,
  serializeAnnotationsAsJson,
  serializeAnnotationsAsMarkdown,
  sortAnnotationsInReadingOrder,
} from '@/annotationExport'
import { saveAnnotationExport } from '@/annotationExportFile'
import {
  type AnnotationFilterValue,
  createDefaultAnnotationFilter,
  filterAnnotations,
  isDefaultAnnotationFilter,
} from '@/annotationFilter'
import { formatErrorMessage } from '@/errorMessage'
import { useList } from '@/hooks/useList'
import { useTranslation } from '@/hooks/useTranslation'
import { getBookTabFrameWindows, reader, useReaderSnapshot } from '@/models/reader'
import { copy } from '@/utils'

import { AppTooltip } from '../AppTooltip'
import { Pane, PaneView, type PaneViewProps } from '../base/PaneView'
import { IconButton } from '../IconButton'
import { Row } from '../Row'
import { Button } from '../ui/button'
import { Checkbox } from '../ui/checkbox'
import { useNotify } from '../ui/notificationContext'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'

import { AnnotationFilterFields } from './AnnotationFilterFields'

export const AnnotationView: React.FC<PaneViewProps> = (props) => {
  const active = props.active ?? true
  const { focusedBookTab } = useReaderSnapshot()

  return (
    <PaneView {...props}>
      {active && (
        <>
          <DefinitionPane />
          <AnnotationPane key={focusedBookTab?.id} />
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
      stateKey="annotationDefinitions"
    >
      <div className="relative" style={{ height: totalSize }}>
        {items.map(({ index, start, size }) => {
          const definition = definitions[index]
          if (!definition) return null

          return (
            <div
              key={definition}
              className="absolute top-0 right-0 left-0"
              style={{ height: size, transform: `translateY(${start}px)` }}
            >
              <Row onDelete={() => reader.focusedBookTab?.undefine(definition)}>{definition}</Row>
            </div>
          )
        })}
      </div>
    </Pane>
  )
}

type AnnotationRow =
  | { annotations: Annotation[]; expanded: boolean; id: number; type: 'section' }
  | { annotation: Annotation; type: 'annotation' }
  | { annotation: Annotation; type: 'note' }

const AnnotationPane: React.FC = () => {
  const { focusedBookTab } = useReaderSnapshot()
  const t = useTranslation()
  const annotationT = useTranslation('annotation')
  const [collapsedSections, setCollapsedSections] = useState(() => new Set<number>())
  const [filter, setFilter] = useState(createDefaultAnnotationFilter)
  const [activeRowKey, setActiveRowKey] = useState<string>()
  const [exportOpen, setExportOpen] = useState(false)
  const [filterOpen, setFilterOpen] = useState(false)
  const pendingSectionRef = useRef<number | undefined>(undefined)
  const popoverOpen = exportOpen || filterOpen

  useEffect(() => {
    const tab = reader.focusedBookTab
    const frameWindows = popoverOpen && tab ? getBookTabFrameWindows(tab) : []
    const closePopovers = () => {
      setExportOpen(false)
      setFilterOpen(false)
    }
    frameWindows.forEach((frame) => frame.addEventListener('mousedown', closePopovers, true))
    return () => frameWindows.forEach((frame) => frame.removeEventListener('mousedown', closePopovers, true))
  }, [focusedBookTab?.viewVersion, popoverOpen])

  const annotations = useMemo(
    () => (focusedBookTab?.overlayState.annotations as Annotation[]) ?? [],
    [focusedBookTab?.overlayState.annotations],
  )
  const sortedAnnotations = useMemo(() => {
    const tab = reader.focusedBookTab
    if (!tab) return []
    return sortAnnotationsInReadingOrder(annotations, tab.compareCfi.bind(tab))
  }, [annotations])
  const filteredAnnotations = useMemo(() => filterAnnotations(sortedAnnotations, filter), [filter, sortedAnnotations])
  const sections = useMemo(() => {
    const grouped: { annotations: Annotation[]; id: number }[] = []
    for (const annotation of filteredAnnotations) {
      const section = grouped.at(-1)
      if (section?.id === annotation.spine.index) section.annotations.push(annotation)
      else grouped.push({ annotations: [annotation], id: annotation.spine.index })
    }
    return grouped
  }, [filteredAnnotations])
  const sectionIds = useMemo(() => sections.map(({ id }) => id), [sections])
  const expanded = sectionIds.some((id) => !collapsedSections.has(id))
  const rows = useMemo(
    () =>
      sections.flatMap(({ annotations, id }): AnnotationRow[] => {
        const sectionExpanded = !collapsedSections.has(id)
        const sectionRow: AnnotationRow = { annotations, expanded: sectionExpanded, id, type: 'section' }
        if (!sectionExpanded) return [sectionRow]

        return [
          sectionRow,
          ...annotations.flatMap((annotation): AnnotationRow[] => [
            { annotation, type: 'annotation' },
            ...(annotation.notes?.trim() ? [{ annotation, type: 'note' as const }] : []),
          ]),
        ]
      }),
    [collapsedSections, sections],
  )
  const { outerRef, items, scrollbar, scrollToItem, totalSize } = useList(rows)

  useLayoutEffect(() => {
    const sectionId = pendingSectionRef.current
    if (sectionId === undefined) return

    pendingSectionRef.current = undefined
    const index = rows.findIndex((row) => row.type === 'section' && row.id === sectionId)
    if (index >= 0) scrollToItem({ index, align: 'start' })
  }, [rows, scrollToItem])

  const toggleSections = () => {
    setCollapsedSections(() => (expanded ? new Set(sectionIds) : new Set()))
  }
  const toggleSection = (id: number) => {
    setCollapsedSections((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const locateCurrentSection = () => {
    const sectionId = reader.focusedBookTab?.currentSection?.index
    if (sectionId === undefined) return

    const index = rows.findIndex((row) => row.type === 'section' && row.id === sectionId)
    if (index < 0) return

    if (collapsedSections.has(sectionId)) {
      pendingSectionRef.current = sectionId
      setCollapsedSections((current) => {
        const next = new Set(current)
        next.delete(sectionId)
        return next
      })
    } else {
      scrollToItem({ index, align: 'start' })
    }
  }
  return (
    <Pane
      headline={annotationT('annotations')}
      minSize={160}
      overlayScroll
      ref={outerRef}
      reserveScrollbarWidth
      scrollbar={{ ...scrollbar, scrollRef: outerRef }}
      stateKey="annotationAnnotations"
      actions={
        annotations.length > 0
          ? [
              {
                id: 'export',
                content: (
                  <AnnotationExportPanel annotations={annotations} open={exportOpen} onOpenChange={setExportOpen} />
                ),
              },
              {
                id: 'filter',
                content: (
                  <AnnotationFilterPopover
                    filter={filter}
                    onChange={setFilter}
                    open={filterOpen}
                    onOpenChange={setFilterOpen}
                  />
                ),
              },
              {
                id: 'locate-current',
                title: t('action.locate_current'),
                Icon: LocateFixedIcon,
                handle: locateCurrentSection,
              },
              {
                id: expanded ? 'collapse-all' : 'expand-all',
                title: t(expanded ? 'action.collapse_all' : 'action.expand_all'),
                Icon: expanded ? FoldVerticalIcon : UnfoldVerticalIcon,
                handle: toggleSections,
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
              style={{ height: size, transform: `translateY(${start}px)` }}
            >
              {row.type === 'section' ? (
                <Row
                  active={row.id === focusedBookTab?.currentSection?.index}
                  depth={1}
                  badge
                  expanded={row.expanded}
                  toggle={() => toggleSection(row.id)}
                  subitems={row.annotations}
                >
                  {row.annotations[0] ? getAnnotationSpineTitle(row.annotations[0].spine) : undefined}
                </Row>
              ) : row.type === 'annotation' ? (
                <Row
                  active={activeRowKey === activeKey}
                  depth={2}
                  leading={
                    <span aria-hidden="true" className="text-sm leading-none">
                      {annotationColorIcons[row.annotation.color]}
                    </span>
                  }
                  onClick={() => {
                    setActiveRowKey(activeKey)
                    reader.focusedBookTab?.display(row.annotation.cfi)
                  }}
                  onDelete={() => {
                    void reader.focusedBookTab?.removeAnnotation(row.annotation.cfi).catch(console.error)
                  }}
                >
                  {row.annotation.text}
                </Row>
              ) : (
                <Row
                  active={activeRowKey === activeKey}
                  depth={2}
                  onClick={() => {
                    setActiveRowKey(activeKey)
                    reader.focusedBookTab?.display(row.annotation.cfi)
                  }}
                >
                  <span className="text-muted-foreground">{row.annotation.notes}</span>
                </Row>
              )}
            </div>
          )
        })}
      </div>
    </Pane>
  )
}

interface AnnotationExportPanelProps {
  annotations: readonly Annotation[]
  onOpenChange: (open: boolean) => void
  open: boolean
}

function AnnotationExportPanel({ annotations, onOpenChange, open }: AnnotationExportPanelProps) {
  const annotationT = useTranslation('annotation')
  const errorT = useTranslation('error')
  const homeT = useTranslation('home')
  const notify = useNotify()
  const [filter, setFilter] = useState(createDefaultAnnotationFilter)
  const [format, setFormat] = useState<AnnotationExportFormat>('markdown')
  const [includeCfiLinks, setIncludeCfiLinks] = useState(true)
  const hasAnnotations = useMemo(() => filterAnnotations(annotations, filter).length > 0, [annotations, filter])
  const notifyExportError = (error: unknown) => {
    notify({
      autoCloseMs: false,
      description: formatErrorMessage(error),
      title: errorT('export_failed'),
      type: 'error',
    })
  }

  const serialize = () => {
    const tab = reader.focusedBookTab
    if (!tab) return
    const exported = createAnnotationExport(tab.book, annotations, tab.compareCfi.bind(tab), Date.now(), filter)
    return format === 'markdown'
      ? serializeAnnotationsAsMarkdown(exported, includeCfiLinks ? tab.book.id : undefined)
      : serializeAnnotationsAsJson(exported)
  }
  const handleCopy = () => {
    const contents = serialize()
    if (!contents) return
    onOpenChange(false)
    void copy(contents).catch(notifyExportError)
  }
  const handleExport = () => {
    const tab = reader.focusedBookTab
    const contents = serialize()
    if (!tab || !contents) return
    onOpenChange(false)
    void saveAnnotationExport(tab.book, format, contents)
      .then((outputPath) => {
        if (outputPath) notify({ description: outputPath, title: homeT('export_complete'), type: 'success' })
      })
      .catch(notifyExportError)
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <AppTooltip label={annotationT('export')}>
        <PopoverTrigger asChild>
          <IconButton aria-label={annotationT('export')} Icon={DownloadIcon} />
        </PopoverTrigger>
      </AppTooltip>
      <PopoverContent align="end" className="w-64 gap-3 p-2.5">
        <div className="text-muted-foreground px-1 font-semibold">{annotationT('links')}</div>
        <label htmlFor="annotation-export-cfi-links" className="flex h-6 cursor-pointer items-center gap-2 px-1">
          <Checkbox
            id="annotation-export-cfi-links"
            checked={includeCfiLinks}
            onCheckedChange={(checked) => setIncludeCfiLinks(checked === true)}
          />
          <span className="leading-none">{annotationT('include_cfi_links')}</span>
        </label>
        <div className="text-muted-foreground px-1 font-semibold">{annotationT('filter')}</div>
        <AnnotationFilterFields value={filter} onChange={setFilter} />
        <div className="text-muted-foreground mt-1 px-1 font-semibold">{annotationT('format')}</div>
        <div className="grid grid-cols-2 gap-1">
          {(['markdown', 'json'] as AnnotationExportFormat[]).map((candidate) => (
            <Button
              key={candidate}
              type="button"
              size="xs"
              variant={format === candidate ? 'secondary' : 'ghost'}
              onClick={() => setFormat(candidate)}
            >
              {candidate === 'markdown' ? 'Markdown' : 'JSON'}
            </Button>
          ))}
        </div>
        <div className="border-border/70 -mx-2.5 flex items-center gap-1 border-t px-2.5 pt-2">
          <Button
            type="button"
            size="xs"
            variant="secondary"
            disabled={isDefaultAnnotationFilter(filter) && includeCfiLinks}
            onClick={() => {
              setFilter(createDefaultAnnotationFilter())
              setIncludeCfiLinks(true)
            }}
          >
            {annotationT('reset')}
          </Button>
          <div className="ml-auto flex items-center gap-1">
            <Button type="button" size="xs" variant="secondary" disabled={!hasAnnotations} onClick={handleCopy}>
              {annotationT('copy')}
            </Button>
            <Button type="button" size="xs" disabled={!hasAnnotations} onClick={handleExport}>
              {annotationT('export')}
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}

interface AnnotationFilterPopoverProps {
  filter: AnnotationFilterValue
  onChange: (filter: AnnotationFilterValue) => void
  onOpenChange: (open: boolean) => void
  open: boolean
}

function AnnotationFilterPopover({ filter, onChange, onOpenChange, open }: AnnotationFilterPopoverProps) {
  const t = useTranslation('annotation')
  const filterActive = !isDefaultAnnotationFilter(filter)

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <AppTooltip label={t('filter')}>
        <PopoverTrigger asChild>
          <IconButton
            aria-label={t('filter')}
            className={filterActive ? 'text-(--flow-accent)' : undefined}
            Icon={FilterIcon}
          />
        </PopoverTrigger>
      </AppTooltip>
      <PopoverContent align="end" className="w-52 gap-2 p-2">
        <AnnotationFilterFields value={filter} onChange={onChange} />
        <div className="border-border/70 -mx-2 flex justify-end border-t px-2 pt-2">
          <Button
            type="button"
            size="xs"
            variant="secondary"
            disabled={!filterActive}
            onClick={() => onChange(createDefaultAnnotationFilter())}
          >
            {t('reset')}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

function annotationRowKey(row: AnnotationRow) {
  if (row.type === 'section') return `section:${row.id}`
  return `${row.type}:${row.annotation.cfi}`
}
