import Contents from '../contents'
import Section from '../section'

export function replaceBase(doc: Document, section: Section): void

export function replaceCanonical(doc: Document, section: Section): void

export function replaceMeta(doc: Document, section: Section): void

export interface LinkClickMeta {
  button: number
  ctrlKey: boolean
  external: boolean
  metaKey: boolean
}

export function replaceLinks(
  contents: Contents,
  fn: (href: string, meta?: LinkClickMeta) => void,
): void

export function substitute(
  contents: Contents,
  urls: string[],
  replacements: string[],
): void
