import { useEffect, useRef } from 'react'

import { IS_SERVER } from '@/env'

export function useEventListener<K extends keyof WindowEventMap>(
  type: K,
  listener: (event: WindowEventMap[K]) => void,
  options?: boolean | AddEventListenerOptions,
) {
  const listenerRef = useRef(listener)

  useEffect(() => {
    listenerRef.current = listener
  }, [listener])

  useEffect(() => {
    if (IS_SERVER) return

    const handler = (event: WindowEventMap[K]) => {
      listenerRef.current(event)
    }

    window.addEventListener(type, handler, options)

    return () => {
      window.removeEventListener(type, handler, options)
    }
  }, [options, type])
}
