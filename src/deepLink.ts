export const flowReaderDeepLinkScheme = 'flow-reader:'

const bookIdPattern = /^[a-z0-9_-]+$/
const maximumDeepLinkLength = 16_384
const maximumCfiLength = 8_192

export interface FlowReaderDeepLink {
  bookId: string
  cfi?: string
}

export function createFlowReaderDeepLink({ bookId, cfi }: FlowReaderDeepLink) {
  const url = new URL(`${flowReaderDeepLinkScheme}//${bookId}`)
  if (cfi) url.searchParams.set('cfi', cfi)
  return url.href
}

export function parseFlowReaderDeepLink(value: string): FlowReaderDeepLink | undefined {
  if (!value || value.length > maximumDeepLinkLength || [...value].some((character) => character < ' ')) return

  let url: URL
  try {
    url = new URL(value)
  } catch {
    return
  }

  if (
    url.protocol !== flowReaderDeepLinkScheme ||
    !url.hostname ||
    !bookIdPattern.test(url.hostname) ||
    url.username ||
    url.password ||
    url.port ||
    (url.pathname && url.pathname !== '/') ||
    url.hash
  ) {
    return
  }

  const cfi = url.searchParams.get('cfi') || undefined
  if (cfi && cfi.length > maximumCfiLength) return

  return {
    bookId: url.hostname,
    ...(cfi ? { cfi } : {}),
  }
}

export async function setupDeepLinks(onOpen: (request: FlowReaderDeepLink) => void | Promise<void>) {
  const { getCurrent, onOpenUrl } = await import('@tauri-apps/plugin-deep-link')
  const deliveredDuringSetup = new Set<string>()
  let settingUp = true
  let delivery = Promise.resolve()

  const enqueue = (values: string[]) => {
    const requests = values.flatMap((value) => {
      const request = parseFlowReaderDeepLink(value)
      return request ? [request] : []
    })
    const operation = delivery.then(async () => {
      for (const request of requests) await onOpen(request)
    })
    delivery = operation.catch(() => undefined)
    return operation
  }

  const unlisten = await onOpenUrl((values) => {
    if (settingUp) values.forEach((value) => deliveredDuringSetup.add(value))
    void enqueue(values).catch(console.error)
  })

  let current: string[] | null
  try {
    current = await getCurrent()
  } catch (error) {
    settingUp = false
    unlisten()
    throw error
  }
  settingUp = false
  if (current) {
    await enqueue(current.filter((value) => !deliveredDuringSetup.has(value))).catch(console.error)
  }

  return { cleanup: unlisten }
}
