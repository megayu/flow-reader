'use client'

import { ContextMenu as ContextMenuPrimitive, DropdownMenu as DropdownMenuPrimitive } from 'radix-ui'
import type * as React from 'react'

import { cn } from '@/utils'

import { OverlayHierarchyProvider } from './overlay-hierarchy'
import { useOverlayHierarchy } from './overlayHierarchyContext'

const menuContentClassName =
  'ring-border bg-popover text-popover-foreground rounded-lg p-1 shadow-lg ring-1 outline-none'
const menuItemClassName =
  'flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-base outline-none select-none data-disabled:pointer-events-none data-disabled:opacity-50'

const ContextMenu = ContextMenuPrimitive.Root
const ContextMenuTrigger = ContextMenuPrimitive.Trigger

function ContextMenuContent({
  className,
  loop = true,
  children,
  ref: forwardedRef,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Content>) {
  const overlayHierarchy = useOverlayHierarchy(forwardedRef)

  return (
    <ContextMenuPrimitive.Portal>
      <OverlayHierarchyProvider value={overlayHierarchy.hierarchy}>
        <ContextMenuPrimitive.Content
          ref={overlayHierarchy.ref}
          loop={loop}
          className={cn(menuContentClassName, 'z-70 w-40', className)}
          {...props}
        >
          {children}
        </ContextMenuPrimitive.Content>
      </OverlayHierarchyProvider>
    </ContextMenuPrimitive.Portal>
  )
}

function ContextMenuItem({
  className,
  variant = 'default',
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Item> & {
  variant?: 'default' | 'destructive'
}) {
  return (
    <ContextMenuPrimitive.Item
      className={cn(
        menuItemClassName,
        'focus:bg-muted',
        variant === 'destructive' ? 'text-destructive' : 'text-muted-foreground',
        className,
      )}
      {...props}
    />
  )
}

function ContextMenuSeparator({ className, ...props }: React.ComponentProps<typeof ContextMenuPrimitive.Separator>) {
  return <ContextMenuPrimitive.Separator className={cn('bg-muted my-1 h-px', className)} {...props} />
}

const DropdownMenu = DropdownMenuPrimitive.Root
const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger

function DropdownMenuItem({ className, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Item>) {
  return (
    <DropdownMenuPrimitive.Item
      className={cn(
        menuItemClassName,
        'text-muted-foreground focus:bg-(--flow-bg-control-hover) focus:text-(--flow-text) font-medium transition-colors',
        className,
      )}
      {...props}
    />
  )
}

function DropdownMenuContent({
  className,
  loop = true,
  children,
  ref: forwardedRef,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Content>) {
  const overlayHierarchy = useOverlayHierarchy(forwardedRef)

  return (
    <DropdownMenuPrimitive.Portal>
      <OverlayHierarchyProvider value={overlayHierarchy.hierarchy}>
        <DropdownMenuPrimitive.Content
          ref={overlayHierarchy.ref}
          loop={loop}
          className={cn(
            menuContentClassName,
            'data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 z-50 origin-(--radix-dropdown-menu-content-transform-origin) duration-100',
            className,
          )}
          {...props}
        >
          {children}
        </DropdownMenuPrimitive.Content>
      </OverlayHierarchyProvider>
    </DropdownMenuPrimitive.Portal>
  )
}

const DropdownMenuRadioGroup = DropdownMenuPrimitive.RadioGroup

function DropdownMenuRadioItem({ className, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.RadioItem>) {
  return (
    <DropdownMenuPrimitive.RadioItem
      className={cn(
        menuItemClassName,
        'text-muted-foreground focus:bg-(--flow-bg-control-hover) focus:text-(--flow-text) font-medium transition-colors',
        className,
      )}
      {...props}
    />
  )
}

const DropdownMenuItemIndicator = DropdownMenuPrimitive.ItemIndicator

export {
  // biome-ignore lint/style/useComponentExportOnlyModules: This Radix primitive alias is a React component.
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  // biome-ignore lint/style/useComponentExportOnlyModules: This Radix primitive alias is a React component.
  ContextMenuTrigger,
  // biome-ignore lint/style/useComponentExportOnlyModules: This Radix primitive alias is a React component.
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  // biome-ignore lint/style/useComponentExportOnlyModules: This Radix primitive alias is a React component.
  DropdownMenuItemIndicator,
  // biome-ignore lint/style/useComponentExportOnlyModules: This Radix primitive alias is a React component.
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  // biome-ignore lint/style/useComponentExportOnlyModules: This Radix primitive alias is a React component.
  DropdownMenuTrigger,
}
