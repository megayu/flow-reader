import { useEffect, useId, useMemo, useState } from 'react'

import { Button } from '../components/ui/button'
import { Checkbox } from '../components/ui/checkbox'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/dialog'
import { formatLocalPathForDisplay } from '../dictionary/path'
import { formatErrorMessage } from '../errorMessage'
import { type FolderImportSelection, selectImportFolder } from '../file'
import { useTranslation } from '../hooks/useTranslation'
import { type FolderImportCandidate, scanImportFolder } from '../storage'

interface FolderImportDialogProps {
  rootPath: string
  onClose: () => void
  onImport: (selection: FolderImportSelection) => void
}

interface FolderScanResult {
  candidates: FolderImportCandidate[]
  recursive: boolean
  rootPath: string
}

interface CheckRowProps {
  checked: boolean
  disabled?: boolean
  id: string
  label: string
  onCheckedChange: (checked: boolean) => void
  trailing?: string
}

function CheckRow({ checked, disabled, id, label, onCheckedChange, trailing }: CheckRowProps) {
  return (
    <label
      htmlFor={id}
      className={`flex h-8 items-center gap-2 text-base ${
        disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'
      }`}
    >
      <Checkbox
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(value) => onCheckedChange(value === true)}
      />
      <span className="leading-none">{label}</span>
      {trailing !== undefined && (
        <span className="text-muted-foreground min-w-4 text-right leading-none tabular-nums">{trailing}</span>
      )}
    </label>
  )
}

export function FolderImportDialog({ rootPath: initialRootPath, onClose, onImport }: FolderImportDialogProps) {
  const t = useTranslation()
  const id = useId()
  const [rootPath, setRootPath] = useState(initialRootPath)
  const [recursive, setRecursive] = useState(false)
  const [includeEpub, setIncludeEpub] = useState(true)
  const [includeTxt, setIncludeTxt] = useState(false)
  const [tagRootDirectory, setTagRootDirectory] = useState(true)
  const [tagIntermediateDirectories, setTagIntermediateDirectories] = useState(false)
  const [tagDirectDirectory, setTagDirectDirectory] = useState(false)
  const [scanResult, setScanResult] = useState<FolderScanResult>()
  const [scanRequestVersion, setScanRequestVersion] = useState(0)
  const [scanError, setScanError] = useState('')
  const displayedPath = formatLocalPathForDisplay(rootPath)
  const candidates =
    scanResult?.rootPath === rootPath && scanResult.recursive === recursive ? scanResult.candidates : undefined

  useEffect(() => {
    let active = true
    setScanError('')
    void scanImportFolder(rootPath, recursive)
      .then((result) => {
        if (active) setScanResult({ candidates: result, recursive, rootPath })
      })
      .catch((error) => {
        if (active) setScanError(formatErrorMessage(error))
      })
    return () => {
      active = false
    }
  }, [recursive, rootPath, scanRequestVersion])

  const epubCount = candidates?.filter((candidate) => candidate.format === 'epub').length
  const txtCount = candidates?.filter((candidate) => candidate.format === 'txt').length
  const selectedCandidates = useMemo(
    () =>
      candidates?.filter(
        (candidate) => (candidate.format === 'epub' && includeEpub) || (candidate.format === 'txt' && includeTxt),
      ) ?? [],
    [candidates, includeEpub, includeTxt],
  )

  const changeFolder = () => {
    void selectImportFolder()
      .then((path) => {
        if (!path) return
        setScanResult(undefined)
        setScanError('')
        setRootPath(path)
        setScanRequestVersion((version) => version + 1)
      })
      .catch((error) => setScanError(formatErrorMessage(error)))
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="w-[min(32rem,calc(100vw-2rem))] max-w-none text-base">
        <DialogHeader>
          <DialogTitle>{t('home.folder_import.title')}</DialogTitle>
        </DialogHeader>

        <section className="min-w-0 space-y-1.5">
          <h3 className="text-muted-foreground leading-none font-medium">{t('home.folder_import.selected_folder')}</h3>
          <div className="border-input flex h-8 w-full min-w-0 items-center gap-2 overflow-hidden rounded-lg border bg-(--flow-bg-control) pl-2.5">
            <span
              dir="rtl"
              className="text-muted-foreground min-w-0 flex-1 truncate text-left leading-none"
              title={displayedPath}
            >
              <bdo dir="ltr">{displayedPath}</bdo>
            </span>
            <Button
              type="button"
              variant="secondary"
              className="h-full rounded-l-none border-l border-(--flow-border) bg-(--flow-bg-control-active) hover:bg-(--flow-bg-control-hover)"
              onClick={changeFolder}
            >
              {t('home.folder_import.change_folder')}
            </Button>
          </div>
          {scanError && <div className="text-destructive text-base">{scanError}</div>}
        </section>

        <section className="space-y-1">
          <h3 className="text-muted-foreground leading-none font-medium">{t('home.folder_import.search_scope')}</h3>
          <CheckRow
            id={`${id}-recursive`}
            label={t('home.folder_import.include_subfolders')}
            checked={recursive}
            onCheckedChange={(checked) => {
              setScanResult(undefined)
              setScanError('')
              setRecursive(checked)
              if (!checked) {
                setTagIntermediateDirectories(false)
                setTagDirectDirectory(false)
              }
            }}
          />
        </section>

        <section className="flex min-h-8 flex-wrap items-center gap-x-5 gap-y-1">
          <h3 className="text-muted-foreground leading-none font-medium">{t('home.folder_import.formats')}</h3>
          <CheckRow
            id={`${id}-epub`}
            label="EPUB"
            trailing={epubCount === undefined ? '…' : String(epubCount)}
            checked={includeEpub}
            onCheckedChange={setIncludeEpub}
          />
          <CheckRow
            id={`${id}-txt`}
            label="TXT"
            trailing={txtCount === undefined ? '…' : String(txtCount)}
            checked={includeTxt}
            onCheckedChange={setIncludeTxt}
          />
        </section>

        <section className="space-y-1">
          <h3 className="text-muted-foreground leading-none font-medium">{t('home.folder_import.tags')}</h3>
          <div className="grid grid-cols-1 gap-x-4 sm:grid-cols-3">
            <CheckRow
              id={`${id}-tag-root`}
              label={t('home.folder_import.tag_root')}
              checked={tagRootDirectory}
              onCheckedChange={setTagRootDirectory}
            />
            <CheckRow
              id={`${id}-tag-intermediate`}
              label={t('home.folder_import.tag_intermediate')}
              checked={tagIntermediateDirectories}
              disabled={!recursive}
              onCheckedChange={setTagIntermediateDirectories}
            />
            <CheckRow
              id={`${id}-tag-direct`}
              label={t('home.folder_import.tag_direct')}
              checked={tagDirectDirectory}
              disabled={!recursive}
              onCheckedChange={setTagDirectDirectory}
            />
          </div>
        </section>

        <DialogFooter>
          <Button type="button" variant="secondary" onClick={onClose}>
            {t('home.cancel')}
          </Button>
          <Button
            type="button"
            disabled={!candidates || !selectedCandidates.length}
            onClick={() =>
              onImport({
                candidates: selectedCandidates,
                tagRules: {
                  rootDirectory: tagRootDirectory,
                  intermediateDirectories: tagIntermediateDirectories,
                  directDirectory: tagDirectDirectory,
                },
              })
            }
          >
            {t('home.import')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
