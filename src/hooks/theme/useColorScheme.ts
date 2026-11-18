import { useColorSchemeSetting } from '@/state'

import { useMediaQuery } from '../useMediaQuery'

export function useColorScheme() {
  const scheme = useColorSchemeSetting()
  const prefersDark = useMediaQuery('(prefers-color-scheme: dark)')
  return scheme === 'dark' || (scheme === 'system' && prefersDark)
}
