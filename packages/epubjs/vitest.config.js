import { playwright } from '@vitest/browser-playwright'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    {
      name: 'epubjs-test-fixtures',
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
    globals: true,
    include: ['test/*.js'],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      api: { host: '127.0.0.1' },
      instances: [{ browser: 'chromium' }],
    },
  },
})
