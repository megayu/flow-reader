import { type ReactNode, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'

import { IS_SERVER } from '@/env'

import { Progress } from './ui/progress'

interface BlockingProgressPanelProps {
  blockKeyboard?: boolean
  children?: ReactNode
  completed: number
  title: string
  total: number
}

export function BlockingProgressPanel({
  blockKeyboard = false,
  children,
  completed,
  title,
  total,
}: BlockingProgressPanelProps) {
  const overlayRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!blockKeyboard) return

    const blockKey = (event: KeyboardEvent) => {
      event.preventDefault()
      event.stopPropagation()
    }
    overlayRef.current?.focus()
    window.addEventListener('keydown', blockKey, true)
    return () => window.removeEventListener('keydown', blockKey, true)
  }, [blockKeyboard])

  if (IS_SERVER) return null

  return createPortal(
    <div
      ref={overlayRef}
      className="fixed inset-0 z-9998 grid place-items-center bg-black/20 outline-none"
      data-flow-keyboard-capture={blockKeyboard ? 'true' : undefined}
      tabIndex={blockKeyboard ? -1 : undefined}
      onKeyDownCapture={(event) => {
        if (!blockKeyboard) return
        event.preventDefault()
        event.stopPropagation()
      }}
    >
      <section
        aria-live="polite"
        className="bg-popover text-popover-foreground ring-foreground/10 w-[min(calc(100vw-2rem),24rem)] rounded-lg p-4 text-base shadow-xl ring-1"
        role="status"
      >
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-foreground leading-tight font-medium">{title}</h2>
          <span className="text-muted-foreground tabular-nums">
            {completed} / {total}
          </span>
        </div>
        <Progress max={Math.max(total, 1)} value={completed} />
        {children}
      </section>
    </div>,
    document.body,
  )
}
