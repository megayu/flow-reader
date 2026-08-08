import clsx from 'clsx'
import { PinIcon } from 'lucide-react'
import { type ComponentProps, useCallback, useLayoutEffect, useRef } from 'react'

import { Button as UiButton } from '../components/ui/button'

export const libraryFilterOptionsClassName = 'flex min-w-0 flex-wrap gap-1'
export const libraryFilterChipClassName = 'h-7 max-w-full min-w-0 gap-1 px-1.5 text-sm leading-tight'
export const libraryFilterInactiveChipClassName =
  'bg-transparent text-(--flow-text) ring-1 ring-(--flow-sidebar-item-border) ring-inset hover:bg-(--flow-sidebar-item-bg-hover)'
const libraryFilterPartialChipClassName =
  'bg-(--flow-sidebar-item-bg-hover) text-(--flow-text) ring-1 ring-(--flow-accent)/60 ring-inset hover:bg-(--flow-sidebar-item-bg-hover)'

type LibraryFilterChipState = 'active' | 'inactive' | 'partial'

interface LibraryFilterChipButtonProps extends Omit<ComponentProps<typeof UiButton>, 'children' | 'size' | 'variant'> {
  label: string
  labelTestId?: string
  pinned?: boolean
  state: LibraryFilterChipState
}

export function LibraryFilterChipButton({
  'aria-label': ariaLabel,
  className,
  label,
  labelTestId,
  onPointerEnter,
  pinned = false,
  state,
  type = 'button',
  ...props
}: LibraryFilterChipButtonProps) {
  const labelRef = useRef<HTMLSpanElement>(null)
  const active = state === 'active'

  const updateOverflowTitle = useCallback(
    (button: HTMLButtonElement) => {
      const labelElement = labelRef.current
      if (!labelElement) return

      button.title = labelElement.scrollWidth > labelElement.clientWidth ? label : ''
    },
    [label],
  )

  useLayoutEffect(() => {
    const labelElement = labelRef.current
    const button = labelElement?.closest('button')
    if (button instanceof HTMLButtonElement) updateOverflowTitle(button)
  }, [updateOverflowTitle])

  return (
    <UiButton
      {...props}
      type={type}
      size="sm"
      variant={active ? 'default' : 'secondary'}
      aria-label={ariaLabel ?? label}
      className={clsx(
        libraryFilterChipClassName,
        'justify-start',
        state === 'inactive' && libraryFilterInactiveChipClassName,
        state === 'partial' && libraryFilterPartialChipClassName,
        className,
      )}
      onPointerEnter={(event) => {
        updateOverflowTitle(event.currentTarget)
        onPointerEnter?.(event)
      }}
    >
      {pinned && (
        <PinIcon
          aria-hidden
          className={clsx('size-3.5', active ? 'text-primary-foreground' : 'text-muted-foreground')}
        />
      )}
      <span ref={labelRef} className="min-w-0 truncate leading-tight" data-testid={labelTestId}>
        {label}
      </span>
    </UiButton>
  )
}
