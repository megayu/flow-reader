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
  useState,
} from 'react'

import { clamp } from '@flow/reader/utils'

import { Overlay } from './Overlay'

interface ISplitViewItem {
  fixed?: boolean
  key: string
  reset?: () => void
  visible?: boolean
  resize?: (size: number) => void
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
      setSize((size) => {
        const current = size ?? preferredSize
        if (current === undefined) return size

        const next = clamp(current + delta, minSize, maxSize)
        persistSize(next)
        return next
      })
    },
    [maxSize, minSize, persistSize, preferredSize],
  )
  const reset = useCallback(() => {
    persistSize(undefined)
    setSize(preferredSize)
  }, [persistSize, preferredSize])

  return [size, resize, reset] as const
}

export function useSplitViewItem(
  key: React.FC | string,
  {
    preferredSize,
    minSize = 0,
    maxSize = Number.POSITIVE_INFINITY,
    storageKey,
    visible = true,
  }: {
    preferredSize?: number
    minSize?: number
    maxSize?: number
    storageKey?: string
    visible?: boolean
  } = {},
) {
  const [size, _resize, reset] = useSize(
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
      fixed,
      key: stringKey,
      reset,
      resize,
      visible,
    }),
    [fixed, reset, stringKey, resize, visible],
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
      map.set(key, view)
      return new Map(map)
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

        function handleMouseMove(e: MouseEvent) {
          const delta = vertical ? e.movementY : e.movementX
          views.forEach((v, i) => {
            v?.resize?.(delta * (-1) ** i)
          })
        }

        window.addEventListener('mousemove', handleMouseMove)
        window.addEventListener('mouseup', function handleMouseUp() {
          // `mouseleave` not fire when `mousedown`
          setHover(false)
          setActive(false)
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
