import { createContext, type FC, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'

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

function useSize(
  preferredSize?: number,
  minSize = 0,
  maxSize = Number.POSITIVE_INFINITY,
  initialSize?: number,
  onSizeChange?: (size: number) => void,
) {
  const initial = initialSize ?? preferredSize
  const [size, setSize] = useState(initial === undefined ? undefined : clamp(initial, minSize, maxSize))
  const sizeRef = useRef(size)
  const resize = useCallback(
    (delta: number) => {
      const current = sizeRef.current ?? preferredSize
      if (current === undefined) return

      const next = clamp(current + delta, minSize, maxSize)
      sizeRef.current = next
      setSize(next)
      onSizeChange?.(next)
    },
    [maxSize, minSize, onSizeChange, preferredSize],
  )
  const reset = useCallback(() => {
    sizeRef.current = preferredSize
    setSize(preferredSize)
    if (preferredSize !== undefined) onSizeChange?.(preferredSize)
  }, [onSizeChange, preferredSize])

  return [size, resize, reset] as const
}

export function useSplitViewItem(
  key: FC | string,
  {
    preferredSize,
    minSize = 0,
    maxSize = Number.POSITIVE_INFINITY,
    initialSize,
    onSizeChange,
    visible = true,
    dragMinSize,
  }: {
    dragMinSize?: number
    preferredSize?: number
    minSize?: number
    maxSize?: number
    initialSize?: number
    onSizeChange?: (size: number) => void
    visible?: boolean
  } = {},
) {
  const [size, resizeValue, reset] = useSize(preferredSize, dragMinSize ?? minSize, maxSize, initialSize, onSizeChange)
  const fixed = minSize === maxSize
  const resize = fixed ? undefined : resizeValue
  const stringKey = typeof key === 'string' ? key : key.name
  const view = useMemo(
    () => ({
      fixed,
      dragMinSize,
      key: stringKey,
      maxSize,
      minSize,
      reset,
      resize,
      visible,
    }),
    [dragMinSize, fixed, maxSize, minSize, reset, stringKey, resize, visible],
  )
  useRegisterView(stringKey, view)

  return { size }
}
