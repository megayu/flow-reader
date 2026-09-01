import { BlockingProgressPanel } from '../components/BlockingProgressPanel'
import { useTranslation } from '../hooks/useTranslation'
import type { BookImportProgress } from '../storage'

export function BookImportProgressPanel({ progress }: { progress: BookImportProgress }) {
  const t = useTranslation()
  return (
    <BlockingProgressPanel title={t('import.title.progress')} completed={progress.completed} total={progress.total}>
      <p className="text-muted-foreground mt-3 leading-snug">
        {t('import.result.summary', progress.imported, progress.failed, progress.skipped)}
      </p>
    </BlockingProgressPanel>
  )
}
