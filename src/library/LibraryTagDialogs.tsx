import { useRef, useState } from 'react'

import { Button as UiButton } from '../components/ui/button'
import { ConfirmDialog } from '../components/ui/confirm-dialog'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/dialog'
import { Input } from '../components/ui/input'
import { useNotify } from '../components/ui/notificationContext'
import { useTranslation } from '../hooks/useTranslation'
import { db } from '../storage/client'
import type { LibraryTagRecord } from '../storage/types'

import { cleanLibraryTagName, sameLibraryTagName } from './filters'

interface LibraryTagDialogProps {
  onClose: () => void
  tag: LibraryTagRecord
}

export function EditLibraryTagDialog({ onClose, tag }: LibraryTagDialogProps) {
  const t = useTranslation('home')
  const notify = useNotify()
  const inputRef = useRef<HTMLInputElement>(null)
  const [name, setName] = useState(tag.name)
  const trimmedName = cleanLibraryTagName(name)
  const canSave = !!trimmedName && trimmedName !== tag.name

  const save = () => {
    if (!canSave) return
    void (async () => {
      const tags = await db.tags.toArray()
      const duplicate = tags.some(
        (existingTag) => existingTag.id !== tag.id && sameLibraryTagName(existingTag.name, trimmedName),
      )
      const updatedTag = duplicate ? undefined : await db.tags.update(tag.id, trimmedName)

      if (!updatedTag) {
        notify({
          title: t('library_filter.tag_exists'),
          type: 'warning',
        })
        return
      }
      onClose()
    })()
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="w-[min(24rem,calc(100vw-2rem))] max-w-none text-base"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          inputRef.current?.focus()
        }}
      >
        <form
          autoComplete="off"
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            save()
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('library_filter.edit_tag')}</DialogTitle>
          </DialogHeader>
          <label className="block">
            <span className="text-muted-foreground mb-1.5 block leading-none font-medium">
              {t('library_filter.tag_name')}
            </span>
            <Input
              ref={inputRef}
              value={name}
              focusBehavior="select-all"
              onValueChange={setName}
              className="focus-visible:border-input text-base focus-visible:ring-0"
            />
          </label>
          <DialogFooter>
            <UiButton type="button" variant="secondary" onClick={onClose}>
              {t('cancel')}
            </UiButton>
            <UiButton type="submit" disabled={!canSave}>
              {t('edit.save')}
            </UiButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

interface DeleteLibraryTagDialogProps extends LibraryTagDialogProps {
  onDeleted: () => void
}

export function DeleteLibraryTagDialog({ onClose, onDeleted, tag }: DeleteLibraryTagDialogProps) {
  const t = useTranslation('home')

  return (
    <ConfirmDialog
      title={t('library_filter.delete_tag')}
      description={
        <>
          {t('library_filter.delete_tag_message')} <span className="text-foreground font-medium">{tag.name}</span>
        </>
      }
      cancelLabel={t('cancel')}
      confirmLabel={t('delete')}
      onClose={onClose}
      onConfirm={() => {
        void db.tags.delete(tag.id).then(onDeleted)
      }}
    />
  )
}
