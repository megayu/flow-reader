import { useEffect } from 'react'

import { IS_SERVER } from '@flow/reader/env'

export function useEventListener<K extends keyof WindowEventMap>(
  type: K,
  listener: (event: WindowEventMap[K]) => void,
  options?: boolean | AddEventListenerOptions,
) {
  useEffect(() => {
    if (IS_SERVER) return

    window.addEventListener(type, listener, options)

    return () => {
      window.removeEventListener(type, listener, options)
    }
  }, [listener, options, type])
}
