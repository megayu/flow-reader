import './styles.css'

import { invoke } from '@tauri-apps/api/core'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { createRoot } from 'react-dom/client'

import { FlowReader } from './app/FlowReader'
import { installProductionReloadShortcutGuard, installSettingsShortcut } from './keyboard'
import { reader } from './models/reader'
import { initializeWindowUiState, snapshotWindowUiState, useAppStore, type WindowUiState } from './state'
import { db } from './storage/client'

const root = document.getElementById('root')
if (!root) throw new Error('Flow Reader root element was not found')
const appRoot = root
installProductionReloadShortcutGuard(document)
installSettingsShortcut(document, () => useAppStore.getState().setSettingsDialogOpen(true))

const windowUiStateReady = invoke<WindowUiState>('get_window_ui_state').then(initializeWindowUiState)
const recentBooksReady = db.recentBooks.get().catch((error) => {
  console.error(error)
  return []
})

async function handleAppCloseRequested() {
  try {
    await windowUiStateReady
    await recentBooksReady
    const bookCheckpoints = await reader.collectAppCloseBookCheckpoints()
    await invoke('persist_app_close_state', {
      closeState: {
        bookCheckpoints,
        recentBookIds: db.recentBooks.peek(),
        window: snapshotWindowUiState(),
      },
    })
  } catch (error) {
    console.error(error)
    await invoke('cancel_app_close').catch(console.error)
  }
}

async function start() {
  await getCurrentWebviewWindow().listen('flow-app-close-requested', handleAppCloseRequested)
  await windowUiStateReady

  createRoot(appRoot).render(<FlowReader />)
}

void start()
