import { useCallback, useState } from 'react'

import { cleanLibraryTagName } from '../library/filters'
import { db } from '../storage/client'

export function useLibraryTagCreation() {
  const [name, setName] = useState('')

  const create = useCallback(async () => {
    const cleanName = cleanLibraryTagName(name)
    if (!cleanName) return

    await db.tags.create(cleanName)
    setName('')
  }, [name])

  const clear = useCallback(() => setName(''), [])

  return { clear, create, name, setName }
}
