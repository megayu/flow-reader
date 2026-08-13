import clsx from 'clsx'
import { RefreshCwIcon } from 'lucide-react'
import {
  type CSSProperties,
  createContext,
  type Dispatch,
  type PropsWithChildren,
  type SetStateAction,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

import { useAction } from '@/hooks/useAction'
import { LIST_ITEM_SIZE } from '@/hooks/useList'
import { useScrollViewport } from '@/hooks/useScrollViewport'
import { useTranslation } from '@/hooks/useTranslation'
import { type ImageEntry, type ISection, reader, useReaderSnapshot } from '@/models/reader'
import { normalizeHrefPath, sameHref } from '@/noteLinks'
import type { BookImageIndexCache } from '@/storage'
import { loadBookImageIndex } from '@/storage'

import { OverlayScroll, PaneView, type PaneViewProps } from '../base/PaneView'
import { IconButton } from '../IconButton'
import { Row } from '../Row'
import { SegmentedControl, SegmentedControlItem } from '../ui/segmented-control'

const IMAGE_LIST_OVERSCAN = 6
const IMAGE_LIST_TOP_PADDING = 4
const IMAGE_SECTION_ESTIMATED_THUMBNAIL_HEIGHT = 180

type ImageDisplayMode = 'illustrations' | 'all'
type ImageIndexStatus = 'error' | 'loading' | 'ready'

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
  resolveHref: (href: string) => string | undefined
}

interface VirtualImageSection {
  index: number
  section: ImageSection
  start: number
}

const ImageSelectionContext = createContext<[string | undefined, Dispatch<SetStateAction<string | undefined>>] | null>(
  null,
)

const ImageSelectionProvider: React.FC<PropsWithChildren> = ({ children }) => {
  const selection = useState<string>()

  return <ImageSelectionContext.Provider value={selection}>{children}</ImageSelectionContext.Provider>
}

function useImageSelection() {
  const value = useContext(ImageSelectionContext)
  if (!value) throw new Error('Image selection requires its provider')
  return value
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

function normalizePath(value: string | undefined) {
  return normalizeHrefPath(value)
}

function resolveImageHref(href: string, resolve: (href: string) => string | undefined) {
  if (/^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith('//') || href.startsWith('#')) {
    return href
  }
  return resolve(href)
}

function createImageAssetLookup(
  resources: any,
  resolve: ((href: string) => string | undefined) | undefined,
): ImageAssetLookup | undefined {
  if (!resources || !resolve) return

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
    resolveHref: (href) => resolveImageHref(href, resolve),
  }
}

function applyImageIndexCache(tab: typeof reader.focusedBookTab, sections: ISection[], cache: BookImageIndexCache) {
  if (!tab) return false

  const matchedSections = cache.sections.map((cachedSection) => {
    const indexedSection = sections[cachedSection.index]
    return indexedSection?.href === cachedSection.href
      ? indexedSection
      : sections.find((section) => section.href === cachedSection.href)
  })
  if (matchedSections.some((section) => !section)) return false

  cache.sections.forEach((cachedSection, index) => {
    const section = matchedSections[index]
    if (!section) return

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
  })

  return cache.sections.length > 0
}

function sectionKey(section: ISection) {
  return section.href
}

function estimatedImageSectionHeight(section: ImageSection, expanded: boolean) {
  return expanded ? LIST_ITEM_SIZE + section.images.length * IMAGE_SECTION_ESTIMATED_THUMBNAIL_HEIGHT : LIST_ITEM_SIZE
}

function useVirtualImageSections(sections: ImageSection[], expandedKeys: ReadonlySet<string>) {
  const { outerRef, updateViewport, viewport } = useScrollViewport()
  const measuredHeights = useRef<Map<string, number> | null>(null)
  const [measureRevision, setMeasureRevision] = useState(0)

  measuredHeights.current ??= new Map()

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
    const height = expanded ? (measured ?? estimatedImageSectionHeight(section, expanded)) : LIST_ITEM_SIZE

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
    scrollbar: {
      scrollTop: viewport.scrollTop,
      totalSize: totalSize + IMAGE_LIST_TOP_PADDING,
      viewportHeight: viewport.height,
    },
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
      {active && (
        <ImageSelectionProvider>
          <ImagePane mode={mode} setMode={setMode} />
        </ImageSelectionProvider>
      )}
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
  const [imageIndexStatus, setImageIndexStatus] = useState<ImageIndexStatus>('loading')
  const [imageIndexRetryCount, setImageIndexRetryCount] = useState(0)
  const [, setImageScanRevision] = useState(0)
  const liveSections = useMemo(() => (tab?.sections as ISection[] | undefined) ?? [], [tab?.sections])
  const snapshotSections = focusedBookTab?.sections as ISection[] | undefined
  const canLoadImages = action === 'image' && !!snapshotSections
  const imageAssetLookup = useMemo(() => {
    const epub = tab?.epub
    return createImageAssetLookup(epub?.resources, epub ? (href) => epub.resolve(href) : undefined)
  }, [tab?.epub])

  useEffect(() => {
    if (!canLoadImages || !liveSections.length || !tab) return

    let cancelled = false
    const revision = tab.book.revision
    setImageIndexStatus('loading')

    void loadBookImageIndex(tab.book.id)
      .then((cache) => {
        if (cancelled || reader.focusedBookTab !== tab) return
        if (cache.revision !== revision) {
          setImageIndexStatus('error')
          return
        }
        const applied = applyImageIndexCache(tab, liveSections, cache)
        if (cache.sections.length && !applied) {
          setImageIndexStatus('error')
          return
        }
        if (applied) {
          setImageScanRevision((revision) => revision + 1)
        }
        setImageIndexStatus('ready')
      })
      .catch((error: unknown) => {
        if (cancelled || reader.focusedBookTab !== tab) return
        console.error(error)
        setImageIndexStatus('error')
      })

    return () => {
      cancelled = true
    }
  }, [canLoadImages, imageIndexRetryCount, liveSections, tab, tab?.book.revision])

  const allImages = liveSections.flatMap(imageEntries)
  const sections = liveSections.flatMap((section): ImageSection[] => {
    const entries = imageEntries(section)
    const images = mode === 'all' ? entries : entries.filter((image) => !image.hiddenByDefault)
    return images.length ? [{ images, section }] : []
  })
  const visibleImageCount = sections.reduce((count, section) => count + section.images.length, 0)
  let expandedKeys = expandedState.keys

  if (expandedState.mode !== mode) {
    expandedKeys = new Set()
    setExpandedState({ keys: expandedKeys, mode })
  }

  const { outerRef, scrollbar, setMeasuredHeight, totalSize, visibleItems } = useVirtualImageSections(
    sections,
    expandedKeys,
  )

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
      <div className="flex h-11 shrink-0 items-center gap-2 bg-(--flow-bg-sidebar) px-2">
        <SegmentedControl className="flex min-w-0 flex-1 bg-(--flow-sidebar-item-bg) ring-(--flow-sidebar-item-border)">
          {(['illustrations', 'all'] as const).map((item) => (
            <SegmentedControlItem
              key={item}
              selected={mode === item}
              className={[
                'h-full min-w-0 flex-1 truncate rounded-md px-2 py-0 text-base leading-tight',
                mode === item
                  ? 'bg-(--flow-accent-bg) text-(--flow-text) ring-1 ring-(--flow-accent-border) ring-inset hover:bg-(--flow-accent-bg)'
                  : 'text-(--flow-text-muted) hover:bg-(--flow-sidebar-item-bg-hover) hover:text-(--flow-text)',
              ].join(' ')}
              onClick={() => setMode(item)}
            >
              {t(`image.filter.${item}`)}
            </SegmentedControlItem>
          ))}
        </SegmentedControl>
        <span className="flex h-7 min-w-8 shrink-0 items-center justify-center rounded-full bg-(--flow-sidebar-item-bg) px-1.5 text-sm leading-none font-medium text-(--flow-text-muted) ring-1 ring-(--flow-sidebar-item-border) ring-inset">
          {imageIndexStatus === 'ready'
            ? mode === 'all'
              ? visibleImageCount
              : `${visibleImageCount}/${allImages.length}`
            : '—'}
        </span>
      </div>
      <OverlayScroll
        ref={outerRef}
        className="text-muted-foreground text-base"
        containerClassName="min-h-0 flex-1"
        reserveScrollbarWidth
        scrollbar={{ ...scrollbar, scrollRef: outerRef }}
      >
        {imageIndexStatus === 'loading' ? (
          <div className="px-5 pt-1 pb-4 text-base text-(--flow-text-muted)">{t('image.loading')}</div>
        ) : imageIndexStatus === 'error' ? (
          <div className="inline-flex items-center gap-1 px-5 pt-1 pb-4 text-base text-destructive">
            <span>{t('image.load_error')}</span>
            <IconButton
              aria-label={t('image.retry')}
              Icon={RefreshCwIcon}
              className="size-6 shrink-0 text-(--flow-text-muted) hover:text-(--flow-text)"
              onClick={() => {
                setImageIndexStatus('loading')
                setImageIndexRetryCount((count) => count + 1)
              }}
            />
          </div>
        ) : sections.length ? (
          <div className="relative pt-1" style={{ height: totalSize + IMAGE_LIST_TOP_PADDING }}>
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
          <div className="px-5 pt-1 pb-4 text-base text-(--flow-text-muted)">{t('image.empty')}</div>
        )}
      </OverlayScroll>
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

const MeasuredImageBlock: React.FC<MeasuredImageBlockProps> = ({ onMeasured, style, ...props }) => {
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

    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure)

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

const Block: React.FC<BlockProps> = ({ assetLookup, expanded, images, onToggle, section }) => {
  const { focusedBookTab } = useReaderSnapshot()
  const [activeKey, setActiveKey] = useImageSelection()

  return (
    <div>
      <Row badge expanded={expanded} toggle={onToggle} subitems={images}>
        {section.navitem?.label ?? section.href}
      </Row>

      {expanded && (
        <div>
          {images.map((image) => {
            const { src } = image
            const key = imageSelectionKey(focusedBookTab?.id, section, image)
            const i = findImageAssetIndex(src, assetLookup)
            const asset = assetLookup?.assets[i]
            const imageSrc = assetLookup?.blobs[i] ?? assetLookup?.resolveHref(asset?.href ?? src) ?? src
            const active = key === activeKey

            if (!imageSrc) return null
            return (
              <button
                type="button"
                key={`${src}:${image.index}`}
                className={clsx(
                  'focus:ring-ring block w-full cursor-pointer border-0 bg-transparent py-0 pr-2.5 pl-0 text-left outline-none focus:ring-1 focus:ring-inset',
                  active ? 'flow-bg-active hover:bg-(--flow-bg-active-hover)' : 'hover:bg-(--flow-bg-control-hover)',
                )}
                onClick={() => {
                  setActiveKey(key)
                  void reader.focusedBookTab?.displayImage(section, src, image.index)
                }}
              >
                <img className="w-full px-5 py-2" src={imageSrc} alt={asset?.href ?? src} />
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

function imageSelectionKey(tabId: string | undefined, section: ISection, image: ImageEntry) {
  return `${tabId ?? ''}:${section.href}:${image.src}:${image.index}`
}

function findImageAssetIndex(src: string, lookup?: ImageAssetLookup) {
  if (!lookup) return -1

  const normalizedSrc = normalizePath(src)
  const exactIndex =
    lookup.indexesByHref.get(src) ?? (normalizedSrc ? lookup.indexesByHref.get(normalizedSrc) : undefined)

  if (exactIndex !== undefined) return exactIndex

  return lookup.entries.findIndex((entry) => imageSourceMatchesAsset(src, normalizedSrc, entry))
}

function imageSourceMatchesAsset(src: string, normalizedSrc: string | undefined, asset: ImageAssetEntry) {
  const href = asset.href
  if (!href) return false
  if (sameHref(src, href)) return true

  return !!(normalizedSrc && asset.normalizedHref && sameHref(normalizedSrc, asset.normalizedHref))
}
