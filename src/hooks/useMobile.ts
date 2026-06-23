import { useEffect } from 'react'

import { useMobileState } from '../state'

let listened = false

export function useMobile() {
  const [mobile, setMobile] = useMobileState()

  useEffect(() => {
    if (listened) return
    listened = true

    const mq = window.matchMedia('(max-width: 640px)')
    setMobile(mq.matches)
    mq.addEventListener('change', (e) => {
      setMobile(e.matches)
    })
  }, [setMobile])

  return mobile
}
