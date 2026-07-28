import { useRef, useState } from 'react'

import { Dialog, DialogContent } from '@/components/ui/dialog'

import { SettingsPanel } from './SettingsPanel'

interface SettingsDialogProps {
  open: boolean
  onClose: () => void
}

export function SettingsDialog({ open, onClose }: SettingsDialogProps) {
  const [popupOpen, setPopupOpen] = useState(false)
  const contentRef = useRef<HTMLDivElement>(null)
  const popupPointerDownOutsideRef = useRef(false)

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !popupOpen) onClose()
      }}
    >
      <DialogContent
        ref={contentRef}
        data-flow-keyboard-capture="true"
        className="h-[min(38rem,calc(100vh-4rem))] w-[min(56rem,calc(100vw-2rem))] max-w-none overflow-hidden rounded-lg p-0"
        onEscapeKeyDown={(event) => {
          if (
            event.target instanceof Element &&
            event.target.closest('[data-dictionary-inline-editor]')
          ) {
            event.preventDefault()
          }
        }}
        onPointerDownOutside={(event) => {
          if (popupPointerDownOutsideRef.current) {
            popupPointerDownOutsideRef.current = false
            event.preventDefault()
          }
        }}
      >
        <SettingsPanel
          onPopupOpenChange={setPopupOpen}
          onPopupPointerDownOutside={(target) => {
            popupPointerDownOutsideRef.current = !(
              target instanceof Node && contentRef.current?.contains(target)
            )
          }}
        />
      </DialogContent>
    </Dialog>
  )
}
