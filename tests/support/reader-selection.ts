import type { Page } from '@playwright/test'

interface ReaderTextSelectionOptions {
  endOffset?: number
  startOffset?: number
  targetSelector: string
}

export async function selectReaderTextAndOpenMenu(
  page: Page,
  { endOffset, startOffset = 0, targetSelector }: ReaderTextSelectionOptions,
) {
  await page.evaluate(
    ({ endOffset, startOffset, targetSelector }) => {
      const pane = document.querySelector('[data-flow-reader-pane][aria-hidden="false"]')
      const frame = Array.from(pane?.querySelectorAll('iframe') ?? []).find(
        (candidate) => candidate.getBoundingClientRect().width > 0,
      ) as HTMLIFrameElement | undefined
      const target = frame?.contentDocument?.querySelector(targetSelector)
      const text = target?.firstChild
      if (!frame?.contentWindow || !target || !text) {
        throw new Error('Missing reader selection target')
      }

      const length = text.textContent?.length ?? 0
      const range = frame.contentDocument!.createRange()
      range.setStart(text, Math.min(startOffset, length))
      range.setEnd(text, Math.min(endOffset ?? length, length))
      const selection = frame.contentWindow.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
      const rect = range.getBoundingClientRect()
      frame.contentWindow.dispatchEvent(
        new (frame.contentWindow as Window & { MouseEvent: typeof MouseEvent }).MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2,
        }),
      )
    },
    { endOffset, startOffset, targetSelector },
  )
}
