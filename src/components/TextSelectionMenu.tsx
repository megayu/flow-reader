import clsx from 'clsx'
import {
  CopyIcon,
  PencilIcon,
  SearchIcon,
  SquareMinusIcon,
  SquarePlusIcon,
} from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import FocusLock from 'react-focus-lock'
import { useSnapshot } from 'valtio'

import { typeMap, colorMap } from '../annotation'
import { useSetAction } from '../hooks/useAction'
import { isForwardSelection, useTextSelection } from '../hooks/useTextSelection'
import { useTranslation } from '../hooks/useTranslation'
import { useTypography } from '../hooks/useTypography'
import { BookTab } from '../models/reader'
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
