import clsx from 'clsx'
import { MinusIcon, PlusIcon, RefreshCwIcon, RotateCcwIcon, RotateCwIcon, XIcon } from 'lucide-react'
import React, {
  type ComponentProps,
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'

import { useTranslation } from '../../hooks/useTranslation'

const IMAGE_PREVIEW_ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 5]
const IMAGE_PREVIEW_MIN_STEP = IMAGE_PREVIEW_ZOOM_STEPS[0] ?? 0.5
const IMAGE_PREVIEW_MAX_STEP = IMAGE_PREVIEW_ZOOM_STEPS[IMAGE_PREVIEW_ZOOM_STEPS.length - 1] ?? 5
const IMAGE_PREVIEW_SIDE_PADDING = 64
const IMAGE_PREVIEW_VERTICAL_PADDING = 192
const IMAGE_PREVIEW_WHEEL_THRESHOLD = 6

export interface ReaderImagePreviewProps {
  openKey?: number
  src?: string
  onClose: () => void
}

type ReaderImagePreviewMode = 'fit' | 'zoom'
type ReaderImagePreviewRotation = 0 | 90 | 180 | 270

interface ReaderImagePreviewState {
  mode: ReaderImagePreviewMode
  naturalSize?: {
    width: number
    height: number
  }
  pan: {
    x: number
    y: number
  }
  rotation: number
  scale: number
}

function createReaderImagePreviewState(): ReaderImagePreviewState {
  return {
    mode: 'fit',
    pan: { x: 0, y: 0 },
    rotation: 0,
    scale: 1,
  }
}

export const ReaderImagePreview: React.FC<ReaderImagePreviewProps> = ({ openKey, src, onClose }) => {
  const t = useTranslation('image_preview')
  const previewRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 })
  const [dragging, setDragging] = useState(false)
  const [previewState, setPreviewState] = useState(createReaderImagePreviewState)
  const { mode, naturalSize, pan, rotation, scale } = previewState
  const normalizedRotation = normalizeImagePreviewRotation(rotation)
  const dragState = useRef<
    | {
        pointerId: number
        startPan: { x: number; y: number }
        startX: number
        startY: number
      }
    | undefined
  >(undefined)

  const availableSize = useMemo(
    () => ({
      height: Math.max(1, stageSize.height - IMAGE_PREVIEW_VERTICAL_PADDING),
      width: Math.max(1, stageSize.width - IMAGE_PREVIEW_SIDE_PADDING),
    }),
    [stageSize.height, stageSize.width],
  )

  const rotatedSize = useMemo(() => {
    if (!naturalSize) return undefined
    if (normalizedRotation === 90 || normalizedRotation === 270) {
      return {
        width: naturalSize.height,
        height: naturalSize.width,
      }
    }
    return naturalSize
  }, [naturalSize, normalizedRotation])

  const fitScale = useMemo(() => {
    if (!rotatedSize || !stageSize.width || !stageSize.height) return 1

    return Math.min(1, availableSize.width / rotatedSize.width, availableSize.height / rotatedSize.height)
  }, [availableSize.height, availableSize.width, rotatedSize, stageSize.height, stageSize.width])

  const displayScale = mode === 'fit' ? fitScale : scale
  const previewReady = !!naturalSize && stageSize.width > 0 && stageSize.height > 0

  const panBounds = useMemo(() => {
    if (!rotatedSize) return { x: 0, y: 0 }

    return {
      x: Math.max(0, (rotatedSize.width * displayScale - availableSize.width) / 2),
      y: Math.max(0, (rotatedSize.height * displayScale - availableSize.height) / 2),
    }
  }, [availableSize.height, availableSize.width, displayScale, rotatedSize])

  const clampedPan = useMemo(() => clampImagePreviewPan(pan, panBounds), [pan, panBounds])

  useLayoutEffect(() => {
    if (!src) return

    const stage = stageRef.current
    if (!stage) return

    const updateStageSize = () => {
      const rect = stage.getBoundingClientRect()
      setStageSize({
        width: rect.width,
        height: rect.height,
      })
    }

    updateStageSize()

    const observer = new ResizeObserver(updateStageSize)
    observer.observe(stage)
    window.addEventListener('resize', updateStageSize)

    return () => {
      observer.disconnect()
      window.removeEventListener('resize', updateStageSize)
    }
  }, [openKey, src])

  useLayoutEffect(() => {
    if (!src) return

    setPreviewState(createReaderImagePreviewState())

    requestAnimationFrame(() => {
      previewRef.current?.focus()
    })
  }, [openKey, src])

  const zoomTo = useCallback((nextScale: number) => {
    setPreviewState((current) => ({
      ...current,
      mode: 'zoom',
      pan: { x: 0, y: 0 },
      scale: clamp(nextScale, IMAGE_PREVIEW_MIN_STEP, IMAGE_PREVIEW_MAX_STEP),
    }))
  }, [])

  const zoomIn = useCallback(() => {
    const next = getNextImagePreviewZoomIn(displayScale)
    if (next === undefined) return
    setPreviewState((current) => ({
      ...current,
      mode: 'zoom',
      pan: { x: 0, y: 0 },
      scale: next,
    }))
  }, [displayScale])

  const zoomOut = useCallback(() => {
    const next = getNextImagePreviewZoomOut(displayScale)
    if (next === undefined) return
    setPreviewState((current) => ({
      ...current,
      mode: 'zoom',
      pan: { x: 0, y: 0 },
      scale: next,
    }))
  }, [displayScale])

  const resetToFit = useCallback(() => {
    setPreviewState((current) => ({
      ...current,
      mode: 'fit',
      pan: { x: 0, y: 0 },
    }))
  }, [])

  const rotateImage = useCallback((delta: -90 | 90) => {
    setPreviewState((current) => ({
      ...current,
      pan: { x: 0, y: 0 },
      rotation: current.rotation + delta,
    }))
  }, [])

  const handleWheel = useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      event.preventDefault()
      event.stopPropagation()

      const delta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX
      if (Math.abs(delta) < IMAGE_PREVIEW_WHEEL_THRESHOLD) return

      if (delta < 0) zoomIn()
      else zoomOut()
    },
    [zoomIn, zoomOut],
  )

  const canPan = previewReady && (panBounds.x > 0 || panBounds.y > 0)

  const handleImagePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const rect = event.currentTarget.getBoundingClientRect()
      const insideImage =
        event.clientX >= rect.left &&
        event.clientX <= rect.right &&
        event.clientY >= rect.top &&
        event.clientY <= rect.bottom

      if (!insideImage) {
        event.preventDefault()
        event.stopPropagation()
        onClose()
        return
      }

      event.preventDefault()
      event.stopPropagation()

      if (!canPan) return

      event.currentTarget.setPointerCapture(event.pointerId)
      dragState.current = {
        pointerId: event.pointerId,
        startPan: clampedPan,
        startX: event.clientX,
        startY: event.clientY,
      }
      setDragging(true)
    },
    [canPan, clampedPan, onClose],
  )

  const handleImagePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragState.current
      if (!drag || drag.pointerId !== event.pointerId) return

      event.preventDefault()
      event.stopPropagation()

      setPreviewState((current) => ({
        ...current,
        pan: clampImagePreviewPan(
          {
            x: drag.startPan.x + event.clientX - drag.startX,
            y: drag.startPan.y + event.clientY - drag.startY,
          },
          panBounds,
        ),
      }))
    },
    [panBounds],
  )

  const endImageDrag = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (dragState.current?.pointerId !== event.pointerId) return

    event.preventDefault()
    event.stopPropagation()
    dragState.current = undefined
    setDragging(false)
  }, [])

  const handlePreviewBackdropPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault()
      event.stopPropagation()
      onClose()
    },
    [onClose],
  )

  const handlePreviewKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return

    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onClose()
      return
    }

    if (event.key === '+' || event.key === '=') {
      event.preventDefault()
      event.stopPropagation()
      zoomIn()
      return
    }

    if (event.key === '-') {
      event.preventDefault()
      event.stopPropagation()
      zoomOut()
      return
    }

    if (event.key === '0') {
      event.preventDefault()
      event.stopPropagation()
      resetToFit()
      return
    }

    if (event.key === '1') {
      event.preventDefault()
      event.stopPropagation()
      zoomTo(1)
      return
    }

    if (event.key === '[') {
      event.preventDefault()
      event.stopPropagation()
      rotateImage(-90)
      return
    }

    if (event.key === ']') {
      event.preventDefault()
      event.stopPropagation()
      rotateImage(90)
    }
  })

  useEffect(() => {
    if (!src) return

    const handleKeyDown = (event: KeyboardEvent) => {
      handlePreviewKeyDown(event)
    }

    document.addEventListener('keydown', handleKeyDown, true)

    return () => {
      document.removeEventListener('keydown', handleKeyDown, true)
    }
  }, [src])

  if (!src) return null

  const zoomPercent = `${Math.round(displayScale * 100)}%`
  const canZoomOut = getNextImagePreviewZoomOut(displayScale) !== undefined && displayScale > IMAGE_PREVIEW_MIN_STEP
  const canZoomIn = getNextImagePreviewZoomIn(displayScale) !== undefined && displayScale < IMAGE_PREVIEW_MAX_STEP
  const isOneToOne = Math.abs(displayScale - 1) < 0.001
  const isFit = mode === 'fit'

  if (typeof document === 'undefined') return null

  return createPortal(
    <div
      ref={previewRef}
      role="dialog"
      aria-modal="true"
      data-flow-keyboard-capture="true"
      tabIndex={-1}
      className="fixed inset-0 z-[9999] overflow-hidden bg-neutral-500 text-white outline-none"
      onWheel={handleWheel}
      onPointerDown={handlePreviewBackdropPointerDown}
      onMouseDown={(event) => {
        event.preventDefault()
        event.stopPropagation()
      }}
      onClick={onClose}
    >
      <div className="pointer-events-none absolute inset-0 bg-white/8" />
      <div ref={stageRef} className="absolute inset-0 flex items-center justify-center overflow-hidden px-8 py-24">
        <div
          className={clsx(
            'pointer-events-auto touch-none select-none',
            mode === 'zoom' && previewReady && !dragging && 'transition-transform duration-100 ease-out',
            previewReady ? 'opacity-100' : 'opacity-0',
            canPan ? (dragging ? 'cursor-grabbing' : 'cursor-grab') : 'cursor-default',
          )}
          style={{
            width: naturalSize ? naturalSize.width : undefined,
            height: naturalSize ? naturalSize.height : undefined,
            transform: `translate3d(${clampedPan.x}px, ${clampedPan.y}px, 0) rotate(${rotation}deg) scale(${displayScale})`,
          }}
          onPointerDown={handleImagePointerDown}
          onPointerMove={handleImagePointerMove}
          onPointerUp={endImageDrag}
          onPointerCancel={endImageDrag}
          onLostPointerCapture={endImageDrag}
          onClick={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <img
            key={openKey}
            src={src}
            alt=""
            draggable={false}
            className={clsx('max-w-none shadow-2xl shadow-black/35 select-none')}
            style={{
              width: naturalSize ? naturalSize.width : undefined,
              height: naturalSize ? naturalSize.height : undefined,
            }}
            onLoad={(event) => {
              const image = event.currentTarget
              setPreviewState((current) => ({
                ...current,
                naturalSize: {
                  width: image.naturalWidth || image.width,
                  height: image.naturalHeight || image.height,
                },
              }))
            }}
          />
        </div>
      </div>

      <div
        className="absolute bottom-6 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full bg-black/35 px-2 py-1.5 text-white shadow-lg ring-1 ring-white/15 backdrop-blur-md"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <ReaderImagePreviewButton label={t('zoom_out')} disabled={!canZoomOut} onClick={zoomOut}>
          <MinusIcon className="size-5" />
        </ReaderImagePreviewButton>
        <div className="min-w-16 px-2 text-center text-sm font-medium tabular-nums">{zoomPercent}</div>
        <ReaderImagePreviewButton label={t('zoom_in')} disabled={!canZoomIn} onClick={zoomIn}>
          <PlusIcon className="size-5" />
        </ReaderImagePreviewButton>
        <div className="mx-1 h-5 w-px bg-white/20" />
        <ReaderImagePreviewButton
          label={t('actual_size')}
          active={isOneToOne && !isFit}
          disabled={isOneToOne && !isFit}
          onClick={() => zoomTo(1)}
        >
          <span className="text-xs font-semibold tracking-normal">1:1</span>
        </ReaderImagePreviewButton>
        <ReaderImagePreviewButton label={t('rotate_left')} onClick={() => rotateImage(-90)}>
          <RotateCcwIcon className="size-[1.125rem]" />
        </ReaderImagePreviewButton>
        <ReaderImagePreviewButton label={t('rotate_right')} onClick={() => rotateImage(90)}>
          <RotateCwIcon className="size-[1.125rem]" />
        </ReaderImagePreviewButton>
        <ReaderImagePreviewButton label={t('fit')} active={isFit} disabled={isFit} onClick={resetToFit}>
          <RefreshCwIcon className="size-[1.125rem]" />
        </ReaderImagePreviewButton>
        <div className="mx-1 h-5 w-px bg-white/20" />
        <ReaderImagePreviewButton label={t('close')} onClick={onClose}>
          <XIcon className="size-5" />
        </ReaderImagePreviewButton>
      </div>
    </div>,
    document.body,
  )
}

interface ReaderImagePreviewButtonProps extends ComponentProps<'button'> {
  active?: boolean
  label: string
}

export function ReaderImagePreviewButton({
  active,
  children,
  className,
  disabled,
  label,
  ...props
}: ReaderImagePreviewButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      className={clsx(
        'flex size-9 items-center justify-center rounded-full border-0 bg-transparent text-white/85 transition-colors outline-none',
        active && 'bg-white/18 text-white',
        disabled
          ? 'cursor-default text-white/35'
          : 'cursor-pointer hover:bg-white/16 hover:text-white focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:ring-offset-0',
        className,
      )}
      {...props}
    >
      {children}
    </button>
  )
}

function clamp(value: number, min: number, max: number) {
  if (max < min) return min
  return Math.min(Math.max(value, min), max)
}

function clampImagePreviewPan(pan: { x: number; y: number }, bounds: { x: number; y: number }) {
  return {
    x: clamp(pan.x, -bounds.x, bounds.x),
    y: clamp(pan.y, -bounds.y, bounds.y),
  }
}

function normalizeImagePreviewRotation(value: number): ReaderImagePreviewRotation {
  const normalized = ((value % 360) + 360) % 360
  if (normalized === 0 || normalized === 90 || normalized === 180 || normalized === 270) {
    return normalized
  }
  return 0
}

function getNextImagePreviewZoomIn(current: number) {
  return IMAGE_PREVIEW_ZOOM_STEPS.find((step) => step > current + 0.001)
}

function getNextImagePreviewZoomOut(current: number) {
  for (let index = IMAGE_PREVIEW_ZOOM_STEPS.length - 1; index >= 0; index--) {
    const step = IMAGE_PREVIEW_ZOOM_STEPS[index]
    if (step !== undefined && step < current - 0.001) return step
  }
}
