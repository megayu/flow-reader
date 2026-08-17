import path from 'node:path'

import type { Page } from '@playwright/test'

const fixtureRoot = path.resolve('packages/epubjs/test/fixtures/alice')
const fixtureRootPrefix = `${fixtureRoot}${path.sep}`
const fixtureUrlPrefix = '/test-assets/epub/'
const contentTypes: Record<string, string> = {
  '.css': 'text/css',
  '.jpg': 'image/jpeg',
  '.opf': 'application/oebps-package+xml',
  '.xhtml': 'application/xhtml+xml',
  '.xml': 'application/xml',
}

export const epubFixturePackageUrl = `${fixtureUrlPrefix}OPS/package.opf`

export function installEpubFixtureRoutes(page: Page) {
  return page.route(`**${fixtureUrlPrefix}**`, (route) => {
    const pathname = decodeURIComponent(new URL(route.request().url()).pathname)
    const relative = pathname.slice(pathname.indexOf(fixtureUrlPrefix) + fixtureUrlPrefix.length)
    const filePath = path.resolve(fixtureRoot, relative.replaceAll('/', path.sep))
    if (filePath !== fixtureRoot && !filePath.startsWith(fixtureRootPrefix)) {
      return route.fulfill({ status: 403 })
    }
    return route.fulfill({
      path: filePath,
      contentType: contentTypes[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream',
    })
  })
}
