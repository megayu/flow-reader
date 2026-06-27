import { Html, Head, Main, NextScript } from 'next/document'

export default function Document() {
  return (
    // https://github.com/vercel/next.js/issues/10285
    // Next injects `<style data-next-hide-fouc="true">body{display:none}</style>`,
    // so we should set background on `html`
    <Html className="bg-background">
      <Head>
        <PreventFlash />
      </Head>
      <body>
        <Main />
        <NextScript />
      </body>
    </Html>
  )
}

const background = {
  light: 'white',
  dark: '#24292e',
}
const preventFlashScript = 'const background={"light":"white","dark":"#24292e"}'

function PreventFlash() {
  return (
    <>
      <style>{`
        .bg-background, .hover\\:bg-background:hover {
          background: ${background.light};
        }
        .dark.bg-background, .dark .bg-background, .dark .hover\\:bg-background:hover {
          background: ${background.dark};
        }
      `}</style>
      <script
        dangerouslySetInnerHTML={{
          __html: preventFlashScript,
        }}
      ></script>
    </>
  )
}
