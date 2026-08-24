import type { ReactNode } from 'react'

export function UpdaterProvider({ children }: { children: ReactNode }) {
  return <>{children}</>
}

export function UpdaterControl() {
  return null
}
