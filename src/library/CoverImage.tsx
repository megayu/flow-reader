import clsx from 'clsx'
import { useEffect, useState } from 'react'

import { acquireCoverResource, isCoverResourceReady } from './coverResourceCache'

export const bookCoverPlaceholder = `data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect fill="gray" fill-opacity="0" width="1" height="1"/></svg>`
const imageClassName = 'block h-full w-full rounded-[inherit]'

interface CoverImageProps {
  alt: string
  bookId: string
  cover: string
  fit: 'contain' | 'cover'
}

function RetainedCoverImage({ alt, bookId, cover, fit }: CoverImageProps) {
  const [ready, setReady] = useState(() => isCoverResourceReady({ bookId, cover }))
  const fitClassName = fit === 'contain' ? 'object-contain' : 'object-cover'

  useEffect(() => {
    const identity = { bookId, cover }
    return acquireCoverResource(identity, (status) => setReady(status === 'ready'))
  }, [bookId, cover])

  return (
    <>
      <img
        src={bookCoverPlaceholder}
        alt=""
        aria-hidden
        className={clsx(imageClassName, fitClassName)}
        draggable={false}
      />
      <img
        src={ready ? cover : bookCoverPlaceholder}
        alt={alt}
        className={clsx(imageClassName, fitClassName, 'absolute inset-0', !ready && 'invisible')}
        data-flow-library-cover-real
        data-flow-library-cover-ready={ready}
        decoding="async"
        draggable={false}
        loading="eager"
      />
    </>
  )
}

export function CoverImage(props: CoverImageProps) {
  return <RetainedCoverImage key={`${props.bookId}\u0000${props.cover}`} {...props} />
}
