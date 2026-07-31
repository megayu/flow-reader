import {
  type ChangeEventHandler,
  type FocusEventHandler,
  type KeyboardEventHandler,
  type PointerEventHandler,
  type Ref,
  useCallback,
  useRef,
} from 'react'

type EditableControlElement = HTMLInputElement | HTMLTextAreaElement

type EditableControlEscapeBehavior = 'exit' | 'none' | 'restore'
type EditableControlFocusBehavior = 'end' | 'native' | 'select-all'

const editableControlSelector = '[data-flow-editable-control]'
const escapeSurfaceSelector = '[data-flow-escape-surface], [data-slot="dialog-content"], [data-slot="popover-content"]'

interface EditableControlProps {
  escapeBehavior?: EditableControlEscapeBehavior
  focusBehavior?: EditableControlFocusBehavior
  onExitEditing?: () => void
  onValueChange?: (value: string) => void
}

interface EditableControlOptions<T extends EditableControlElement> extends EditableControlProps {
  forwardedRef?: Ref<T>
  onBlur?: FocusEventHandler<T>
  onChange?: ChangeEventHandler<T>
  onFocus?: FocusEventHandler<T>
  onKeyDown?: KeyboardEventHandler<T>
  onPointerCancel?: PointerEventHandler<T>
  onPointerDown?: PointerEventHandler<T>
  onPointerUp?: PointerEventHandler<T>
}

function setRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (typeof ref === 'function') {
    ref(value)
    return
  }

  if (ref) ref.current = value
}

function placeSelection(element: EditableControlElement, behavior: EditableControlFocusBehavior) {
  if (behavior === 'native') return

  try {
    if (behavior === 'select-all') {
      element.select()
      return
    }

    const end = element.value.length
    element.setSelectionRange(end, end)
    if (element instanceof HTMLTextAreaElement) element.scrollTop = element.scrollHeight
  } catch {
    // Some platform input types, including number inputs, do not expose a text selection range.
  }
}

function hasExplicitSelection(element: EditableControlElement) {
  try {
    return (
      element.selectionStart !== null &&
      element.selectionEnd !== null &&
      element.selectionStart !== element.selectionEnd
    )
  } catch {
    return false
  }
}

function isEditableControlEscapeTarget(target: EventTarget | null) {
  return target instanceof Element && target.closest(editableControlSelector) !== null
}

function exitEditableControl(element: EditableControlElement, previousTarget: HTMLElement | null) {
  const escapeSurface = element.closest<HTMLElement>(escapeSurfaceSelector)
  const canReturnToPreviousTarget =
    previousTarget?.isConnected === true && !isEditableControlEscapeTarget(previousTarget)

  if (canReturnToPreviousTarget && (!escapeSurface || escapeSurface.contains(previousTarget))) {
    previousTarget.focus()
    return
  }

  if (escapeSurface) {
    escapeSurface.focus()
    return
  }

  if (canReturnToPreviousTarget) {
    previousTarget.focus()
    return
  }

  element.blur()
}

function useEditableControl<T extends EditableControlElement>({
  escapeBehavior = 'restore',
  focusBehavior = 'end',
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
}: EditableControlOptions<T>) {
  const editStartValueRef = useRef<string | undefined>(undefined)
  const exitFocusTargetRef = useRef<HTMLElement | null>(null)
  const pointerDownRef = useRef(false)

  const ref = useCallback(
    (element: T | null) => {
      setRef(forwardedRef, element)
    },
    [forwardedRef],
  )

  const handlePointerDown: PointerEventHandler<T> = useCallback(
    (event) => {
      pointerDownRef.current = true
      onPointerDown?.(event)
    },
    [onPointerDown],
  )

  const handlePointerUp: PointerEventHandler<T> = useCallback(
    (event) => {
      pointerDownRef.current = false
      onPointerUp?.(event)
    },
    [onPointerUp],
  )

  const handlePointerCancel: PointerEventHandler<T> = useCallback(
    (event) => {
      pointerDownRef.current = false
      onPointerCancel?.(event)
    },
    [onPointerCancel],
  )

  const handleFocus: FocusEventHandler<T> = useCallback(
    (event) => {
      editStartValueRef.current = event.currentTarget.value
      exitFocusTargetRef.current =
        event.relatedTarget instanceof HTMLElement && event.relatedTarget !== document.body ? event.relatedTarget : null
      if (!pointerDownRef.current && !hasExplicitSelection(event.currentTarget)) {
        placeSelection(event.currentTarget, focusBehavior)
      }
      onFocus?.(event)
    },
    [focusBehavior, onFocus],
  )

  const handleBlur: FocusEventHandler<T> = useCallback(
    (event) => {
      pointerDownRef.current = false
      editStartValueRef.current = undefined
      onBlur?.(event)
    },
    [onBlur],
  )

  const handleChange: ChangeEventHandler<T> = useCallback(
    (event) => {
      onChange?.(event)
      onValueChange?.(event.currentTarget.value)
    },
    [onChange, onValueChange],
  )

  const handleKeyDown: KeyboardEventHandler<T> = useCallback(
    (event) => {
      if (
        event.key !== 'Escape' ||
        event.nativeEvent.isComposing ||
        escapeBehavior === 'none' ||
        editStartValueRef.current === undefined
      ) {
        onKeyDown?.(event)
        return
      }

      event.preventDefault()
      event.stopPropagation()

      if (escapeBehavior === 'exit') {
        if (onExitEditing) {
          onExitEditing()
        } else {
          exitEditableControl(event.currentTarget, exitFocusTargetRef.current)
        }
        return
      }

      const editStartValue = editStartValueRef.current
      if (event.currentTarget.value === editStartValue) {
        if (onExitEditing) {
          onExitEditing()
          return
        }

        exitEditableControl(event.currentTarget, exitFocusTargetRef.current)
        return
      }

      event.currentTarget.value = editStartValue
      onValueChange?.(editStartValue)
      placeSelection(event.currentTarget, focusBehavior)
    },
    [escapeBehavior, focusBehavior, onExitEditing, onKeyDown, onValueChange],
  )

  return {
    onBlur: handleBlur,
    onChange: handleChange,
    onFocus: handleFocus,
    onKeyDown: handleKeyDown,
    onPointerCancel: handlePointerCancel,
    onPointerDown: handlePointerDown,
    onPointerUp: handlePointerUp,
    ref,
  }
}

export {
  type EditableControlEscapeBehavior,
  type EditableControlFocusBehavior,
  type EditableControlProps,
  isEditableControlEscapeTarget,
  useEditableControl,
}
