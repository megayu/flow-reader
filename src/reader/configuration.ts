import type { RenditionSpread } from '@flow/epubjs/rendition'

export type PageAppearance = 'cards' | 'book' | 'divider'

export interface TypographyConfiguration {
  fontSize?: string
  fontWeight?: number
  fontFamily?: string
  lineHeight?: number
  textIndent?: number
  textAlign?: 'default' | 'justify'
  spread?: RenditionSpread
  zoom?: number
  pageAppearance?: PageAppearance
}
