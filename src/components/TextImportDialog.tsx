import clsx from 'clsx'
import {
  ChevronDownIcon,
  ChevronRightIcon,
  FoldVerticalIcon,
  SquareCheckBigIcon,
  SquareIcon,
  UnfoldVerticalIcon,
} from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'

import { formatErrorMessage } from '../errorMessage'
import { useTranslation } from '../hooks/useTranslation'
import { toMessageKeySegment } from '../locales'
import { defaultTextImportRules, useSettings } from '../state'
import type {
  TextImportChapterPreview,
  TextImportEncodingOption,
  TextImportPreview,
  TextImportRulesInput,
  TextImportSelection,
} from '../storage'
import { getTextImportEncodings, previewTextImportPaths } from '../storage'

import { AppTooltip } from './AppTooltip'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogTitle } from './ui/dialog'
import { Input } from './ui/input'
import { useNotify } from './ui/notificationContext'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'

interface TextImportDialogProps {
  paths: string[]
  openAfterImport?: boolean
  onClose: () => void
  onImport: (imports: TextImportSelection[], openAfterImport: boolean, rules: TextImportRulesInput) => void
}

interface ChapterPreviewNode extends TextImportChapterPreview {
  key: string
  children: ChapterPreviewNode[]
}

export const TextImportDialog: React.FC<TextImportDialogProps> = ({
  paths,
  openAfterImport = false,
  onClose,
  onImport,
}) => {
  const t = useTranslation('text_import')
  const errorT = useTranslation('error')
  const notify = useNotify()
  const titleId = useId()
  const [settings] = useSettings()
  const [encodings, setEncodings] = useState<TextImportEncodingOption[]>([])
  const [previews, setPreviews] = useState<TextImportPreview[]>([])
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set())
  const [activePath, setActivePath] = useState(paths[0])
  const [encodingOverrides, setEncodingOverrides] = useState<Record<string, string>>({})
  const [titleOverrides, setTitleOverrides] = useState<Record<string, string>>({})
  const [creatorOverrides, setCreatorOverrides] = useState<Record<string, string>>({})
  const [previewSplit, setPreviewSplit] = useState(44)
  const previewAreaRef = useRef<HTMLDivElement>(null)
  const splitDragRef = useRef<
    | {
        pointerId: number
        startX: number
        startSplit: number
        width: number
      }
    | undefined
  >(undefined)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [collapsedChapterKeys, setCollapsedChapterKeys] = useState<Set<string>>(new Set())
  const initializedSelectionRef = useRef(false)
  const textImportRules = useMemo<TextImportRulesInput>(() => {
    const rules = settings.textImportRules ?? defaultTextImportRules
    return {
      groupPatterns: normalizePatternList(rules.groupPatterns),
      chapterPatterns: normalizePatternList(rules.chapterPatterns),
    }
  }, [settings.textImportRules])
  const textImportRulesKey = useMemo(() => JSON.stringify(textImportRules), [textImportRules])

  useEffect(() => {
    getTextImportEncodings().then(setEncodings).catch(console.error)
  }, [])

  useEffect(() => {
    if (!paths.length) return

    let disposed = false
    setLoading(true)
    setError('')

    previewTextImportPaths(paths, encodingOverrides, textImportRules)
      .then((items) => {
        if (disposed) return
        setPreviews(items)
        setTitleOverrides((current) => {
          const next = { ...current }
          for (const item of items) {
            if (next[item.path] === undefined) next[item.path] = item.title
          }
          return next
        })
        setCreatorOverrides((current) => {
          const next = { ...current }
          for (const item of items) {
            if (next[item.path] === undefined) next[item.path] = ''
          }
          return next
        })
        setSelectedPaths((current) => {
          const next = new Set([...current].filter((path) => items.some((item) => item.path === path)))
          for (const item of items) {
            if (!initializedSelectionRef.current && item.selected) {
              next.add(item.path)
            }
            if (item.status === 'error') next.delete(item.path)
          }
          initializedSelectionRef.current = true
          return next
        })
        setActivePath((current) => (current && items.some((item) => item.path === current) ? current : items[0]?.path))
      })
      .catch((error) => {
        if (!disposed) {
          const message = formatErrorMessage(error)
          setError(message)
          notify({
            autoCloseMs: false,
            description: message,
            title: errorT('txt_preview_failed'),
            type: 'error',
          })
        }
      })
      .finally(() => {
        if (!disposed) setLoading(false)
      })

    return () => {
      disposed = true
    }
  }, [encodingOverrides, errorT, notify, paths, textImportRules, textImportRulesKey])

  useEffect(() => {
    return () => {
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [])

  const resizePreviewSplit = (pointerId: number, clientX: number) => {
    const drag = splitDragRef.current
    if (!drag || pointerId !== drag.pointerId) return

    const delta = ((clientX - drag.startX) / drag.width) * 100
    setPreviewSplit(Math.min(72, Math.max(28, drag.startSplit + delta)))
  }
  const finishPreviewSplit = (pointerId: number) => {
    if (splitDragRef.current?.pointerId !== pointerId) return

    splitDragRef.current = undefined
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  }

  const activePreview = useMemo(
    () => previews.find((preview) => preview.path === activePath) ?? previews[0],
    [activePath, previews],
  )
  const chapterTree = useMemo(() => buildChapterTree(activePreview?.chapters ?? []), [activePreview?.chapters])
  const collapsibleChapterKeys = useMemo(() => collectCollapsibleChapterKeys(chapterTree), [chapterTree])
  const chapterPreviewExpanded = useMemo(
    () => collapsibleChapterKeys.some((key) => !collapsedChapterKeys.has(key)),
    [collapsibleChapterKeys, collapsedChapterKeys],
  )

  useEffect(() => {
    setCollapsedChapterKeys(new Set())
  }, [activePreview?.path])

  const selectedImports: {
    creator?: string
    encoding: string
    path: string
    title?: string
  }[] = []
  for (const preview of previews) {
    if (selectedPaths.has(preview.path) && preview.status !== 'error' && preview.status !== 'skipped') {
      selectedImports.push({
        path: preview.path,
        encoding: encodingOverrides[preview.path] ?? preview.encoding,
        title: (titleOverrides[preview.path] ?? preview.title).trim(),
        creator: (creatorOverrides[preview.path] ?? '').trim(),
      })
    }
  }

  const toggleSelected = (preview: TextImportPreview) => {
    if (preview.status === 'error' || preview.status === 'skipped') return
    setSelectedPaths((current) => {
      const next = new Set(current)
      if (next.has(preview.path)) {
        next.delete(preview.path)
      } else {
        next.add(preview.path)
      }
      return next
    })
  }

  const importSelected = () => {
    if (!selectedImports.length) return

    onClose()
    onImport(selectedImports, openAfterImport, textImportRules)
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        aria-labelledby={titleId}
        showCloseButton={false}
        className="grid h-[min(40rem,calc(100vh-3rem))] w-[min(58rem,calc(100vw-1.5rem))] max-w-none grid-cols-[12rem_minmax(0,1fr)] gap-0 overflow-hidden p-0"
      >
        <aside className="border-border flex min-h-0 flex-col border-r bg-(--flow-bg-sidebar)">
          <div className="border-border border-b px-3 py-3">
            <DialogTitle id={titleId}>{t('title')}</DialogTitle>
          </div>
          <div className="scroll min-h-0 flex-1 overflow-y-auto p-2" style={{ scrollbarGutter: 'auto' }}>
            {previews.map((preview) => {
              const selected = selectedPaths.has(preview.path)
              const active = activePreview?.path === preview.path
              const Icon = selected ? SquareCheckBigIcon : SquareIcon
              return (
                <button
                  key={preview.path}
                  type="button"
                  className={clsx(
                    'mb-1 flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left hover:bg-(--flow-bg-control-hover)',
                    active && 'text-foreground bg-(--flow-accent-bg) ring-1 ring-(--flow-accent-border) ring-inset',
                  )}
                  onClick={() => setActivePath(preview.path)}
                >
                  <Icon
                    size={18}
                    className={clsx(
                      'mt-0.5 shrink-0',
                      (preview.status === 'error' || preview.status === 'skipped') && 'opacity-30',
                    )}
                    onClick={(event) => {
                      event.stopPropagation()
                      toggleSelected(preview)
                    }}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-base">{preview.filename}</span>
                    <span className="text-muted-foreground mt-0.5 block truncate text-base">
                      {preview.encodingLabel} · {t(`status.${toMessageKeySegment(preview.status)}`)}
                    </span>
                  </span>
                </button>
              )
            })}
            {!loading && !previews.length && (
              <div className="text-muted-foreground px-2 py-6 text-base">{t('empty')}</div>
            )}
          </div>
        </aside>

        <main className="flex min-h-0 min-w-0 flex-col">
          <div className="border-border shrink-0 border-b px-4 py-3">
            {activePreview && (
              <div
                className="grid gap-3"
                style={{
                  gridTemplateColumns: 'repeat(auto-fit, minmax(10rem, 1fr))',
                }}
              >
                <label className="grid gap-1">
                  <span className="text-muted-foreground text-base">{t('book_title')}</span>
                  <Input
                    value={titleOverrides[activePreview.path] ?? ''}
                    onValueChange={(value) => {
                      setTitleOverrides((current) => ({
                        ...current,
                        [activePreview.path]: value,
                      }))
                    }}
                  />
                </label>
                <label className="grid gap-1">
                  <span className="text-muted-foreground text-base">{t('creator')}</span>
                  <Input
                    value={creatorOverrides[activePreview.path] ?? ''}
                    onValueChange={(value) => {
                      setCreatorOverrides((current) => ({
                        ...current,
                        [activePreview.path]: value,
                      }))
                    }}
                  />
                </label>
                <label className="grid gap-1">
                  <span className="text-muted-foreground text-base">{t('encoding')}</span>
                  <Select
                    value={encodingOverrides[activePreview.path] ?? 'auto'}
                    onValueChange={(value) => {
                      setEncodingOverrides((current) => ({
                        ...current,
                        [activePreview.path]: value,
                      }))
                    }}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {encodings.map((encoding) => (
                        <SelectItem key={encoding.id} value={encoding.id}>
                          {encoding.id === 'auto'
                            ? `${encoding.label} (${activePreview.encodingLabel})`
                            : encoding.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </label>
              </div>
            )}
          </div>

          {activePreview ? (
            <div
              ref={previewAreaRef}
              data-testid="text-import-preview-grid"
              className="grid min-h-0 flex-1 overflow-hidden"
              style={{
                gridTemplateColumns: `minmax(0,${previewSplit}fr) 0.75rem minmax(0,${100 - previewSplit}fr)`,
              }}
            >
              <section className="flex min-h-0 min-w-0 flex-col py-4 pr-2 pl-4">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <h3 className="text-base font-semibold">{t('chapters')}</h3>
                  {!!collapsibleChapterKeys.length && (
                    <AppTooltip label={t(chapterPreviewExpanded ? 'collapse_all' : 'expand_all')}>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t(chapterPreviewExpanded ? 'collapse_all' : 'expand_all')}
                        onClick={() => {
                          setCollapsedChapterKeys(chapterPreviewExpanded ? new Set(collapsibleChapterKeys) : new Set())
                        }}
                      >
                        {chapterPreviewExpanded ? (
                          <FoldVerticalIcon className="size-4.5" />
                        ) : (
                          <UnfoldVerticalIcon className="size-4.5" />
                        )}
                      </Button>
                    </AppTooltip>
                  )}
                </div>
                <div className="scroll min-h-0 flex-1 overflow-auto rounded-lg bg-(--flow-bg-panel) p-2 text-base">
                  <ChapterPreviewTree
                    nodes={chapterTree}
                    collapsedKeys={collapsedChapterKeys}
                    onToggle={(key) => {
                      setCollapsedChapterKeys((current) => {
                        const next = new Set(current)
                        if (next.has(key)) {
                          next.delete(key)
                        } else {
                          next.add(key)
                        }
                        return next
                      })
                    }}
                  />
                </div>
              </section>
              <div
                data-flow-text-import-splitter
                className="group flex h-full cursor-col-resize items-stretch justify-center"
                onPointerDown={(event) => {
                  const width = previewAreaRef.current?.clientWidth
                  if (!width) return
                  event.currentTarget.setPointerCapture(event.pointerId)
                  splitDragRef.current = {
                    pointerId: event.pointerId,
                    startX: event.clientX,
                    startSplit: previewSplit,
                    width,
                  }
                  document.body.style.cursor = 'col-resize'
                  document.body.style.userSelect = 'none'
                  event.preventDefault()
                }}
                onPointerMove={(event) => resizePreviewSplit(event.pointerId, event.clientX)}
                onPointerUp={(event) => finishPreviewSplit(event.pointerId)}
                onPointerCancel={(event) => finishPreviewSplit(event.pointerId)}
                onLostPointerCapture={(event) => finishPreviewSplit(event.pointerId)}
              >
                <div className="bg-border group-hover:bg-ring/60 h-full w-px transition-colors" />
              </div>
              <section className="flex min-h-0 min-w-0 flex-col py-4 pr-4 pl-2">
                <h3 className="mb-2 text-base font-semibold">{t('sample')}</h3>
                <pre className="scroll min-h-0 flex-1 overflow-auto rounded-lg bg-(--flow-bg-panel) p-3 font-sans text-base whitespace-pre-wrap">
                  {activePreview.sample}
                </pre>
              </section>
            </div>
          ) : (
            <div className="text-muted-foreground flex min-h-0 flex-1 items-center justify-center p-4 text-base">
              {loading ? t('loading') : t('empty')}
            </div>
          )}

          <div className="border-border flex shrink-0 items-center justify-between gap-3 border-t bg-(--flow-bg-panel) px-4 py-3">
            <div className="text-destructive min-w-0 text-base">{error || activePreview?.message || ''}</div>
            <div className="flex shrink-0 items-center gap-2">
              <Button variant="secondary" onClick={onClose}>
                {t('cancel')}
              </Button>
              <Button disabled={!selectedImports.length} onClick={importSelected}>
                {t('import_selected')}
              </Button>
            </div>
          </div>
        </main>
      </DialogContent>
    </Dialog>
  )
}

interface ChapterPreviewTreeProps {
  nodes: ChapterPreviewNode[]
  collapsedKeys: Set<string>
  onToggle: (key: string) => void
  depth?: number
}

const ChapterPreviewTree: React.FC<ChapterPreviewTreeProps> = ({ nodes, collapsedKeys, onToggle, depth = 0 }) => {
  if (!nodes.length) return null

  if (nodes.every((node) => !node.children.length)) {
    return (
      <pre className="font-sans text-base whitespace-pre-wrap" style={{ paddingLeft: depth ? depth * 16 : 0 }}>
        {nodes.map((node) => node.title).join('\n')}
      </pre>
    )
  }

  return (
    <div className="space-y-1">
      {nodes.map((node) => {
        const hasChildren = node.children.length > 0
        const collapsed = collapsedKeys.has(node.key)
        const Icon = collapsed ? ChevronRightIcon : ChevronDownIcon

        return (
          <div key={node.key}>
            <button
              type="button"
              className={clsx(
                'flex w-full items-center gap-1 rounded-sm py-1 pr-2 text-left hover:bg-(--flow-bg-control-hover)',
                hasChildren ? 'text-muted-foreground' : 'text-muted-foreground/80',
              )}
              style={{ paddingLeft: depth * 16 }}
              onClick={() => {
                if (hasChildren) onToggle(node.key)
              }}
            >
              <Icon size={18} className={clsx('text-muted-foreground shrink-0', !hasChildren && 'invisible')} />
              <span className="min-w-0 flex-1 wrap-break-word">{node.title}</span>
            </button>
            {hasChildren && !collapsed && (
              <ChapterPreviewTree
                nodes={node.children}
                collapsedKeys={collapsedKeys}
                onToggle={onToggle}
                depth={depth + 1}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}

function buildChapterTree(chapters: TextImportChapterPreview[]) {
  const roots: ChapterPreviewNode[] = []
  const stack: ChapterPreviewNode[] = []

  chapters.forEach((chapter, index) => {
    const node: ChapterPreviewNode = {
      ...chapter,
      key: `${index}:${chapter.level}:${chapter.title}`,
      children: [],
    }

    while (stack.length) {
      const last = stack[stack.length - 1]
      if (!last || last.level < node.level) break
      stack.pop()
    }

    const parent = stack[stack.length - 1]
    if (parent) {
      parent.children.push(node)
    } else {
      roots.push(node)
    }
    stack.push(node)
  })

  return roots
}

function collectCollapsibleChapterKeys(nodes: ChapterPreviewNode[]) {
  const keys: string[] = []
  const visit = (node: ChapterPreviewNode) => {
    if (node.children.length) keys.push(node.key)
    node.children.forEach(visit)
  }
  nodes.forEach(visit)
  return keys
}

function normalizePatternList(patterns: string[] | undefined) {
  const normalized: string[] = []
  for (const pattern of patterns ?? []) {
    const trimmed = pattern.trim()
    if (trimmed) normalized.push(trimmed)
  }
  return normalized
}
