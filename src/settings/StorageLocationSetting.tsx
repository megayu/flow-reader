import { Channel, invoke } from '@tauri-apps/api/core'
import { type ReactNode, useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Progress } from '@/components/ui/progress'
import { formatLocalPathForDisplay } from '@/dictionary/path'
import { formatErrorMessage } from '@/errorMessage'
import { selectImportFolder } from '@/file'
import { useTranslation } from '@/hooks/useTranslation'
import { reader } from '@/models/reader'
import { snapshotWindowUiState, useAppStore } from '@/state'
import { db } from '@/storage/client'

import { SettingsItem } from './SettingsItem'
import { flushNativeSettings } from './sync'

interface StorageLocation {
  directory: string
  overriddenByEnvironment: boolean
}

interface MigrationTarget {
  directory: string
  createDirectory: boolean
  issue: 'unavailable' | null
}

interface MigrationProgress {
  completed: number
  total: number
}

function DirectoryField({ label, directory, children }: { label: string; directory: string; children?: ReactNode }) {
  const path = formatLocalPathForDisplay(directory)
  return (
    <section className="min-w-0 space-y-1.5">
      <h3 className="text-muted-foreground leading-none font-medium">{label}</h3>
      <div className="border-input flex h-8 w-full min-w-0 items-center gap-2 overflow-hidden rounded-lg border bg-(--flow-bg-control) pl-2.5">
        <span dir="rtl" className="text-muted-foreground min-w-0 flex-1 truncate text-left leading-7.5" title={path}>
          <bdo dir="ltr">{path}</bdo>
        </span>
        {children}
      </div>
    </section>
  )
}

function StorageMigrationDialog({ location, onClose }: { location: StorageLocation; onClose: () => void }) {
  const t = useTranslation()
  const [target, setTarget] = useState<MigrationTarget>()
  const [phase, setPhase] = useState<'idle' | 'selecting' | 'migrating'>('idle')
  const [progress, setProgress] = useState<MigrationProgress>({ completed: 0, total: 1 })
  const [error, setError] = useState('')
  const migrating = phase === 'migrating'

  const selectDirectory = async () => {
    setPhase('selecting')
    setError('')
    try {
      const directory = await selectImportFolder()
      if (directory) setTarget(await invoke<MigrationTarget>('validate_storage_target', { directory }))
    } catch (error) {
      setTarget(undefined)
      setError(formatErrorMessage(error))
    } finally {
      setPhase('idle')
    }
  }

  const migrate = async () => {
    if (!target || target.issue || phase !== 'idle') return
    setPhase('migrating')
    setError('')
    useAppStore.setState({ storageMigrating: true })
    try {
      await flushNativeSettings()
      const bookCheckpoints = await reader.collectAppCloseBookCheckpoints()
      const onProgress = new Channel<MigrationProgress>()
      onProgress.onmessage = setProgress
      await invoke('migrate_storage', {
        directory: target.directory,
        createDirectory: target.createDirectory,
        closeState: { bookCheckpoints, recentBookIds: db.recentBooks.peek(), window: snapshotWindowUiState() },
        onProgress,
      })
    } catch (error) {
      setError(formatErrorMessage(error))
      setProgress({ completed: 0, total: 1 })
      setPhase('idle')
      useAppStore.setState({ storageMigrating: false })
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && phase === 'idle') onClose()
      }}
    >
      <DialogContent
        className="w-[min(32rem,calc(100vw-2rem))] max-w-none text-base"
        showCloseButton={phase === 'idle'}
        onEscapeKeyDown={(event) => {
          if (phase !== 'idle') event.preventDefault()
        }}
        onInteractOutside={(event) => {
          if (phase !== 'idle') event.preventDefault()
        }}
      >
        <DialogHeader>
          <DialogTitle>{t('settings.storage_location.title')}</DialogTitle>
        </DialogHeader>
        <DirectoryField label={t('settings.storage_location.current')} directory={location.directory} />
        <DirectoryField label={t('settings.storage_location.target')} directory={target?.directory ?? ''}>
          <Button
            type="button"
            variant="secondary"
            className="h-full rounded-l-none border-l border-(--flow-border) bg-(--flow-bg-control-active) hover:bg-(--flow-bg-control-hover)"
            disabled={phase !== 'idle'}
            onClick={() => void selectDirectory()}
          >
            {t('home.select')}
          </Button>
        </DirectoryField>
        {(target?.issue || error) && (
          <div className="space-y-1 text-sm leading-snug">
            {target?.issue && (
              <p className="text-destructive py-0!">{t(`settings.storage_location.issue.${target.issue}`)}</p>
            )}
            {error && <p className="text-destructive py-0! wrap-break-word">{error}</p>}
          </div>
        )}
        {migrating && (
          <div className="space-y-2">
            <Progress value={progress.completed} max={progress.total} />
            <p className="text-muted-foreground py-0! text-right text-sm tabular-nums">
              {Math.floor((progress.completed / progress.total) * 100)}%
            </p>
          </div>
        )}
        <DialogFooter>
          <Button type="button" variant="secondary" disabled={phase !== 'idle'} onClick={onClose}>
            {t('action.cancel')}
          </Button>
          <Button
            type="button"
            disabled={phase !== 'idle' || !target || target.issue !== null}
            onClick={() => void migrate()}
          >
            {t('settings.storage_location.migrate')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function StorageLocationSetting() {
  const t = useTranslation()
  const [location, setLocation] = useState<StorageLocation>()
  const [open, setOpen] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    void invoke<StorageLocation>('get_storage_location').then(
      (location) => {
        if (active) setLocation(location)
      },
      (error) => {
        if (active) setError(formatErrorMessage(error))
      },
    )
    return () => {
      active = false
    }
  }, [])
  if (location?.overriddenByEnvironment) return null

  return (
    <>
      <SettingsItem
        title={t('settings.storage_location.title')}
        description={error || t('settings.storage_location.description')}
      >
        <Button type="button" variant="secondary" disabled={!location} onClick={() => setOpen(true)}>
          {t('settings.storage_location.migrate')}
        </Button>
      </SettingsItem>
      {open && location && <StorageMigrationDialog location={location} onClose={() => setOpen(false)} />}
    </>
  )
}
