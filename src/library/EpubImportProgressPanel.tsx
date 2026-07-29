import { Progress } from '../components/ui/progress'
import { useTranslation } from '../hooks/useTranslation'
import type { EpubImportProgress } from '../storage'

export function EpubImportProgressPanel({ progress }: { progress: EpubImportProgress }) {
  const t = useTranslation('import')
  const total = Math.max(progress.total, 1)

  return (
    <div className="fixed inset-0 z-[9998] grid place-items-center bg-black/20">
      <section
        aria-live="polite"
        className="bg-popover text-popover-foreground ring-foreground/10 w-[min(calc(100vw-2rem),24rem)] rounded-lg p-4 text-base shadow-xl ring-1"
        role="status"
      >
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-foreground leading-tight font-medium">{t('title.progress')}</h2>
          <span className="text-muted-foreground tabular-nums">
            {progress.completed} / {progress.total}
          </span>
        </div>
        <Progress max={total} value={progress.completed} />
        <p className="text-muted-foreground mt-3 leading-snug">
          {t('result.partial', progress.imported, progress.failed)}
        </p>
      </section>
    </div>
  )
}
