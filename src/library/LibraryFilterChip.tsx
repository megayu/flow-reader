import { type LucideIcon, PinIcon, PinOffIcon } from 'lucide-react'
import { memo } from 'react'

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '../components/ui/menu'

import { LibraryFilterChipButton } from './LibraryFilterChipButton'

export interface LibraryFilterMenuItem {
  danger?: boolean
  Icon: LucideIcon
  label: string
  onClick: (value: string) => void
}

const EMPTY_MENU_ITEMS: LibraryFilterMenuItem[] = []

interface LibraryFilterChipProps {
  active: boolean
  contextMenuTestId?: string
  label: string
  labelTestId?: string
  menuItems?: LibraryFilterMenuItem[]
  onPin: (value: string) => void
  onToggle: (value: string) => void
  onUnpin: (value: string) => void
  pinLabel: string
  pinned: boolean
  preserveInputFocus?: boolean
  testId?: string
  unpinLabel: string
  value: string
}

export const LibraryFilterChip = memo(function LibraryFilterChip({
  active,
  contextMenuTestId,
  label,
  labelTestId,
  menuItems = EMPTY_MENU_ITEMS,
  onPin,
  onToggle,
  onUnpin,
  pinLabel,
  pinned,
  preserveInputFocus = false,
  testId,
  unpinLabel,
  value,
}: LibraryFilterChipProps) {
  return (
    <div className="relative max-w-full min-w-0">
      <ContextMenu modal={false}>
        <ContextMenuTrigger asChild>
          <LibraryFilterChipButton
            state={active ? 'active' : 'inactive'}
            label={label}
            labelTestId={labelTestId}
            pinned={pinned}
            aria-pressed={active}
            data-testid={testId}
            data-value={value}
            onPointerDown={(event) => {
              if (preserveInputFocus && event.button === 0) event.preventDefault()
            }}
            onClick={() => onToggle(value)}
          />
        </ContextMenuTrigger>
        <ContextMenuContent className="w-max" data-testid={contextMenuTestId}>
          <ContextMenuItem onSelect={() => onPin(value)}>
            <PinIcon aria-hidden className="size-4 shrink-0" />
            <span className="min-w-0 truncate">{pinLabel}</span>
          </ContextMenuItem>
          {pinned && (
            <ContextMenuItem onSelect={() => onUnpin(value)}>
              <PinOffIcon aria-hidden className="size-4 shrink-0" />
              <span className="min-w-0 truncate">{unpinLabel}</span>
            </ContextMenuItem>
          )}
          {menuItems.length > 0 && <ContextMenuSeparator />}
          {menuItems.map((item) => (
            <ContextMenuItem
              key={item.label}
              variant={item.danger ? 'destructive' : 'default'}
              onSelect={() => item.onClick(value)}
            >
              <item.Icon aria-hidden className="size-4 shrink-0" />
              <span className="min-w-0 truncate">{item.label}</span>
            </ContextMenuItem>
          ))}
        </ContextMenuContent>
      </ContextMenu>
    </div>
  )
})
