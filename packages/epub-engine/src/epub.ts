import type { BookInput, BookOptions } from './book'
import Book from './book'
import type { Book as PublicBook } from './public-rendition'

/**
 * Creates a new Book
 * @param {string|ArrayBuffer} url URL, Path or ArrayBuffer
 * @param {object} options to pass to the book
 * @returns {Book} a new Book object
 * @example ePub("/path/to/book.epub", {})
 */
function ePub(
  url?: BookInput | BookOptions,
  options?: BookOptions,
): PublicBook {
  return new Book(url, options)
}

export default ePub
