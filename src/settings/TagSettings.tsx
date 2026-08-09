import { PencilIcon, PlusIcon, SearchIcon, Trash2Icon } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { Button as UiButton } from '../components/ui/button'
import { ConfirmDialog } from '../components/ui/confirm-dialog'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/dialog'
import { Input } from '../components/ui/input'
import { useNotify } from '../components/ui/notificationContext'
import { useLibrary, useLibraryPins, useLibraryTags } from '../hooks/useLibrary'
import { useLibraryTagCreation } from '../hooks/useLibraryTagCreation'
import { useTranslation } from '../hooks/useTranslation'
import { cleanLibraryTagName, orderLibraryTags } from '../library/filters'
import { LibraryFilterChip, type LibraryFilterMenuItem } from '../library/LibraryFilterChip'
import { LibraryFilterChipButton, libraryFilterOptionsClassName } from '../library/LibraryFilterChipButton'
import { LibraryFilterInput } from '../library/LibraryFilterInput'
import { DeleteLibraryTagDialog, EditLibraryTagDialog } from '../library/LibraryTagDialogs'
import { useStringSet } from '../library/selection'
import { createTextSearchIndex, createTextSearchQuery, matchesTextSearch } from '../search/textSearch'
import { db } from '../storage/client'
import type { LibraryTagRecord } from '../storage/types'

export function TagSettings() {
  const t = useTranslation('settings.tags')
  const homeT = useTranslation('home')
  const books = useLibrary()
  const tags = useLibraryTags()
  const pins = useLibraryPins()
  const tagCreation = useLibraryTagCreation()
  const [query, setQuery] = useState('')
  const [selectedTagIds, { replace: replaceSelectedTagIds, reset: resetSelectedTagIds, toggle: toggleTag }] =
    useStringSet()
  const [editingTag, setEditingTag] = useState<LibraryTagRecord>()
  const [deletingTag, setDeletingTag] = useState<LibraryTagRecord>()
  const [confirmAction, setConfirmAction] = useState<'delete' | 'orphans'>()
  const [mergeOpen, setMergeOpen] = useState(false)
  const orderedTags = useMemo(() => orderLibraryTags(tags ?? [], pins?.tagIds), [pins?.tagIds, tags])
  const pinnedTagIds = useMemo(() => new Set(pins?.tagIds ?? []), [pins?.tagIds])
  const tagsById = useMemo(() => new Map(orderedTags.map((tag) => [tag.id, tag])), [orderedTags])
  const searchQuery = useMemo(() => createTextSearchQuery(query), [query])
  const searchIndexById = useMemo(
    () => new Map(orderedTags.map((tag) => [tag.id, createTextSearchIndex([tag.name])])),
    [orderedTags],
  )
  const visibleTags = useMemo(
    () =>
      searchQuery.length
        ? orderedTags.filter((tag) => matchesTextSearch(searchIndexById.get(tag.id) ?? [], searchQuery))
        : orderedTags,
    [orderedTags, searchIndexById, searchQuery],
  )
  const visibleTagIds = useMemo(() => new Set(visibleTags.map((tag) => tag.id)), [visibleTags])
  const allVisibleSelected = visibleTags.length > 0 && visibleTags.every((tag) => selectedTagIds.has(tag.id))
  const referencedTagIds = useMemo(() => new Set((books ?? []).flatMap((book) => book.tagIds ?? [])), [books])
  const orphanTagIds = useMemo(() => {
    const ids: string[] = []
    for (const tag of orderedTags) {
      if (!referencedTagIds.has(tag.id)) ids.push(tag.id)
    }
    return ids
  }, [orderedTags, referencedTagIds])

  useEffect(() => {
    const existingTagIds = new Set(orderedTags.map((tag) => tag.id))
    const next = [...selectedTagIds].filter((tagId) => existingTagIds.has(tagId))
    if (next.length !== selectedTagIds.size) replaceSelectedTagIds(next)
  }, [orderedTags, replaceSelectedTagIds, selectedTagIds])

  const tagMenuItems = useMemo<LibraryFilterMenuItem[]>(
    () => [
      {
        Icon: PencilIcon,
        label: homeT('context.edit'),
        onClick: (tagId) => setEditingTag(tagsById.get(tagId)),
      },
      {
        danger: true,
        Icon: Trash2Icon,
        label: homeT('delete'),
        onClick: (tagId) => setDeletingTag(tagsById.get(tagId)),
      },
    ],
    [homeT, tagsById],
  )

  const toggleVisibleTags = () => {
    const next = new Set(selectedTagIds)
    if (allVisibleSelected) visibleTagIds.forEach((tagId) => next.delete(tagId))
    else visibleTagIds.forEach((tagId) => next.add(tagId))
    replaceSelectedTagIds(next)
  }

  return (
    <div data-flow-settings-panel className="flex h-full min-h-0 flex-col gap-3">
      <div className="grid shrink-0 grid-cols-[repeat(auto-fit,minmax(min(14rem,100%),1fr))] gap-2">
        <LibraryFilterInput
          Icon={PlusIcon}
          aria-label={t('new')}
          placeholder={t('new')}
          value={tagCreation.name}
          onValueChange={tagCreation.setName}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return
            event.preventDefault()
            void tagCreation.create()
          }}
        />
        <LibraryFilterInput
          Icon={SearchIcon}
          aria-label={t('search')}
          placeholder={t('search')}
          value={query}
          onValueChange={setQuery}
          clearLabel={t('search')}
          onClear={query ? () => setQuery('') : undefined}
        />
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <UiButton
          type="button"
          size="sm"
          variant="secondary"
          aria-pressed={allVisibleSelected}
          disabled={!visibleTags.length}
          onClick={toggleVisibleTags}
        >
          {t('select_all')}
        </UiButton>
        <UiButton
          type="button"
          size="sm"
          variant="secondary"
          disabled={!selectedTagIds.size}
          onClick={resetSelectedTagIds}
        >
          {homeT('deselect_all')}
        </UiButton>
        <UiButton
          type="button"
          size="sm"
          variant="secondary"
          disabled={selectedTagIds.size < 2}
          onClick={() => setMergeOpen(true)}
        >
          {t('merge_action')}
        </UiButton>
        <UiButton
          type="button"
          size="sm"
          variant="secondary"
          disabled={!selectedTagIds.size}
          onClick={() => setConfirmAction('delete')}
        >
          {homeT('delete')}
        </UiButton>
        <UiButton
          type="button"
          size="sm"
          variant="secondary"
          className="ml-auto"
          disabled={books === undefined || !orphanTagIds.length}
          onClick={() => setConfirmAction('orphans')}
        >
          {t('clear_orphans')}
        </UiButton>
      </div>

      <div className="scroll min-h-0 flex-1 overflow-x-hidden overflow-y-auto pr-1">
        {visibleTags.length ? (
          <div className={libraryFilterOptionsClassName}>
            {visibleTags.map((tag) => (
              <LibraryFilterChip
                key={tag.id}
                value={tag.id}
                active={selectedTagIds.has(tag.id)}
                label={tag.name}
                menuItems={tagMenuItems}
                onPin={(tagId) => void db.pins.pinTag(tagId)}
                onToggle={toggleTag}
                onUnpin={(tagId) => void db.pins.unpinTag(tagId)}
                pinLabel={homeT('library_filter.pin_tag')}
                pinned={pinnedTagIds.has(tag.id)}
                unpinLabel={homeT('library_filter.unpin_tag')}
              />
            ))}
          </div>
        ) : (
          <div className="text-muted-foreground py-8 text-center text-sm">{t('no_tags')}</div>
        )}
      </div>

      {editingTag && <EditLibraryTagDialog tag={editingTag} onClose={() => setEditingTag(undefined)} />}
      {deletingTag && (
        <DeleteLibraryTagDialog
          tag={deletingTag}
          onClose={() => setDeletingTag(undefined)}
          onDeleted={() => setDeletingTag(undefined)}
        />
      )}
      {confirmAction && (
        <ConfirmDialog
          title={t(confirmAction === 'orphans' ? 'clear_orphans' : 'delete_selected')}
          description={t(
            confirmAction === 'orphans' ? 'clear_orphans_message' : 'delete_selected_message',
            confirmAction === 'orphans' ? orphanTagIds.length : selectedTagIds.size,
          )}
          cancelLabel={homeT('cancel')}
          confirmLabel={confirmAction === 'orphans' ? t('clear') : homeT('delete')}
          onClose={() => setConfirmAction(undefined)}
          onConfirm={() => {
            const deletingSelection = confirmAction === 'delete'
            void db.tags.deleteMany(deletingSelection ? [...selectedTagIds] : orphanTagIds).then(() => {
              if (deletingSelection) resetSelectedTagIds()
              setConfirmAction(undefined)
            })
          }}
        />
      )}
      {mergeOpen && (
        <MergeTagsDialog
          tags={orderedTags.filter((tag) => selectedTagIds.has(tag.id))}
          onClose={() => setMergeOpen(false)}
          onMerged={() => {
            resetSelectedTagIds()
            setMergeOpen(false)
          }}
        />
      )}
    </div>
  )
}

interface MergeTagsDialogProps {
  onClose: () => void
  onMerged: () => void
  tags: LibraryTagRecord[]
}

function MergeTagsDialog({ onClose, onMerged, tags }: MergeTagsDialogProps) {
  const t = useTranslation('settings.tags')
  const homeT = useTranslation('home')
  const notify = useNotify()
  const [targetId, setTargetId] = useState(tags[0]?.id)
  const [name, setName] = useState('')
  const cleanName = cleanLibraryTagName(name)

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="w-[min(28rem,calc(100vw-2rem))] max-w-none text-base">
        <DialogHeader>
          <DialogTitle>{t('merge')}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-2">
          <span className="text-muted-foreground leading-none font-medium">{t('merge_target')}</span>
          <div className={libraryFilterOptionsClassName}>
            {tags.map((tag) => (
              <LibraryFilterChipButton
                key={tag.id}
                label={tag.name}
                state={targetId === tag.id ? 'active' : 'inactive'}
                aria-pressed={targetId === tag.id}
                onClick={() => {
                  setTargetId(tag.id)
                  setName('')
                }}
              />
            ))}
          </div>
        </div>
        <label className="grid gap-2">
          <span className="text-muted-foreground leading-none font-medium">{t('merge_name')}</span>
          <Input
            value={name}
            onValueChange={(value) => {
              setName(value)
              setTargetId(undefined)
            }}
            className="focus-visible:border-input text-base focus-visible:ring-0"
          />
        </label>
        <DialogFooter>
          <UiButton type="button" variant="secondary" onClick={onClose}>
            {homeT('cancel')}
          </UiButton>
          <UiButton
            type="button"
            disabled={!targetId && !cleanName}
            onClick={() => {
              void db.tags
                .merge(
                  tags.map((tag) => tag.id),
                  targetId ? { id: targetId } : { name: cleanName },
                )
                .then(onMerged)
                .catch((error) => {
                  console.error(error)
                  notify({ type: 'error', title: t('merge_error') })
                })
            }}
          >
            {t('merge_action')}
          </UiButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
