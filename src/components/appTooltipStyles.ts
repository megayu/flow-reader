import type { CSSProperties } from 'react'

export const readerPageTooltipContentStyle = {
  maxWidth: 'min(var(--flow-reader-page-width, 24rem), calc(100vw - 2rem))',
} satisfies CSSProperties
