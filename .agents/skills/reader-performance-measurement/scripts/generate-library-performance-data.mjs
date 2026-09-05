import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { chromium } from '@playwright/test'

const PROFILE_ROOT = path.resolve(process.cwd(), 'perf-results', 'library-virtualization')
const COVER_PROFILES = new Set(['none', 'svg', 'webp', 'mixed'])
const COMPLEXITY_BUCKETS = ['flat', 'medium', 'high']
const COMPLEXITY_WEIGHTS = [4, 4, 2]
const FIXED_EPOCH_MS = Date.UTC(2026, 0, 1)
const WEBP_WIDTH = 320
const WEBP_HEIGHT = 480
const WEBP_QUALITY = 0.9
const LIBRARY_VERSION = 1

function fail(message) {
  console.error(message)
  process.exit(1)
}

function parseArguments(argv) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith('--') || value === undefined || value.startsWith('--')) {
      fail(
        'Usage: node .agents/skills/reader-performance-measurement/scripts/generate-library-performance-data.mjs --out <path> --count <number> --covers <none|svg|webp|mixed> --seed <integer> [--card-width <120-240>] [--show-recent <true|false>]',
      )
    }
    if (values.has(key)) fail(`duplicate argument: ${key}`)
    values.set(key, value)
  }

  for (const required of ['--out', '--count', '--covers', '--seed']) {
    if (!values.has(required)) fail(`missing required argument: ${required}`)
  }
  const supported = new Set(['--out', '--count', '--covers', '--seed', '--card-width', '--show-recent'])
  for (const key of values.keys()) {
    if (!supported.has(key)) fail(`unsupported argument: ${key}`)
  }

  const count = Number(values.get('--count'))
  const seed = Number(values.get('--seed'))
  const cardWidth = Number(values.get('--card-width') ?? 160)
  const covers = values.get('--covers')
  const showRecent = values.get('--show-recent') ?? 'false'

  if (!Number.isSafeInteger(count) || count < 0 || count > 20_000) {
    fail('--count must be an integer between 0 and 20000')
  }
  if (!Number.isSafeInteger(seed) || seed < 0) fail('--seed must be a non-negative safe integer')
  if (!COVER_PROFILES.has(covers)) fail(`unsupported --covers profile: ${covers}`)
  if (!Number.isFinite(cardWidth) || cardWidth < 120 || cardWidth > 240 || cardWidth % 10 !== 0) {
    fail('--card-width must be a 10 px step between 120 and 240')
  }
  if (showRecent !== 'true' && showRecent !== 'false') fail('--show-recent must be true or false')

  return {
    outDir: validateOutputDirectory(values.get('--out')),
    count,
    seed,
    covers,
    cardWidth,
    showRecent: showRecent === 'true',
  }
}

function validateOutputDirectory(value) {
  if (!value?.trim()) fail('--out must not be empty')
  const outDir = path.resolve(process.cwd(), value)
  const relative = path.relative(PROFILE_ROOT, outDir)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    fail(`--out must be a child directory of ${PROFILE_ROOT}`)
  }
  if (outDir === path.parse(outDir).root || outDir === process.cwd()) {
    fail('--out must not be a filesystem or repository root')
  }
  if (fs.existsSync(outDir) && fs.readdirSync(outDir).length > 0) {
    fail(`--out already exists and is not empty: ${outDir}`)
  }
  return outDir
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function createStoredZip(entries) {
  const localParts = []
  const centralParts = []
  let offset = 0
  const dosTime = 0
  const dosDate = ((2026 - 1980) << 9) | (1 << 5) | 1

  for (const entry of entries) {
    const name = Buffer.from(entry.name.replaceAll('\\', '/'), 'utf8')
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8')
    const checksum = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt16LE(dosTime, 10)
    local.writeUInt16LE(dosDate, 12)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    localParts.push(local, name, data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(dosTime, 12)
    central.writeUInt16LE(dosDate, 14)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    centralParts.push(central, name)
    offset += local.length + name.length + data.length
  }

  const centralDirectory = Buffer.concat(centralParts)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralDirectory.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)
  return Buffer.concat([...localParts, centralDirectory, end])
}

function createSyntheticEpub(seed) {
  const title = `Synthetic Library Source ${seed}`
  return createStoredZip([
    { name: 'mimetype', data: 'application/epub+zip' },
    {
      name: 'META-INF/container.xml',
      data: `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OPS/package.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`,
    },
    {
      name: 'OPS/package.opf',
      data: `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="pub-id">flow-library-performance-${seed}</dc:identifier>
    <dc:title>${title}</dc:title>
    <dc:creator>Synthetic Creator</dc:creator>
    <dc:language>en-US</dc:language>
    <meta property="dcterms:modified">2026-01-01T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/>
    <item id="style" href="style.css" media-type="text/css"/>
  </manifest>
  <spine><itemref idref="chapter"/></spine>
</package>`,
    },
    {
      name: 'OPS/nav.xhtml',
      data: `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>${title}</title></head><body><nav epub:type="toc"><ol><li><a href="chapter.xhtml">Synthetic Chapter</a></li></ol></nav></body></html>`,
    },
    {
      name: 'OPS/chapter.xhtml',
      data: `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Synthetic Chapter</title><link rel="stylesheet" href="style.css" type="text/css"/></head><body><h1>Synthetic Chapter</h1><p>Deterministic synthetic content for library mode switching.</p></body></html>`,
    },
    { name: 'OPS/style.css', data: 'body{font-family:serif;}p{line-height:1.6;}' },
  ])
}

function bucketAt(index) {
  const position = index % COMPLEXITY_WEIGHTS.reduce((sum, value) => sum + value, 0)
  let cursor = 0
  for (let bucketIndex = 0; bucketIndex < COMPLEXITY_BUCKETS.length; bucketIndex += 1) {
    cursor += COMPLEXITY_WEIGHTS[bucketIndex]
    if (position < cursor) return COMPLEXITY_BUCKETS[bucketIndex]
  }
  return COMPLEXITY_BUCKETS[0]
}

function coverKindAt(profile, index, count, seed) {
  if (profile === 'none') return 'none'
  if (profile === 'svg') return 'svg'
  if (profile === 'webp') return 'webp'
  if (!count) return 'none'
  const position = (index * 13 + seed) % count
  const webpCount = Math.round(count * 0.9)
  const svgCount = Math.round(count * 0.05)
  if (position < webpCount) return 'webp'
  if (position < webpCount + svgCount) return 'svg'
  return 'none'
}

function color(seed, index, channel) {
  const hash = crypto.createHash('sha256').update(`${seed}:${index}:${channel}`).digest()
  return `#${hash.subarray(0, 3).toString('hex')}`
}

function createSvg(id, seed, index, complexity) {
  const elementCount = complexity === 'flat' ? 3 : complexity === 'medium' ? 12 : 32
  const titleLength = complexity === 'flat' ? 12 : complexity === 'medium' ? 24 : 42
  const title = `${id.replaceAll('-', ' ')} synthetic cover`.slice(0, titleLength)
  const shapes = Array.from({ length: elementCount }, (_, shapeIndex) => {
    const x = (shapeIndex * 37 + index * 11) % WEBP_WIDTH
    const y = (shapeIndex * 53 + seed * 7) % WEBP_HEIGHT
    const size = 14 + ((shapeIndex * 17 + index) % 52)
    return `<rect x="${x}" y="${y}" width="${size}" height="${size}" rx="${shapeIndex % 9}" fill="${color(seed, index, shapeIndex + 2)}" opacity="0.${3 + (shapeIndex % 6)}"/>`
  }).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WEBP_WIDTH}" height="${WEBP_HEIGHT}" viewBox="0 0 ${WEBP_WIDTH} ${WEBP_HEIGHT}"><rect width="100%" height="100%" fill="${color(seed, index, 0)}"/><circle cx="250" cy="90" r="90" fill="${color(seed, index, 1)}" opacity=".7"/>${shapes}<text x="24" y="410" font-family="sans-serif" font-size="22" fill="white">${title}</text><text x="24" y="444" font-family="sans-serif" font-size="13" fill="white">${complexity} ${String(index + 1).padStart(5, '0')}</text></svg>`
}

async function createWebpCovers(items) {
  if (!items.length) return new Map()
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: WEBP_WIDTH, height: WEBP_HEIGHT } })
    const output = new Map()
    for (let start = 0; start < items.length; start += 48) {
      const batch = items.slice(start, start + 48)
      const encoded = await page.evaluate(
        ({ batch, width, height, quality }) =>
          batch.map((item) => {
            const canvas = document.createElement('canvas')
            canvas.width = width
            canvas.height = height
            const context = canvas.getContext('2d', { alpha: false })
            if (!context) throw new Error('2D canvas unavailable')
            let state = (item.seed ^ Math.imul(item.index + 1, 0x9e3779b1)) >>> 0
            const random = () => {
              state ^= state << 13
              state ^= state >>> 17
              state ^= state << 5
              return (state >>> 0) / 0x100000000
            }
            const rgb = () =>
              `${Math.floor(random() * 256)},${Math.floor(random() * 256)},${Math.floor(random() * 256)}`
            const gradient = context.createLinearGradient(0, 0, width, height)
            gradient.addColorStop(0, `rgb(${rgb()})`)
            gradient.addColorStop(1, `rgb(${rgb()})`)
            context.fillStyle = gradient
            context.fillRect(0, 0, width, height)

            const shapeCount = item.complexity === 'flat' ? 4 : item.complexity === 'medium' ? 45 : 260
            for (let shape = 0; shape < shapeCount; shape += 1) {
              context.fillStyle = `rgba(${rgb()},${0.18 + random() * 0.62})`
              const x = random() * width
              const y = random() * height
              const size = 4 + random() * (item.complexity === 'high' ? 55 : 95)
              if (shape % 2) context.fillRect(x, y, size, size * (0.4 + random()))
              else {
                context.beginPath()
                context.arc(x, y, size / 2, 0, Math.PI * 2)
                context.fill()
              }
            }
            if (item.complexity === 'high') {
              const image = context.getImageData(0, 0, width, height)
              for (let pixel = 0; pixel < image.data.length; pixel += 4) {
                const noise = Math.floor(random() * 46) - 23
                image.data[pixel] = Math.max(0, Math.min(255, image.data[pixel] + noise))
                image.data[pixel + 1] = Math.max(0, Math.min(255, image.data[pixel + 1] + noise))
                image.data[pixel + 2] = Math.max(0, Math.min(255, image.data[pixel + 2] + noise))
              }
              context.putImageData(image, 0, 0)
            }
            context.fillStyle = 'rgba(0,0,0,.62)'
            context.fillRect(18, height - 92, width - 36, 68)
            context.fillStyle = 'white'
            context.font = '600 18px sans-serif'
            context.fillText(item.id.slice(-18), 30, height - 56)
            context.font = '13px sans-serif'
            context.fillText(`${item.complexity} ${item.index + 1}`, 30, height - 34)
            return [item.id, canvas.toDataURL('image/webp', quality)]
          }),
        { batch, width: WEBP_WIDTH, height: WEBP_HEIGHT, quality: WEBP_QUALITY },
      )
      for (const [id, dataUrl] of encoded) {
        const marker = 'base64,'
        const markerIndex = dataUrl.indexOf(marker)
        if (!dataUrl.startsWith('data:image/webp') || markerIndex < 0) {
          throw new Error('Chromium did not encode a WebP cover')
        }
        output.set(id, Buffer.from(dataUrl.slice(markerIndex + marker.length), 'base64'))
      }
    }
    return output
  } finally {
    await browser.close()
  }
}

function percentile(values, value) {
  if (!values.length) return 0
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.ceil((value / 100) * sorted.length) - 1)]
}

function summarizeBytes(values) {
  if (!values.length) return { count: 0, min: 0, p50: 0, p95: 0, max: 0 }
  return {
    count: values.length,
    min: Math.min(...values),
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    max: Math.max(...values),
  }
}

function createSettings(options) {
  return {
    dictionary: {
      zdic: { enabled: false },
      merriamWebster: { apiKey: '', enabled: false },
      sourceOrder: ['zdic', 'merriam-webster'],
    },
    enableTextSelectionMenu: false,
    directTextImport: false,
    hideEndnotes: false,
    restoreLastReadingOnStartup: false,
    showLibraryInToc: false,
    showRecentBooks: options.showRecent,
    showModifiedBookExportIndicator: false,
    importSourceStorage: 'referenced',
    startupSession: { viewMode: 'library' },
    libraryDisplay: { bookCardWidth: options.cardWidth },
    librarySort: { field: 'title', direction: 'asc' },
    libraryPinnedAuthors: [],
    libraryPinnedTags: [],
    librarySidebarOpen: false,
    readerSidebarOpen: false,
    locale: 'en-US',
    theme: {
      accent: '#0EA5E9',
      backgroundPreset: 'clean',
      contrast: 'standard',
      scheme: 'light',
    },
    ui: { fontSize: 15 },
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  fs.mkdirSync(options.outDir, { recursive: true })
  const sourcesDir = path.join(options.outDir, 'sources')
  const booksDir = path.join(options.outDir, 'books')
  fs.mkdirSync(sourcesDir, { recursive: true })
  fs.mkdirSync(booksDir, { recursive: true })

  const epubBytes = createSyntheticEpub(options.seed)
  const sourcePath = path.join(sourcesDir, 'synthetic-library-source.epub')
  fs.writeFileSync(sourcePath, epubBytes)
  const sourceHash = sha256(epubBytes)

  const books = []
  const tags = Array.from({ length: 8 }, (_, index) => ({
    id: `synthetic-tag-${String(index + 1).padStart(2, '0')}`,
    name: `Synthetic Tag ${String(index + 1).padStart(2, '0')}`,
    createdAt: FIXED_EPOCH_MS + index,
  }))
  const coverItems = []
  for (let index = 0; index < options.count; index += 1) {
    const id = `libperf-${options.seed.toString(16)}-${String(index + 1).padStart(6, '0')}`
    const coverKind = coverKindAt(options.covers, index, options.count, options.seed)
    const complexity = bucketAt(index)
    const creatorIndex = index % 12
    const statusIndex = index % 4
    const readingStatus = ['toRead', 'reading', 'read', undefined][statusIndex]
    const tagIds = [tags[index % tags.length]?.id, tags[(index * 3 + 1) % tags.length]?.id].filter(
      (value, itemIndex, values) => value && values.indexOf(value) === itemIndex,
    )
    const book = {
      id,
      scope: 'library',
      name: `${id}.epub`,
      size: epubBytes.length,
      ...(readingStatus ? { readingStatus } : {}),
      sourceFormat: 'epub',
      generatedCover: coverKind === 'none',
      definitions: [],
      annotations: [],
      sourceHash,
      sourceRevision: 1,
      revision: 1,
      editable: false,
      sourcePath,
      metadata: {
        title: `Synthetic Library Book ${String(index + 1).padStart(6, '0')}`,
        creator: `Synthetic Creator ${String(creatorIndex + 1).padStart(2, '0')}`,
        language: 'en-US',
        subject: [`Synthetic Subject ${String((index % 6) + 1).padStart(2, '0')}`],
      },
      createdAt: FIXED_EPOCH_MS + index * 10_000,
      updatedAt: FIXED_EPOCH_MS + index * 10_000 + (index % 17) * 1_000,
      ...(index % 5 === 0 ? { lastReadAt: FIXED_EPOCH_MS + index * 11_000, percentage: (index % 101) / 100 } : {}),
      tagIds,
    }
    books.push(book)
    fs.mkdirSync(path.join(booksDir, id), { recursive: true })
    coverItems.push({ id, index, kind: coverKind, complexity, seed: options.seed })
  }

  const webpItems = coverItems.filter((item) => item.kind === 'webp')
  const webpCovers = await createWebpCovers(webpItems)
  const compressedBytes = { svg: [], webp: [] }
  const hashes = new Set()
  const distribution = { none: 0, svg: 0, webp: 0 }
  const complexityDistribution = Object.fromEntries(COMPLEXITY_BUCKETS.map((bucket) => [bucket, 0]))
  for (const item of coverItems) {
    distribution[item.kind] += 1
    complexityDistribution[item.complexity] += 1
    if (item.kind === 'none') continue
    const bookDir = path.join(booksDir, item.id)
    if (item.kind === 'svg') {
      const bytes = Buffer.from(createSvg(item.id, options.seed, item.index, item.complexity), 'utf8')
      fs.writeFileSync(path.join(bookDir, 'cover.svg'), bytes)
      compressedBytes.svg.push(bytes.length)
      continue
    }
    const bytes = webpCovers.get(item.id)
    if (!bytes?.length) fail(`missing generated WebP for ${item.id}`)
    const hash = sha256(bytes)
    if (hashes.has(hash)) fail(`duplicate WebP bytes detected for ${item.id}`)
    hashes.add(hash)
    fs.writeFileSync(path.join(bookDir, 'cover.webp'), bytes)
    compressedBytes.webp.push(bytes.length)
  }

  const switchBookId = books[0]?.id ?? null
  const library = {
    version: LIBRARY_VERSION,
    books,
    tags,
    pins: { authors: [], tagIds: [] },
    recentBookIds: options.showRecent ? books.slice(0, 10).map((book) => book.id) : [],
  }
  const settings = createSettings(options)
  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    generator: '.agents/skills/reader-performance-measurement/scripts/generate-library-performance-data.mjs',
    count: options.count,
    seed: options.seed,
    coverProfile: options.covers,
    coverTargetRatio: options.covers === 'mixed' ? { webp: 0.9, svg: 0.05, none: 0.05 } : null,
    coverDistribution: distribution,
    complexityDistribution,
    mixedProfileClaim: options.covers === 'mixed' ? 'synthetic profile only; not a claim about user libraries' : null,
    webp: {
      width: WEBP_WIDTH,
      height: WEBP_HEIGHT,
      qualityTarget: 90,
      uniqueByteHashes: hashes.size,
      compressedBytes: summarizeBytes(compressedBytes.webp),
    },
    svg: {
      width: WEBP_WIDTH,
      height: WEBP_HEIGHT,
      compressedBytes: summarizeBytes(compressedBytes.svg),
    },
    source: {
      path: sourcePath,
      bytes: epubBytes.length,
      sha256: sourceHash,
      storage: 'referenced',
    },
    switchBookId,
    switchBookStartsUnpacked: false,
    windowProfile: {
      logicalWidth: 1280,
      logicalHeight: 800,
      source: 'tauri-startup-configuration',
      runtimeResize: false,
    },
    settings,
  }

  fs.writeFileSync(path.join(options.outDir, 'library.json'), `${JSON.stringify(library, null, 2)}\n`, 'utf8')
  fs.writeFileSync(path.join(options.outDir, 'settings.json'), `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
  fs.writeFileSync(path.join(options.outDir, 'dataset-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  console.log(
    JSON.stringify(
      {
        outDir: options.outDir,
        count: options.count,
        coverProfile: options.covers,
        coverDistribution: distribution,
        switchBookId,
        webpBytes: manifest.webp.compressedBytes,
        svgBytes: manifest.svg.compressedBytes,
      },
      null,
      2,
    ),
  )
}

main().catch((error) => fail(error?.stack || error?.message || String(error)))
