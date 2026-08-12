import { useCallback, useState } from 'react'

import { useNotify } from '../components/ui/notificationContext'
import { cleanLibraryTagName, sameLibraryTagName } from '../library/filters'
import { db } from '../storage/client'

import { useTranslation } from './useTranslation'

export function useLibraryTagCreation() {
  const t = useTranslation('home')
  const notify = useNotify()
  const [name, setName] = useState('')

  const create = useCallback(async () => {
    const cleanName = cleanLibraryTagName(name)
    if (!cleanName) return

    const tags = await db.tags.toArray()
    if (tags.some((tag) => sameLibraryTagName(tag.name, cleanName))) {
      notify({
        title: t('library_filter.tag_exists'),
        type: 'warning',
      })
      setName('')
      return
    }

    await db.tags.create(cleanName)
    setName('')
  }, [name, notify, t])

  const clear = useCallback(() => setName(''), [])

  return { clear, create, name, setName }
}
