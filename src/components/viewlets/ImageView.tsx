import { useEffect, useMemo, useState } from 'react'

import { useAction } from '@flow/reader/hooks/useAction'
import { useBoolean } from '@flow/reader/hooks/useBoolean'
import { useTranslation } from '@flow/reader/hooks/useTranslation'
import {
  ImageEntry,
  ISection,
  reader,
  useReaderSnapshot,
} from '@flow/reader/models/reader'

import { Row } from '../Row'
import { PaneView, PaneViewProps } from '../base/PaneView'

const MAX_IMAGE_SECTIONS = 500
type ImageDisplayMode = 'illustrations' | 'all'

interface ImageSection {
  images: ImageEntry[]
  section: ISection
}

function normalizeImageEntry(image: ImageEntry | string, index: number) {
  return typeof image === 'string'
    ? {
        hiddenByDefault: false,
        index,
        src: image,
      }
    : image
}

function imageEntries(section: ISection) {
  return section.images.map(normalizeImageEntry)
}

function imageSignature(section: ISection) {
  return imageEntries(section)
    .map(
      (image) =>
        `${image.index}:${image.src}:${image.hiddenByDefault ? (image.reason ?? 'hidden') : 'visible'}`,
    )
    .join('|')
}

export const ImageView: React.FC<PaneViewProps> = (props) => {
  const [action] = useAction()
  const { focusedBookTab } = useReaderSnapshot()
  const t = useTranslation()
  const tab = reader.focusedBookTab
  const [, setImageScanRevision] = useState(0)
  const [mode, setMode] = useState<ImageDisplayMode>('illustrations')
  const liveSections = useMemo(
    () => (tab?.sections as ISection[] | undefined) ?? [],
    [tab?.sections],
  )
  const snapshotSections = focusedBookTab?.sections as ISection[] | undefined
  const sectionCount = snapshotSections?.length ?? 0
  const canLoadImages = action === 'image' && sectionCount <= MAX_IMAGE_SECTIONS

  useEffect(() => {
    if (!canLoadImages || !liveSections.length || !tab) return

    let cancelled = false
    let frame = 0
    const refreshImages = () => {
      if (cancelled || frame) return

      frame = window.requestAnimationFrame(() => {
        frame = 0
        if (!cancelled) setImageScanRevision((revision) => revision + 1)
      })
    }

    void (async () => {
      refreshImages()

      for (const section of liveSections) {
        if (cancelled || reader.focusedBookTab !== tab) return

        const previousImageSignature = imageSignature(section)
        await tab.ensureSectionInfo(section)
        if (cancelled || reader.focusedBookTab !== tab) return

        if (imageSignature(section) !== previousImageSignature) {
          refreshImages()
        }
      }
    })()

    return () => {
      cancelled = true
      if (frame) window.cancelAnimationFrame(frame)
    }
  }, [canLoadImages, liveSections, tab])

  const allImages = liveSections.flatMap(imageEntries)
  const sections = liveSections
    .map((section): ImageSection => {
      const entries = imageEntries(section)
      const images =
        mode === 'all'
          ? entries
          : entries.filter((image) => !image.hiddenByDefault)
      return { images, section }
    })
    .filter(({ images }) => images.length)
  const visibleImageCount = sections.reduce(
    (count, section) => count + section.images.length,
    0,
  )

  if (sectionCount > MAX_IMAGE_SECTIONS) return null

  return (
    <PaneView {...props}>
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--flow-border)] bg-[var(--flow-bg-sidebar)] px-2">
          <div className="flex h-8 min-w-0 flex-1 items-center rounded-lg bg-[var(--flow-sidebar-item-bg)] p-0.5 ring-1 ring-[var(--flow-sidebar-item-border)] ring-inset">
            {(['illustrations', 'all'] as const).map((item) => (
              <button
                key={item}
                type="button"
                className={[
                  'flex h-full min-w-0 flex-1 items-center justify-center truncate rounded-md px-2 py-0 text-base leading-tight font-medium transition-colors',
                  mode === item
                    ? 'bg-[var(--flow-accent-bg)] text-[var(--flow-text)] ring-1 ring-[var(--flow-accent-border)] ring-inset'
                    : 'text-[var(--flow-text-muted)] hover:bg-[var(--flow-sidebar-item-bg-hover)] hover:text-[var(--flow-text)]',
                ].join(' ')}
                onClick={() => setMode(item)}
              >
                {t(`image.filter.${item}`)}
              </button>
            ))}
          </div>
          <span className="flex h-7 min-w-8 shrink-0 items-center justify-center rounded-full bg-[var(--flow-sidebar-item-bg)] px-1.5 text-sm leading-none font-medium text-[var(--flow-text-muted)] ring-1 ring-[var(--flow-sidebar-item-border)] ring-inset">
            {mode === 'all'
              ? visibleImageCount
              : `${visibleImageCount}/${allImages.length}`}
          </span>
        </div>
        <div className="scroll text-muted-foreground min-h-0 flex-1 text-base">
          {sections.length ? (
            sections.map(({ images, section }) => (
              <Block key={section.href} images={images} section={section} />
            ))
          ) : (
            <div className="px-5 py-4 text-base text-[var(--flow-text-muted)]">
              {t('image.empty')}
            </div>
          )}
        </div>
      </div>
    </PaneView>
  )
}

interface BlockProps {
  images: ImageEntry[]
  section: ISection
}
const Block: React.FC<BlockProps> = ({ images, section }) => {
  useReaderSnapshot()
  const [expanded, toggle] = useBoolean(false)

  const resources = reader.focusedBookTab?.epub?.resources
  if (!resources) return null

  const blobs = resources.replacementUrls
  const assets = resources.assets

  return (
    <div>
      <Row badge expanded={expanded} toggle={toggle} subitems={images}>
        {section.navitem?.label}
      </Row>

      {expanded && (
        <div>
          {images.map((image) => {
            const { src } = image
            const i = assets.findIndex((a: any) =>
              imageSourceMatchesAsset(src, a.href),
            )
            const asset = assets[i]
            const imageSrc = blobs[i] ?? src

            if (!imageSrc) return null
            return (
              <img
                className="w-full cursor-pointer px-5 py-2"
                key={`${src}:${image.index}`}
                src={imageSrc}
                alt={asset?.href ?? src}
                onClick={() => {
                  void reader.focusedBookTab?.displayImage(
                    section,
                    src,
                    image.index,
                  )
                }}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}

function imageSourceMatchesAsset(src: string, href?: string) {
  if (!href) return false
  if (src.includes(href)) return true

  try {
    return decodeURI(src).includes(href)
  } catch {
    return false
  }
}
