import './styles.css'

import { useEffect } from 'react'
import { createRoot } from 'react-dom/client'

import App from './app/App'
import { Layout } from './components/Layout'
import { Theme } from './components/Theme'
import { TooltipProvider } from './components/ui/tooltip'
import { loadDevtoolsShortcutEnabled, toggleDevtools } from './devtools'
import { isGlobalKeyboardShortcutBlocked } from './keyboard'

function useDevtoolsShortcut() {
  useEffect(() => {
    const handleKeyDown = async (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || !event.shiftKey) return
      if (event.code !== 'KeyI' && event.key.toLowerCase() !== 'i') return
      if (isGlobalKeyboardShortcutBlocked(event)) return

      event.preventDefault()
      event.stopPropagation()

      await toggleDevtools()
    }

    let disposed = false
    let listening = false

    void loadDevtoolsShortcutEnabled().then((enabled) => {
      if (disposed || !enabled) return
      listening = true
      document.addEventListener('keydown', handleKeyDown, true)
    })

    return () => {
      disposed = true
      if (listening) {
        document.removeEventListener('keydown', handleKeyDown, true)
      }
    }
  }, [])
}

function FlowReader() {
  useDevtoolsShortcut()

  return (
    <>
      <Theme />
      <TooltipProvider>
        <Layout>
          <App />
        </Layout>
      </TooltipProvider>
    </>
  )
}

const root = document.getElementById('root')
if (!root) throw new Error('Flow Reader root element was not found')

createRoot(root).render(<FlowReader />)
