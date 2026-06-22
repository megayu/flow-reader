// https://github.com/juliankrispel/use-text-selection

import { useEffect, useMemo, useState } from 'react'

import { isTouchScreen } from '../platform'

import { useForceRender } from './useForceRender'

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

export function useTextSelection(target?: Window | Window[]) {
  const [selection, setSelection] = useState<Selection | undefined>()
  const render = useForceRender()
  const windows = useMemo(
    () =>
      (Array.isArray(target) ? target : target ? [target] : []).filter(
        (win): win is Window => !!win,
      ),
    [target],
  )

  // On touch screen device, mouse/touch/pointer events not working when selection is created.
  useEffect(() => {
    const event = isTouchScreen ? 'selectionchange' : 'mouseup'

    const removeListeners = windows.map((win) => {
      const target = isTouchScreen ? win.document : win
      const updateSelection = () => {
        const s = win.getSelection()

        if (hasSelection(s)) {
          // sometime `getSelection` will return the same `selection`
          // when select text by clicking empty space
          render()
          setSelection(s)
        }
      }

      target.addEventListener(event, updateSelection)

      return () => target.removeEventListener(event, updateSelection)
    })

    return () => {
      removeListeners.forEach((removeListener) => removeListener())
    }
  }, [render, windows])

  // https://stackoverflow.com/questions/3413683/disabling-the-context-menu-on-long-taps-on-android
  useEffect(() => {
    if (!isTouchScreen) return

    const removeListeners = windows.map((win) => {
      const preventContextMenu = (e: Event) => {
        e.preventDefault()
      }

      win.addEventListener('contextmenu', preventContextMenu)

      return () => win.removeEventListener('contextmenu', preventContextMenu)
    })

    return () => {
      removeListeners.forEach((removeListener) => removeListener())
    }
  }, [windows])

  useEffect(() => {
    if (!selection) return
    const selectionWindow = selection.anchorNode?.ownerDocument?.defaultView
    if (!selectionWindow || windows.includes(selectionWindow)) return

    setSelection(undefined)
  }, [selection, windows])

  return [selection, setSelection] as const
}
