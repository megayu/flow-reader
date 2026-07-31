import type { ReactNode } from 'react'

import { Button } from './button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from './dialog'

interface ConfirmDialogProps {
  cancelLabel: string
  confirmLabel: string
  description: ReactNode
  onClose: () => void
  onConfirm: () => void
  title: string
}

function ConfirmDialog({ cancelLabel, confirmLabel, description, onClose, onConfirm, title }: ConfirmDialogProps) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="w-[min(24rem,calc(100vw-2rem))] max-w-none text-base">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="text-muted-foreground leading-relaxed">{description}</div>
        <DialogFooter>
          <Button
            type="button"
            variant="secondary"
            className="focus:border-ring focus:ring-ring focus:ring-1 focus:ring-inset focus-visible:ring-1 focus-visible:ring-inset"
            onClick={onClose}
          >
            {cancelLabel}
          </Button>
          <Button type="button" variant="destructive" onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export { ConfirmDialog }
