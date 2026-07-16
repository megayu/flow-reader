import {
  type SyntheticEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

import type { DictionaryRichDocument } from '../dictionary/types'

interface DictionaryRichContentProps {
  document: DictionaryRichDocument
  onEntryNavigate: (entry: string) => void
  title: string
}

const MIN_HEIGHT = 96

export function DictionaryRichContent({
  document,
  onEntryNavigate,
  title,
}: DictionaryRichContentProps) {
  const [height, setHeight] = useState(MIN_HEIGHT)
  const cleanupRef = useRef<() => void>(() => undefined)
  const srcDoc = useMemo(() => richSource(document), [document])

  const handleLoad = useCallback(
    (event: SyntheticEvent<HTMLIFrameElement>) => {
      cleanupRef.current()
      const iframe = event.currentTarget
      const frameDocument = iframe.contentDocument
      if (!frameDocument?.body) return

      const parentStyle = getComputedStyle(iframe)
      frameDocument.body.style.color = parentStyle.color
      frameDocument.body.style.fontFamily = parentStyle.fontFamily
      frameDocument.body.style.fontSize = parentStyle.fontSize

      const updateHeight = () => {
        setHeight(
          Math.max(
            MIN_HEIGHT,
            Math.ceil(frameDocument.documentElement.scrollHeight),
          ),
        )
      }
      const handleClick = (clickEvent: MouseEvent) => {
        const anchor = (clickEvent.target as Element | null)?.closest(
          'a[data-mdict-entry]',
        )
        const entry = anchor?.getAttribute('data-mdict-entry')
        if (!entry) return
        clickEvent.preventDefault()
        onEntryNavigate(entry)
      }
      const handleResourceError = (resourceEvent: Event) => {
        if (resourceEvent.target instanceof HTMLImageElement) {
          resourceEvent.target.hidden = true
        }
      }
      frameDocument.addEventListener('click', handleClick)
      frameDocument.addEventListener('error', handleResourceError, true)
      const resizeObserver = new ResizeObserver(updateHeight)
      resizeObserver.observe(frameDocument.documentElement)
      void frameDocument.fonts?.ready.then(updateHeight).catch(() => undefined)
      updateHeight()

      cleanupRef.current = () => {
        frameDocument.removeEventListener('click', handleClick)
        frameDocument.removeEventListener('error', handleResourceError, true)
        resizeObserver.disconnect()
      }
    },
    [onEntryNavigate],
  )

  useEffect(
    () => () => {
      cleanupRef.current()
    },
    [],
  )

  return (
    <iframe
      className="text-foreground block w-full border-0 bg-transparent text-base"
      data-dictionary-rich-content="true"
      height={height}
      onLoad={handleLoad}
      sandbox="allow-same-origin"
      scrolling="no"
      srcDoc={srcDoc}
      style={{ height }}
      title={title}
    />
  )
}

function richSource(document: DictionaryRichDocument) {
  const css = document.sanitizedCss.join('\n')
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src dictionary: http://dictionary.localhost https://dictionary.localhost; font-src dictionary: http://dictionary.localhost https://dictionary.localhost; media-src 'none'; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'">
<style>
html { overflow: hidden; color-scheme: light dark; }
body { box-sizing: border-box; margin: 0; padding: 16px 20px; background: transparent; line-height: 1.6; overflow: hidden; overflow-wrap: anywhere; }
*, *::before, *::after { box-sizing: border-box; }
img { max-width: 100%; height: auto; }
a[data-mdict-entry] { color: inherit; text-decoration: underline; text-decoration-color: color-mix(in srgb, currentColor 35%, transparent); text-underline-offset: 0.16em; cursor: pointer; }
table { max-width: 100%; border-collapse: collapse; }
${css}
</style>
</head>
<body>${document.sanitizedHtml}</body>
</html>`
}
