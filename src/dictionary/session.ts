import { cancelDictionarySession } from './native'

let nextSessionId = 1

export function beginDictionarySession(signal: AbortSignal) {
  const id = nextSessionId++
  const cancel = () => {
    void cancelDictionarySession(id).catch(() => undefined)
  }
  const throwIfCancelled = () => {
    if (signal.aborted) throw new DOMException('Request cancelled', 'AbortError')
  }

  if (signal.aborted) {
    cancel()
    throwIfCancelled()
  }
  signal.addEventListener('abort', cancel, { once: true })

  return {
    id,
    throwIfCancelled,
    // Online requests detach when finished. Local dictionaries keep the listener
    // until the popup closes so native files and MDict resources remain available.
    detachCancellation() {
      signal.removeEventListener('abort', cancel)
    },
  }
}
