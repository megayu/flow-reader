import type { ComponentProps, ReactNode, Ref } from 'react'

import { OverlayHierarchyContext, type OverlayHierarchyValue, useOverlayHierarchy } from './overlayHierarchyContext'

function OverlayHierarchyProvider({ children, value }: { children: ReactNode; value: OverlayHierarchyValue }) {
  return <OverlayHierarchyContext.Provider value={value}>{children}</OverlayHierarchyContext.Provider>
}

function OverlayLayer({
  children,
  ref: forwardedRef,
  tabIndex = -1,
  ...props
}: ComponentProps<'div'> & {
  ref?: Ref<HTMLDivElement>
}) {
  const overlayHierarchy = useOverlayHierarchy(forwardedRef)

  return (
    <OverlayHierarchyProvider value={overlayHierarchy.hierarchy}>
      <div ref={overlayHierarchy.ref} data-flow-overlay-layer data-flow-escape-surface tabIndex={tabIndex} {...props}>
        {children}
      </div>
    </OverlayHierarchyProvider>
  )
}

export { OverlayHierarchyProvider, OverlayLayer }
