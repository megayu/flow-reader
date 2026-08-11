import clsx from 'clsx'
import { useEffect, useState } from 'react'

import { acquireCoverResource, isCoverResourceReady } from './coverResourceCache'

export const bookCoverPlaceholder = `data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect fill="gray" fill-opacity="0" width="1" height="1"/></svg>`
const imageClassName = 'block h-full w-full rounded-[inherit] object-cover'

interface CoverImageProps {
  alt: string
  bookId: string
  cover: string
}

function RetainedCoverImage({ alt, bookId, cover }: { alt: string; bookId: string; cover: string }) {
  const [ready, setReady] = useState(() => isCoverResourceReady({ bookId, cover }))

  useEffect(() => {
    const identity = { bookId, cover }
    return acquireCoverResource(identity, (status) => setReady(status === 'ready'))
  }, [bookId, cover])

  return (
    <>
      <img src={bookCoverPlaceholder} alt="" aria-hidden className={imageClassName} draggable={false} />
      <img
        src={ready ? cover : bookCoverPlaceholder}
        alt={alt}
        className={clsx(imageClassName, 'absolute inset-0', !ready && 'invisible')}
        data-flow-library-cover-real
        data-flow-library-cover-ready={ready}
        decoding="async"
        draggable={false}
        loading="eager"
      />
    </>
  )
}

export function CoverImage({ alt, bookId, cover }: CoverImageProps) {
  return <RetainedCoverImage key={`${bookId}\u0000${cover}`} alt={alt} bookId={bookId} cover={cover} />
}
