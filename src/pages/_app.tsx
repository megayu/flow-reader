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

export default function MyApp({ Component, pageProps }: AppProps) {
  useRevealScrollbars()

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
