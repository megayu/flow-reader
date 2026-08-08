import { expect, test } from '@playwright/test'

import type { BookSourceFormat, FolderImportCandidate } from '../../src/storage'
import { createTestBook } from '../support/book-fixtures'
import { msg } from '../support/i18n'
import { getStoredLibraryMockState, installTauriMock } from '../support/tauri-mock'

function candidate(root: string, filename: string, format: BookSourceFormat): FolderImportCandidate {
  return {
    path: `${root}/${filename}`,
    format,
    rootDirectory: root,
    intermediateDirectories: [],
    directDirectory: root,
  }
}

test('folder import defaults to EPUB and updates both format counts when the folder changes', async ({ page }) => {
  const firstFolder = 'library-one'
  const secondFolder = 'library-two'
  await installTauriMock(page, {
    folderDialogPaths: [firstFolder, secondFolder],
    folderImportCandidates: {
      [firstFolder]: [
        candidate(firstFolder, 'first.epub', 'epub'),
        candidate(firstFolder, 'first.txt', 'txt'),
        candidate(firstFolder, 'second.txt', 'txt'),
      ],
      [secondFolder]: [
        candidate(secondFolder, 'first.epub', 'epub'),
        candidate(secondFolder, 'second.epub', 'epub'),
        candidate(secondFolder, 'third.epub', 'epub'),
        candidate(secondFolder, 'first.txt', 'txt'),
      ],
    },
  })
  await page.goto('/')

  await page.getByRole('button', { name: msg('home.import') }).click()
  await page.getByRole('menuitem', { name: msg('home.folder_import.action') }).click()

  const dialog = page.getByRole('dialog')
  const epub = dialog.getByRole('checkbox', { name: /^EPUB/ })
  const txt = dialog.getByRole('checkbox', { name: /^TXT/ })
  await expect(epub).toBeChecked()
  await expect(txt).not.toBeChecked()
  await expect(epub).toHaveAccessibleName('EPUB 1')
  await expect(txt).toHaveAccessibleName('TXT 2')

  await dialog.getByRole('button', { name: msg('home.folder_import.change_folder') }).click()
  await expect(epub).toHaveAccessibleName('EPUB 3')
  await expect(txt).toHaveAccessibleName('TXT 1')
})

test('folder import applies the selected folder tag to imported books', async ({ page }) => {
  const root = 'Rust'
  const bookPath = `${root}/book.epub`
  await installTauriMock(page, {
    folderDialogPaths: [root],
    folderImportCandidates: {
      [root]: [candidate(root, 'book.epub', 'epub')],
    },
    importedBooks: [
      createTestBook({
        id: 'folder-imported-book',
        sourcePath: bookPath,
      }),
    ],
    tags: [{ id: 'tag-rust', name: 'rust', createdAt: 1 }],
  })
  await page.goto('/')

  await page.getByRole('button', { name: msg('home.import') }).click()
  await page.getByRole('menuitem', { name: msg('home.folder_import.action') }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('button', { name: msg('home.import'), exact: true }).click()

  await expect
    .poll(async () => {
      const state = await getStoredLibraryMockState(page)
      return {
        bookTagIds: state.books.find((book) => book.id === 'folder-imported-book')?.tagIds,
        tagNames: state.tags.map((tag) => tag.name),
      }
    })
    .toEqual({ bookTagIds: ['tag-rust'], tagNames: ['rust'] })
})
