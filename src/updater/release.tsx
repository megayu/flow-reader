import { relaunch } from '@tauri-apps/plugin-process'
import { check, type DownloadEvent, type Update } from '@tauri-apps/plugin-updater'
import { LoaderCircleIcon } from 'lucide-react'
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useNotify } from '@/components/ui/notificationContext'
import { Progress } from '@/components/ui/progress'
import { useTranslation } from '@/hooks/useTranslation'
import { type ChangelogSection, changelogSectionsBetween } from '@/updateChangelog'

const AUTO_CHECK_START_DELAY_MS = 3_000
const AUTO_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1_000

type UpdateStatus =
  | { kind: 'idle' }
  | { kind: 'available'; notes: ChangelogSection[]; version: string }
  | { kind: 'downloading'; downloaded: number; notes: ChangelogSection[]; total?: number; version: string }

interface UpdaterContextValue {
  checking: boolean
  checkManually: () => Promise<void>
}

const UpdaterContext = createContext<UpdaterContextValue | null>(null)

export function UpdaterProvider({ children }: { children: ReactNode }) {
  const t = useTranslation()
  const notify = useNotify()
  const [checking, setChecking] = useState(false)
  const [status, setStatus] = useState<UpdateStatus>({ kind: 'idle' })
  const checkingRef = useRef(false)
  const downloadingRef = useRef(false)
  const dismissedVersionRef = useRef<string | null>(null)
  const installButtonRef = useRef<HTMLButtonElement>(null)
  const updateRef = useRef<Update | null>(null)

  const closeActiveUpdate = useCallback(() => {
    const update = updateRef.current
    updateRef.current = null
    if (update) void update.close()
  }, [])

  useEffect(
    () => () => {
      closeActiveUpdate()
    },
    [closeActiveUpdate],
  )

  const checkForUpdate = useCallback(
    async (manual: boolean) => {
      if (checkingRef.current || downloadingRef.current) return

      checkingRef.current = true
      setChecking(true)
      let update: Update | null = null
      try {
        update = await check({ timeout: 30_000 })
        if (!update) {
          if (manual) notify({ type: 'success', title: t('settings.about.update.current') })
          return
        }
        if (!manual && dismissedVersionRef.current === update.version) {
          void update.close()
          return
        }
        if (!update.body) throw new Error('The update manifest does not contain CHANGELOG.md.')

        const notes = changelogSectionsBetween(update.body, update.currentVersion, update.version)
        closeActiveUpdate()
        updateRef.current = update
        setStatus({ kind: 'available', notes, version: update.version })
      } catch {
        void update?.close()
        if (manual) notify({ type: 'error', title: t('settings.about.update.error') })
      } finally {
        checkingRef.current = false
        setChecking(false)
      }
    },
    [closeActiveUpdate, notify, t],
  )

  useEffect(() => {
    const startupTimer = window.setTimeout(() => void checkForUpdate(false), AUTO_CHECK_START_DELAY_MS)
    const interval = window.setInterval(() => void checkForUpdate(false), AUTO_CHECK_INTERVAL_MS)

    return () => {
      window.clearTimeout(startupTimer)
      window.clearInterval(interval)
    }
  }, [checkForUpdate])

  const dismissUpdate = () => {
    if (status.kind === 'available') dismissedVersionRef.current = status.version
    closeActiveUpdate()
    setStatus({ kind: 'idle' })
  }

  const installUpdate = async () => {
    const update = updateRef.current
    if (!update || status.kind !== 'available') return

    let downloaded = 0
    let total: number | undefined
    const { notes, version } = status
    downloadingRef.current = true
    setStatus({ kind: 'downloading', downloaded, notes, version })
    try {
      await update.downloadAndInstall((event: DownloadEvent) => {
        if (event.event === 'Started') {
          total = event.data.contentLength
        } else if (event.event === 'Progress') {
          downloaded += event.data.chunkLength
        }
        setStatus({ kind: 'downloading', downloaded, notes, total, version })
      })
      updateRef.current = null
      await relaunch()
    } catch {
      closeActiveUpdate()
      setStatus({ kind: 'idle' })
      notify({ type: 'error', title: t('settings.about.update.install_error') })
    } finally {
      downloadingRef.current = false
    }
  }

  const contextValue = useMemo<UpdaterContextValue>(
    () => ({ checking, checkManually: () => checkForUpdate(true) }),
    [checking, checkForUpdate],
  )
  const dialogOpen = status.kind !== 'idle'
  const downloading = status.kind === 'downloading'
  const percent = downloading && status.total ? Math.min(100, Math.round((status.downloaded / status.total) * 100)) : 0

  return (
    <UpdaterContext.Provider value={contextValue}>
      {children}
      <Dialog open={dialogOpen} onOpenChange={(open) => !open && !downloading && dismissUpdate()}>
        <DialogContent
          className="grid max-h-[min(42rem,calc(100vh-2rem))] w-[min(42rem,calc(100vw-2rem))] max-w-none grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden text-base"
          showCloseButton={!downloading}
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            installButtonRef.current?.focus()
          }}
          onEscapeKeyDown={(event) => downloading && event.preventDefault()}
          onInteractOutside={(event) => downloading && event.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle>{t('settings.about.update.available')}</DialogTitle>
          </DialogHeader>
          {status.kind !== 'idle' && <ChangelogNotes sections={status.notes} />}
          <DialogFooter className={downloading ? 'items-center' : undefined}>
            {downloading ? (
              <div className="flex w-full items-center gap-3">
                <Progress className="flex-1" value={percent} />
                <span className="w-10 text-right font-mono text-sm tabular-nums text-muted-foreground">{percent}%</span>
              </div>
            ) : (
              <>
                <Button type="button" variant="secondary" onClick={dismissUpdate}>
                  {t('settings.about.update.later')}
                </Button>
                <Button ref={installButtonRef} type="button" onClick={() => void installUpdate()}>
                  {t('settings.about.update.install')}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </UpdaterContext.Provider>
  )
}

export function UpdaterControl() {
  const t = useTranslation()
  const updater = useContext(UpdaterContext)
  if (!updater) throw new Error('UpdaterControl must be used within UpdaterProvider')

  return (
    <div className="shrink-0">
      <Button
        type="button"
        className="relative min-w-32"
        disabled={updater.checking}
        onClick={() => void updater.checkManually()}
      >
        <span className={updater.checking ? 'invisible' : undefined}>{t('settings.about.update.check')}</span>
        {updater.checking && <LoaderCircleIcon className="absolute size-4 animate-spin" />}
      </Button>
    </div>
  )
}

function ChangelogNotes({ sections }: { sections: ChangelogSection[] }) {
  return (
    <div className="scroll min-h-0 space-y-4 overflow-y-auto pr-1 text-muted-foreground">
      {sections.map((section) => (
        <section key={section.version}>
          <h3 className="font-medium text-(--flow-text)">
            {section.version}
            {section.date && <span className="ml-2 font-normal text-muted-foreground">{section.date}</span>}
          </h3>
          <div className="mt-1 whitespace-pre-wrap leading-relaxed">{section.body}</div>
        </section>
      ))}
    </div>
  )
}
