import { useCallback } from 'react'

import { useNotify } from '../components/ui/notificationContext'
import { formatErrorMessage } from '../errorMessage'
import type { MessageKey } from '../locales'

import { useTranslation } from './useTranslation'

export function useNotifyError() {
  const notify = useNotify()
  const t = useTranslation()

  return useCallback(
    (error: unknown, operation: MessageKey) => {
      console.error(error)
      notify({
        autoCloseMs: false,
        description: formatErrorMessage(error),
        title: t('error.operation_failed', t(operation)),
        type: 'error',
      })
    },
    [notify, t],
  )
}
