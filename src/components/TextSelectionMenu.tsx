import clsx from 'clsx'
import {
  BookOpenTextIcon,
  CopyIcon,
  FilePenLineIcon,
  LanguagesIcon,
  PencilIcon,
  SearchIcon,
  SquareMinusIcon,
  SquarePlusIcon,
} from 'lucide-react'
import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import { useSnapshot } from 'valtio'

import { typeMap, colorMap, orderRangeRectsForWritingMode } from '../annotation'
import { BookTextReplaceTarget, replaceBookText } from '../db'
import {
  listLocalDictionariesCached,
  type LocalDictionaryRecord,
} from '../dictionary/native'
import { normalizeDictionaryQuery } from '../dictionary/query'
import { useSetAction } from '../hooks/useAction'
import { isForwardSelection, useTextSelection } from '../hooks/useTextSelection'
import { useTranslation } from '../hooks/useTranslation'
import { useTypography } from '../hooks/useTypography'
import { BookTab, reader } from '../models/reader'
import { useSettings } from '../state'
import {
  resolveTranslationDirection,
  type TranslationLanguage,
} from '../translation/languages'
import { serializeTranslationFragment } from '../translation/serialize'
import { copy, keys, last } from '../utils'

import { Button, IconButton } from './Button'
import { DictionaryPopup } from './DictionaryPopup'
import { TextField } from './Form'
import { TranslationPopup } from './TranslationPopup'
import {
  layout,
  LayoutAnchorMode,
  LayoutAnchorPosition,
  layoutBesideRect,
} from './base/ContextView'
import { Overlay } from './base/Overlay'

interface TextSelectionMenuProps {
  tab: BookTab
  onChapterFind: () => void
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
  textNode: Text
}

function paragraphIndexForTextNode(node: Node) {
  const paragraph = node.parentElement?.closest('p')
  if (!paragraph) return

  const marker = paragraph.closest('[data-flow-body-text="true"]')
  const container =
    marker === paragraph
      ? paragraph.parentElement
      : marker instanceof HTMLElement
        ? marker
        : paragraph.closest('.flow-txt-body')
  if (!container) return

  const paragraphs = Array.from(container.children).filter(
    (element) =>
      element.tagName.toLowerCase() === 'p' &&
      (marker !== paragraph ||
        element.getAttribute('data-flow-body-text') === 'true'),
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

  const node = range.startContainer as Text
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
        textNode: node,
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
      'TEXT_REPLACE_RENDER_PATCH_FAILED',
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
  onChapterFind,
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
  const onChapterFindEvent = useEffectEvent(onChapterFind)

  useEffect(() => {
    if (!range) return

    const handleFindShortcut = (event: KeyboardEvent) => {
      if (
        !(event.metaKey || event.ctrlKey) ||
        event.altKey ||
        (event.key.toLowerCase() !== 'f' && event.code !== 'KeyF')
      ) {
        return
      }

      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
      onChapterFindEvent()
    }

    window.addEventListener('keydown', handleFindShortcut, true)
    return () => window.removeEventListener('keydown', handleFindShortcut, true)
  }, [range])

  if (!range) return null

  const view = tab.viewForRange(range)
  const el = view?.element as HTMLElement | undefined
  if (!el) return null

  const forward = menuSelection ? isForwardSelection(menuSelection) : true

  const rangeElement =
    range.startContainer.nodeType === Node.ELEMENT_NODE
      ? (range.startContainer as Element)
      : range.startContainer.parentElement
  const writingMode = rangeElement
    ? rangeElement.ownerDocument.defaultView?.getComputedStyle(rangeElement)
        .writingMode
    : undefined
  const rects = orderRangeRectsForWritingMode(
    [...range.getClientRects()].filter((r) => Math.round(r.width)),
    writingMode ?? 'horizontal-tb',
  )
  const anchorRect = rects && (forward ? last(rects) : rects[0])
  if (!anchorRect) return null

  const contents = range.cloneContents()
  const text = contents.textContent?.trim()
  if (!text) return null
  const translationText = serializeTranslationFragment(contents) || text

  return (
    // to reset inner state
    <TextSelectionMenuRenderer
      tab={tab}
      range={range as Range}
      anchorRect={anchorRect}
      rangeRects={rects}
      containerRect={el.parentElement!.getBoundingClientRect()}
      viewRect={el.getBoundingClientRect()}
      releasePoint={menuSelection ? releasePoint : undefined}
      text={text}
      translationText={translationText}
      cfi={menuSelection ? undefined : annotationCfi}
      forward={forward}
      writingMode={writingMode}
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
  rangeRects: readonly DOMRect[]
  containerRect: DOMRect
  viewRect: DOMRect
  releasePoint?: { x: number; y: number }
  text: string
  translationText: string
  cfi?: string
  forward: boolean
  writingMode?: string
  hide: () => void
}
const TextSelectionMenuRenderer: React.FC<TextSelectionMenuRendererProps> = ({
  tab,
  range,
  anchorRect,
  rangeRects,
  containerRect,
  viewRect,
  releasePoint,
  forward,
  writingMode,
  text,
  translationText,
  cfi: annotationCfi,
  hide,
}) => {
  const setAction = useSetAction()
  const ref = useRef<HTMLInputElement>(null)
  const [width, setWidth] = useState(0)
  const [height, setHeight] = useState(0)
  const popupResizeObserverRef = useRef<ResizeObserver | undefined>(undefined)
  const t = useTranslation('menu')
  const [settings] = useSettings()
  const [view, setView] = useState<'actions' | 'dictionary' | 'translation'>(
    'actions',
  )
  const [localDictionaries, setLocalDictionaries] = useState<
    LocalDictionaryRecord[]
  >([])

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
  const savingReplacementRef = useRef(false)
  const [replacementError, setReplacementError] =
    useState<TextReplacementError>()
  const replaceTarget = editing
    ? replacementSnapshotRef.current
    : currentReplaceTarget
  const textEditingDisabled =
    tab.book.scope === 'external' || tab.book.contentMode === 'archiveOnly'
  const closeMenu = () => {
    if (savingReplacementRef.current) return
    hide()
  }
  const switchView = (nextView: 'actions' | 'dictionary' | 'translation') => {
    setWidth(0)
    setHeight(0)
    setView(nextView)
  }
  const dismissOverlay = () => {
    if (view === 'dictionary' || view === 'translation') {
      switchView('actions')
      return
    }
    closeMenu()
  }
  const dictionaryMetadataLanguage = selectionLanguage(
    range,
    tab.book.metadata.language,
  )
  const translationSettings = settings.translation ?? {
    mainLanguage: 'zh-Hans' as TranslationLanguage,
    secondaryLanguage: 'en' as TranslationLanguage,
    defaultProvider: 'google' as const,
  }
  const translationDirection = resolveTranslationDirection({
    declaredLanguage: dictionaryMetadataLanguage,
    mainLanguage: translationSettings.mainLanguage,
    secondaryLanguage: translationSettings.secondaryLanguage,
    text: translationText,
  })
  const dictionaryQuery = normalizeDictionaryQuery(
    text,
    dictionaryMetadataLanguage,
  )
  useEffect(() => {
    let active = true
    void listLocalDictionariesCached()
      .then((records) => {
        if (!active) return
        setLocalDictionaries(
          records.filter(
            (record) => record.enabled && record.sourceStatus === 'available',
          ),
        )
      })
      .catch(() => {
        if (active) setLocalDictionaries([])
      })
    return () => {
      active = false
    }
  }, [])
  const dictionaryLanguage = dictionaryQuery?.language
  const eligibleLocalDictionaries = useMemo(
    () =>
      localDictionaries.filter(
        (dictionary) =>
          dictionaryLanguage &&
          dictionary.language.value.some(
            (language) => language === dictionaryLanguage,
          ),
      ),
    [dictionaryLanguage, localDictionaries],
  )
  const dictionaryAvailable =
    (dictionaryQuery?.language === 'zh' &&
      settings.dictionary?.zdic?.enabled !== false) ||
    (dictionaryQuery?.language === 'en' &&
      settings.dictionary?.merriamWebster?.enabled === true) ||
    eligibleLocalDictionaries.length > 0

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
  const vertical = writingMode === 'vertical-rl'
  const outerRangeRects = rangeRects.map((rect) => ({
    left: rect.left + viewRect.left - containerRect.left,
    top: rect.top + viewRect.top - containerRect.top,
    width: rect.width,
    height: rect.height,
  }))
  const rangeLeft = Math.min(...outerRangeRects.map((rect) => rect.left))
  const rangeRight = Math.max(
    ...outerRangeRects.map((rect) => rect.left + rect.width),
  )
  const rangeTop = Math.min(...outerRangeRects.map((rect) => rect.top))
  const rangeBottom = Math.max(
    ...outerRangeRects.map((rect) => rect.top + rect.height),
  )
  const verticalAnchor = {
    left: rangeLeft,
    top: releasePoint
      ? releasePoint.y + viewRect.top - containerRect.top
      : rangeTop,
    width: rangeRight - rangeLeft,
    height: releasePoint ? 1 : rangeBottom - rangeTop,
  }
  const verticalPlacement = vertical
    ? layoutBesideRect(
        {
          left: 0,
          top: 0,
          width: containerRect.width,
          height: containerRect.height,
        },
        verticalAnchor,
        { width, height },
        {
          preferredSide: 'right',
          gap: 12,
          margin: 10,
          avoidRects: outerRangeRects,
        },
      )
    : undefined

  return (
    <>
      <Overlay
        // cover `sash`
        className="!z-50 !bg-transparent"
        onPointerDown={dismissOverlay}
      />
      <div
        key={view}
        data-flow-keyboard-capture="true"
        data-flow-dictionary-popup={view === 'dictionary' ? 'true' : undefined}
        data-flow-translation-popup={
          view === 'translation' ? 'true' : undefined
        }
        ref={(el) => {
          popupResizeObserverRef.current?.disconnect()
          popupResizeObserverRef.current = undefined
          if (!el) return
          const updateSize = () => {
            setWidth(el.offsetWidth)
            setHeight(el.offsetHeight)
          }
          updateSize()
          popupResizeObserverRef.current = new ResizeObserver(updateSize)
          popupResizeObserverRef.current.observe(el)
          el.focus({ preventScroll: true })
        }}
        className={clsx(
          'border-border bg-popover text-popover-foreground absolute z-50 box-border rounded-lg border shadow-lg shadow-black/10 focus:outline-none',
          view === 'dictionary' || view === 'translation'
            ? 'overflow-hidden p-0'
            : 'p-2',
          view === 'actions' && (editing || annotate) && 'space-y-2',
        )}
        style={{
          width:
            view === 'dictionary' || view === 'translation'
              ? Math.min(600, Math.max(0, containerRect.width - 20))
              : undefined,
          left:
            verticalPlacement?.left ??
            layout(containerRect.width, width, {
              offset: layoutAnchor.left + viewRect.left - containerRect.left,
              size: layoutAnchor.width,
              mode: LayoutAnchorMode.ALIGN,
              position,
            }),
          top:
            verticalPlacement?.top ??
            layout(containerRect.height, height, {
              offset:
                layoutAnchor.top - (layoutLineHeight - layoutAnchor.height) / 2,
              size: layoutLineHeight,
              position,
            }),
          visibility: width && height ? 'visible' : 'hidden',
        }}
        role={
          view === 'dictionary' || view === 'translation' ? 'dialog' : undefined
        }
        tabIndex={-1}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Escape') {
            e.preventDefault()
            dismissOverlay()
            return
          }
          if (
            e.key.toLowerCase() === 'c' &&
            (e.ctrlKey || e.metaKey) &&
            !window.getSelection()?.toString()
          ) {
            copy(text)
          }
        }}
      >
        {view === 'dictionary' ? (
          <DictionaryPopup
            key={dictionaryQuery?.text ?? text}
            metadataLanguage={dictionaryMetadataLanguage}
            query={dictionaryQuery?.text ?? text}
            localDictionaries={eligibleLocalDictionaries}
            maxPopupHeight={Math.max(0, containerRect.height - 22)}
            onBack={() => switchView('actions')}
            onClose={closeMenu}
          />
        ) : view === 'translation' ? (
          <TranslationPopup
            key={translationText}
            text={translationText}
            mainLanguage={translationSettings.mainLanguage}
            secondaryLanguage={translationSettings.secondaryLanguage}
            initialProvider={translationSettings.defaultProvider}
            initialSourceLanguage={translationDirection.sourceLanguage}
            initialTargetLanguage={translationDirection.targetLanguage}
            maxPopupHeight={Math.max(0, containerRect.height - 22)}
            onBack={() => switchView('actions')}
            onClose={closeMenu}
          />
        ) : editing ? (
          <div className="space-y-2">
            <textarea
              ref={replacementRef}
              name="replacement"
              aria-label={t('edit_text')}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              defaultValue={replaceTarget?.selectedText ?? text}
              className="textfield bg-background text-foreground scroll block h-40 w-68 resize-none px-1.5 py-1 text-base outline-none"
            />
            {replacementError && (
              <div className="text-destructive w-68 text-sm leading-snug">
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
          <div>
            <TextField
              mRef={ref}
              as="textarea"
              name="notes"
              defaultValue={annotation?.notes}
              hideLabel
              className="h-40 w-68"
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
              title={t('dictionary')}
              Icon={BookOpenTextIcon}
              size={ICON_SIZE}
              className={actionIconClassName}
              style={{
                width: ANNOTATION_SIZE,
                height: ANNOTATION_SIZE,
              }}
              disabled={!dictionaryAvailable}
              onClick={() => switchView('dictionary')}
            />
            <IconButton
              title={t('translate')}
              Icon={LanguagesIcon}
              size={ICON_SIZE}
              className={actionIconClassName}
              style={{ width: ANNOTATION_SIZE, height: ANNOTATION_SIZE }}
              onClick={() => switchView('translation')}
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
              title={t(
                textEditingDisabled ? 'edit_text_archive_only' : 'edit_text',
              )}
              Icon={FilePenLineIcon}
              disabled={textEditingDisabled || !currentReplaceTarget}
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
        {view === 'actions' && !editing && (
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
                      'border-border text-muted-foreground flex cursor-pointer appearance-none items-center justify-center rounded-md border bg-transparent p-0 text-base transition-[box-shadow,filter] outline-none hover:shadow-[inset_0_0_0_2px_var(--flow-accent-border)] hover:brightness-110 active:brightness-95',
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
        {view === 'actions' && editing && (
          <div className="flex gap-2">
            <Button
              compact
              variant="secondary"
              disabled={savingReplacement}
              onClick={() => {
                if (savingReplacement) return
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
                const { selectedText, textNode, ...target } = replaceTarget
                const newText = replacementRef.current?.value ?? selectedText
                if (newText === selectedText) {
                  hide()
                  return
                }

                savingReplacementRef.current = true
                setSavingReplacement(true)
                setReplacementError(undefined)
                void replaceBookText({
                  id: tab.book.id,
                  target,
                  oldText: selectedText,
                  newText,
                })
                  .then(async (result) => {
                    await reader.applyBookContentEdit(
                      result.book,
                      result.sectionHref,
                      tab,
                      {
                        target,
                        oldText: selectedText,
                        newText,
                        document:
                          range.startContainer.ownerDocument ?? undefined,
                        textNode,
                      },
                    )
                    hide()
                  })
                  .catch((error) => {
                    setReplacementError(textReplacementErrorMessage(error, t))
                  })
                  .finally(() => {
                    savingReplacementRef.current = false
                    setSavingReplacement(false)
                  })
              }}
            >
              {savingReplacement ? t('saving') : t('save')}
            </Button>
          </div>
        )}
        {view === 'actions' && annotate && !editing && (
          <div className="flex">
            {annotation ? (
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
            ) : (
              <Button
                compact
                variant="secondary"
                onClick={() => setAnnotate(false)}
              >
                {t('cancel')}
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
    </>
  )
}

function selectionLanguage(range: Range, bookLanguage?: string) {
  const container = range.commonAncestorContainer
  let element =
    container.nodeType === Node.ELEMENT_NODE
      ? (container as Element)
      : container.parentElement
  while (element) {
    const language =
      element.getAttribute('lang') ??
      element.getAttributeNS('http://www.w3.org/XML/1998/namespace', 'lang')
    if (language?.trim()) return language
    element = element.parentElement
  }
  return bookLanguage
}
