import clsx from 'clsx'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { MdCheckBox, MdCheckBoxOutlineBlank } from 'react-icons/md'
import {
  VscChevronDown,
  VscChevronRight,
  VscCollapseAll,
  VscExpandAll,
} from 'react-icons/vsc'

import {
  getTextImportEncodings,
  importTextPaths,
  previewTextImportPaths,
} from '../db'
import type {
  BookRecord,
  TextImportEncodingOption,
  TextImportChapterPreview,
  TextImportPreview,
  TextImportRulesInput,
} from '../db'
import { useTranslation } from '../hooks/useTranslation'
import { defaultTextImportRules, useSettings } from '../state'

import { Button } from './Button'
import { Select } from './Form'
import { Overlay } from './base/Overlay'

interface TextImportDialogProps {
  paths: string[]
  openAfterImport?: boolean
  onClose: () => void
  onImported?: (books: BookRecord[], openAfterImport: boolean) => void
}

interface ChapterPreviewNode extends TextImportChapterPreview {
  key: string
  children: ChapterPreviewNode[]
}

export const TextImportDialog: React.FC<TextImportDialogProps> = ({
  paths,
  openAfterImport = false,
  onClose,
  onImported,
}) => {
  const t = useTranslation('text_import')
  const [settings] = useSettings()
  const [encodings, setEncodings] = useState<TextImportEncodingOption[]>([])
  const [previews, setPreviews] = useState<TextImportPreview[]>([])
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set())
  const [activePath, setActivePath] = useState(paths[0])
  const [encodingOverrides, setEncodingOverrides] = useState<
    Record<string, string>
  >({})
  const [loading, setLoading] = useState(false)
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState('')
  const [collapsedChapterKeys, setCollapsedChapterKeys] = useState<Set<string>>(
    new Set(),
  )
  const initializedSelectionRef = useRef(false)
  const textImportRules = useMemo<TextImportRulesInput>(() => {
    const rules = settings.textImportRules ?? defaultTextImportRules
    return {
      groupPatterns: normalizePatternList(rules.groupPatterns),
      chapterPatterns: normalizePatternList(rules.chapterPatterns),
    }
  }, [settings.textImportRules])
  const textImportRulesKey = useMemo(
    () => JSON.stringify(textImportRules),
    [textImportRules],
  )

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
        setSelectedPaths((current) => {
          const next = new Set(
            [...current].filter((path) =>
              items.some((item) => item.path === path),
            ),
          )
          for (const item of items) {
            if (!initializedSelectionRef.current && item.selected) {
              next.add(item.path)
            }
            if (item.status === 'error') next.delete(item.path)
          }
          initializedSelectionRef.current = true
          return next
        })
        setActivePath((current) =>
          current && items.some((item) => item.path === current)
            ? current
            : items[0]?.path,
        )
      })
      .catch((error) => {
        if (!disposed) setError(String(error))
      })
      .finally(() => {
        if (!disposed) setLoading(false)
      })

    return () => {
      disposed = true
    }
  }, [encodingOverrides, paths, textImportRules, textImportRulesKey])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onClose()
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const activePreview = useMemo(
    () =>
      previews.find((preview) => preview.path === activePath) ?? previews[0],
    [activePath, previews],
  )
  const chapterTree = useMemo(
    () => buildChapterTree(activePreview?.chapters ?? []),
    [activePreview?.chapters],
  )
  const collapsibleChapterKeys = useMemo(
    () => collectCollapsibleChapterKeys(chapterTree),
    [chapterTree],
  )
  const chapterPreviewExpanded = useMemo(
    () => collapsibleChapterKeys.some((key) => !collapsedChapterKeys.has(key)),
    [collapsibleChapterKeys, collapsedChapterKeys],
  )

  useEffect(() => {
    setCollapsedChapterKeys(new Set())
  }, [activePreview?.path])

  const selectedImports = previews
    .filter(
      (preview) =>
        selectedPaths.has(preview.path) &&
        preview.status !== 'error' &&
        preview.status !== 'skipped',
    )
    .map((preview) => ({
      path: preview.path,
      encoding: encodingOverrides[preview.path] ?? preview.encoding,
    }))

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

  const importSelected = async () => {
    if (!selectedImports.length || importing) return

    setImporting(true)
    setError('')
    try {
      const books = await importTextPaths(selectedImports, {
        rules: textImportRules,
      })
      onImported?.(books, openAfterImport)
      onClose()
    } catch (error) {
      setError(String(error))
    } finally {
      setImporting(false)
    }
  }

  return createPortal(
    <>
      <Overlay className="z-[80] !bg-black/20" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        data-flow-keyboard-capture="true"
        className="text-muted-foreground ring-border bg-background fixed top-1/2 left-1/2 z-[90] flex h-[min(42rem,calc(100vh-4rem))] w-[min(82rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-md shadow-xl ring-1 ring-inset"
      >
        <aside className="border-border bg-muted/50 flex w-72 shrink-0 flex-col border-r">
          <div className="px-4 py-3 text-base font-semibold">{t('title')}</div>
          <div className="scroll min-h-0 flex-1 overflow-y-auto p-2">
            {previews.map((preview) => {
              const selected = selectedPaths.has(preview.path)
              const active = activePreview?.path === preview.path
              const Icon = selected ? MdCheckBox : MdCheckBoxOutlineBlank
              return (
                <button
                  key={preview.path}
                  type="button"
                  className={clsx(
                    'hover:bg-muted mb-1 flex w-full items-start gap-2 rounded-sm px-2 py-2 text-left',
                    active && 'text-primary-foreground bg-primary',
                  )}
                  onClick={() => setActivePath(preview.path)}
                >
                  <Icon
                    size={20}
                    className={clsx(
                      'mt-0.5 shrink-0',
                      (preview.status === 'error' ||
                        preview.status === 'skipped') &&
                        'opacity-30',
                    )}
                    onClick={(event) => {
                      event.stopPropagation()
                      toggleSelected(preview)
                    }}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">
                      {preview.filename}
                    </span>
                    <span className="text-muted-foreground mt-0.5 block truncate text-xs">
                      {preview.encodingLabel} · {t(`status.${preview.status}`)}
                    </span>
                  </span>
                </button>
              )
            })}
            {!loading && !previews.length && (
              <div className="text-muted-foreground px-2 py-6 text-sm">
                {t('empty')}
              </div>
            )}
          </div>
        </aside>

        <main className="flex min-w-0 flex-1 flex-col">
          <div className="border-border border-b px-5 py-3">
            <div className="truncate text-base font-semibold">
              {activePreview?.title ?? t('title')}
            </div>
            {activePreview && (
              <div className="mt-2 grid grid-cols-[auto_minmax(12rem,20rem)] items-center gap-x-3 gap-y-2">
                <div className="text-muted-foreground text-sm">
                  {t('encoding')}
                </div>
                <Select
                  value={encodingOverrides[activePreview.path] ?? 'auto'}
                  onChange={(event) => {
                    setEncodingOverrides((current) => ({
                      ...current,
                      [activePreview.path]: event.target.value,
                    }))
                  }}
                >
                  {encodings.map((encoding) => (
                    <option key={encoding.id} value={encoding.id}>
                      {encoding.id === 'auto'
                        ? `${encoding.label} (${activePreview.encodingLabel})`
                        : encoding.label}
                    </option>
                  ))}
                </Select>
              </div>
            )}
          </div>

          <div className="grid min-h-0 flex-1 grid-cols-[minmax(22rem,0.9fr)_minmax(28rem,1.1fr)] gap-5 overflow-hidden p-5">
            <section className="flex min-h-0 flex-col">
              <div className="mb-2 flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold">{t('chapters')}</h3>
                {!!collapsibleChapterKeys.length && (
                  <button
                    type="button"
                    className="text-muted-foreground hover:bg-muted hover:text-muted-foreground rounded-sm p-1"
                    title={t(
                      chapterPreviewExpanded ? 'collapse_all' : 'expand_all',
                    )}
                    onClick={() => {
                      setCollapsedChapterKeys(
                        chapterPreviewExpanded
                          ? new Set(collapsibleChapterKeys)
                          : new Set(),
                      )
                    }}
                  >
                    {chapterPreviewExpanded ? (
                      <VscCollapseAll size={18} />
                    ) : (
                      <VscExpandAll size={18} />
                    )}
                  </button>
                )}
              </div>
              <div className="scroll bg-muted/50 min-h-0 flex-1 overflow-auto rounded-sm p-2 text-sm">
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
            <section className="flex min-h-0 flex-col">
              <h3 className="mb-2 text-sm font-semibold">{t('sample')}</h3>
              <pre className="scroll bg-muted/50 min-h-0 flex-1 overflow-auto rounded-sm p-3 font-sans text-sm whitespace-pre-wrap">
                {activePreview?.sample ?? ''}
              </pre>
            </section>
          </div>

          <div className="border-border flex items-center justify-between border-t px-5 py-3">
            <div className="text-destructive min-w-0 text-xs">
              {error || activePreview?.message || ''}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button variant="secondary" onClick={onClose}>
                {t('cancel')}
              </Button>
              <Button
                disabled={!selectedImports.length || importing}
                onClick={importSelected}
              >
                {t('import_selected')}
              </Button>
            </div>
          </div>
        </main>
      </div>
    </>,
    document.body,
  )
}

interface ChapterPreviewTreeProps {
  nodes: ChapterPreviewNode[]
  collapsedKeys: Set<string>
  onToggle: (key: string) => void
  depth?: number
}

const ChapterPreviewTree: React.FC<ChapterPreviewTreeProps> = ({
  nodes,
  collapsedKeys,
  onToggle,
  depth = 0,
}) => {
  if (!nodes.length) return null

  if (nodes.every((node) => !node.children.length)) {
    return (
      <pre
        className="font-sans text-sm whitespace-pre-wrap"
        style={{ paddingLeft: depth ? depth * 16 : 0 }}
      >
        {nodes.map((node) => node.title).join('\n')}
      </pre>
    )
  }

  return (
    <div className="space-y-1">
      {nodes.map((node) => {
        const hasChildren = node.children.length > 0
        const collapsed = collapsedKeys.has(node.key)
        const Icon = collapsed ? VscChevronRight : VscChevronDown

        return (
          <div key={node.key}>
            <button
              type="button"
              className={clsx(
                'hover:bg-muted flex w-full items-center gap-1 rounded-sm py-1 pr-2 text-left',
                hasChildren
                  ? 'text-muted-foreground'
                  : 'text-muted-foreground/80',
              )}
              style={{ paddingLeft: depth * 16 }}
              onClick={() => {
                if (hasChildren) onToggle(node.key)
              }}
            >
              <Icon
                size={18}
                className={clsx(
                  'text-muted-foreground shrink-0',
                  !hasChildren && 'invisible',
                )}
              />
              <span className="min-w-0 flex-1 break-words">{node.title}</span>
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
  return (patterns ?? [])
    .map((pattern) => pattern.trim())
    .filter((pattern) => pattern.length > 0)
}
