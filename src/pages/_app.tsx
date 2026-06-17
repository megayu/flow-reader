import './styles.css'
import 'react-photo-view/dist/react-photo-view.css'

import { LiteralProvider } from '@literal-ui/core'
import type { AppProps } from 'next/app'
import type { ComponentType, PropsWithChildren } from 'react'
import { RecoilRoot } from 'recoil'

import { Layout, Theme } from '../components'

const AppLiteralProvider = LiteralProvider as ComponentType<PropsWithChildren>

export default function MyApp({ Component, pageProps }: AppProps) {
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
