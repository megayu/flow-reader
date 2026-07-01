import { useNotify } from '../components/ui/notification'
import { EpubImportResult } from '../db'

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
        description:
          imported > 0
            ? `${t('imported_count')}${imported}${t('books_unit')}，${t('failed_count')}${failed}${t('books_unit')}`
            : `${t('failed_count')}${failed}${t('books_unit')}`,
        items: result.failures.map((failure) => failure.filename),
        title: t(imported > 0 ? 'partial_failed' : 'failed'),
        type: 'error',
      })
      return
    }

    if (imported > 0) {
      notify({
        title: `${t('success')}${imported}${t('books_unit')}`,
        type: 'success',
      })
    }
  }
}
