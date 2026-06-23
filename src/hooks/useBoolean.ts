import { useCallback, useState } from 'react'

export function useBoolean(defaultValue = false) {
  const [value, setValue] = useState(defaultValue)
  const toggle = useCallback(() => {
    setValue((value) => !value)
  }, [])

  return [value, toggle, setValue] as const
}
