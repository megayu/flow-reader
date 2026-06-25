import './styles.css'

import type { AppProps } from 'next/app'
import { useEffect } from 'react'

import { Layout } from '../components/Layout'
import { Theme } from '../components/Theme'
import { TooltipProvider } from '../components/ui/tooltip'
import { revealScrollbars } from '../scrollbar'

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

function disableControlAutocomplete(element: Element) {
  if (element instanceof HTMLFormElement) {
    element.setAttribute('autocomplete', 'off')
    return
  }

  if (
    !(element instanceof HTMLInputElement) &&
    !(element instanceof HTMLTextAreaElement)
  ) {
    return
  }

  element.setAttribute('autocomplete', 'off')
  element.setAttribute('autocorrect', 'off')
  element.setAttribute('autocapitalize', 'off')
  element.setAttribute('spellcheck', 'false')
}

function disableAutocompleteIn(root: ParentNode) {
  if (root instanceof Element) {
    disableControlAutocomplete(root)
  }

  root
    .querySelectorAll?.('form, input, textarea')
    .forEach(disableControlAutocomplete)
}

function useDisableInputAutocomplete() {
  useEffect(() => {
    disableAutocompleteIn(document)

    const handleFocusIn = (event: FocusEvent) => {
      if (event.target instanceof Element) {
        disableControlAutocomplete(event.target)
      }
    }

    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        mutation.addedNodes.forEach((node) => {
          if (node instanceof Element) {
            disableAutocompleteIn(node)
          }
        })
      })
    })

    document.addEventListener('focusin', handleFocusIn, true)
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    })

    return () => {
      document.removeEventListener('focusin', handleFocusIn, true)
      observer.disconnect()
    }
  }, [])
}

export default function MyApp({ Component, pageProps }: AppProps) {
  useRevealScrollbars()
  useDevtoolsShortcut()
  useDisableInputAutocomplete()

  return (
    <>
      <Theme />
      <TooltipProvider>
        <Layout>
          <Component {...pageProps} />
        </Layout>
      </TooltipProvider>
    </>
  )
}
