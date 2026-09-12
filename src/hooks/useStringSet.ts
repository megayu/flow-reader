import { useCallback, useState } from 'react'

export function useStringSet() {
  const [values, setValues] = useState(() => new Set<string>())

  const add = useCallback((value: string) => {
    setValues((current) => {
      if (current.has(value)) return current
      const next = new Set(current)
      next.add(value)
      return next
    })
  }, [])

  const has = useCallback((value: string) => values.has(value), [values])

  const toggle = useCallback((value: string) => {
    setValues((current) => {
      const next = new Set(current)
      if (next.has(value)) {
        next.delete(value)
      } else {
        next.add(value)
      }
      return next
    })
  }, [])

  const replace = useCallback((nextValues: Iterable<string>) => {
    setValues(new Set(nextValues))
  }, [])

  const reset = useCallback(() => {
    setValues((current) => (current.size ? new Set() : current))
  }, [])

  return [values, { add, has, toggle, replace, reset }] as const
}
