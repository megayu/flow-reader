// https://github.com/juliankrispel/use-text-selection

import { useEffect, useMemo, useState } from 'react'

import { useForceRender } from './useForceRender'

export interface TextSelectionReleasePoint {
  x: number
  y: number
}

interface TextSelectionOptions {
  automatic?: boolean
}

export function hasSelection(
  selection?: Selection | null,
): selection is Selection {
  return !(!selection || selection.isCollapsed)
}

// https://htmldom.dev/get-the-direction-of-the-text-selection/
export function isForwardSelection(selection: Selection) {
  if (selection.anchorNode && selection.focusNode) {
    const range = document.createRange()
    range.setStart(selection.anchorNode, selection.anchorOffset)
    range.setEnd(selection.focusNode, selection.focusOffset)

    return !range.collapsed
  }

  return true
}

export function useTextSelection(
  target?: Window | Window[],
  { automatic = true }: TextSelectionOptions = {},
) {
  const [selection, setSelection] = useState<Selection | undefined>()
  const [releasePoint, setReleasePoint] = useState<
    TextSelectionReleasePoint | undefined
  >()
  const [menuOpen, setMenuOpen] = useState(false)
  const render = useForceRender()
  const windows = useMemo(
    () =>
      (Array.isArray(target) ? target : target ? [target] : []).filter(
        (win): win is Window => !!win,
      ),
    [target],
  )

  useEffect(() => {
    const removeListeners = windows.map((win) => {
      let timeout: ReturnType<typeof setTimeout> | undefined
      const updateSelection = (event: MouseEvent) => {
        const s = win.getSelection()

        if (hasSelection(s)) {
          // sometime `getSelection` will return the same `selection`
          // when select text by clicking empty space
          render()
          setSelection(s)
          setReleasePoint({
            x: event.clientX,
            y: event.clientY,
          })
          setMenuOpen(automatic)
        } else {
          setSelection(undefined)
          setReleasePoint(undefined)
          setMenuOpen(false)
        }
      }
      const openContextMenuSelection = (event: MouseEvent) => {
        const s = win.getSelection()
        if (!hasSelection(s)) return

        event.preventDefault()
        render()
        setSelection(s)
        setReleasePoint({
          x: event.clientX,
          y: event.clientY,
        })
        setMenuOpen(true)
      }

      const clearCollapsedSelection = () => {
        if (timeout) clearTimeout(timeout)
        timeout = setTimeout(() => {
          const s = win.getSelection()
          if (hasSelection(s)) return

          setSelection((selection) => {
            const selectionWindow =
              selection?.anchorNode?.ownerDocument?.defaultView
            return selectionWindow === win ? undefined : selection
          })
          setReleasePoint(undefined)
          setMenuOpen(false)
        }, 80)
      }

      win.addEventListener('mouseup', updateSelection)
      win.addEventListener('contextmenu', openContextMenuSelection)
      win.document.addEventListener('mouseup', updateSelection)
      win.document.addEventListener('contextmenu', openContextMenuSelection)
      win.document.addEventListener('selectionchange', clearCollapsedSelection)

      return () => {
        if (timeout) clearTimeout(timeout)
        win.removeEventListener('mouseup', updateSelection)
        win.removeEventListener('contextmenu', openContextMenuSelection)
        win.document.removeEventListener('mouseup', updateSelection)
        win.document.removeEventListener(
          'contextmenu',
          openContextMenuSelection,
        )
        win.document.removeEventListener(
          'selectionchange',
          clearCollapsedSelection,
        )
      }
    })

    return () => {
      removeListeners.forEach((removeListener) => removeListener())
    }
  }, [automatic, render, windows])

  useEffect(() => {
    if (!selection) {
      setReleasePoint(undefined)
      setMenuOpen(false)
      return
    }

    const selectionWindow = selection.anchorNode?.ownerDocument?.defaultView
    if (
      selectionWindow &&
      windows.includes(selectionWindow) &&
      hasSelection(selection) &&
      selection.anchorNode?.isConnected
    ) {
      return
    }

    setSelection(undefined)
    setReleasePoint(undefined)
    setMenuOpen(false)
  }, [selection, windows])

  return [selection, setSelection, releasePoint, menuOpen] as const
}
