import { useNotify } from '../components/ui/notificationContext'
import type { BookImportResult } from '../storage'

import { useTranslation } from './useTranslation'

export function useBookImportNotifications() {
  const notify = useNotify()
  const t = useTranslation()

  return (result: BookImportResult) => {
    const imported = result.books.length
    const failed = result.failures.length
    const skipped = result.skipped.length
    if (imported === 0 && failed === 0 && skipped === 0) return

    notify({
      autoCloseMs: failed > 0 || skipped > 0 ? false : undefined,
      items:
        failed > 0 || skipped > 0
          ? [
              ...result.failures.map((failure) => `× ${failure.filename}`),
              ...result.skipped.map((filename) => `- ${filename}`),
            ]
          : undefined,
      title: t('import.result.summary', imported, failed, skipped),
      type: failed > 0 ? 'error' : skipped > 0 ? 'warning' : 'success',
    })
  }
}
