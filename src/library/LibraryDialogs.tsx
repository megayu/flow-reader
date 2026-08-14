import clsx from 'clsx'
import React, { useCallback, useMemo, useRef, useState } from 'react'

import { cleanBookText, getBookDisplayTitle } from '../book'
import { Button as UiButton } from '../components/ui/button'
import { ConfirmDialog } from '../components/ui/confirm-dialog'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/dialog'
import { Input } from '../components/ui/input'
import { formatLocalDirectoryForDisplay } from '../dictionary/path'
import { useLibraryPins, useLibraryTags } from '../hooks/useLibrary'
import { useTranslation } from '../hooks/useTranslation'
import { type BookRecord, db, type LibraryTagRecord } from '../storage'

import { cleanLibraryTagName, orderLibraryTags, sameLibraryTagName, uniqueStringValues } from './filters'
import { LibraryFilterChipButton, libraryFilterOptionsClassName } from './LibraryFilterChipButton'
import {
  cleanBookDescription,
  formatDateTime,
  formatFileSize,
  formatLanguage,
  formatPercentage,
  mergeLibraryTags,
} from './model'

interface BookDialogProps {
  book: BookRecord
  onClose: () => void
}

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
  const pins = useLibraryPins()
  const [newTagName, setNewTagName] = useState('')
  const temporaryTagIndexRef = useRef(0)
  const visibleTags = useMemo(
    () => orderLibraryTags(mergeLibraryTags(tags, temporaryTags), pins?.tagIds),
    [pins?.tagIds, tags, temporaryTags],
  )
  const pinnedTagIds = useMemo(() => new Set(pins?.tagIds ?? []), [pins?.tagIds])
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
        <div className={libraryFilterOptionsClassName}>
          {visibleTags.map((tag) => {
            const state: TagSelectionState = selectedTagIds.has(tag.id)
              ? 'selected'
              : partialTagIds?.has(tag.id)
                ? 'partial'
                : 'none'

            return (
              <LibraryFilterChipButton
                key={tag.id}
                state={state === 'selected' ? 'active' : state === 'partial' ? 'partial' : 'inactive'}
                label={tag.name}
                pinned={state !== 'partial' && pinnedTagIds.has(tag.id)}
                aria-pressed={state === 'partial' ? 'mixed' : state === 'selected'}
                onClick={() => onToggleTag(tag.id)}
              />
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

function sameStringSet(left: Set<string>, right: Set<string>) {
  return left.size === right.size && [...left].every((value) => right.has(value))
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
  const [initialSelectedTagIds] = useState(() => getTagsInAllBooks(books, tags))
  const [initialPartialTagIds] = useState(() => getPartiallySelectedTags(books, tags))
  const [selectedTagIds, setSelectedTagIds] = useState(() => new Set(initialSelectedTagIds))
  const [partialTagIds, setPartialTagIds] = useState(() => new Set(initialPartialTagIds))
  const [temporaryTags, setTemporaryTags] = useState<TemporaryLibraryTagRecord[]>([])
  const canSave =
    !sameStringSet(selectedTagIds, initialSelectedTagIds) || !sameStringSet(partialTagIds, initialPartialTagIds)

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
    if (!books.length || !canSave) return

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
          <DialogTitle>{t('tag_editor.title')}</DialogTitle>
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
            disabled={!books.length || !canSave}
            onClick={() => {
              void apply()
            }}
          >
            {t('edit.save')}
          </UiButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

interface DeleteSelectedBooksDialogProps {
  count: number
  openCount: number
  onClose: () => void
  onConfirm: () => void
}

export const DeleteSelectedBooksDialog: React.FC<DeleteSelectedBooksDialogProps> = ({
  count,
  openCount,
  onClose,
  onConfirm,
}) => {
  const t = useTranslation('home')
  const description =
    openCount === 0 ? t('delete_selected.message', count) : t('delete_selected.message_open', count, openCount)

  return (
    <ConfirmDialog
      title={t('delete_selected.title')}
      description={description}
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
  const [initialTagIds] = useState(() => new Set(uniqueStringValues(book.tagIds ?? [])))
  const [tagIds, setTagIds] = useState(() => new Set(initialTagIds))
  const [temporaryTags, setTemporaryTags] = useState<TemporaryLibraryTagRecord[]>([])
  const canSave = !sameStringSet(tagIds, initialTagIds)

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
    if (!canSave) return

    void resolveSelectedTagIds(tagIds, temporaryTags)
      .then((resolvedTagIds) => {
        const current = new Set(book.tagIds ?? [])
        const next = new Set(resolvedTagIds)
        return db.books.updateTags([book.id], {
          addTagIds: [...next].filter((tagId) => !current.has(tagId)),
          removeTagIds: [...current].filter((tagId) => !next.has(tagId)),
        })
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
      <DialogContent className="w-[min(32rem,calc(100vw-2rem))] max-w-none text-base">
        <DialogHeader>
          <DialogTitle>{t('tag_editor.title')}</DialogTitle>
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
          <UiButton type="button" disabled={!canSave} onClick={apply}>
            {t('edit.save')}
          </UiButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export const EditBookDialog: React.FC<BookDialogProps> = ({ book, onClose }) => {
  const t = useTranslation('home')
  const titleRef = useRef<HTMLInputElement>(null)
  const initialTitle = getBookDisplayTitle(book)
  const initialCreator = cleanBookText(book.metadata.creator)
  const [title, setTitle] = useState(initialTitle)
  const [creator, setCreator] = useState(initialCreator)
  const canSave = cleanBookText(title) !== initialTitle || cleanBookText(creator) !== initialCreator

  const save = () => {
    if (!canSave) return

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
                focusBehavior="end"
                className="focus-visible:border-input text-base focus-visible:ring-0"
              />
            </label>
            <label className="block">
              <span className="text-muted-foreground mb-1.5 block leading-none font-medium">{t('edit.creator')}</span>
              <Input
                value={creator}
                onValueChange={setCreator}
                focusBehavior="end"
                className="focus-visible:border-input text-base focus-visible:ring-0"
              />
            </label>
          </div>
          <DialogFooter>
            <UiButton type="button" variant="secondary" onClick={onClose}>
              {t('cancel')}
            </UiButton>
            <UiButton type="submit" disabled={!canSave}>
              {t('edit.save')}
            </UiButton>
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
    ...(!book.managed && book.sourcePath
      ? [[t('info.file_path'), formatLocalDirectoryForDisplay(book.sourcePath)]]
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
              <img
                src={cover}
                alt=""
                className={clsx(
                  'block max-w-full',
                  book.sourceFormat === 'txt' ? 'h-64 w-48' : 'h-auto max-h-64 w-auto',
                )}
                draggable={false}
              />
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
