import { type ReactNode, useRef } from 'react'

import { Button } from './button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from './dialog'

interface ConfirmDialogProps {
  cancelLabel: string
  children?: ReactNode
  confirmLabel: string
  description?: ReactNode
  onClose: () => void
  onConfirm: () => void
  title: string
}

function ConfirmDialog({
  cancelLabel,
  children,
  confirmLabel,
  description,
  onClose,
  onConfirm,
  title,
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null)

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="w-[min(24rem,calc(100vw-2rem))] max-w-none text-base"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          cancelRef.current?.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {description && <div className="text-muted-foreground leading-relaxed">{description}</div>}
        {children}
        <DialogFooter>
          <Button
            ref={cancelRef}
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
