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

import { type AnnotationColor, colorMap, orderRangeRectsForWritingMode, typeMap } from '../annotation'
import { type LocalDictionaryRecord, listLocalDictionariesCached } from '../dictionary/native'
import { normalizeDictionaryQuery } from '../dictionary/query'
import { useSetAction } from '../hooks/useAction'
import { isForwardSelection, useTextSelection } from '../hooks/useTextSelection'
import { useTranslation } from '../hooks/useTranslation'
import { useTypography } from '../hooks/useTypography'
import { type BookTab, getBookTabFrameWindows, reader } from '../models/reader'
import { LayoutAnchorMode, LayoutAnchorPosition, layout, layoutBesideRect } from '../reader/contextViewLayout'
import { useSettings } from '../state'
import { type BookTextReplaceTarget, replaceBookText } from '../storage'
import { resolveTranslationDirection, type TranslationLanguage } from '../translation/languages'
import { serializeTranslationFragment } from '../translation/serialize'
import { copy, keys, last } from '../utils'

import { Overlay } from './base/Overlay'
import { DictionaryPopup } from './DictionaryPopup'
import { IconButton } from './IconButton'
import { TranslationPopup } from './TranslationPopup'
import { Button } from './ui/button'
import { Textarea } from './ui/textarea'

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
  } catch (_error) {
    return
  }
}

function clearWindowSelections(windows: readonly Window[]) {
  windows.forEach((win) => {
    try {
      win.getSelection()?.removeAllRanges()
    } catch (_error) {
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
      (marker !== paragraph || element.getAttribute('data-flow-body-text') === 'true'),
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

function textReplacementErrorMessage(error: unknown, t: (key: string) => string): TextReplacementError {
  const message = error instanceof Error ? error.message : String(error)
  const match = textReplacementErrorKeys.find(({ fragments }) =>
    fragments.some((fragment) => message.includes(fragment)),
  )

  return {
    message: t(match?.key ?? 'edit_text_error_generic'),
    detail: message || undefined,
  }
}

export const TextSelectionMenu: React.FC<TextSelectionMenuProps> = ({ tab, onChapterFind }) => {
  const { viewVersion, annotationRange, annotationCfi } = useSnapshot(tab) as unknown as {
    viewVersion: number
    annotationRange?: Range
    annotationCfi?: string
  }
  const [settings] = useSettings()

  const windows = useMemo(() => {
    const frameWindows = getBookTabFrameWindows(tab)

    return (
      frameWindows.length
        ? [...frameWindows]
        : (tab.rendition?.manager?.views?._views
            ?.map((view: any) => view.window as Window | undefined)
            .filter((win: Window | undefined): win is Window => !!win) ?? [])
    ) as Window[]
  }, [tab, viewVersion])

  const [selection, setSelection, releasePoint, menuOpen] = useTextSelection(windows, {
    automatic: settings.enableTextSelectionMenu === true,
  })

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
    ? rangeElement.ownerDocument.defaultView?.getComputedStyle(rangeElement).writingMode
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
          } catch (_error) {
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
const actionIconClassName = 'flex! items-center justify-center p-0! [&_svg]:size-7!'

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
  const ref = useRef<HTMLTextAreaElement>(null)
  const [width, setWidth] = useState(0)
  const [height, setHeight] = useState(0)
  const popupElementRef = useRef<HTMLDivElement>(null)
  const popupResizeObserverRef = useRef<ResizeObserver | undefined>(undefined)
  const t = useTranslation('menu')
  const [settings] = useSettings()
  const [view, setView] = useState<'actions' | 'dictionary' | 'translation'>('actions')
  const [localDictionaries, setLocalDictionaries] = useState<LocalDictionaryRecord[]>([])

  const cfi = annotationCfi ?? tab.rangeToCfi(range)
  const section = tab.sectionForRange(range)
  const annotation = tab.overlayState.annotations.find((a) => a.cfi === cfi)
  const annotationHasNotes = Boolean(annotation?.notes?.trim())
  const [annotate, setAnnotate] = useState(annotationHasNotes)
  const [draftAnnotationColor, setDraftAnnotationColor] = useState<AnnotationColor>(annotation?.color ?? 'yellow')
  const [annotationNotesChanged, setAnnotationNotesChanged] = useState(false)
  const replacementRef = useRef<HTMLTextAreaElement>(null)
  const currentReplaceTarget = useMemo(() => createTextReplaceTarget(range, section), [range, section])
  const replacementSnapshotRef = useRef<TextReplaceTarget | undefined>(undefined)
  const [editing, setEditing] = useState(false)
  const [editorChanged, setEditorChanged] = useState(false)
  const [savingReplacement, setSavingReplacement] = useState(false)
  const savingReplacementRef = useRef(false)
  const [replacementError, setReplacementError] = useState<TextReplacementError>()
  const replaceTarget = editing ? replacementSnapshotRef.current : currentReplaceTarget
  const initialAnnotationNotes = annotation?.notes ?? ''
  const annotationColorChanged = draftAnnotationColor !== (annotation?.color ?? 'yellow')
  const annotationChanged = annotationNotesChanged || annotationColorChanged
  const textEditingDisabled = tab.book.scope === 'external' || tab.book.archive === true
  const closeMenu = () => {
    if (savingReplacementRef.current) return
    hide()
  }
  const cancelEditing = () => {
    if (savingReplacementRef.current) return
    setEditing(false)
    setReplacementError(undefined)
  }
  const cancelAnnotation = () => {
    setDraftAnnotationColor(annotation?.color ?? 'yellow')
    setAnnotationNotesChanged(false)
    setAnnotate(false)
    popupElementRef.current?.focus({ preventScroll: true })
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
  const dictionaryMetadataLanguage = selectionLanguage(range, tab.book.metadata.language)
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
  const dictionaryQuery = normalizeDictionaryQuery(text, dictionaryMetadataLanguage)
  useEffect(() => {
    let active = true
    void listLocalDictionariesCached()
      .then((records) => {
        if (!active) return
        setLocalDictionaries(records.filter((record) => record.enabled && record.sourceStatus === 'available'))
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
          dictionaryLanguage && dictionary.language.value.some((language) => language === dictionaryLanguage),
      ),
    [dictionaryLanguage, localDictionaries],
  )
  const dictionaryAvailable =
    (dictionaryQuery?.language === 'zh' && settings.dictionary?.zdic?.enabled === true) ||
    (dictionaryQuery?.language === 'en' && settings.dictionary?.merriamWebster?.enabled === true) ||
    eligibleLocalDictionaries.length > 0

  useEffect(() => {
    if (!editing) return

    const timer = window.setTimeout(() => replacementRef.current?.focus())

    return () => window.clearTimeout(timer)
  }, [editing])

  useEffect(() => {
    if (!annotate) return

    const timer = window.setTimeout(() => ref.current?.focus())
    return () => window.clearTimeout(timer)
  }, [annotate])

  const position = releasePoint
    ? LayoutAnchorPosition.Before
    : forward
      ? LayoutAnchorPosition.Before
      : LayoutAnchorPosition.After

  const { zoom } = useTypography(tab)
  const endContainer = forward ? range.endContainer : range.startContainer
  const _lineHeight = parseFloat(getComputedStyle(endContainer.parentElement!).lineHeight)
  // no custom line height and the origin is keyword, e.g. 'normal'.
  const lineHeight = Number.isNaN(_lineHeight) ? anchorRect.height : _lineHeight * (zoom ?? 1)
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
  const rangeRight = Math.max(...outerRangeRects.map((rect) => rect.left + rect.width))
  const rangeTop = Math.min(...outerRangeRects.map((rect) => rect.top))
  const rangeBottom = Math.max(...outerRangeRects.map((rect) => rect.top + rect.height))
  const verticalAnchor = {
    left: rangeLeft,
    top: releasePoint ? releasePoint.y + viewRect.top - containerRect.top : rangeTop,
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
        className="z-50! bg-transparent!"
        onPointerDown={dismissOverlay}
      />
      <div
        key={view}
        data-flow-keyboard-capture="true"
        data-flow-dictionary-popup={view === 'dictionary' ? 'true' : undefined}
        data-flow-translation-popup={view === 'translation' ? 'true' : undefined}
        ref={(el) => {
          popupElementRef.current = el
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
          if (!el.contains(el.ownerDocument.activeElement)) {
            el.focus({ preventScroll: true })
          }
        }}
        className={clsx(
          'border-border bg-popover text-popover-foreground absolute z-50 box-border rounded-lg border shadow-lg shadow-black/10 focus:outline-none',
          view === 'dictionary' || view === 'translation' ? 'overflow-hidden p-0' : 'p-2',
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
              offset: layoutAnchor.top - (layoutLineHeight - layoutAnchor.height) / 2,
              size: layoutLineHeight,
              position,
            }),
          visibility: width && height ? 'visible' : 'hidden',
        }}
        role={view === 'dictionary' || view === 'translation' ? 'dialog' : undefined}
        data-flow-escape-surface
        tabIndex={-1}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Escape') {
            e.preventDefault()
            if (editing) {
              cancelEditing()
              return
            }
            if (annotate) {
              cancelAnnotation()
              return
            }
            dismissOverlay()
            return
          }
          if (e.key.toLowerCase() === 'c' && (e.ctrlKey || e.metaKey) && !window.getSelection()?.toString()) {
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
            <Textarea
              ref={replacementRef}
              name="replacement"
              aria-label={t('edit_text')}
              defaultValue={replaceTarget?.selectedText ?? text}
              onValueChange={(value) => setEditorChanged(value !== replaceTarget?.selectedText)}
              onExitEditing={cancelEditing}
              className="textfield bg-background text-foreground scroll block h-40 min-h-0 w-68 resize-none rounded-none border-0 px-1.5 py-1 text-base outline-none focus-visible:border-transparent focus-visible:ring-1 focus-visible:ring-inset"
            />
            {replacementError && (
              <div className="text-destructive w-68 text-sm leading-snug">
                <div>{replacementError.message}</div>
                {replacementError.detail && (
                  <div className="mt-1 text-xs wrap-break-word">
                    {t('edit_text_error_reason')}
                    {replacementError.detail}
                  </div>
                )}
              </div>
            )}
          </div>
        ) : annotate ? (
          <Textarea
            ref={ref}
            name="notes"
            aria-label="notes"
            defaultValue={initialAnnotationNotes}
            onValueChange={(value) => setAnnotationNotesChanged(value !== initialAnnotationNotes)}
            autoFocus
            onExitEditing={cancelAnnotation}
            className="textfield bg-background text-muted-foreground scroll h-40 min-h-0 w-68 resize-none rounded-none border-0 px-1.5 py-1 text-base focus-visible:border-transparent focus-visible:ring-1 focus-visible:ring-inset"
          />
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
                void tab.searchKeywordImmediately(text)
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
              title={t(textEditingDisabled ? 'edit_text_archive_only' : 'edit_text')}
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
                setEditorChanged(false)
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
                setAnnotationNotesChanged(false)
                setDraftAnnotationColor(annotation?.color ?? 'yellow')
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
                      'text-muted-foreground flex cursor-pointer appearance-none items-center justify-center rounded-md border-2 bg-transparent p-0 text-base transition-[filter] outline-none hover:brightness-110 active:brightness-95',
                      type === (annotation?.type ?? 'highlight') &&
                        color === (annotate ? draftAnnotationColor : annotation?.color)
                        ? 'border-(--flow-accent)'
                        : annotate && annotationColorChanged && type === annotation?.type && color === annotation.color
                          ? 'border-(--flow-text-muted)'
                          : 'border-border',
                      typeMap[type].class,
                    )}
                    onClick={() => {
                      if (annotate) {
                        setDraftAnnotationColor(color)
                        return
                      }

                      if (annotation && !annotationHasNotes && annotation.type === type && annotation.color === color) {
                        void tab.removeAnnotation(cfi).catch(console.error)
                      } else if (annotation?.type !== type || annotation.color !== color) {
                        void tab.putAnnotation(type, cfi, color, text, annotation?.notes, section).catch(console.error)
                      }
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
            <Button size="sm" variant="secondary" disabled={savingReplacement} onClick={cancelEditing}>
              {t('cancel')}
            </Button>
            <Button
              className="ml-auto"
              size="sm"
              disabled={!replaceTarget || savingReplacement || !editorChanged}
              onClick={() => {
                if (!replaceTarget) return
                const { selectedText, textNode, ...target } = replaceTarget
                const newText = replacementRef.current?.value ?? selectedText
                if (newText === selectedText) return

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
                    await reader.applyBookContentEdit(result.book, result.sectionHref, tab, {
                      target,
                      oldText: selectedText,
                      newText,
                      document: range.startContainer.ownerDocument ?? undefined,
                      textNode,
                    })
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
                size="sm"
                variant="secondary"
                onClick={() => {
                  void tab.removeAnnotation(cfi).catch(console.error)
                  hide()
                }}
              >
                {t('delete')}
              </Button>
            ) : (
              <Button size="sm" variant="secondary" onClick={cancelAnnotation}>
                {t('cancel')}
              </Button>
            )}
            <Button
              className="ml-auto"
              size="sm"
              disabled={!annotationChanged}
              onClick={() => {
                void tab
                  .putAnnotation(
                    annotation?.type ?? 'highlight',
                    cfi,
                    draftAnnotationColor,
                    text,
                    ref.current?.value,
                    section,
                  )
                  .catch(console.error)
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
  let element = container.nodeType === Node.ELEMENT_NODE ? (container as Element) : container.parentElement
  while (element) {
    const language =
      element.getAttribute('lang') ?? element.getAttributeNS('http://www.w3.org/XML/1998/namespace', 'lang')
    if (language?.trim()) return language
    element = element.parentElement
  }
  return bookLanguage
}
