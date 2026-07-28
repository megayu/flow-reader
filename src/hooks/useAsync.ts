import { useEffect, useRef, useState } from 'react'

export function useAsync<T>(func: () => Promise<T> | undefined | null, deps = []) {
  const ref = useRef(func)
  ref.current = func
  const [value, setValue] = useState<T>()

  useEffect(() => {
    ref.current()?.then(setValue)
    /* oxlint-disable react-doctor/exhaustive-deps */
  }, deps)
  /* oxlint-enable react-doctor/exhaustive-deps */

  return value
}
