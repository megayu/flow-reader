import { createContext, useContext } from 'react'

export const DEFAULT_NOTIFICATION_AUTO_CLOSE_MS = 5000

export type NotificationType = 'success' | 'warning' | 'error'

export interface NotificationInput {
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

export interface NotificationContextValue {
  dismiss: (id: number) => void
  notify: (notification: NotificationInput) => number
}

export const NotificationContext = createContext<NotificationContextValue | undefined>(undefined)

export function useNotify() {
  const context = useContext(NotificationContext)
  if (!context) {
    throw new Error('useNotify must be used within NotificationProvider')
  }
  return context.notify
}
