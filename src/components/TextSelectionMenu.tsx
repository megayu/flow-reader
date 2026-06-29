import clsx from 'clsx'
import {
  CopyIcon,
  FilePenLineIcon,
  PencilIcon,
  SearchIcon,
  SquareMinusIcon,
  SquarePlusIcon,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import FocusLock from 'react-focus-lock'
import { useSnapshot } from 'valtio'

import { typeMap, colorMap } from '../annotation'
import { BookTextReplaceTarget, replaceBookText } from '../db'
import { useSetAction } from '../hooks/useAction'
import { isForwardSelection, useTextSelection } from '../hooks/useTextSelection'
import { useTranslation } from '../hooks/useTranslation'
import { useTypography } from '../hooks/useTypography'
import { BookTab, reader } from '../models/reader'
import { useSettings } from '../state'
import { copy, keys, last } from '../utils'

import { Button, IconButton } from './Button'
import { TextField } from './Form'
import {
  layout,
  LayoutAnchorMode,
  LayoutAnchorPosition,
} from './base/ContextView'
import { Overlay } from './base/Overlay'

interface TextSelectionMenuProps {
  tab: BookTab
}

function getSelectionRange(selection?: Selection) {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return
  }

  try {
    return selection.getRangeAt(0).cloneRange()
  } catch (error) {
    return
  }
}

function clearWindowSelections(windows: readonly Window[]) {
  windows.forEach((win) => {
    try {
      win.getSelection()?.removeAllRanges()
    } catch (error) {
      // The iframe may have been detached since the selection was captured.
    }
  })
}

interface TextReplaceTarget extends BookTextReplaceTarget {
  selectedText: string
}

function paragraphIndexForTextNode(node: Node) {
  const paragraph = node.parentElement?.closest('p')
  const body = paragraph?.closest('[data-flow-body-text="true"]')
  if (!paragraph || !body) return

  const paragraphs = Array.from(body.children).filter(
    (element) => element.tagName.toLowerCase() === 'p',
  )
  const index = paragraphs.indexOf(paragraph)
  return index >= 0 ? index : undefined
}

function createTextReplaceTarget(
  range: Range,
  section: ReturnType<BookTab['sectionForRange']>,
): TextReplaceTarget | undefined {
  if (!section?.href) return
  if (range.startContainer !== range.endContainer) return
  if (range.startContainer.nodeType !== Node.TEXT_NODE) return

  const node = range.startContainer
  const selectedText = range.toString()
  if (!selectedText) return

  const ownerDocument = node.ownerDocument
  const body = ownerDocument?.body
  if (!body) return

  const walker = ownerDocument.createTreeWalker(body, NodeFilter.SHOW_TEXT)
  let textNodeIndex = 0
  let current = walker.nextNode()
  while (current) {
    if (current === node) {
      const textNodeText = node.textContent ?? ''
      return {
        sectionHref: section.href,
        textNodeIndex,
        textNodeText,
        startOffset: range.startOffset,
        endOffset: range.endOffset,
        paragraphIndex: paragraphIndexForTextNode(node),
        selectedText,
      }
    }
    textNodeIndex += 1
    current = walker.nextNode()
  }
}

const textReplacementErrorKeys = [
  {
    fragments: ['TEXT_REPLACE_EMPTY', 'Selected text is empty'],
    key: 'edit_text_error_empty',
  },
  {
    fragments: [
      'TEXT_REPLACE_SECTION_BODY_NOT_FOUND',
      'TEXT_REPLACE_NODE_STALE',
      'TEXT_REPLACE_TEXT_STALE',
      'TEXT_REPLACE_NODE_NOT_FOUND',
      'no longer matches',
      'no longer exists',
      'node was not found',
    ],
    key: 'edit_text_error_stale',
  },
]

interface TextReplacementError {
  message: string
  detail?: string
}

function textReplacementErrorMessage(
  error: unknown,
  t: (key: string) => string,
): TextReplacementError {
  const message = error instanceof Error ? error.message : String(error)
  const match = textReplacementErrorKeys.find(({ fragments }) =>
    fragments.some((fragment) => message.includes(fragment)),
  )

  return {
    message: t(match?.key ?? 'edit_text_error_generic'),
    detail: message || undefined,
  }
}

export const TextSelectionMenu: React.FC<TextSelectionMenuProps> = ({
  tab,
}) => {
  const { iframe, iframes, annotationRange, annotationCfi } = useSnapshot(
    tab,
  ) as unknown as {
    iframe?: Window
    iframes: readonly Window[]
    annotationRange?: Range
    annotationCfi?: string
  }
  const [settings] = useSettings()

  const windows = useMemo(() => {
    void iframe
    void iframes.length

    return (
      tab.iframes.length
        ? [...tab.iframes]
        : tab.iframe
          ? [tab.iframe]
          : (tab.rendition?.manager?.views?._views
              ?.map((view: any) => view.window as Window | undefined)
              .filter((win: Window | undefined): win is Window => !!win) ?? [])
    ) as Window[]
  }, [iframe, iframes, tab])

  const [selection, setSelection, releasePoint, menuOpen] = useTextSelection(
    windows,
    { automatic: settings.enableTextSelectionMenu !== false },
  )

  // it is possible that both `selection` and `tab.annotationRange`
  // are set when select end within an annotation
  const menuSelection = menuOpen ? selection : undefined
  const range = getSelectionRange(menuSelection) ?? annotationRange
  if (!range) return null

  const view = tab.viewForRange(range)
  const el = view?.element as HTMLElement | undefined
  if (!el) return null

  const forward = menuSelection ? isForwardSelection(menuSelection) : true

  const rects = [...range.getClientRects()].filter((r) => Math.round(r.width))
  const anchorRect = rects && (forward ? last(rects) : rects[0])
  if (!anchorRect) return null

  const contents = range.cloneContents()
  const text = contents.textContent?.trim()
  if (!text) return null

  return (
    // to reset inner state
    <TextSelectionMenuRenderer
      tab={tab}
      range={range as Range}
      anchorRect={anchorRect}
      containerRect={el.parentElement!.getBoundingClientRect()}
      viewRect={el.getBoundingClientRect()}
      releasePoint={menuSelection ? releasePoint : undefined}
      text={text}
      cfi={menuSelection ? undefined : annotationCfi}
      forward={forward}
      hide={() => {
        if (menuSelection) {
          try {
            menuSelection.removeAllRanges()
          } catch (error) {
            // The selection may belong to an iframe that has been replaced.
          }
          setSelection(undefined)
        }
        clearWindowSelections(windows)
        /**
         * {@link range}
         */
        tab.annotationRange = undefined
        tab.annotationCfi = undefined
      }}
    />
  )
}

const ICON_SIZE = 28
const ANNOTATION_SIZE = 32
const actionIconClassName =
  '!flex items-center justify-center !p-0 [&_svg]:!size-7'

interface TextSelectionMenuRendererProps {
  tab: BookTab
  range: Range
  anchorRect: DOMRect
  containerRect: DOMRect
  viewRect: DOMRect
  releasePoint?: { x: number; y: number }
  text: string
  cfi?: string
  forward: boolean
  hide: () => void
}
const TextSelectionMenuRenderer: React.FC<TextSelectionMenuRendererProps> = ({
  tab,
  range,
  anchorRect,
  containerRect,
  viewRect,
  releasePoint,
  forward,
  text,
  cfi: annotationCfi,
  hide,
}) => {
  const setAction = useSetAction()
  const ref = useRef<HTMLInputElement>(null)
  const [width, setWidth] = useState(0)
  const [height, setHeight] = useState(0)
  const t = useTranslation('menu')

  const cfi = annotationCfi ?? tab.rangeToCfi(range)
  const section = tab.sectionForRange(range)
  const annotation = tab.overlayState.annotations.find((a) => a.cfi === cfi)
  const [annotate, setAnnotate] = useState(!!annotation)
  const replacementRef = useRef<HTMLTextAreaElement>(null)
  const currentReplaceTarget = useMemo(
    () => createTextReplaceTarget(range, section),
    [range, section],
  )
  const replacementSnapshotRef = useRef<TextReplaceTarget | undefined>(
    undefined,
  )
  const [editing, setEditing] = useState(false)
  const [savingReplacement, setSavingReplacement] = useState(false)
  const [replacementError, setReplacementError] =
    useState<TextReplacementError>()
  const replaceTarget = editing
    ? replacementSnapshotRef.current
    : currentReplaceTarget

  useEffect(() => {
    if (!editing) return

    const timer = window.setTimeout(() => {
      const textarea = replacementRef.current
      if (!textarea) return

      const end = textarea.value.length
      textarea.focus()
      textarea.setSelectionRange(end, end)
    })

    return () => window.clearTimeout(timer)
  }, [editing])

  const position = releasePoint
    ? LayoutAnchorPosition.Before
    : forward
      ? LayoutAnchorPosition.Before
      : LayoutAnchorPosition.After

  const { zoom } = useTypography(tab)
  const endContainer = forward ? range.endContainer : range.startContainer
  const _lineHeight = parseFloat(
    getComputedStyle(endContainer.parentElement!).lineHeight,
  )
  // no custom line height and the origin is keyword, e.g. 'normal'.
  const lineHeight = isNaN(_lineHeight)
    ? anchorRect.height
    : _lineHeight * (zoom ?? 1)
  const layoutAnchor = releasePoint
    ? {
        left: releasePoint.x,
        top: releasePoint.y,
        width: 1,
        height: 1,
      }
    : anchorRect
  const layoutLineHeight = releasePoint ? layoutAnchor.height : lineHeight

  return (
    <FocusLock>
      <Overlay
        // cover `sash`
        className="!z-50 !bg-transparent"
        onClick={hide}
        onMouseDown={hide}
        onPointerDown={hide}
      />
      <div
        data-flow-keyboard-capture="true"
        ref={(el) => {
          if (!el) return
          setWidth(el.clientWidth)
          setHeight(el.clientHeight)
          el.focus()
        }}
        className={clsx(
          'border-border bg-popover text-popover-foreground absolute z-50 rounded-lg border p-2 shadow-lg shadow-black/10 focus:outline-none',
        )}
        style={{
          left: layout(containerRect.width, width, {
            offset: layoutAnchor.left + viewRect.left - containerRect.left,
            size: layoutAnchor.width,
            mode: LayoutAnchorMode.ALIGN,
            position,
          }),
          top: layout(containerRect.height, height, {
            offset:
              layoutAnchor.top - (layoutLineHeight - layoutAnchor.height) / 2,
            size: layoutLineHeight,
            position,
          }),
        }}
        tabIndex={-1}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Escape') {
            e.preventDefault()
            hide()
            return
          }
          if (e.key === 'c' && e.ctrlKey) {
            copy(text)
          }
        }}
      >
        {editing ? (
          <div className="mb-3 space-y-2">
            <textarea
              ref={replacementRef}
              name="replacement"
              aria-label={t('edit_text')}
              defaultValue={replaceTarget?.selectedText ?? text}
              className="textfield bg-background text-foreground scroll h-40 w-72 resize-none px-1.5 py-1 text-base outline-none"
            />
            {replacementError && (
              <div className="text-destructive w-72 text-sm leading-snug">
                <div>{replacementError.message}</div>
                {replacementError.detail && (
                  <div className="mt-1 text-xs break-words">
                    {t('edit_text_error_reason')}
                    {replacementError.detail}
                  </div>
                )}
              </div>
            )}
          </div>
        ) : annotate ? (
          <div className="mb-3">
            <TextField
              mRef={ref}
              as="textarea"
              name="notes"
              defaultValue={annotation?.notes}
              hideLabel
              className="h-40 w-72"
              autoFocus
            />
          </div>
        ) : (
          <div className="text-muted-foreground mb-3 flex gap-2">
            <IconButton
              title={t('copy')}
              Icon={CopyIcon}
              size={ICON_SIZE}
              className={actionIconClassName}
              style={{
                width: ANNOTATION_SIZE,
                height: ANNOTATION_SIZE,
              }}
              onClick={() => {
                hide()
                copy(text)
              }}
            />
            <IconButton
              title={t('search_in_book')}
              Icon={SearchIcon}
              size={ICON_SIZE}
              className={actionIconClassName}
              style={{
                width: ANNOTATION_SIZE,
                height: ANNOTATION_SIZE,
              }}
              onClick={() => {
                hide()
                setAction('search')
                tab.setKeyword(text)
              }}
            />
            <IconButton
              title={t('edit_text')}
              Icon={FilePenLineIcon}
              disabled={!currentReplaceTarget}
              size={ICON_SIZE}
              className={actionIconClassName}
              style={{
                width: ANNOTATION_SIZE,
                height: ANNOTATION_SIZE,
              }}
              onClick={() => {
                replacementSnapshotRef.current = currentReplaceTarget
                setReplacementError(undefined)
                setEditing(true)
              }}
            />
            <IconButton
              title={t('annotate')}
              Icon={PencilIcon}
              size={ICON_SIZE}
              className={actionIconClassName}
              style={{
                width: ANNOTATION_SIZE,
                height: ANNOTATION_SIZE,
              }}
              onClick={() => {
                setAnnotate(true)
              }}
            />
            {tab.isDefined(text) ? (
              <IconButton
                title={t('undefine')}
                Icon={SquareMinusIcon}
                size={ICON_SIZE}
                className={actionIconClassName}
                style={{
                  width: ANNOTATION_SIZE,
                  height: ANNOTATION_SIZE,
                }}
                onClick={() => {
                  hide()
                  tab.undefine(text)
                }}
              />
            ) : (
              <IconButton
                title={t('define')}
                Icon={SquarePlusIcon}
                size={ICON_SIZE}
                className={actionIconClassName}
                style={{
                  width: ANNOTATION_SIZE,
                  height: ANNOTATION_SIZE,
                }}
                onClick={() => {
                  hide()
                  tab.define([text])
                }}
              />
            )}
          </div>
        )}
        {!editing && (
          <div className="space-y-2">
            {keys(typeMap).map((type) => (
              <div key={type} className="flex gap-2">
                {keys(colorMap).map((color) => (
                  <button
                    type="button"
                    key={color}
                    aria-label={`${type} ${color}`}
                    style={{
                      [typeMap[type].style]: colorMap[color],
                      width: ANNOTATION_SIZE,
                      height: ANNOTATION_SIZE,
                      fontSize: 18,
                    }}
                    className={clsx(
                      'border-border text-muted-foreground hover:bg-muted flex cursor-pointer appearance-none items-center justify-center rounded-md border bg-transparent p-0 text-base',
                      typeMap[type].class,
                    )}
                    onClick={() => {
                      tab.putAnnotation(
                        type,
                        cfi,
                        color,
                        text,
                        ref.current?.value,
                        section,
                      )
                      hide()
                    }}
                  >
                    A
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}
        {editing && (
          <div className="mt-3 flex gap-2">
            <Button
              compact
              variant="secondary"
              disabled={savingReplacement}
              onClick={() => {
                setEditing(false)
                setReplacementError(undefined)
              }}
            >
              {t('cancel')}
            </Button>
            <Button
              className="ml-auto"
              compact
              disabled={!replaceTarget || savingReplacement}
              onClick={() => {
                if (!replaceTarget) return
                const { selectedText, ...target } = replaceTarget
                const newText = replacementRef.current?.value ?? selectedText
                if (newText === selectedText) {
                  hide()
                  return
                }

                setSavingReplacement(true)
                setReplacementError(undefined)
                void replaceBookText({
                  id: tab.book.id,
                  target,
                  oldText: selectedText,
                  newText,
                })
                  .then((result) => {
                    reader.applyBookContentEdit(
                      result.book,
                      result.sectionHref,
                      tab,
                      {
                        target,
                        oldText: selectedText,
                        newText,
                      },
                    )
                    hide()
                  })
                  .catch((error) => {
                    setReplacementError(textReplacementErrorMessage(error, t))
                  })
                  .finally(() => setSavingReplacement(false))
              }}
            >
              {savingReplacement ? '...' : t('save')}
            </Button>
          </div>
        )}
        {annotate && !editing && (
          <div className="mt-3 flex">
            {annotation && (
              <Button
                compact
                variant="secondary"
                onClick={() => {
                  tab.removeAnnotation(cfi)
                  hide()
                }}
              >
                {t('delete')}
              </Button>
            )}
            <Button
              className="ml-auto"
              compact
              onClick={() => {
                tab.putAnnotation(
                  annotation?.type ?? 'highlight',
                  cfi,
                  annotation?.color ?? 'yellow',
                  text,
                  ref.current?.value,
                  section,
                )
                hide()
              }}
            >
              {t(annotation ? 'update' : 'create')}
            </Button>
          </div>
        )}
      </div>
    </FocusLock>
  )
}
