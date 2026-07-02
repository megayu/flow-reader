import {
  CSSProperties,
  Dispatch,
  SetStateAction,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

import { loadBookImageIndex, storeBookImageIndex } from '@flow/reader/db'
import type {
  BookImageIndexCache,
  BookImageIndexCacheInput,
} from '@flow/reader/db'
import { useAction } from '@flow/reader/hooks/useAction'
import { LIST_ITEM_SIZE } from '@flow/reader/hooks/useList'
import { useTranslation } from '@flow/reader/hooks/useTranslation'
import { createDuplicateIllustrationFilter } from '@flow/reader/imageFilters'
import {
  ImageEntry,
  ISection,
  reader,
  useReaderSnapshot,
} from '@flow/reader/models/reader'

import { Row } from '../Row'
import { PaneView, PaneViewProps } from '../base/PaneView'

const IMAGE_SCAN_CONCURRENCY = 4
const IMAGE_LIST_OVERSCAN = 6
const IMAGE_LIST_TOP_PADDING = 4
const IMAGE_SECTION_ESTIMATED_THUMBNAIL_HEIGHT = 180

type ImageDisplayMode = 'illustrations' | 'all'

interface ImageSection {
  images: ImageEntry[]
  section: ISection
}

interface ImageAssetEntry {
  href?: string
  index: number
  normalizedHref?: string
}

interface ImageAssetLookup {
  assets: any[]
  blobs: string[]
  entries: ImageAssetEntry[]
  indexesByHref: Map<string, number>
}

interface VirtualImageSection {
  index: number
  section: ImageSection
  start: number
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

function knownImageEntries(section: ISection) {
  return !!section.imageInfoLoaded
}

function imageSignature(section: ISection) {
  return imageEntries(section)
    .map(
      (image) =>
        `${image.index}:${image.src}:${image.hiddenByDefault ? (image.reason ?? 'hidden') : 'visible'}`,
    )
    .join('|')
}

function normalizePath(value: string | undefined) {
  if (!value) return

  try {
    return decodeURI(value)
  } catch {
    return value
  }
}

function assignImageSectionNavItems(
  tab: typeof reader.focusedBookTab,
  sections: ISection[],
) {
  if (!tab) return

  sections.forEach((section) => {
    section.navitem ??= tab.mapSectionToNavItem(section.href)
  })
}

function createImageAssetLookup(resources: any): ImageAssetLookup | undefined {
  if (!resources) return

  const assets = resources.assets ?? []
  const blobs = resources.replacementUrls ?? []
  const indexesByHref = new Map<string, number>()
  const entries = assets.map((asset: any, index: number) => {
    const href = asset?.href
    const normalizedHref = normalizePath(href)

    if (href) indexesByHref.set(href, index)
    if (normalizedHref) indexesByHref.set(normalizedHref, index)

    return {
      href,
      index,
      normalizedHref,
    }
  })

  return {
    assets,
    blobs,
    entries,
    indexesByHref,
  }
}

function applyImageIndexCache(
  tab: typeof reader.focusedBookTab,
  sections: ISection[],
  cache: BookImageIndexCache,
) {
  if (!tab) return false

  let applied = 0
  cache.sections.forEach((cachedSection) => {
    const section =
      sections[cachedSection.sectionIndex] ??
      sections.find((item) => item.href === cachedSection.href)

    if (!section || section.href !== cachedSection.href) return

    section.images = cachedSection.images.map((image): ImageEntry => {
      const reason = image.reason ?? undefined
      return {
        hiddenByDefault: image.hiddenByDefault,
        index: image.index,
        ...(reason ? { reason } : {}),
        src: image.src,
      }
    })
    section.imageInfoLoaded = true
    section.navitem ??= tab.mapSectionToNavItem(section.href)
    applied += 1
  })

  return applied > 0
}

function createImageIndexCacheInput(
  tab: typeof reader.focusedBookTab,
  sections: ISection[],
): BookImageIndexCacheInput | undefined {
  if (!tab) return

  return {
    bookHash: tab.book.contentHash ?? '',
    contentVersion: tab.book.contentVersion ?? 0,
    sections: sections.map((section, index) => {
      const navitem = section.navitem ?? tab.mapSectionToNavItem(section.href)
      return {
        sectionIndex: section.index ?? index,
        href: section.href,
        title: navitem?.label ?? null,
        navPath: navitem
          ? tab.getNavPath(navitem).map((item) => item.label)
          : [],
        images: imageEntries(section).map((image) => ({
          src: image.src,
          index: image.index,
          hiddenByDefault: image.hiddenByDefault,
          reason: image.reason ?? null,
        })),
      }
    }),
  }
}

function sectionKey(section: ISection) {
  return section.href
}

function estimatedImageSectionHeight(section: ImageSection, expanded: boolean) {
  return expanded
    ? LIST_ITEM_SIZE +
        section.images.length * IMAGE_SECTION_ESTIMATED_THUMBNAIL_HEIGHT
    : LIST_ITEM_SIZE
}

function useVirtualImageSections(
  sections: ImageSection[],
  expandedKeys: ReadonlySet<string>,
) {
  const outerRef = useRef<HTMLDivElement | null>(null)
  const measuredHeights = useRef<Map<string, number> | null>(null)
  const [measureRevision, setMeasureRevision] = useState(0)
  const [viewport, setViewport] = useState({ height: 0, scrollTop: 0 })

  measuredHeights.current ??= new Map()

  const updateViewport = useCallback(() => {
    const el = outerRef.current
    if (!el) return

    const next = {
      height: Math.ceil(el.clientHeight),
      scrollTop: Math.max(0, el.scrollTop),
    }

    setViewport((current) =>
      current.height === next.height && current.scrollTop === next.scrollTop
        ? current
        : next,
    )
  }, [])

  useLayoutEffect(() => {
    const el = outerRef.current
    if (!el) return

    let frame = 0
    const scheduleUpdate = () => {
      if (frame) return

      frame = window.requestAnimationFrame(() => {
        frame = 0
        updateViewport()
      })
    }

    updateViewport()
    el.addEventListener('scroll', scheduleUpdate, { passive: true })

    const observer =
      typeof ResizeObserver === 'undefined'
        ? undefined
        : new ResizeObserver(scheduleUpdate)

    if (observer) {
      observer.observe(el)
    } else {
      window.addEventListener('resize', scheduleUpdate)
    }

    return () => {
      el.removeEventListener('scroll', scheduleUpdate)
      observer?.disconnect()
      window.removeEventListener('resize', scheduleUpdate)
      if (frame) window.cancelAnimationFrame(frame)
    }
  }, [updateViewport])

  useLayoutEffect(() => {
    updateViewport()
  }, [sections.length, updateViewport])

  void measureRevision

  const layoutItems: VirtualImageSection[] = []
  let totalSize = 0

  sections.forEach((section, index) => {
    const key = sectionKey(section.section)
    const expanded = expandedKeys.has(key)
    const measured = measuredHeights.current?.get(key)
    const height = expanded
      ? (measured ?? estimatedImageSectionHeight(section, expanded))
      : LIST_ITEM_SIZE

    layoutItems.push({
      index,
      section,
      start: totalSize,
    })
    totalSize += height
  })

  const start = Math.max(0, viewport.scrollTop)
  const end = start + viewport.height
  const overscan = IMAGE_LIST_OVERSCAN * LIST_ITEM_SIZE
  const visibleItems = layoutItems.filter((item, index) => {
    const next = layoutItems[index + 1]
    const itemEnd = next?.start ?? totalSize

    return itemEnd >= start - overscan && item.start <= end + overscan
  })

  const setMeasuredHeight = useCallback((key: string, height: number) => {
    const next = Math.max(LIST_ITEM_SIZE, Math.ceil(height))
    if (measuredHeights.current?.get(key) === next) return

    measuredHeights.current?.set(key, next)
    setMeasureRevision((revision) => revision + 1)
  }, [])

  return {
    outerRef,
    setMeasuredHeight,
    totalSize,
    visibleItems,
  }
}

export const ImageView: React.FC<PaneViewProps> = (props) => {
  const active = props.active ?? true
  const [mode, setMode] = useState<ImageDisplayMode>('illustrations')

  return (
    <PaneView {...props}>
      {active && <ImagePane mode={mode} setMode={setMode} />}
    </PaneView>
  )
}

interface ImagePaneProps {
  mode: ImageDisplayMode
  setMode: Dispatch<SetStateAction<ImageDisplayMode>>
}

const ImagePane: React.FC<ImagePaneProps> = ({ mode, setMode }) => {
  const [action] = useAction()
  const { focusedBookTab } = useReaderSnapshot()
  const t = useTranslation()
  const tab = reader.focusedBookTab
  const [expandedState, setExpandedState] = useState(() => ({
    keys: new Set<string>(),
    mode,
  }))
  const [, setImageScanRevision] = useState(0)
  const liveSections = useMemo(
    () => (tab?.sections as ISection[] | undefined) ?? [],
    [tab?.sections],
  )
  const snapshotSections = focusedBookTab?.sections as ISection[] | undefined
  const canLoadImages = action === 'image' && !!snapshotSections
  const imageAssetLookup = useMemo(
    () => createImageAssetLookup(tab?.epub?.resources),
    [tab?.epub?.resources],
  )

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
      const duplicateFilter = createDuplicateIllustrationFilter()
      const applyDuplicateFilterToKnownSections = () => {
        let changed = false

        for (const section of liveSections) {
          if (!knownImageEntries(section)) continue
          changed = duplicateFilter.applyToSection(section) || changed
        }

        return changed
      }
      const replayDuplicateFilterForKnownSections = () => {
        duplicateFilter.reset()
        return applyDuplicateFilterToKnownSections()
      }

      assignImageSectionNavItems(tab, liveSections)
      applyDuplicateFilterToKnownSections()
      refreshImages()

      try {
        const cache = await loadBookImageIndex(tab.book.id)
        if (cancelled || reader.focusedBookTab !== tab) return
        if (cache && applyImageIndexCache(tab, liveSections, cache)) {
          replayDuplicateFilterForKnownSections()
          refreshImages()
        }
      } catch (error) {
        console.error(error)
      }

      let nextSectionIndex = 0
      const sectionsToScan = liveSections.filter(
        (section) => !knownImageEntries(section),
      )

      const scanNextSection = async () => {
        while (!cancelled) {
          const section = sectionsToScan[nextSectionIndex]
          nextSectionIndex += 1
          if (!section) return

          if (knownImageEntries(section)) continue
          if (reader.focusedBookTab !== tab) return

          const previousImageSignature = imageSignature(section)
          await tab.ensureSectionInfo(section)

          if (cancelled || reader.focusedBookTab !== tab) return

          const duplicatesChanged = duplicateFilter.applyToSection(section)
          if (
            duplicatesChanged ||
            imageSignature(section) !== previousImageSignature
          ) {
            refreshImages()
          }
        }
      }

      await Promise.all(
        Array.from(
          { length: Math.min(IMAGE_SCAN_CONCURRENCY, sectionsToScan.length) },
          scanNextSection,
        ),
      )

      if (
        !cancelled &&
        reader.focusedBookTab === tab &&
        liveSections.every(knownImageEntries)
      ) {
        if (replayDuplicateFilterForKnownSections()) refreshImages()

        const cache = createImageIndexCacheInput(tab, liveSections)
        if (cache) {
          void storeBookImageIndex(tab.book.id, cache).catch(console.error)
        }
      }
    })()

    return () => {
      cancelled = true
      if (frame) window.cancelAnimationFrame(frame)
    }
  }, [canLoadImages, liveSections, tab])

  const allImages = liveSections.flatMap(imageEntries)
  const sections = liveSections.flatMap((section): ImageSection[] => {
    const entries = imageEntries(section)
    const images =
      mode === 'all'
        ? entries
        : entries.filter((image) => !image.hiddenByDefault)
    return images.length ? [{ images, section }] : []
  })
  const visibleImageCount = sections.reduce(
    (count, section) => count + section.images.length,
    0,
  )
  let expandedKeys = expandedState.keys

  if (expandedState.mode !== mode) {
    expandedKeys = new Set()
    setExpandedState({ keys: expandedKeys, mode })
  }

  const { outerRef, setMeasuredHeight, totalSize, visibleItems } =
    useVirtualImageSections(sections, expandedKeys)

  const toggleSection = useCallback(
    (key: string) => {
      setExpandedState((current) => {
        const next = new Set(current.mode === mode ? current.keys : [])

        if (next.has(key)) {
          next.delete(key)
        } else {
          next.add(key)
        }

        return { keys: next, mode }
      })
    },
    [mode],
  )

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-2 bg-[var(--flow-bg-sidebar)] px-2">
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
      <div
        ref={outerRef}
        className="scroll text-muted-foreground min-h-0 flex-1 text-base"
      >
        {sections.length ? (
          <div
            className="relative pt-1"
            style={{ height: totalSize + IMAGE_LIST_TOP_PADDING }}
          >
            {visibleItems.map(({ section: imageSection, start }) => {
              const key = sectionKey(imageSection.section)
              const expanded = expandedKeys.has(key)

              return (
                <MeasuredImageBlock
                  key={key}
                  assetLookup={imageAssetLookup}
                  expanded={expanded}
                  images={imageSection.images}
                  section={imageSection.section}
                  style={{
                    position: 'absolute',
                    top: start,
                    width: '100%',
                  }}
                  onMeasured={(height) => setMeasuredHeight(key, height)}
                  onToggle={() => toggleSection(key)}
                />
              )
            })}
          </div>
        ) : (
          <div className="px-5 pt-1 pb-4 text-base text-[var(--flow-text-muted)]">
            {t('image.empty')}
          </div>
        )}
      </div>
    </div>
  )
}

interface BlockProps {
  assetLookup?: ImageAssetLookup
  expanded: boolean
  images: ImageEntry[]
  onToggle: () => void
  section: ISection
}

interface MeasuredImageBlockProps extends BlockProps {
  onMeasured: (height: number) => void
  style: CSSProperties
}

const MeasuredImageBlock: React.FC<MeasuredImageBlockProps> = ({
  onMeasured,
  style,
  ...props
}) => {
  const ref = useRef<HTMLDivElement | null>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return

    let frame = 0
    const measure = () => {
      if (frame) return

      frame = window.requestAnimationFrame(() => {
        frame = 0
        onMeasured(el.offsetHeight)
      })
    }

    measure()

    const observer =
      typeof ResizeObserver === 'undefined'
        ? undefined
        : new ResizeObserver(measure)

    if (observer) {
      observer.observe(el)
    }

    return () => {
      observer?.disconnect()
      if (frame) window.cancelAnimationFrame(frame)
    }
  }, [onMeasured])

  return (
    <div ref={ref} style={style}>
      <Block {...props} />
    </div>
  )
}

const Block: React.FC<BlockProps> = ({
  assetLookup,
  expanded,
  images,
  onToggle,
  section,
}) => {
  useReaderSnapshot()

  return (
    <div>
      <Row badge expanded={expanded} toggle={onToggle} subitems={images}>
        {section.navitem?.label ?? section.href}
      </Row>

      {expanded && (
        <div>
          {images.map((image) => {
            const { src } = image
            const i = findImageAssetIndex(src, assetLookup)
            const asset = assetLookup?.assets[i]
            const imageSrc = assetLookup?.blobs[i] ?? src

            if (!imageSrc) return null
            return (
              <button
                type="button"
                key={`${src}:${image.index}`}
                className="block w-full cursor-pointer border-0 bg-transparent p-0 text-left"
                onClick={() => {
                  void reader.focusedBookTab?.displayImage(
                    section,
                    src,
                    image.index,
                  )
                }}
              >
                <img
                  className="w-full px-5 py-2"
                  src={imageSrc}
                  alt={asset?.href ?? src}
                />
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

function findImageAssetIndex(src: string, lookup?: ImageAssetLookup) {
  if (!lookup) return -1

  const normalizedSrc = normalizePath(src)
  const exactIndex =
    lookup.indexesByHref.get(src) ??
    (normalizedSrc ? lookup.indexesByHref.get(normalizedSrc) : undefined)

  if (exactIndex !== undefined) return exactIndex

  return lookup.entries.findIndex((entry) =>
    imageSourceMatchesAsset(src, normalizedSrc, entry),
  )
}

function imageSourceMatchesAsset(
  src: string,
  normalizedSrc: string | undefined,
  asset: ImageAssetEntry,
) {
  const href = asset.href
  if (!href) return false
  if (src.includes(href)) return true

  return !!(
    normalizedSrc &&
    asset.normalizedHref &&
    normalizedSrc.includes(asset.normalizedHref)
  )
}
