import { useState } from 'react'

import { BlockingProgressPanel } from '@/components/BlockingProgressPanel'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { useNotify } from '@/components/ui/notificationContext'
import { useTranslation } from '@/hooks/useTranslation'
import { reader } from '@/models/reader'
import { useSetBookCacheClearing } from '@/state'
import { type BookCacheClearProgress, clearBookCaches } from '@/storage'

import { SettingsItem } from './SettingsItem'

export function BookCacheSetting() {
  const t = useTranslation('settings.book_cache')
  const notify = useNotify()
  const setBookCacheClearing = useSetBookCacheClearing()
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [discardUnexportedEdits, setDiscardUnexportedEdits] = useState(false)
  const [progress, setProgress] = useState<BookCacheClearProgress>()

  const closeConfirm = () => {
    setConfirmOpen(false)
    setDiscardUnexportedEdits(false)
  }

  const clear = async () => {
    const discardEdits = discardUnexportedEdits
    const preservedUnpackedBookIds = reader.getOpenBookIds()
    setConfirmOpen(false)
    setBookCacheClearing(true)
    try {
      await clearBookCaches(discardEdits, preservedUnpackedBookIds, setProgress)
      notify({ type: 'success', title: t('complete') })
    } catch (clearError) {
      console.error(clearError)
      notify({ type: 'error', title: t('error') })
    } finally {
      setProgress(undefined)
      setBookCacheClearing(false)
      setDiscardUnexportedEdits(false)
    }
  }

  return (
    <>
      <SettingsItem title={t('title')} description={t('description')}>
        <Button
          type="button"
          variant="secondary"
          onClick={() => {
            setDiscardUnexportedEdits(false)
            setConfirmOpen(true)
          }}
        >
          {t('clear')}
        </Button>
      </SettingsItem>
      {confirmOpen && (
        <ConfirmDialog
          title={t('confirm')}
          cancelLabel={t('cancel')}
          confirmLabel={t('clear')}
          onClose={closeConfirm}
          onConfirm={() => {
            void clear()
          }}
        >
          <label
            htmlFor="settings-book-cache-discard-edits"
            className="flex min-h-8 cursor-pointer items-center gap-2 text-(--flow-text)"
          >
            <Checkbox
              id="settings-book-cache-discard-edits"
              checked={discardUnexportedEdits}
              onCheckedChange={(checked) => setDiscardUnexportedEdits(checked === true)}
            />
            <span>{t('discard_edits')}</span>
          </label>
        </ConfirmDialog>
      )}
      {progress && (
        <BlockingProgressPanel
          blockKeyboard
          title={t('clearing')}
          completed={progress.completed}
          total={progress.total}
        />
      )}
    </>
  )
}
