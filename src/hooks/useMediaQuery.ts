import { useEffect, useState } from 'react'

import { IS_SERVER } from '@flow/reader/env'

export function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(false)

  useEffect(() => {
    if (IS_SERVER) return

    const media = window.matchMedia(query)
    const update = () => setMatches(media.matches)

    update()
    media.addEventListener('change', update)

    return () => {
      media.removeEventListener('change', update)
    }
  }, [query])

  return matches
}
