import clsx from 'clsx'
import {
  Children,
  ComponentProps,
  Fragment,
  createContext,
  useCallback,
  useContext,
  useEffect,
  isValidElement,
  useMemo,
  useRef,
  useState,
} from 'react'

import { clamp } from '@flow/reader/utils'

import { Overlay } from './Overlay'

interface ISplitViewItem {
  dragMinSize?: number
  fixed?: boolean
  key: string
  maxSize?: number
  minSize?: number
  reset?: () => void
  visible?: boolean
  resize?: (size: number) => void
  commitSize?: () => void
}
interface SplitViewContext {
  registerView(key: string, view: ISplitViewItem): void
}
const SplitViewContext = createContext<Partial<SplitViewContext>>({})
SplitViewContext.displayName = 'SplitViewContext'

function flattenSplitViewChildren(
  children: React.ReactNode,
): React.ReactNode[] {
  return Children.toArray(children).flatMap((child) => {
    if (
      !isValidElement<{ children?: React.ReactNode }>(child) ||
      child.type !== Fragment
    ) {
      return [child]
    }

    return flattenSplitViewChildren(child.props.children)
  })
}

function useSplitView() {
  return useContext(SplitViewContext)
}

function useRegisterView(key: string, view: ISplitViewItem) {
  const { registerView } = useSplitView()

  useEffect(() => {
    registerView?.(key, view)
  }, [key, registerView, view])
}

function useSize(
  preferredSize?: number,
  minSize = 0,
  maxSize = Number.POSITIVE_INFINITY,
  storageKey?: string,
) {
  const [size, setSize] = useState(() => {
    if (!storageKey || typeof window === 'undefined') return preferredSize

    const stored = window.localStorage.getItem(storageKey)
    const parsed = stored ? Number(stored) : Number.NaN
    return Number.isFinite(parsed)
      ? clamp(parsed, minSize, maxSize)
      : preferredSize
  })
  const sizeRef = useRef(size)
  const persistSize = useCallback(
    (size: number | undefined) => {
      if (!storageKey || typeof window === 'undefined') return

      if (size === undefined) {
        window.localStorage.removeItem(storageKey)
      } else {
        window.localStorage.setItem(storageKey, String(size))
      }
    },
    [storageKey],
  )
  const resize = useCallback(
    (delta: number) => {
      const current = sizeRef.current ?? preferredSize
      if (current === undefined) return

      const next = clamp(current + delta, minSize, maxSize)
      sizeRef.current = next
      setSize(next)
    },
    [maxSize, minSize, preferredSize],
  )
  const commitSize = useCallback(() => {
    persistSize(sizeRef.current)
  }, [persistSize])
  const reset = useCallback(() => {
    persistSize(undefined)
    sizeRef.current = preferredSize
    setSize(preferredSize)
  }, [persistSize, preferredSize])

  return [size, resize, reset, commitSize] as const
}

export function useSplitViewItem(
  key: React.FC | string,
  {
    preferredSize,
    minSize = 0,
    maxSize = Number.POSITIVE_INFINITY,
    storageKey,
    visible = true,
    dragMinSize,
  }: {
    dragMinSize?: number
    preferredSize?: number
    minSize?: number
    maxSize?: number
    storageKey?: string
    visible?: boolean
  } = {},
) {
  const [size, _resize, reset, commitSize] = useSize(
    preferredSize,
    minSize,
    maxSize,
    storageKey,
  )
  const fixed = minSize === maxSize
  const resize = fixed ? undefined : _resize
  const stringKey = typeof key === 'string' ? key : key.name
  const view = useMemo(
    () => ({
      commitSize,
      fixed,
      dragMinSize,
      key: stringKey,
      maxSize,
      minSize,
      reset,
      resize,
      visible,
    }),
    [
      commitSize,
      dragMinSize,
      fixed,
      maxSize,
      minSize,
      reset,
      stringKey,
      resize,
      visible,
    ],
  )
  useRegisterView(stringKey, view)

  return { size }
}

interface SplitViewProps extends ComponentProps<'div'> {
  vertical?: boolean
}

export const SplitView = ({
  children,
  className,
  vertical = false,
}: SplitViewProps) => {
  const [viewMap, setViewMap] = useState(new Map<string, ISplitViewItem>())
  const views = [...viewMap.values()]

  const registerView = useCallback((key: string, view: ISplitViewItem) => {
    setViewMap((map) => {
      const next = new Map(map)
      next.set(key, view)
      return next
    })
  }, [])
  const contextValue = useMemo(() => ({ registerView }), [registerView])

  const childList = flattenSplitViewChildren(children)
  if (!childList.length) return null

  return (
    <div className={clsx('SplitView relative h-full min-h-0', className)}>
      <SplitViewContext.Provider value={contextValue}>
        <div
          className={clsx(
            'SplitViewContainer flex h-full min-h-0',
            vertical && 'flex-col',
          )}
        >
          {childList.reduce((a, c, i) => (
            <>
              {a}
              <Sash vertical={vertical} views={[views[i - 1], views[i]]} />
              {c}
            </>
          ))}
        </div>
      </SplitViewContext.Provider>
    </div>
  )
}

const SASH_SIZE = 6
const SASH_LINE_SIZE = 1
const SASH_HIGHLIGHT_LINE_SIZE = 2
interface SashProps {
  vertical: boolean
  views: (ISplitViewItem | undefined)[]
}
const Sash: React.FC<SashProps> = ({ vertical, views }) => {
  const [hover, setHover] = useState(false)
  const [active, setActive] = useState(false)
  const highlighted = hover || active

  const visible = views.every((v) => v?.visible)
  const fixed = views.some((v) => v?.fixed)
  const enabled = visible && !fixed && views.some((v) => v?.resize)

  return (
    <div
      className={clsx(
        'sash relative z-30 shrink-0',
        !enabled && 'pointer-events-none',
        vertical ? 'cursor-ns-resize' : 'cursor-ew-resize',
      )}
      style={{
        [vertical ? 'height' : 'width']: SASH_SIZE,
        [vertical ? 'marginBlock' : 'marginInline']: -SASH_SIZE / 2,
      }}
      onMouseEnter={() => {
        setHover(true)
      }}
      onMouseLeave={() => {
        setHover(false)
      }}
      onDoubleClick={(event) => {
        event.preventDefault()
        views.forEach((v) => v?.reset?.())
      }}
      onMouseDown={(event) => {
        event.preventDefault()
        setActive(true)
        const sash = event.currentTarget
        const startPosition = vertical ? event.clientY : event.clientX
        const bounds = resizeDeltaBounds(vertical, views, sash)
        let appliedDelta = 0

        function handleMouseMove(e: MouseEvent) {
          const position = vertical ? e.clientY : e.clientX
          const delta =
            clamp(
              position - startPosition,
              bounds?.min ?? Number.NEGATIVE_INFINITY,
              bounds?.max ?? Number.POSITIVE_INFINITY,
            ) - appliedDelta
          if (!delta) return

          appliedDelta += delta

          views.forEach((v, i) => {
            v?.resize?.(delta * (-1) ** i)
          })
        }

        window.addEventListener('mousemove', handleMouseMove)
        window.addEventListener('mouseup', function handleMouseUp() {
          // `mouseleave` not fire when `mousedown`
          setHover(false)
          setActive(false)
          views.forEach((view) => view?.commitSize?.())
          window.removeEventListener('mousemove', handleMouseMove)
          window.removeEventListener('mouseup', handleMouseUp)
        })
      }}
    >
      <div
        className={clsx(
          'pointer-events-none absolute inset-0 transition-[background-color,opacity]',
          vertical ? 'top-1/2 -translate-y-1/2' : 'left-1/2 -translate-x-1/2',
          highlighted
            ? 'bg-[var(--flow-accent)]'
            : 'bg-[var(--flow-border-strong)]',
          highlighted && (active ? 'opacity-90' : 'opacity-65'),
        )}
        style={{
          [vertical ? 'height' : 'width']: highlighted
            ? SASH_HIGHLIGHT_LINE_SIZE
            : SASH_LINE_SIZE,
        }}
      ></div>
      {active && <Overlay className="!bg-transparent" />}
    </div>
  )
}

function resizeDeltaBounds(
  vertical: boolean,
  views: (ISplitViewItem | undefined)[],
  sash: HTMLElement,
) {
  const [previousView, nextView] = views
  const previousElement = sash.previousElementSibling
  const nextElement = sash.nextElementSibling
  if (!previousElement || !nextElement) return undefined

  const previousSize = elementSplitSize(previousElement, vertical)
  const nextSize = elementSplitSize(nextElement, vertical)

  return {
    min: Math.max(
      dragMinSize(previousView) - previousSize,
      nextSize - (nextView?.maxSize ?? Number.POSITIVE_INFINITY),
    ),
    max: Math.min(
      (previousView?.maxSize ?? Number.POSITIVE_INFINITY) - previousSize,
      nextSize - dragMinSize(nextView),
    ),
  }
}

function elementSplitSize(element: Element, vertical: boolean) {
  const rect = element.getBoundingClientRect()
  return vertical ? rect.height : rect.width
}

function dragMinSize(view?: ISplitViewItem) {
  return view?.dragMinSize ?? view?.minSize ?? 0
}
