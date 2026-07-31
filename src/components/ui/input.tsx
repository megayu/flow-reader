import type * as React from 'react'

import { cn } from '@/utils'

import { type EditableControlProps, useEditableControl } from './editable-control'

type InputProps = Omit<React.ComponentProps<'input'>, 'ref'> &
  EditableControlProps & {
    ref?: React.Ref<HTMLInputElement>
  }

function Input({
  className,
  type,
  autoComplete = 'off',
  autoCorrect = 'off',
  autoCapitalize = 'off',
  spellCheck = false,
  escapeBehavior,
  focusBehavior,
  onBlur,
  onChange,
  onExitEditing,
  onFocus,
  onKeyDown,
  onPointerCancel,
  onPointerDown,
  onPointerUp,
  onValueChange,
  ref: forwardedRef,
  ...props
}: InputProps) {
  const editableControl = useEditableControl<HTMLInputElement>({
    escapeBehavior,
    focusBehavior,
    forwardedRef,
    onBlur,
    onChange,
    onExitEditing,
    onFocus,
    onKeyDown,
    onPointerCancel,
    onPointerDown,
    onPointerUp,
    onValueChange,
  })

  return (
    <input
      ref={editableControl.ref}
      data-flow-editable-control={escapeBehavior === 'none' ? undefined : ''}
      type={type}
      autoComplete={autoComplete}
      autoCorrect={autoCorrect}
      autoCapitalize={autoCapitalize}
      spellCheck={spellCheck}
      data-slot="input"
      className={cn(
        'border-input file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 disabled:bg-input/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 h-8 w-full min-w-0 rounded-lg border bg-transparent px-2.5 py-1 text-base transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-base file:font-medium focus-visible:ring-3 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:ring-3',
        className,
      )}
      onBlur={editableControl.onBlur}
      onChange={editableControl.onChange}
      onFocus={editableControl.onFocus}
      onKeyDown={editableControl.onKeyDown}
      onPointerCancel={editableControl.onPointerCancel}
      onPointerDown={editableControl.onPointerDown}
      onPointerUp={editableControl.onPointerUp}
      {...props}
    />
  )
}

export { Input }
