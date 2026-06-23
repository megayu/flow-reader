import clsx from 'clsx'
import { useMemo, useRef, useState } from 'react'
import FocusLock from 'react-focus-lock'
import {
  MdCopyAll,
  MdOutlineAddBox,
  MdOutlineEdit,
  MdOutlineIndeterminateCheckBox,
  MdSearch,
} from 'react-icons/md'
import { useSnapshot } from 'valtio'

import { typeMap, colorMap } from '../annotation'
import { useSetAction } from '../hooks/useAction'
import { useMobile } from '../hooks/useMobile'
import { isForwardSelection, useTextSelection } from '../hooks/useTextSelection'
import { useTranslation } from '../hooks/useTranslation'
import { useTypography } from '../hooks/useTypography'
import { BookTab } from '../models/reader'
import { isTouchScreen, scale } from '../platform'
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
    return selection.getRangeAt(0)
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

  const [selection, setSelection] = useTextSelection(windows)

  // If text selection menu is disabled, don't render it
  if (settings.enableTextSelectionMenu === false) {
    return null
  }

  // it is possible that both `selection` and `tab.annotationRange`
  // are set when select end within an annotation
  const range = getSelectionRange(selection) ?? annotationRange
  if (!range) return null

  const view = tab.viewForRange(range)
  const el = view?.element as HTMLElement | undefined
  if (!el) return null

  // prefer to display above the selection to avoid text selection helpers
  // https://stackoverflow.com/questions/68081757/hide-the-two-text-selection-helpers-in-mobile-browsers
  const forward = isTouchScreen
    ? false
    : selection
      ? isForwardSelection(selection)
      : true

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
      text={text}
      cfi={selection ? undefined : annotationCfi}
      forward={forward}
      hide={() => {
        if (selection) {
          try {
            selection.removeAllRanges()
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

const ICON_SIZE = scale(20, 24)
const ANNOTATION_SIZE = scale(24, 30)

interface TextSelectionMenuRendererProps {
  tab: BookTab
  range: Range
  anchorRect: DOMRect
  containerRect: DOMRect
  viewRect: DOMRect
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
  forward,
  text,
  cfi: annotationCfi,
  hide,
}) => {
  const setAction = useSetAction()
  const ref = useRef<HTMLInputElement>(null)
  const [width, setWidth] = useState(0)
  const [height, setHeight] = useState(0)
  const mobile = useMobile()
  const t = useTranslation('menu')

  const cfi = annotationCfi ?? tab.rangeToCfi(range)
  const section = tab.sectionForRange(range)
  const annotation = tab.book.annotations.find((a) => a.cfi === cfi)
  const [annotate, setAnnotate] = useState(!!annotation)

  const position = forward
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

  return (
    <FocusLock disabled={mobile}>
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
          if (!mobile) {
            el.focus()
          }
        }}
        className={clsx(
          'bg-popover text-muted-foreground absolute z-50 p-2 shadow-sm focus:outline-none',
        )}
        style={{
          left: layout(containerRect.width, width, {
            offset: anchorRect.left + viewRect.left - containerRect.left,
            size: anchorRect.width,
            mode: LayoutAnchorMode.ALIGN,
            position,
          }),
          top: layout(containerRect.height, height, {
            offset: anchorRect.top - (lineHeight - anchorRect.height) / 2,
            size: lineHeight,
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
        {annotate ? (
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
              Icon={MdCopyAll}
              size={ICON_SIZE}
              className="!flex items-center justify-center !p-0"
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
              Icon={MdSearch}
              size={ICON_SIZE}
              className="!flex items-center justify-center !p-0"
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
              title={t('annotate')}
              Icon={MdOutlineEdit}
              size={ICON_SIZE}
              className="!flex items-center justify-center !p-0"
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
                Icon={MdOutlineIndeterminateCheckBox}
                size={ICON_SIZE}
                className="!flex items-center justify-center !p-0"
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
                Icon={MdOutlineAddBox}
                size={ICON_SIZE}
                className="!flex items-center justify-center !p-0"
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
        <div className="space-y-2">
          {keys(typeMap).map((type) => (
            <div key={type} className="flex gap-2">
              {keys(colorMap).map((color) => (
                <div
                  key={color}
                  style={{
                    [typeMap[type].style]: colorMap[color],
                    width: ANNOTATION_SIZE,
                    height: ANNOTATION_SIZE,
                    fontSize: scale(16, 20),
                  }}
                  className={clsx(
                    'text-muted-foreground flex cursor-pointer items-center justify-center text-base',
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
                </div>
              ))}
            </div>
          ))}
        </div>
        {annotate && (
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
