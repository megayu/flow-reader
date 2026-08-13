import { CheckCircleIcon, CircleXIcon, TriangleAlertIcon, XIcon } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react'

import { cn } from '@/utils'

import { Button } from './button'
import { DEFAULT_NOTIFICATION_AUTO_CLOSE_MS, NotificationContext, type NotificationInput } from './notificationContext'

interface NotificationRecord extends NotificationInput {
  id: number
}

export function NotificationProvider({ children }: { children: ReactNode }) {
  const [notifications, setNotifications] = useState<NotificationRecord[]>([])

  const dismiss = useCallback((id: number) => {
    setNotifications((current) => current.filter((notification) => notification.id !== id))
  }, [])

  const notify = useCallback((notification: NotificationInput) => {
    const id = Date.now() + Math.floor(Math.random() * 1000)
    setNotifications((current) => [
      ...current,
      {
        ...notification,
        autoCloseMs:
          notification.autoCloseMs ?? (notification.type === 'error' ? false : DEFAULT_NOTIFICATION_AUTO_CLOSE_MS),
        id,
      },
    ])
    return id
  }, [])

  const value = useMemo(
    () => ({
      dismiss,
      notify,
    }),
    [dismiss, notify],
  )

  return (
    <NotificationContext.Provider value={value}>
      {children}
      <div
        className="fixed top-3 right-3 z-10000 flex w-[min(calc(100vw-1.5rem),24rem)] flex-col gap-2"
        aria-live="polite"
        aria-relevant="additions text"
      >
        {notifications.map((notification) => (
          <NotificationToast key={notification.id} notification={notification} onDismiss={dismiss} />
        ))}
      </div>
    </NotificationContext.Provider>
  )
}

function NotificationToast({
  notification,
  onDismiss,
}: {
  notification: NotificationRecord
  onDismiss: (id: number) => void
}) {
  useEffect(() => {
    if (notification.autoCloseMs === false) return

    const timeout = window.setTimeout(() => {
      onDismiss(notification.id)
    }, notification.autoCloseMs)

    return () => window.clearTimeout(timeout)
  }, [notification.autoCloseMs, notification.id, onDismiss])

  const Icon = {
    error: CircleXIcon,
    success: CheckCircleIcon,
    warning: TriangleAlertIcon,
  }[notification.type]
  const borderClassName = {
    error: 'border-l-(--flow-danger)',
    success: 'border-l-(--flow-success)',
    warning: 'border-l-(--flow-warning)',
  }[notification.type]
  const iconClassName = {
    error: 'text-(--flow-danger)',
    success: 'text-(--flow-success)',
    warning: 'text-(--flow-warning)',
  }[notification.type]

  return (
    <section
      className={cn(
        'bg-popover text-popover-foreground ring-foreground/10 grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-lg border-l-4 p-3 text-base shadow-lg ring-1',
        borderClassName,
      )}
      role={notification.type === 'error' ? 'alert' : 'status'}
    >
      <Icon aria-hidden className={cn('size-4', iconClassName)} />
      <div className="min-w-0 cursor-text space-y-1 wrap-anywhere select-text">
        <h2 className="text-foreground text-base leading-tight font-medium">{notification.title}</h2>
        {notification.description && <p className="text-muted-foreground leading-snug">{notification.description}</p>}
        {!!notification.items?.length && (
          <ul className="text-muted-foreground max-h-40 space-y-1 overflow-auto pr-1 leading-snug">
            {notification.items.map((item, index) => (
              <li key={`${item}-${index}`} className="whitespace-pre-wrap wrap-anywhere">
                {item}
              </li>
            ))}
          </ul>
        )}
        {notification.action && (
          <Button
            className="h-auto w-fit justify-start p-0 leading-snug"
            onClick={() => {
              onDismiss(notification.id)
              notification.action?.onClick()
            }}
            variant="link"
          >
            {notification.action.label}
          </Button>
        )}
      </div>
      <Button
        aria-label="Close"
        className="-mr-1"
        onClick={() => onDismiss(notification.id)}
        size="icon-sm"
        variant="ghost"
      >
        <XIcon />
      </Button>
    </section>
  )
}
