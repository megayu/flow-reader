import { useNotify } from '../components/ui/notification'
import type { EpubImportResult } from '../storage'

import { useTranslation } from './useTranslation'

export function useEpubImportNotifications() {
  const notify = useNotify()
  const t = useTranslation('import')

  return (result: EpubImportResult) => {
    const imported = result.books.length
    const failed = result.failures.length

    if (failed > 0) {
      notify({
        autoCloseMs: false,
        description: imported > 0 ? t('result.partial', imported, failed) : t('result.failed', failed),
        items: result.failures.map((failure) => failure.filename),
        title: t(imported > 0 ? 'title.partial_failure' : 'title.failed'),
        type: 'error',
      })
      return
    }

    if (imported > 0) {
      notify({
        title: t('result.success', imported),
        type: 'success',
      })
    }
  }
}
