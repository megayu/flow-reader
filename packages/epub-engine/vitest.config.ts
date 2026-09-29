import { fileURLToPath } from 'node:url'

import { playwright } from '@vitest/browser-playwright'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    {
      name: 'epub-engine-test-fixtures',
      configureServer(server) {
        server.middlewares.use((request, _response, next) => {
          if (request.url?.startsWith('/fixtures/')) {
            request.url = `/test${request.url}`
          }
          next()
        })
      },
    },
  ],
  test: {
    reporters: ['default', 'json'],
    outputFile: { json: fileURLToPath(new URL('../../test-results/epub-engine/results.json', import.meta.url)) },
    globals: true,
    include: ['test/*.ts'],
    browser: {
      enabled: true,
      headless: true,
      trace: {
        mode: 'retain-on-failure',
        tracesDir: fileURLToPath(new URL('../../test-results/epub-engine/traces', import.meta.url)),
      },
      screenshotDirectory: fileURLToPath(new URL('../../test-results/epub-engine/screenshots', import.meta.url)),
      screenshotFailures: true,
      provider: playwright(),
      api: { host: '127.0.0.1' },
      instances: [{ browser: 'chromium' }],
    },
  },
})
