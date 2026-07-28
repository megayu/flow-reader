import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, join, resolve, sep } from 'node:path'

import buildStaticExport from './build-static-export.ts'

const port = Number(process.env.PLAYWRIGHT_PORT ?? 7127)
const host = process.env.PLAYWRIGHT_HOST ?? 'localhost'
const exportRoot = resolve('dist')
const exportRootPrefix = `${exportRoot}${sep}`
const contentTypes: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url ?? '/', `http://${host}:${port}`).pathname)
    const relativePath = pathname === '/' ? 'index.html' : pathname.slice(1)
    let filePath = resolve(exportRoot, relativePath)
    if (filePath !== exportRoot && !filePath.startsWith(exportRootPrefix)) {
      response.writeHead(403).end()
      return
    }

    const metadata = await stat(filePath)
    if (metadata.isDirectory()) filePath = join(filePath, 'index.html')
    response.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Type': contentTypes[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
    })
    createReadStream(filePath).pipe(response)
  } catch {
    response.writeHead(404).end()
  }
})

await buildStaticExport()
server.listen(port, host)

const close = () => server.close(() => process.exit(0))
process.once('SIGINT', close)
process.once('SIGTERM', close)
