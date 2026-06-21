import './styles.css'
import 'react-photo-view/dist/react-photo-view.css'

import { LiteralProvider } from '@literal-ui/core'
import type { AppProps } from 'next/app'
import type { ComponentType, PropsWithChildren } from 'react'
import { useEffect } from 'react'
import { RecoilRoot } from 'recoil'

import { Layout, Theme } from '../components'
import { revealScrollbars } from '../scrollbar'

const AppLiteralProvider = LiteralProvider as ComponentType<PropsWithChildren>

function useRevealScrollbars() {
  useEffect(() => {
    const handleScroll = (event: Event) => {
      revealScrollbars(event.target)
    }

    document.addEventListener('scroll', handleScroll, true)
    document.addEventListener('wheel', handleScroll, true)

    return () => {
      document.removeEventListener('scroll', handleScroll, true)
      document.removeEventListener('wheel', handleScroll, true)
    }
  }, [])
}

function useDevtoolsShortcut() {
  useEffect(() => {
    const handleKeyDown = async (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || !event.shiftKey) return
      if (event.code !== 'KeyI' && event.key.toLowerCase() !== 'i') return

      event.preventDefault()
      event.stopPropagation()

      try {
        const { invoke } = await import('@tauri-apps/api/core')
        await invoke('toggle_devtools')
      } catch {
        // Not running in Tauri.
      }
    }

    document.addEventListener('keydown', handleKeyDown, true)

    return () => {
      document.removeEventListener('keydown', handleKeyDown, true)
    }
  }, [])
}

export default function MyApp({ Component, pageProps }: AppProps) {
  useRevealScrollbars()
  useDevtoolsShortcut()

  return (
    <AppLiteralProvider>
      <RecoilRoot>
        <Theme />
        <Layout>
          <Component {...pageProps} />
        </Layout>
      </RecoilRoot>
    </AppLiteralProvider>
  )
}
