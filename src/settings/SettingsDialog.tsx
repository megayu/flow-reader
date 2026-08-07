import { Dialog, DialogContent } from '@/components/ui/dialog'
import { useBookCacheClearing } from '@/state'

import { SettingsPanel } from './SettingsPanel'

interface SettingsDialogProps {
  open: boolean
  onClose: () => void
}

export function SettingsDialog({ open, onClose }: SettingsDialogProps) {
  const bookCacheClearing = useBookCacheClearing()

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !bookCacheClearing) onClose()
      }}
    >
      <DialogContent
        className="h-[min(38rem,calc(100vh-4rem))] w-[min(56rem,calc(100vw-2rem))] max-w-none overflow-hidden rounded-lg p-0"
        onEscapeKeyDown={(event) => {
          if (bookCacheClearing) event.preventDefault()
        }}
      >
        <SettingsPanel />
      </DialogContent>
    </Dialog>
  )
}
