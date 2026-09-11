import InternalBook from './book'
import type { BookInput, BookOptions } from './book'
import type { Book as PublicBook } from './public-rendition'
const Book: new (
  url?: BookInput | BookOptions,
  options?: BookOptions,
) => PublicBook = InternalBook
type Book = PublicBook
import Contents from './contents'
import ePub from './epub'
import EpubCFI from './epubcfi'
import Layout from './layout'
import Rendition from './public-rendition'

export default ePub
export { Book, EpubCFI, Rendition, Contents, Layout }

export type { Location } from './rendition'
export type { NavItem } from './navigation'
