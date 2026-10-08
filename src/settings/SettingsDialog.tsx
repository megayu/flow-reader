import { useEffect } from 'react'

import { Dialog, DialogContent } from '@/components/ui/dialog'
import { useAppStore, useBookCacheClearing } from '@/state'

import { SettingsPanel } from './SettingsPanel'
import { currentSettingsRevision, flushSettingsIfChangedSince } from './sync'

interface SettingsDialogProps {
  open: boolean
  onClose: () => void
}

export function SettingsDialog({ open, onClose }: SettingsDialogProps) {
  const bookCacheClearing = useBookCacheClearing()
  const storageMigrating = useAppStore((state) => state.storageMigrating)

  useEffect(() => {
    if (!open) return
    const openRevision = currentSettingsRevision()

    return () => {
      void flushSettingsIfChangedSince(openRevision).catch(console.error)
    }
  }, [open])

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !bookCacheClearing && !storageMigrating) onClose()
      }}
    >
      <DialogContent
        showCloseButton={!storageMigrating}
        className="h-[min(38rem,calc(100vh-4rem))] w-[min(56rem,calc(100vw-2rem))] max-w-none overflow-hidden rounded-lg p-0"
        onEscapeKeyDown={(event) => {
          if (bookCacheClearing || storageMigrating) event.preventDefault()
        }}
      >
        <SettingsPanel />
      </DialogContent>
    </Dialog>
  )
}
