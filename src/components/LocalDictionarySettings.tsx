import {
  ArrowDownIcon,
  ArrowUpIcon,
  FolderSearchIcon,
  PlusIcon,
  Trash2Icon,
} from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import {
  listLocalDictionaries,
  type LocalDictionaryLanguage,
  type LocalDictionaryRecord,
  registerLocalDictionary,
  relocateLocalDictionary,
  removeLocalDictionary,
  updateLocalDictionary,
} from '../dictionary/native'
import { formatLocalPathForDisplay } from '../dictionary/path'
import { useTranslation } from '../hooks/useTranslation'

import { Button as UiButton } from './ui/button'
import { Checkbox as UiCheckbox } from './ui/checkbox'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/select'

export function LocalDictionarySettings() {
  const t = useTranslation('settings')
  const [dictionaries, setDictionaries] = useState<LocalDictionaryRecord[]>([])
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(true)
  const [confirmRemoveId, setConfirmRemoveId] = useState<string>()

  const refresh = useCallback(async () => {
    try {
      const records = await listLocalDictionaries()
      setDictionaries(sortDictionaries(records))
      setError(undefined)
    } catch (reason) {
      setError(errorMessage(reason, t('dictionary.local_error')))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const chooseMasterFile = async () => {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const selected = await open({
      directory: false,
      multiple: false,
      filters: [
        { name: t('dictionary.local_file_filter'), extensions: ['ifo', 'mdx'] },
      ],
    })
    return Array.isArray(selected) ? selected[0] : selected
  }

  const addDictionary = async () => {
    try {
      const path = await chooseMasterFile()
      if (!path) return
      const record = await registerLocalDictionary(path)
      setDictionaries((current) =>
        sortDictionaries(upsertDictionary(current, record)),
      )
      setError(undefined)
    } catch (reason) {
      setError(errorMessage(reason, t('dictionary.local_error')))
    }
  }

  const updateRecord = async (
    id: string,
    changes: { enabled?: boolean; language?: LocalDictionaryLanguage },
  ) => {
    try {
      const record = await updateLocalDictionary(id, changes)
      setDictionaries((current) => upsertDictionary(current, record))
      setError(undefined)
    } catch (reason) {
      setError(errorMessage(reason, t('dictionary.local_error')))
    }
  }

  const moveDictionary = async (index: number, direction: -1 | 1) => {
    const targetIndex = index + direction
    if (targetIndex < 0 || targetIndex >= dictionaries.length) return
    const current = dictionaries[index]
    const target = dictionaries[targetIndex]
    if (!current || !target) return

    try {
      const [moved, displaced] = await Promise.all([
        updateLocalDictionary(current.id, { order: target.order }),
        updateLocalDictionary(target.id, { order: current.order }),
      ])
      setDictionaries((records) =>
        sortDictionaries(
          upsertDictionary(upsertDictionary(records, moved), displaced),
        ),
      )
      setError(undefined)
    } catch (reason) {
      setError(errorMessage(reason, t('dictionary.local_error')))
    }
  }

  const relocate = async (id: string) => {
    try {
      const path = await chooseMasterFile()
      if (!path) return
      const record = await relocateLocalDictionary(id, path)
      setDictionaries((current) => upsertDictionary(current, record))
      setError(undefined)
    } catch (reason) {
      setError(errorMessage(reason, t('dictionary.local_error')))
    }
  }

  const remove = async (id: string) => {
    if (confirmRemoveId !== id) {
      setConfirmRemoveId(id)
      return
    }
    try {
      await removeLocalDictionary(id)
      setDictionaries((current) =>
        current.filter((dictionary) => dictionary.id !== id),
      )
      setConfirmRemoveId(undefined)
      setError(undefined)
    } catch (reason) {
      setError(errorMessage(reason, t('dictionary.local_error')))
    }
  }

  return (
    <section className="border-border min-w-0 space-y-4 border-t pt-5">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="min-w-0 flex-[1_1_28rem]">
          <h3 className="text-base font-semibold">
            {t('dictionary.local_title')}
          </h3>
          <p className="text-muted-foreground mt-1 max-w-xl text-sm leading-relaxed">
            {t('dictionary.local_description')}
          </p>
        </div>
        <UiButton
          type="button"
          size="sm"
          className="ml-auto h-8 max-w-full shrink-0 gap-1.5 rounded-lg px-3"
          onClick={() => void addDictionary()}
        >
          <PlusIcon className="size-4" />
          {t('dictionary.local_add')}
        </UiButton>
      </div>

      {error && (
        <div
          role="alert"
          className="border-destructive/40 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-sm"
        >
          {error}
        </div>
      )}

      {loading ? (
        <div role="status" className="text-muted-foreground py-4 text-sm">
          {t('dictionary.local_loading')}
        </div>
      ) : dictionaries.length === 0 ? (
        <div className="border-border text-muted-foreground rounded-md border border-dashed px-4 py-5 text-sm">
          {t('dictionary.local_empty')}
        </div>
      ) : (
        <div className="border-border divide-border max-w-full min-w-0 divide-y overflow-hidden rounded-md border">
          {dictionaries.map((dictionary, index) => (
            <div
              key={dictionary.id}
              className="min-w-0 bg-[var(--flow-bg)] px-3 py-3"
              data-local-dictionary-id={dictionary.id}
            >
              <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
                <UiCheckbox
                  aria-label={`${t('dictionary.local_enable')} ${dictionary.name}`}
                  checked={dictionary.enabled}
                  onCheckedChange={(value) =>
                    void updateRecord(dictionary.id, {
                      enabled: value === true,
                    })
                  }
                />
                <div className="min-w-0 flex-[1_1_18rem]">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 truncate text-base font-medium">
                      {dictionary.name}
                    </span>
                    <span className="bg-muted text-muted-foreground shrink-0 rounded px-1.5 py-0.5 text-xs uppercase">
                      {dictionary.format}
                    </span>
                    <span
                      className={
                        dictionary.sourceStatus === 'available'
                          ? 'text-muted-foreground shrink-0 text-xs'
                          : 'text-destructive shrink-0 text-xs'
                      }
                    >
                      {t(`dictionary.local_status.${dictionary.sourceStatus}`)}
                    </span>
                  </div>
                  <div
                    className="text-muted-foreground mt-0.5 truncate text-xs"
                    title={formatLocalPathForDisplay(dictionary.sourcePath)}
                  >
                    {formatLocalPathForDisplay(dictionary.sourcePath)}
                  </div>
                </div>
                <Select
                  value={dictionary.language.value}
                  onValueChange={(value) =>
                    void updateRecord(dictionary.id, {
                      language: value as LocalDictionaryLanguage,
                    })
                  }
                >
                  <SelectTrigger
                    aria-label={`${t('dictionary.local_language')} ${dictionary.name}`}
                    className="h-8 w-28 shrink-0 rounded-lg"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(['unknown', 'zh', 'en'] as const).map((language) => (
                      <SelectItem key={language} value={language}>
                        {t(`dictionary.local_language.${language}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <div className="flex shrink-0 items-center gap-0.5">
                  <UiButton
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`${t('dictionary.local_move_up')} ${dictionary.name}`}
                    disabled={index === 0}
                    onClick={() => void moveDictionary(index, -1)}
                  >
                    <ArrowUpIcon className="size-4" />
                  </UiButton>
                  <UiButton
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`${t('dictionary.local_move_down')} ${dictionary.name}`}
                    disabled={index === dictionaries.length - 1}
                    onClick={() => void moveDictionary(index, 1)}
                  >
                    <ArrowDownIcon className="size-4" />
                  </UiButton>
                  <UiButton
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`${t('dictionary.local_relocate')} ${dictionary.name}`}
                    onClick={() => void relocate(dictionary.id)}
                  >
                    <FolderSearchIcon className="size-4" />
                  </UiButton>
                  <UiButton
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className={
                      confirmRemoveId === dictionary.id
                        ? 'text-destructive ring-destructive/40 ring-1'
                        : undefined
                    }
                    aria-label={`${
                      confirmRemoveId === dictionary.id
                        ? t('dictionary.local_confirm_remove')
                        : t('dictionary.local_remove')
                    } ${dictionary.name}`}
                    onBlur={() => setConfirmRemoveId(undefined)}
                    onClick={() => void remove(dictionary.id)}
                  >
                    <Trash2Icon className="size-4" />
                  </UiButton>
                </div>
              </div>
              <div className="text-muted-foreground mt-2 pl-7 text-xs">
                {t('dictionary.local_language_source')}:{' '}
                {t(
                  `dictionary.local_language_source.${dictionary.language.source}`,
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

function upsertDictionary(
  dictionaries: LocalDictionaryRecord[],
  record: LocalDictionaryRecord,
) {
  const index = dictionaries.findIndex(
    (dictionary) => dictionary.id === record.id,
  )
  if (index < 0) return [...dictionaries, record]
  return dictionaries.map((dictionary) =>
    dictionary.id === record.id ? record : dictionary,
  )
}

function sortDictionaries(dictionaries: LocalDictionaryRecord[]) {
  return [...dictionaries].sort(
    (left, right) =>
      left.order - right.order || left.createdAt - right.createdAt,
  )
}

function errorMessage(reason: unknown, fallback: string) {
  if (reason instanceof Error && reason.message) return reason.message
  if (
    typeof reason === 'object' &&
    reason !== null &&
    'message' in reason &&
    typeof reason.message === 'string'
  ) {
    return reason.message
  }
  return fallback
}
