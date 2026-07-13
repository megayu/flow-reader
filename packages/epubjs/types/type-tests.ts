import ePub, { Book } from '../'
import type { Contents, Rendition } from '../'
import type { PackagingMetadataObject } from './packaging'
import type Navigation from './navigation'
import type { RenditionSpread } from './rendition'
import type Section from './section'

declare const source: string
declare const contents: Contents
declare const rendition: Rendition
declare const metadata: PackagingMetadataObject
declare const navigation: Navigation
declare const spread: RenditionSpread
declare const section: Section

const epub: Book = ePub(source)
const book: Book = new Book(source, {})

void epub
void book
void contents
void rendition
void metadata
void navigation
void spread
void section
