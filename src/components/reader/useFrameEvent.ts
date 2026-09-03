import { useLayoutEffect, useRef } from 'react'

export const CAPTURE_EVENT_OPTIONS = { capture: true } as const

export function useFrameEvent<K extends keyof WindowEventMap>(
  frames: readonly Window[],
  type: K,
  listener: (event: WindowEventMap[K]) => void,
  options?: AddEventListenerOptions,
) {
  const listenerRef = useRef(listener)

  useLayoutEffect(() => {
    listenerRef.current = listener
  }, [listener])

  useLayoutEffect(() => {
    if (!frames.length) return

    const handler = (event: WindowEventMap[K]) => {
      listenerRef.current(event)
    }

    frames.forEach((frame) => {
      frame.addEventListener(type, handler, options)
    })

    return () => {
      frames.forEach((frame) => {
        frame.removeEventListener(type, handler, options)
      })
    }
  }, [frames, options, type])
}
