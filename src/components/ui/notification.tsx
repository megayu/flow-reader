import { CheckCircleIcon, TriangleAlertIcon, XIcon } from 'lucide-react'
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react'

import { cn } from '@/utils'

import { Button } from './button'

type NotificationType = 'success' | 'error'
const DEFAULT_NOTIFICATION_AUTO_CLOSE_MS = 5000

interface NotificationInput {
  action?: {
    label: string
    onClick: () => void
  }
  autoCloseMs?: number | false
  description?: string
  items?: string[]
  title: string
  type: NotificationType
}

interface NotificationRecord extends NotificationInput {
  id: number
}

interface NotificationContextValue {
  dismiss: (id: number) => void
  notify: (notification: NotificationInput) => number
}

const NotificationContext = createContext<NotificationContextValue | undefined>(undefined)

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
          notification.autoCloseMs ?? (notification.type === 'success' ? DEFAULT_NOTIFICATION_AUTO_CLOSE_MS : false),
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

export function useNotify() {
  const context = useContext(NotificationContext)
  if (!context) {
    throw new Error('useNotify must be used within NotificationProvider')
  }
  return context.notify
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

  const Icon = notification.type === 'success' ? CheckCircleIcon : TriangleAlertIcon

  return (
    <section
      className={cn(
        'bg-popover text-popover-foreground ring-foreground/10 grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-lg p-3 text-base shadow-lg ring-1',
        notification.type === 'success' ? 'border-l-4 border-l-(--flow-accent)' : 'border-l-4 border-l-(--flow-danger)',
      )}
      role={notification.type === 'error' ? 'alert' : 'status'}
    >
      <Icon
        aria-hidden
        className={cn('size-4', notification.type === 'success' ? 'text-(--flow-accent)' : 'text-(--flow-danger)')}
      />
      <div className="min-w-0 cursor-text space-y-1 [overflow-wrap:anywhere] select-text">
        <h2 className="text-foreground text-base leading-tight font-medium">{notification.title}</h2>
        {notification.description && <p className="text-muted-foreground leading-snug">{notification.description}</p>}
        {!!notification.items?.length && (
          <ul className="text-muted-foreground max-h-40 space-y-1 overflow-auto pr-1 leading-snug">
            {notification.items.map((item) => (
              <li key={item} className="truncate">
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
