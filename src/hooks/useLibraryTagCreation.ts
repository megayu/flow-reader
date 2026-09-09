import { useCallback, useState } from 'react'

import { useNotify } from '../components/ui/notificationContext'
import { cleanLibraryTagName, sameLibraryTagName } from '../library/filters'
import { db } from '../storage/client'

import { useNotifyError } from './useNotifyError'
import { useTranslation } from './useTranslation'

export function useLibraryTagCreation() {
  const t = useTranslation()
  const notify = useNotify()
  const notifyError = useNotifyError()
  const [name, setName] = useState('')

  const create = useCallback(async () => {
    try {
      const cleanName = cleanLibraryTagName(name)
      if (!cleanName) return

      const tags = await db.tags.toArray()
      if (tags.some((tag) => sameLibraryTagName(tag.name, cleanName))) {
        notify({
          title: t('tag.error.name_exists'),
          type: 'warning',
        })
        setName('')
        return
      }

      const tag = await db.tags.create(cleanName)
      setName('')
      return tag
    } catch (error) {
      notifyError(error, 'tag.new')
    }
  }, [name, notify, notifyError, t])

  const clear = useCallback(() => setName(''), [])

  return { clear, create, name, setName }
}
