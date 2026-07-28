import { useCallback, useState } from 'react'

export function useForceRender() {
  const [, render] = useState({})

  return useCallback(() => {
    render({})
  }, [])
}
