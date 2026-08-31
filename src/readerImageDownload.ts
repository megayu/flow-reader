import { invoke } from '@tauri-apps/api/core'

const IMAGE_EXTENSION_BY_MIME_TYPE: Readonly<Record<string, string>> = {
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'image/gif': 'gif',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/svg+xml': 'svg',
  'image/webp': 'webp',
}

export async function downloadReaderImage(bookId: string, src: string) {
  const response = src.startsWith('blob:') ? await loadReaderImage(src) : undefined
  const suggestedFilename = readerImageFilename(src, response?.headers.get('content-type'))
  const extension = filenameExtension(suggestedFilename)
  const { save } = await import('@tauri-apps/plugin-dialog')
  const outputPath = await save({
    defaultPath: suggestedFilename,
    filters: extension ? [{ name: extension.toUpperCase(), extensions: [extension] }] : undefined,
  })
  if (!outputPath) return

  if (isNativeReaderImageSource(src)) {
    const handled = await invoke<boolean>('download_reader_image', { id: bookId, src, outputPath })
    if (handled) return outputPath
  }

  const imageResponse = response ?? (await loadReaderImage(src))
  await invoke('write_image_download', await imageResponse.arrayBuffer(), {
    headers: { 'flow-image-output-path': encodeURIComponent(outputPath) },
  })
  return outputPath
}

function loadReaderImage(src: string) {
  return fetch(src).then((response) => {
    if (!response.ok) {
      throw new Error(`Failed to load image: ${response.status} ${response.statusText}`)
    }
    return response
  })
}

function readerImageFilename(src: string, responseMimeType?: string | null) {
  const sourceMimeType = /^data:([^;,]+)/i.exec(src)?.[1]
  const extension = imageExtension(sourceMimeType ?? responseMimeType)
  if (src.startsWith('data:') || src.startsWith('blob:')) {
    return extension ? `image.${extension}` : 'image'
  }

  try {
    const pathname = decodeURIComponent(new URL(src, window.location.href).pathname).replaceAll('\\', '/')
    const candidate = sanitizeFilename(pathname.slice(pathname.lastIndexOf('/') + 1))
    if (candidate) return filenameExtension(candidate) || !extension ? candidate : `${candidate}.${extension}`
  } catch {
    // Fall back to a stable filename when the source is not a parseable URL.
  }

  return extension ? `image.${extension}` : 'image'
}

function imageExtension(mimeType?: string | null) {
  const normalizedMimeType = mimeType?.split(';', 1)[0]?.trim().toLowerCase()
  return normalizedMimeType ? IMAGE_EXTENSION_BY_MIME_TYPE[normalizedMimeType] : undefined
}

function isNativeReaderImageSource(src: string) {
  return /^(?:https?:\/\/epub\.localhost\/|epub:\/\/localhost\/|https?:\/\/asset\.localhost\/|asset:\/\/localhost\/)/i.test(
    src,
  )
}

function filenameExtension(filename: string) {
  const match = filename.match(/\.([a-zA-Z0-9]+)$/)
  return match?.[1]?.toLowerCase()
}

function sanitizeFilename(value: string) {
  return value
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
}
