import { createContext, type Ref, useCallback, useContext, useMemo, useRef } from 'react'

interface OverlayHierarchyValue {
  hasActiveChildLayer: () => boolean
  registerLayer: (node: HTMLElement) => () => void
}

const OverlayHierarchyContext = createContext<OverlayHierarchyValue | null>(null)

function setRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (typeof ref === 'function') {
    ref(value)
    return
  }

  if (ref) ref.current = value
}

function useOverlayHierarchy<T extends HTMLElement>(forwardedRef?: Ref<T>) {
  const parentHierarchy = useContext(OverlayHierarchyContext)
  const childLayersRef = useRef(new Set<HTMLElement>())
  const unregisterParentLayerRef = useRef<(() => void) | undefined>(undefined)

  const hierarchy = useMemo<OverlayHierarchyValue>(
    () => ({
      hasActiveChildLayer: () => childLayersRef.current.size > 0,
      registerLayer: (node) => {
        childLayersRef.current.add(node)
        return () => {
          childLayersRef.current.delete(node)
        }
      },
    }),
    [],
  )

  const ref = useCallback(
    (node: T | null) => {
      unregisterParentLayerRef.current?.()
      unregisterParentLayerRef.current = undefined
      setRef(forwardedRef, node)
      if (node && parentHierarchy) {
        unregisterParentLayerRef.current = parentHierarchy.registerLayer(node)
      }
    },
    [forwardedRef, parentHierarchy],
  )

  return {
    hasActiveChildLayer: hierarchy.hasActiveChildLayer,
    hierarchy,
    ref,
  }
}

export { OverlayHierarchyContext, type OverlayHierarchyValue, useOverlayHierarchy }
