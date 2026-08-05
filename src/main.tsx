import './styles.css'

import { invoke } from '@tauri-apps/api/core'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { createRoot } from 'react-dom/client'

import { FlowReader } from './app/FlowReader'
import { reader } from './models/reader'
import { initializeWindowUiState, snapshotWindowUiState, type WindowUiState } from './state'

const root = document.getElementById('root')
if (!root) throw new Error('Flow Reader root element was not found')
const appRoot = root

const windowUiStateReady = invoke<WindowUiState>('get_window_ui_state').then(initializeWindowUiState)

async function handleAppCloseRequested() {
  try {
    await windowUiStateReady
    const readingPositions = await reader.collectAppCloseReadingPositions()
    await invoke('persist_app_close_state', {
      closeState: {
        readingPositions,
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
