import {
  createContext,
  type FC,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

import { clamp } from '@/utils'

export interface SplitViewItem {
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

interface SplitViewContextValue {
  registerView(key: string, view: SplitViewItem): void
}

export const SplitViewContext = createContext<Partial<SplitViewContextValue>>({})
SplitViewContext.displayName = 'SplitViewContext'

function useSplitView() {
  return useContext(SplitViewContext)
}

function useRegisterView(key: string, view: SplitViewItem) {
  const { registerView } = useSplitView()

  useEffect(() => {
    registerView?.(key, view)
  }, [key, registerView, view])
}

function useSize(preferredSize?: number, minSize = 0, maxSize = Number.POSITIVE_INFINITY, storageKey?: string) {
  const [size, setSize] = useState(preferredSize)
  const sizeRef = useRef(size)
  useLayoutEffect(() => {
    if (!storageKey) return
    if (preferredSize === undefined) {
      if (sizeRef.current === undefined) return

      sizeRef.current = undefined
      setSize(undefined)
      return
    }

    const stored = window.localStorage.getItem(storageKey)
    const parsed = stored ? Number(stored) : Number.NaN
    const restoredSize = Number.isFinite(parsed) ? clamp(parsed, minSize, maxSize) : preferredSize
    if (restoredSize === sizeRef.current) return

    sizeRef.current = restoredSize
    setSize(restoredSize)
  }, [maxSize, minSize, preferredSize, storageKey])
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
  key: FC | string,
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
  const [size, resizeValue, reset, commitSize] = useSize(preferredSize, dragMinSize ?? minSize, maxSize, storageKey)
  const fixed = minSize === maxSize
  const resize = fixed ? undefined : resizeValue
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
    [commitSize, dragMinSize, fixed, maxSize, minSize, reset, stringKey, resize, visible],
  )
  useRegisterView(stringKey, view)

  return { size }
}
