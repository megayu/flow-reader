import './styles.css'
import 'react-photo-view/dist/react-photo-view.css'

import { LiteralProvider } from '@literal-ui/core'
import type { AppProps } from 'next/app'
import { RecoilRoot } from 'recoil'

import { Layout, Theme } from '../components'

export default function MyApp({ Component, pageProps }: AppProps) {
  return (
    <LiteralProvider>
      <RecoilRoot>
        <Theme />
        <Layout>
          <Component {...pageProps} />
        </Layout>
      </RecoilRoot>
    </LiteralProvider>
  )
}
