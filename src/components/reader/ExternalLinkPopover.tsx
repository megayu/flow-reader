import { Copy, ExternalLink } from 'lucide-react'
import { useEffect } from 'react'

import { openSupportedExternalUrl } from '../../externalLink'
import { useNotifyError } from '../../hooks/useNotifyError'
import { useTranslation } from '../../hooks/useTranslation'
import type { BookTab } from '../../models/reader'
import { safeDecodeHref } from '../../noteLinks'
import { copy } from '../../utils'
import { Button } from '../ui/button'
import { Popover, PopoverAnchor, PopoverContent } from '../ui/popover'

import { CAPTURE_EVENT_OPTIONS, useFrameEvent } from './useFrameEvent'

export interface ExternalLinkPreview {
  href: string
  getBoundingClientRect: () => DOMRect
}

async function copyExternalLink(href: string) {
  return copy(/^mailto:/i.test(href) ? safeDecodeHref(new URL(href).pathname) : href)
}

export function ExternalLinkPopover({
  preview,
  frames,
  tab,
  onClose,
}: {
  preview: ExternalLinkPreview
  frames: readonly Window[]
  tab: BookTab
  onClose: () => void
}) {
  const t = useTranslation()
  const notifyError = useNotifyError()
  const actions = [
    ['action.open', ExternalLink, openSupportedExternalUrl],
    ['action.copy', Copy, copyExternalLink],
  ] as const

  useFrameEvent(frames, 'pointerdown', onClose, CAPTURE_EVENT_OPTIONS)
  useFrameEvent(
    frames,
    'keydown',
    (event) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopImmediatePropagation()
      onClose()
    },
    CAPTURE_EVENT_OPTIONS,
  )
  useFrameEvent(frames, 'scroll', onClose, CAPTURE_EVENT_OPTIONS)

  useEffect(() => {
    const rendition = tab.rendition
    rendition?.on('relocated', onClose)
    window.addEventListener('resize', onClose)
    return () => {
      rendition?.off('relocated', onClose)
      window.removeEventListener('resize', onClose)
    }
  }, [tab, onClose])

  return (
    <Popover
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <PopoverAnchor virtualRef={{ current: preview }} />
      <PopoverContent
        data-flow-external-link
        data-flow-keyboard-capture="true"
        className="w-72 max-w-[calc(100vw-24px)] gap-2 p-2"
        collisionPadding={12}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <div className="max-h-24 overflow-y-auto px-1 py-1 select-text break-all text-sm leading-snug" dir="ltr">
          {preview.href}
        </div>
        <div className="-mx-2 flex justify-end gap-1 border-t border-(--flow-border) px-2 pt-2">
          {actions.map(([label, Icon, action]) => (
            <Button
              key={label}
              size="sm"
              variant="ghost"
              onClick={() => {
                void action(preview.href)
                  .then(onClose)
                  .catch((error) => notifyError(error, label))
              }}
            >
              <Icon />
              {t(label)}
            </Button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
