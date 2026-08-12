import clsx from 'clsx'
import type { ReactNode } from 'react'

interface SettingsItemProps {
  children?: ReactNode
  controlId?: string
  description?: ReactNode
  title: string
  titleAction?: ReactNode
  wideControl?: boolean
}

export function SettingsItem({
  title,
  titleAction,
  children,
  controlId,
  description,
  wideControl = false,
}: SettingsItemProps) {
  const heading = <h3 className="text-base leading-tight font-semibold text-(--flow-text)">{title}</h3>
  const information = (
    <>
      {titleAction ? (
        <div className="flex min-w-0 items-center gap-2">
          {heading}
          <div className="flex shrink-0 items-center">{titleAction}</div>
        </div>
      ) : (
        heading
      )}
      {description && <p className="text-muted-foreground mt-0 py-0 text-sm leading-snug">{description}</p>}
    </>
  )

  return (
    <div
      className={clsx(
        'grid min-h-8 items-center gap-x-6',
        wideControl ? 'grid-cols-[minmax(0,1fr)_minmax(14rem,28rem)]' : 'grid-cols-[minmax(0,1fr)_auto]',
      )}
    >
      {controlId ? (
        <label htmlFor={controlId} className="min-w-0 cursor-pointer">
          {information}
        </label>
      ) : (
        <div className="min-w-0">{information}</div>
      )}
      <div className="flex min-h-8 min-w-0 items-center justify-end">{children}</div>
    </div>
  )
}
