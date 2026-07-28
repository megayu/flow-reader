import {
  CheckIcon,
  ExternalLinkIcon,
  EyeIcon,
  EyeOffIcon,
  FolderSearchIcon,
  GripVerticalIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { Button as UiButton } from '@/components/ui/button'
import { Checkbox as UiCheckbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import {
  type LocalDictionaryLanguage,
  type LocalDictionaryRecord,
  type LocalDictionaryUpdate,
  listLocalDictionaries,
  registerLocalDictionary,
  relocateLocalDictionary,
  removeLocalDictionary,
  updateLocalDictionary,
} from '@/dictionary/native'
import { formatLocalPathForDisplay } from '@/dictionary/path'
import {
  localDictionarySourceId,
  merriamWebsterSourceId,
  reconcileDictionarySourceOrder,
  zdicSourceId,
} from '@/dictionary/sourceOrder'
import { supportedDictionaryLanguages } from '@/dictionary/types'
import { openSupportedExternalUrl } from '@/externalLink'
import { useTranslation } from '@/hooks/useTranslation'
import { defaultDictionarySettings, type SetterOrUpdater, type Settings } from '@/state'

const languageLabels: Record<LocalDictionaryLanguage, string> = {
  de: 'Deutsch',
  en: 'English',
  es: 'Español',
  fr: 'Français',
  it: 'Italiano',
  ja: '日本語',
  ko: '한국어',
  nl: 'Nederlands',
  pl: 'Polski',
  pt: 'Português',
  ru: 'Русский',
  zh: '中文',
}

type DictionarySource =
  | { id: typeof zdicSourceId; kind: 'zdic' }
  | { id: typeof merriamWebsterSourceId; kind: 'merriam-webster' }
  | { id: string; kind: 'local'; dictionary: LocalDictionaryRecord }

interface LocalDictionarySettingsProps {
  settings: Settings
  setSettings: SetterOrUpdater<Settings>
}

export function LocalDictionarySettings({ settings, setSettings }: LocalDictionarySettingsProps) {
  const t = useTranslation('settings')
  const [dictionaries, setDictionaries] = useState<LocalDictionaryRecord[]>([])
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(true)
  const [confirmRemoveId, setConfirmRemoveId] = useState<string>()
  const [editingSourceId, setEditingSourceId] = useState<string>()
  const [localNameDraft, setLocalNameDraft] = useState('')
  const [localLanguagesDraft, setLocalLanguagesDraft] = useState<LocalDictionaryLanguage[]>([])
  const [merriamWebsterKey, setMerriamWebsterKey] = useState('')
  const [showMerriamWebsterKey, setShowMerriamWebsterKey] = useState(false)
  const draggedSourceIdRef = useRef<string | undefined>(undefined)
  const dropTargetRef = useRef<{ after: boolean; sourceId: string } | undefined>(undefined)
  const [dropTarget, setDropTarget] = useState<{
    after: boolean
    sourceId: string
  }>()
  const dictionarySettings = {
    ...defaultDictionarySettings,
    ...settings.dictionary,
    zdic: {
      ...defaultDictionarySettings.zdic,
      ...settings.dictionary?.zdic,
    },
    merriamWebster: {
      ...defaultDictionarySettings.merriamWebster,
      ...settings.dictionary?.merriamWebster,
    },
  }
  const sourceOrder = useMemo(
    () =>
      reconcileDictionarySourceOrder(
        dictionarySettings.sourceOrder,
        dictionaries.map((dictionary) => dictionary.id),
      ),
    [dictionaries, dictionarySettings.sourceOrder],
  )
  const sources = useMemo(() => {
    const sourceById = new Map<string, DictionarySource>([
      [zdicSourceId, { id: zdicSourceId, kind: 'zdic' }],
      [merriamWebsterSourceId, { id: merriamWebsterSourceId, kind: 'merriam-webster' }],
      ...dictionaries.map(
        (dictionary) =>
          [
            localDictionarySourceId(dictionary.id),
            {
              id: localDictionarySourceId(dictionary.id),
              kind: 'local',
              dictionary,
            },
          ] as const,
      ),
    ])
    return sourceOrder.flatMap((sourceId) => {
      const source = sourceById.get(sourceId)
      return source ? [source] : []
    })
  }, [dictionaries, sourceOrder])

  const updateDictionarySettings = useCallback(
    (changes: Partial<typeof defaultDictionarySettings>) => {
      setSettings((current) => ({
        ...current,
        dictionary: {
          ...defaultDictionarySettings,
          ...current.dictionary,
          ...changes,
        },
      }))
    },
    [setSettings],
  )

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
      filters: [{ name: t('dictionary.local_file_filter'), extensions: ['ifo', 'mdx'] }],
    })
    return Array.isArray(selected) ? selected[0] : selected
  }

  const addDictionary = async () => {
    try {
      const path = await chooseMasterFile()
      if (!path) return
      const record = await registerLocalDictionary(path)
      setDictionaries((current) => sortDictionaries(upsertDictionary(current, record)))
      updateDictionarySettings({
        sourceOrder: [
          ...sourceOrder.filter((sourceId) => sourceId !== localDictionarySourceId(record.id)),
          localDictionarySourceId(record.id),
        ],
      })
      setError(undefined)
    } catch (reason) {
      setError(errorMessage(reason, t('dictionary.local_error')))
    }
  }

  const updateRecord = async (id: string, changes: LocalDictionaryUpdate) => {
    const previous = dictionaries.find((dictionary) => dictionary.id === id)
    if (previous) {
      setDictionaries((current) => upsertDictionary(current, applyLocalDictionaryUpdate(previous, changes)))
    }
    try {
      const record = await updateLocalDictionary(id, changes)
      setDictionaries((current) => upsertDictionary(current, record))
      setError(undefined)
    } catch (reason) {
      if (previous) {
        setDictionaries((current) => upsertDictionary(current, previous))
      }
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
      setDictionaries((current) => current.filter((dictionary) => dictionary.id !== id))
      updateDictionarySettings({
        sourceOrder: sourceOrder.filter((sourceId) => sourceId !== localDictionarySourceId(id)),
      })
      setConfirmRemoveId(undefined)
      setEditingSourceId(undefined)
      setError(undefined)
    } catch (reason) {
      setError(errorMessage(reason, t('dictionary.local_error')))
    }
  }

  const commitMerriamWebsterKey = () => {
    const apiKey = merriamWebsterKey.trim()
    updateDictionarySettings({
      merriamWebster: {
        apiKey,
        enabled: apiKey ? dictionarySettings.merriamWebster.enabled : false,
      },
    })
    setMerriamWebsterKey(apiKey)
  }

  const saveEditing = (sourceId = editingSourceId) => {
    if (!sourceId) return
    if (sourceId === merriamWebsterSourceId) {
      commitMerriamWebsterKey()
    } else {
      const dictionary = dictionaries.find((current) => localDictionarySourceId(current.id) === sourceId)
      const name = localNameDraft.trim()
      if (dictionary) {
        const changes: LocalDictionaryUpdate = {}
        if (name && name !== dictionary.name) changes.name = name
        if (!sameLanguages(localLanguagesDraft, dictionary.language.value)) {
          changes.language = localLanguagesDraft
          if (localLanguagesDraft.length === 0) changes.enabled = false
        }
        if (Object.keys(changes).length > 0) {
          void updateRecord(dictionary.id, changes)
        }
      }
    }
    setEditingSourceId(undefined)
  }

  const cancelEditing = (sourceId = editingSourceId) => {
    setEditingSourceId((current) => (current === sourceId ? undefined : current))
  }

  const editMerriamWebster = () => {
    if (editingSourceId && editingSourceId !== merriamWebsterSourceId) {
      cancelEditing()
    }
    setMerriamWebsterKey(dictionarySettings.merriamWebster.apiKey)
    setEditingSourceId(merriamWebsterSourceId)
  }

  const editLocalDictionary = (dictionary: LocalDictionaryRecord) => {
    const sourceId = localDictionarySourceId(dictionary.id)
    if (editingSourceId && editingSourceId !== sourceId) {
      cancelEditing()
    }
    setLocalNameDraft(dictionary.name)
    setLocalLanguagesDraft([...dictionary.language.value])
    setEditingSourceId(sourceId)
  }

  const moveSource = (targetSourceId: string, after: boolean) => {
    const draggedSourceId = draggedSourceIdRef.current
    if (!draggedSourceId || draggedSourceId === targetSourceId) return
    const next = sourceOrder.filter((sourceId) => sourceId !== draggedSourceId)
    const targetIndex = next.indexOf(targetSourceId)
    const insertionIndex = targetIndex < 0 ? next.length : targetIndex + (after ? 1 : 0)
    next.splice(insertionIndex, 0, draggedSourceId)
    updateDictionarySettings({ sourceOrder: next })
  }

  const updateDragTarget = (clientX: number, clientY: number) => {
    const targetRow = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>('[data-dictionary-source-id]')
    const sourceId = targetRow?.dataset.dictionarySourceId
    if (!targetRow || !sourceId || sourceId === draggedSourceIdRef.current) {
      dropTargetRef.current = undefined
      setDropTarget(undefined)
      return
    }
    const bounds = targetRow.getBoundingClientRect()
    const nextTarget = {
      after: clientY >= bounds.top + bounds.height / 2,
      sourceId,
    }
    if (dropTargetRef.current?.sourceId === nextTarget.sourceId && dropTargetRef.current.after === nextTarget.after) {
      return
    }
    dropTargetRef.current = nextTarget
    setDropTarget(nextTarget)
  }

  const finishDrag = () => {
    const target = dropTargetRef.current
    if (target) moveSource(target.sourceId, target.after)
    draggedSourceIdRef.current = undefined
    dropTargetRef.current = undefined
    setDropTarget(undefined)
  }

  return (
    <section
      className="w-full max-w-full min-w-0 space-y-3 overflow-hidden"
      onPointerDownCapture={(event) => {
        if (!editingSourceId || !(event.target instanceof Element)) return
        const targetSourceId = event.target
          .closest('[data-dictionary-source-id]')
          ?.getAttribute('data-dictionary-source-id')
        if (!targetSourceId) {
          cancelEditing()
        }
      }}
    >
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1">
        <h3 className="text-base font-semibold">{t('dictionary.sources_title')}</h3>
        <UiButton type="button" size="sm" className="h-8 shrink-0 gap-1.5 px-3" onClick={() => void addDictionary()}>
          <PlusIcon className="size-4" />
          {t('dictionary.local_add')}
        </UiButton>
        <p className="text-muted-foreground col-span-2 text-sm leading-relaxed">
          {t('dictionary.sources_description')}
        </p>
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
      ) : (
        <div className="border-border divide-border w-full max-w-full min-w-0 divide-y overflow-hidden rounded-md border">
          {sources.map((source) => (
            <DictionarySourceRow
              key={source.id}
              source={source}
              editing={editingSourceId === source.id}
              dropAfter={dropTarget?.sourceId === source.id ? dropTarget.after : undefined}
              dictionarySettings={dictionarySettings}
              localNameDraft={localNameDraft}
              localLanguagesDraft={localLanguagesDraft}
              merriamWebsterKey={merriamWebsterKey}
              showMerriamWebsterKey={showMerriamWebsterKey}
              confirmRemoveId={confirmRemoveId}
              t={t}
              onDragStart={(sourceId) => {
                draggedSourceIdRef.current = sourceId
              }}
              onDragMove={updateDragTarget}
              onDragEnd={finishDrag}
              onDragCancel={() => {
                draggedSourceIdRef.current = undefined
                dropTargetRef.current = undefined
                setDropTarget(undefined)
              }}
              onEditMerriamWebster={editMerriamWebster}
              onEditLocal={editLocalDictionary}
              onSaveEdit={() => saveEditing(source.id)}
              onCancelEdit={() => cancelEditing(source.id)}
              onLocalNameChange={setLocalNameDraft}
              onLocalLanguagesChange={setLocalLanguagesDraft}
              onMerriamWebsterKeyChange={setMerriamWebsterKey}
              onShowMerriamWebsterKeyChange={setShowMerriamWebsterKey}
              onUpdateDictionarySettings={updateDictionarySettings}
              onUpdateRecord={updateRecord}
              onRelocate={relocate}
              onRemove={remove}
              onConfirmRemoveChange={setConfirmRemoveId}
            />
          ))}
        </div>
      )}
    </section>
  )
}

type Translation = ReturnType<typeof useTranslation>

interface DictionarySourceRowProps {
  source: DictionarySource
  editing: boolean
  dropAfter?: boolean
  dictionarySettings: typeof defaultDictionarySettings
  localNameDraft: string
  localLanguagesDraft: LocalDictionaryLanguage[]
  merriamWebsterKey: string
  showMerriamWebsterKey: boolean
  confirmRemoveId?: string
  t: Translation
  onDragStart: (sourceId: string) => void
  onDragMove: (clientX: number, clientY: number) => void
  onDragEnd: () => void
  onDragCancel: () => void
  onEditMerriamWebster: () => void
  onEditLocal: (dictionary: LocalDictionaryRecord) => void
  onSaveEdit: () => void
  onCancelEdit: () => void
  onLocalNameChange: (value: string) => void
  onLocalLanguagesChange: (value: LocalDictionaryLanguage[]) => void
  onMerriamWebsterKeyChange: (value: string) => void
  onShowMerriamWebsterKeyChange: (value: boolean) => void
  onUpdateDictionarySettings: (changes: Partial<typeof defaultDictionarySettings>) => void
  onUpdateRecord: (id: string, changes: LocalDictionaryUpdate) => Promise<void>
  onRelocate: (id: string) => Promise<void>
  onRemove: (id: string) => Promise<void>
  onConfirmRemoveChange: (id: string | undefined) => void
}

function DictionarySourceRow({
  source,
  editing,
  dropAfter,
  dictionarySettings,
  localNameDraft,
  localLanguagesDraft,
  merriamWebsterKey,
  showMerriamWebsterKey,
  confirmRemoveId,
  t,
  onDragStart,
  onDragMove,
  onDragEnd,
  onDragCancel,
  onEditMerriamWebster,
  onEditLocal,
  onSaveEdit,
  onCancelEdit,
  onLocalNameChange,
  onLocalLanguagesChange,
  onMerriamWebsterKeyChange,
  onShowMerriamWebsterKeyChange,
  onUpdateDictionarySettings,
  onUpdateRecord,
  onRelocate,
  onRemove,
  onConfirmRemoveChange,
}: DictionarySourceRowProps) {
  const local = source.kind === 'local' ? source.dictionary : undefined
  const name =
    source.kind === 'zdic' ? '汉典' : source.kind === 'merriam-webster' ? 'Merriam-Webster' : source.dictionary.name
  const configured = Boolean(dictionarySettings.merriamWebster.apiKey)
  const localEligible = Boolean(local?.language.value.length && local.sourceStatus === 'available')
  const checked =
    source.kind === 'zdic'
      ? dictionarySettings.zdic.enabled
      : source.kind === 'merriam-webster'
        ? configured && dictionarySettings.merriamWebster.enabled
        : Boolean(local?.enabled && localEligible)
  const disabled = source.kind === 'merriam-webster' ? !configured : source.kind === 'local' ? !localEligible : false

  return (
    <div
      data-dictionary-source-id={source.id}
      data-local-dictionary-id={local?.id}
      className="relative w-full max-w-full min-w-0 overflow-hidden bg-(--flow-bg) px-3 py-3"
    >
      {dropAfter !== undefined && (
        <span
          className={`pointer-events-none absolute right-0 left-0 z-10 h-0.5 bg-(--flow-accent) ${
            dropAfter ? 'bottom-0' : 'top-0'
          }`}
        />
      )}
      <div className="flex w-full max-w-full min-w-0 items-center gap-3 overflow-hidden">
        <UiCheckbox
          checked={checked}
          disabled={disabled}
          onCheckedChange={(value) => {
            const enabled = value === true
            if (source.kind === 'zdic') {
              onUpdateDictionarySettings({ zdic: { enabled } })
            } else if (source.kind === 'merriam-webster') {
              onUpdateDictionarySettings({
                merriamWebster: {
                  ...dictionarySettings.merriamWebster,
                  enabled,
                },
              })
            } else {
              void onUpdateRecord(source.dictionary.id, { enabled })
            }
          }}
        />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-base font-medium">{name}</span>
            {source.kind !== 'zdic' && (
              <UiButton
                type="button"
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground size-7"
                onClick={() => {
                  if (editing) {
                    onSaveEdit()
                  } else if (source.kind === 'merriam-webster') {
                    onEditMerriamWebster()
                  } else {
                    onEditLocal(source.dictionary)
                  }
                }}
              >
                {editing ? <CheckIcon className="size-3.5" /> : <PencilIcon className="size-3.5" />}
              </UiButton>
            )}
            {source.kind === 'local' && (
              <span className="bg-muted text-muted-foreground shrink-0 rounded px-1.5 py-0.5 text-xs uppercase">
                {source.dictionary.format}
              </span>
            )}
            {(source.kind === 'zdic' || source.kind === 'merriam-webster') && (
              <span className="bg-muted text-muted-foreground shrink-0 rounded px-1.5 py-0.5 text-xs uppercase">
                {t('dictionary.online')}
              </span>
            )}
          </div>
          <div className="text-muted-foreground mt-0.5 truncate text-sm">
            {source.kind === 'zdic'
              ? '中文'
              : source.kind === 'merriam-webster'
                ? `English · Collegiate Dictionary · ${t(
                    configured ? 'dictionary.configured' : 'dictionary.not_configured',
                  )}`
                : localMetadata(source.dictionary, t, editing ? localLanguagesDraft : undefined)}
          </div>
        </div>
        <span
          data-dictionary-drag-handle
          data-dragging="false"
          className="text-muted-foreground flex size-7 shrink-0 cursor-grab items-center justify-center rounded-sm hover:bg-(--flow-bg-control-hover) active:cursor-grabbing"
          onPointerDown={(event) => {
            if (event.button !== 0) return
            event.preventDefault()
            event.currentTarget.setPointerCapture(event.pointerId)
            event.currentTarget.dataset.dragging = 'true'
            onDragStart(source.id)
          }}
          onPointerMove={(event) => {
            if (event.currentTarget.dataset.dragging !== 'true') return
            onDragMove(event.clientX, event.clientY)
          }}
          onPointerUp={(event) => {
            if (event.currentTarget.dataset.dragging !== 'true') return
            event.currentTarget.dataset.dragging = 'false'
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId)
            }
            onDragEnd()
          }}
          onPointerCancel={(event) => {
            event.currentTarget.dataset.dragging = 'false'
            onDragCancel()
          }}
        >
          <GripVerticalIcon className="size-4" />
        </span>
      </div>

      {editing && source.kind === 'merriam-webster' && (
        <div
          data-merriam-webster-key-row
          className="mt-3 flex w-full max-w-full min-w-0 items-center gap-2 overflow-hidden pl-7"
        >
          <div className="relative min-w-0 flex-1">
            <Input
              autoFocus
              type={showMerriamWebsterKey ? 'text' : 'password'}
              className="w-full max-w-full pr-9"
              data-dictionary-inline-editor
              value={merriamWebsterKey}
              onChange={(event) => onMerriamWebsterKeyChange(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  onSaveEdit()
                }
                if (event.key === 'Escape') {
                  event.preventDefault()
                  event.stopPropagation()
                  onCancelEdit()
                }
              }}
            />
            <UiButton
              type="button"
              variant="ghost"
              size="icon-sm"
              className="absolute top-0.5 right-0.5 size-7"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onShowMerriamWebsterKeyChange(!showMerriamWebsterKey)}
            >
              {showMerriamWebsterKey ? <EyeOffIcon className="size-4" /> : <EyeIcon className="size-4" />}
            </UiButton>
          </div>
          <UiButton
            type="button"
            variant="ghost"
            size="sm"
            className="text-muted-foreground ml-auto h-8 shrink-0 gap-1.5 px-2"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              void openSupportedExternalUrl('https://dictionaryapi.com/').catch(() => undefined)
            }}
          >
            {t('dictionary.get_api_key')}
            <ExternalLinkIcon className="size-4" />
          </UiButton>
        </div>
      )}

      {editing && source.kind === 'local' && (
        <LocalDictionaryEditor
          dictionary={source.dictionary}
          name={localNameDraft}
          languages={localLanguagesDraft}
          confirmRemoveId={confirmRemoveId}
          onCancel={onCancelEdit}
          onSave={onSaveEdit}
          onNameChange={onLocalNameChange}
          onLanguagesChange={onLocalLanguagesChange}
          onRelocate={onRelocate}
          onRemove={onRemove}
          onConfirmRemoveChange={onConfirmRemoveChange}
        />
      )}
    </div>
  )
}

function LocalDictionaryEditor({
  dictionary,
  name,
  languages,
  confirmRemoveId,
  onCancel,
  onSave,
  onNameChange,
  onLanguagesChange,
  onRelocate,
  onRemove,
  onConfirmRemoveChange,
}: {
  dictionary: LocalDictionaryRecord
  name: string
  languages: LocalDictionaryLanguage[]
  confirmRemoveId?: string
  onCancel: () => void
  onSave: () => void
  onNameChange: (value: string) => void
  onLanguagesChange: (value: LocalDictionaryLanguage[]) => void
  onRelocate: (id: string) => Promise<void>
  onRemove: (id: string) => Promise<void>
  onConfirmRemoveChange: (id: string | undefined) => void
}) {
  const selectedLanguages = new Set(languages)

  return (
    <div className="border-border mt-3 w-full max-w-full min-w-0 space-y-2 overflow-hidden border-t pt-3 pl-7">
      <Input
        autoFocus
        className="w-full max-w-full"
        data-dictionary-inline-editor
        data-local-dictionary-name-editor
        value={name}
        onChange={(event) => onNameChange(event.currentTarget.value)}
        onFocus={(event) => event.currentTarget.select()}
        onKeyDown={(event) => {
          if (event.key === 'Enter') onSave()
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            onCancel()
          }
        }}
      />
      <div className="grid w-full max-w-full min-w-0 grid-cols-4 gap-x-2 gap-y-0.5 overflow-hidden">
        {supportedDictionaryLanguages.map((language) => {
          const checked = selectedLanguages.has(language)
          return (
            <label
              key={language}
              className="flex h-7 min-w-0 cursor-pointer items-center gap-1.5 rounded-sm px-1.5 hover:bg-(--flow-bg-control-hover)"
            >
              <UiCheckbox
                checked={checked}
                onCheckedChange={() => {
                  onLanguagesChange(
                    checked ? languages.filter((current) => current !== language) : [...languages, language],
                  )
                }}
              />
              <span className="truncate">{languageLabels[language]}</span>
            </label>
          )
        })}
      </div>
      <div className="flex min-w-0 items-center gap-2">
        <span
          className="text-muted-foreground min-w-0 flex-1 truncate text-xs"
          title={formatLocalPathForDisplay(dictionary.sourcePath)}
        >
          {formatLocalPathForDisplay(dictionary.sourcePath)}
        </span>
        <UiButton type="button" variant="ghost" size="icon-sm" onClick={() => void onRelocate(dictionary.id)}>
          <FolderSearchIcon className="size-4" />
        </UiButton>
        <UiButton
          type="button"
          variant={confirmRemoveId === dictionary.id ? 'destructive' : 'ghost'}
          size="icon-sm"
          onBlur={() => onConfirmRemoveChange(undefined)}
          onClick={() => void onRemove(dictionary.id)}
        >
          {confirmRemoveId === dictionary.id ? <CheckIcon className="size-4" /> : <Trash2Icon className="size-4" />}
        </UiButton>
      </div>
    </div>
  )
}

function localMetadata(dictionary: LocalDictionaryRecord, t: Translation, languageDraft?: LocalDictionaryLanguage[]) {
  const languages = (languageDraft ?? dictionary.language.value).map((language) => languageLabels[language])
  const language = languages.length > 0 ? languages.join(', ') : t('dictionary.local_language.unknown')
  const status =
    dictionary.sourceStatus === 'available' ? '' : ` · ${t(`dictionary.local_status.${dictionary.sourceStatus}`)}`
  return `${language} · ${formatLocalPathForDisplay(dictionary.sourcePath)}${status}`
}

function applyLocalDictionaryUpdate(
  dictionary: LocalDictionaryRecord,
  changes: LocalDictionaryUpdate,
): LocalDictionaryRecord {
  return {
    ...dictionary,
    ...(changes.enabled === undefined ? {} : { enabled: changes.enabled }),
    ...(changes.name === undefined ? {} : { name: changes.name }),
    ...(changes.language === undefined
      ? {}
      : {
          language: {
            source: 'manual' as const,
            value: changes.language,
          },
        }),
  }
}

function sameLanguages(left: readonly LocalDictionaryLanguage[], right: readonly LocalDictionaryLanguage[]) {
  return left.length === right.length && left.every((language, index) => language === right[index])
}

function upsertDictionary(dictionaries: LocalDictionaryRecord[], record: LocalDictionaryRecord) {
  const index = dictionaries.findIndex((dictionary) => dictionary.id === record.id)
  if (index < 0) return [...dictionaries, record]
  return dictionaries.map((dictionary) => (dictionary.id === record.id ? record : dictionary))
}

function sortDictionaries(dictionaries: LocalDictionaryRecord[]) {
  return [...dictionaries].sort((left, right) => left.order - right.order || left.createdAt - right.createdAt)
}

function errorMessage(reason: unknown, fallback: string) {
  if (reason instanceof Error && reason.message) return reason.message
  if (typeof reason === 'object' && reason !== null && 'message' in reason && typeof reason.message === 'string') {
    return reason.message
  }
  return fallback
}
