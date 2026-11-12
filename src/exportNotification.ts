import type { NotificationContextValue } from '@/components/ui/notificationContext'
import type { useTranslation } from '@/hooks/useTranslation'
import type { MessageKey } from '@/locales'
import { db } from '@/storage'

export function notifyExportedFile(
  path: string | null | undefined,
  notify: NotificationContextValue['notify'],
  t: ReturnType<typeof useTranslation>,
  title: MessageKey = 'home.export_complete',
) {
  if (!path) return
  notify({
    action: {
      label: t('home.export_reveal'),
      onClick: () => {
        void db.files.reveal(path).catch(console.error)
      },
    },
    description: path,
    title: t(title),
    type: 'success',
  })
}
