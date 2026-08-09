import { type LucideIcon, XIcon } from 'lucide-react'
import type { ComponentProps, RefObject } from 'react'

import { Button as UiButton } from '../components/ui/button'
import { InputGroup, InputGroupActions, InputGroupInput } from '../components/ui/input-group'

interface LibraryFilterInputProps extends Omit<ComponentProps<typeof InputGroupInput>, 'className' | 'ref'> {
  clearLabel?: string
  Icon: LucideIcon
  inputRef?: RefObject<HTMLInputElement | null>
  onClear?: () => void
}

export function LibraryFilterInput({ clearLabel, Icon, inputRef, onClear, ...props }: LibraryFilterInputProps) {
  return (
    <InputGroup className="h-7 min-w-0 flex-1 gap-1 rounded-md bg-transparent px-1.5 focus-within:ring-0 dark:bg-transparent">
      <Icon aria-hidden className="text-muted-foreground size-3.5 shrink-0" />
      <InputGroupInput
        ref={inputRef}
        {...props}
        className="h-6 min-w-0 flex-1 border-0 bg-transparent px-1 py-0 text-sm transition-none focus-visible:border-transparent focus-visible:ring-0 dark:bg-transparent"
      />
      {onClear && (
        <InputGroupActions className="-mr-1 pr-0">
          <UiButton
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={clearLabel}
            className="text-muted-foreground hover:text-foreground size-6 shrink-0 rounded-sm"
            onPointerDown={(event) => {
              if (event.button === 0) event.preventDefault()
            }}
            onClick={onClear}
          >
            <XIcon aria-hidden className="size-4.5" />
          </UiButton>
        </InputGroupActions>
      )}
    </InputGroup>
  )
}
