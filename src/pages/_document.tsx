import { Html, Head, Main, NextScript } from 'next/document'

export default function Document() {
  return (
    // https://github.com/vercel/next.js/issues/10285
    // Next injects `<style data-next-hide-fouc="true">body{display:none}</style>`,
    // so we should set background on `html`
    <Html className="bg-default">
      <Head>
        <link rel="icon" href="/icons/192.png"></link>
        <PWA />
        <PreventFlash />
      </Head>
      <body>
        <Main />
        <NextScript />
      </body>
    </Html>
  )
}

function PWA() {
  return (
    <>
      <link rel="manifest" href="/manifest.json" />
      <meta id="theme-color" name="theme-color" content={background.light} />
      <link rel="apple-touch-icon" href="/icons/192.png" />
    </>
  )
}

const background = {
  light: 'white',
  dark: '#24292e',
}

// external import in `_document.tsx` will break fast refresh,
// so move it to `_document.tsx`
function PreventFlash() {
  const setColorScheme = () => {
    const mql = window.matchMedia('(prefers-color-scheme: dark)')
    const scheme = localStorage.getItem('literal-color-scheme') ?? 'system'

    if (scheme === '"dark"' || (scheme === '"system"' && mql.matches)) {
      document.documentElement.classList.toggle('dark', true)
      document
        .querySelector('#theme-color')
        ?.setAttribute('content', background.dark)
    }
  }

  return (
    <>
      <style>{`
        .bg-default, .hover\\:bg-default:hover {
          background: ${background.light};
        }
        .dark.bg-default, .dark .bg-default, .dark .hover\\:bg-default:hover {
          background: ${background.dark};
        }
      `}</style>
      <script
        dangerouslySetInnerHTML={{
          __html: `const background=${JSON.stringify(background)}`,
        }}
      ></script>
      <script
        dangerouslySetInnerHTML={{ __html: `(${setColorScheme})()` }}
      ></script>
    </>
  )
}
