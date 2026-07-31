import clsx from 'clsx'
import React, { useCallback, useMemo, useRef, useState } from 'react'

import { cleanBookText, getBookDisplayTitle } from '../book'
import { Button as UiButton } from '../components/ui/button'
import { ConfirmDialog } from '../components/ui/confirm-dialog'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/dialog'
import { Input } from '../components/ui/input'
import { formatLocalDirectoryForDisplay } from '../dictionary/path'
import { useLibraryTags } from '../hooks/useLibrary'
import { useTranslation } from '../hooks/useTranslation'
import { type BookRecord, db, type LibraryTagRecord } from '../storage'

import { cleanLibraryTagName, sameLibraryTagName } from './filters'
import {
  cleanBookDescription,
  formatDateTime,
  formatFileSize,
  formatLanguage,
  formatPercentage,
  mergeLibraryTags,
  uniqueStringValues,
} from './model'

interface BookDialogProps {
  book: BookRecord
  onClose: () => void
}

const tagPickerChipClassName = 'h-8 max-w-full justify-start gap-1.5 px-3 text-base leading-none'
const tagPickerInactiveChipClassName =
  'bg-transparent text-(--flow-text) ring-1 ring-(--flow-sidebar-item-border) ring-inset hover:bg-(--flow-sidebar-item-bg-hover)'
const tagPickerPartialChipClassName =
  'bg-(--flow-sidebar-item-bg-hover) text-(--flow-text) ring-1 ring-(--flow-accent)/60 ring-inset hover:bg-(--flow-sidebar-item-bg-hover)'

type TagSelectionState = 'none' | 'partial' | 'selected'

interface TemporaryLibraryTagRecord extends LibraryTagRecord {
  temporary: true
}

interface TagSelectionEditorProps {
  onSelectTag: (tagId: string) => void
  onTemporaryTagsChange: React.Dispatch<React.SetStateAction<TemporaryLibraryTagRecord[]>>
  onToggleTag: (tagId: string) => void
  partialTagIds?: Set<string>
  selectedTagIds: Set<string>
  tags: LibraryTagRecord[]
  temporaryTags: TemporaryLibraryTagRecord[]
}

const TagSelectionEditor: React.FC<TagSelectionEditorProps> = ({
  onSelectTag,
  onTemporaryTagsChange,
  onToggleTag,
  partialTagIds,
  selectedTagIds,
  tags,
  temporaryTags,
}) => {
  const t = useTranslation('home')
  const [newTagName, setNewTagName] = useState('')
  const temporaryTagIndexRef = useRef(0)
  const visibleTags = useMemo(() => mergeLibraryTags(tags, temporaryTags), [tags, temporaryTags])
  const cleanName = cleanLibraryTagName(newTagName)

  const addTag = () => {
    if (!cleanName) return

    const existing = visibleTags.find((tag) => sameLibraryTagName(tag.name, cleanName))
    if (existing) {
      onSelectTag(existing.id)
      setNewTagName('')
      return
    }

    temporaryTagIndexRef.current += 1
    const tag: TemporaryLibraryTagRecord = {
      id: `temp-tag-${Date.now()}-${temporaryTagIndexRef.current}`,
      name: cleanName,
      createdAt: Date.now(),
      temporary: true,
    }

    onTemporaryTagsChange((current) => mergeLibraryTags(current, [tag]) as TemporaryLibraryTagRecord[])
    onSelectTag(tag.id)
    setNewTagName('')
  }

  return (
    <div className="space-y-3">
      <div className="flex items-end gap-2">
        <label className="min-w-0 flex-1">
          <span className="text-muted-foreground mb-1.5 block leading-none font-medium">{t('edit.new_tag')}</span>
          <Input
            value={newTagName}
            onValueChange={setNewTagName}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return

              e.preventDefault()
              addTag()
            }}
            className="focus-visible:border-input text-base focus-visible:ring-0"
          />
        </label>
        <UiButton
          type="button"
          variant="secondary"
          disabled={!cleanName}
          onClick={() => {
            addTag()
          }}
        >
          {t('edit.add_tag')}
        </UiButton>
      </div>

      {visibleTags.length > 0 && (
        <div className="flex min-w-0 flex-wrap gap-1.5">
          {visibleTags.map((tag) => {
            const state: TagSelectionState = selectedTagIds.has(tag.id)
              ? 'selected'
              : partialTagIds?.has(tag.id)
                ? 'partial'
                : 'none'

            return (
              <UiButton
                key={tag.id}
                type="button"
                size="sm"
                variant={state === 'selected' ? 'default' : 'secondary'}
                aria-pressed={state === 'partial' ? 'mixed' : state === 'selected'}
                title={tag.name}
                className={clsx(
                  tagPickerChipClassName,
                  state === 'partial' && tagPickerPartialChipClassName,
                  state === 'none' && tagPickerInactiveChipClassName,
                )}
                onClick={() => onToggleTag(tag.id)}
              >
                <span className="min-w-0 truncate leading-none">{tag.name}</span>
              </UiButton>
            )
          })}
        </div>
      )}
    </div>
  )
}

function getTagsInAllBooks(books: BookRecord[], tags: LibraryTagRecord[]) {
  const tagIds = new Set<string>()
  if (!books.length) return tagIds
  const bookTagIds = books.map((book) => new Set(book.tagIds ?? []))

  for (const tag of tags) {
    if (bookTagIds.every((ids) => ids.has(tag.id))) {
      tagIds.add(tag.id)
    }
  }
  return tagIds
}

function getTagsInAnyBook(books: BookRecord[], tags: LibraryTagRecord[]) {
  const tagIds = new Set<string>()
  const bookTagIds = books.map((book) => new Set(book.tagIds ?? []))

  for (const tag of tags) {
    if (bookTagIds.some((ids) => ids.has(tag.id))) {
      tagIds.add(tag.id)
    }
  }
  return tagIds
}

function getPartiallySelectedTags(books: BookRecord[], tags: LibraryTagRecord[]) {
  const allTagIds = getTagsInAllBooks(books, tags)

  return new Set([...getTagsInAnyBook(books, tags)].filter((tagId) => !allTagIds.has(tagId)))
}

async function resolveSelectedTagIds(selectedTagIds: Set<string>, temporaryTags: TemporaryLibraryTagRecord[]) {
  const temporaryById = new Map(temporaryTags.map((tag) => [tag.id, tag]))
  const resolvedIds: string[] = []

  for (const tagId of selectedTagIds) {
    const temporaryTag = temporaryById.get(tagId)
    if (!temporaryTag) {
      resolvedIds.push(tagId)
      continue
    }

    const tag = await db.tags.create(temporaryTag.name)
    if (tag) resolvedIds.push(tag.id)
  }

  return uniqueStringValues(resolvedIds)
}

interface BatchTagsDialogProps {
  books: BookRecord[]
  onClose: () => void
  tags: LibraryTagRecord[]
}

export const BatchTagsDialog: React.FC<BatchTagsDialogProps> = ({ books, onClose, tags }) => {
  const t = useTranslation('home')
  const [selectedTagIds, setSelectedTagIds] = useState(() => getTagsInAllBooks(books, tags))
  const [partialTagIds, setPartialTagIds] = useState(() => getPartiallySelectedTags(books, tags))
  const [temporaryTags, setTemporaryTags] = useState<TemporaryLibraryTagRecord[]>([])

  const toggleTag = useCallback((tagId: string) => {
    setSelectedTagIds((current) => {
      const next = new Set(current)
      if (next.has(tagId)) {
        next.delete(tagId)
      } else {
        next.add(tagId)
      }

      return next
    })
    setPartialTagIds((current) => {
      if (!current.has(tagId)) return current

      const next = new Set(current)
      next.delete(tagId)
      return next
    })
  }, [])

  const selectTag = useCallback((tagId: string) => {
    setSelectedTagIds((current) => {
      if (current.has(tagId)) return current

      const next = new Set(current)
      next.add(tagId)
      return next
    })
    setPartialTagIds((current) => {
      if (!current.has(tagId)) return current

      const next = new Set(current)
      next.delete(tagId)
      return next
    })
  }, [])

  const apply = async () => {
    if (!books.length) return

    const persistedSelectedTagIds = new Set(await resolveSelectedTagIds(selectedTagIds, temporaryTags))
    const initialTagIds = getTagsInAllBooks(books, tags)
    const initialAnyTagIds = getTagsInAnyBook(books, tags)
    const addTagIds = [...persistedSelectedTagIds].filter((tagId) => !initialTagIds.has(tagId))
    const removeTagIds = [...initialAnyTagIds].filter(
      (tagId) => !persistedSelectedTagIds.has(tagId) && !partialTagIds.has(tagId),
    )

    await db.books.updateTags(
      books.map((book) => book.id),
      { addTagIds, removeTagIds },
    )
    onClose()
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="w-[min(32rem,calc(100vw-2rem))] max-w-none text-base">
        <DialogHeader>
          <DialogTitle>{t('batch_tags.title')}</DialogTitle>
        </DialogHeader>
        <TagSelectionEditor
          tags={tags}
          temporaryTags={temporaryTags}
          selectedTagIds={selectedTagIds}
          partialTagIds={partialTagIds}
          onToggleTag={toggleTag}
          onSelectTag={selectTag}
          onTemporaryTagsChange={setTemporaryTags}
        />
        <DialogFooter>
          <UiButton type="button" variant="secondary" onClick={onClose}>
            {t('cancel')}
          </UiButton>
          <UiButton
            type="button"
            disabled={!books.length}
            onClick={() => {
              void apply()
            }}
          >
            {t('batch_tags.apply')}
          </UiButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

interface DeleteSelectedBooksDialogProps {
  count: number
  onClose: () => void
  onConfirm: () => void
}

export const DeleteSelectedBooksDialog: React.FC<DeleteSelectedBooksDialogProps> = ({ count, onClose, onConfirm }) => {
  const t = useTranslation('home')

  return (
    <ConfirmDialog
      title={t('delete_selected.title')}
      description={t('delete_selected.message', count)}
      cancelLabel={t('cancel')}
      confirmLabel={t('delete')}
      onClose={onClose}
      onConfirm={onConfirm}
    />
  )
}

export const BookTagsDialog: React.FC<BookDialogProps> = ({ book, onClose }) => {
  const t = useTranslation('home')
  const tags = useLibraryTags()
  const [tagIds, setTagIds] = useState(() => new Set(uniqueStringValues(book.tagIds ?? [])))
  const [temporaryTags, setTemporaryTags] = useState<TemporaryLibraryTagRecord[]>([])

  const toggleTag = useCallback((tagId: string) => {
    setTagIds((current) => {
      const next = new Set(current)
      if (next.has(tagId)) {
        next.delete(tagId)
      } else {
        next.add(tagId)
      }

      return next
    })
  }, [])

  const selectTag = useCallback((tagId: string) => {
    setTagIds((current) => {
      if (current.has(tagId)) return current

      const next = new Set(current)
      next.add(tagId)
      return next
    })
  }, [])

  const apply = () => {
    void resolveSelectedTagIds(tagIds, temporaryTags)
      .then((resolvedTagIds) => db.books.update(book.id, { tagIds: resolvedTagIds }))
      .then(() => onClose())
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="w-[min(32rem,calc(100vw-2rem))] max-w-none text-base">
        <DialogHeader>
          <DialogTitle>{t('batch_tags.title')}</DialogTitle>
        </DialogHeader>
        <TagSelectionEditor
          tags={tags ?? []}
          temporaryTags={temporaryTags}
          selectedTagIds={tagIds}
          onToggleTag={toggleTag}
          onSelectTag={selectTag}
          onTemporaryTagsChange={setTemporaryTags}
        />
        <DialogFooter>
          <UiButton type="button" variant="secondary" onClick={onClose}>
            {t('cancel')}
          </UiButton>
          <UiButton type="button" onClick={apply}>
            {t('batch_tags.apply')}
          </UiButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export const EditBookDialog: React.FC<BookDialogProps> = ({ book, onClose }) => {
  const t = useTranslation('home')
  const titleRef = useRef<HTMLInputElement>(null)
  const [title, setTitle] = useState(() => getBookDisplayTitle(book))
  const [creator, setCreator] = useState(() => cleanBookText(book.metadata.creator))

  const save = () => {
    void db.books
      .update(book.id, {
        metadata: {
          ...book.metadata,
          title: cleanBookText(title),
          creator: cleanBookText(creator),
        },
      })
      .then(() => onClose())
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent
        className="w-[min(28rem,calc(100vw-2rem))] max-w-none text-base"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          titleRef.current?.focus()
        }}
      >
        <form
          autoComplete="off"
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            save()
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('edit.dialog_title')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <label className="block">
              <span className="text-muted-foreground mb-1.5 block leading-none font-medium">{t('edit.title')}</span>
              <Input
                ref={titleRef}
                value={title}
                onValueChange={setTitle}
                className="focus-visible:border-input text-base focus-visible:ring-0"
              />
            </label>
            <label className="block">
              <span className="text-muted-foreground mb-1.5 block leading-none font-medium">{t('edit.creator')}</span>
              <Input
                value={creator}
                onValueChange={setCreator}
                className="focus-visible:border-input text-base focus-visible:ring-0"
              />
            </label>
          </div>
          <DialogFooter>
            <UiButton type="button" variant="secondary" onClick={onClose}>
              {t('cancel')}
            </UiButton>
            <UiButton type="submit">{t('edit.save')}</UiButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

interface BookInfoDialogProps extends BookDialogProps {
  cover?: string | null
}

export const BookInfoDialog: React.FC<BookInfoDialogProps> = ({ book, cover, onClose }) => {
  const t = useTranslation('home')
  const title = getBookDisplayTitle(book)
  const description = cleanBookDescription(book.metadata.description)
  const rows = [
    [t('info.creator'), cleanBookText(book.metadata.creator)],
    [t('info.language'), formatLanguage(book.metadata.language)],
    [t('info.publisher'), cleanBookText(book.metadata.publisher)],
    [t('info.publication_date'), cleanBookText(book.metadata.pubdate)],
    ...(book.sourceStorage === 'referenced' && book.sourcePath
      ? [[t('info.original_file_path'), formatLocalDirectoryForDisplay(book.sourcePath)]]
      : []),
    [t('info.file_name'), cleanBookText(book.name)],
    [t('info.size'), formatFileSize(book.size)],
    [t('info.date_added'), formatDateTime(book.createdAt)],
    [t('info.last_read'), formatDateTime(book.lastReadAt)],
    [t('info.reading_progress'), formatPercentage(book.percentage)],
  ].filter(([, value]) => !!value)

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="max-h-[calc(100vh-4rem)] w-[min(46rem,calc(100vw-2rem))] max-w-none gap-0 overflow-hidden p-0 text-base">
        <div className="grid grid-cols-[12rem_minmax(0,1fr)] gap-5 p-5 pr-12">
          <div className="w-full">
            {cover && (
              <img src={cover} alt="" className="block h-auto max-h-64 w-auto max-w-full shadow-sm" draggable={false} />
            )}
          </div>
          <div className="min-w-0 pr-6">
            <DialogTitle className="text-foreground text-xl! leading-tight font-bold">{title}</DialogTitle>
            {!!rows.length && (
              <dl className="mt-4 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-2 gap-y-1 text-base">
                {rows.map(([label, value]) => (
                  <React.Fragment key={label}>
                    <dt className="font-semibold">{label}:</dt>
                    <dd className="min-w-0 wrap-break-word">{value}</dd>
                  </React.Fragment>
                ))}
              </dl>
            )}
          </div>
        </div>
        {description && (
          <div className="scroll border-border max-h-[min(18rem,38vh)] overflow-y-auto border-t p-5 pt-4 text-justify text-base">
            {description.split(/\n{2,}/).map((paragraph, index) => (
              <p key={paragraph} className={clsx(index > 0 && 'mt-3')}>
                {paragraph}
              </p>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
