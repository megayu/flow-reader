import type * as React from 'react'

import { cn } from '@/utils'

import { type EditableControlProps, useEditableControl } from './editable-control'

type TextareaProps = Omit<React.ComponentProps<'textarea'>, 'ref'> &
  EditableControlProps & {
    ref?: React.Ref<HTMLTextAreaElement>
  }

function Textarea({
  className,
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
}: TextareaProps) {
  const editableControl = useEditableControl<HTMLTextAreaElement>({
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
    <textarea
      ref={editableControl.ref}
      data-flow-editable-control={escapeBehavior === 'none' ? undefined : ''}
      data-slot="textarea"
      autoComplete={autoComplete}
      autoCorrect={autoCorrect}
      autoCapitalize={autoCapitalize}
      spellCheck={spellCheck}
      className={cn(
        'border-input placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 disabled:bg-input/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 flex field-sizing-content min-h-16 w-full rounded-lg border bg-transparent px-2.5 py-2 text-base transition-colors outline-none focus-visible:ring-3 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:ring-3',
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

export { Textarea }
