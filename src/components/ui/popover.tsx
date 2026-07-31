'use client'

import { Popover as PopoverPrimitive } from 'radix-ui'
import type * as React from 'react'

import { cn } from '@/utils'

import { isEditableControlEscapeTarget } from './editable-control'
import { OverlayHierarchyProvider } from './overlay-hierarchy'
import { useOverlayHierarchy } from './overlayHierarchyContext'

function Popover({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />
}

function PopoverAnchor({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Anchor>) {
  return <PopoverPrimitive.Anchor data-slot="popover-anchor" {...props} />
}

function PopoverTrigger({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />
}

function PopoverContent({
  className,
  align = 'center',
  sideOffset = 4,
  variant = 'default',
  onEscapeKeyDown,
  onInteractOutside,
  ref: forwardedRef,
  children,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content> & {
  variant?: 'bare' | 'default'
}) {
  const overlayHierarchy = useOverlayHierarchy(forwardedRef)

  return (
    <PopoverPrimitive.Portal>
      <OverlayHierarchyProvider value={overlayHierarchy.hierarchy}>
        <PopoverPrimitive.Content
          ref={overlayHierarchy.ref}
          data-slot="popover-content"
          data-variant={variant}
          align={align}
          sideOffset={sideOffset}
          className={cn(
            'z-50 flex origin-(--radix-popover-content-transform-origin) flex-col text-base outline-hidden',
            variant === 'default'
              ? 'bg-popover text-popover-foreground ring-foreground/10 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 w-72 gap-2.5 rounded-lg p-2.5 shadow-md ring-1 duration-100'
              : 'w-auto gap-0 bg-transparent p-0 shadow-none ring-0',
            className,
          )}
          onEscapeKeyDown={(event) => {
            onEscapeKeyDown?.(event)
            if (overlayHierarchy.hasActiveChildLayer() || isEditableControlEscapeTarget(event.target)) {
              event.preventDefault()
            }
          }}
          onInteractOutside={(event) => {
            onInteractOutside?.(event)
            if (overlayHierarchy.hasActiveChildLayer()) event.preventDefault()
          }}
          {...props}
        >
          {children}
        </PopoverPrimitive.Content>
      </OverlayHierarchyProvider>
    </PopoverPrimitive.Portal>
  )
}

function PopoverHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="popover-header" className={cn('flex flex-col gap-0.5 text-base', className)} {...props} />
}

function PopoverTitle({ className, ...props }: React.ComponentProps<'h2'>) {
  return <div data-slot="popover-title" className={cn('font-medium', className)} {...props} />
}

function PopoverDescription({ className, ...props }: React.ComponentProps<'p'>) {
  return <p data-slot="popover-description" className={cn('text-muted-foreground', className)} {...props} />
}

export { Popover, PopoverAnchor, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger }
