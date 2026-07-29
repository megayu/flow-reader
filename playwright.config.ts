import { createServer } from 'node:net'

import { defineConfig, devices } from '@playwright/test'

async function findAvailablePort(host: string) {
  const probe = createServer()

  return await new Promise<number>((resolve, reject) => {
    probe.once('error', reject)
    probe.listen(0, host, () => {
      const address = probe.address()
      if (!address || typeof address === 'string') {
        probe.close()
        reject(new Error('Could not allocate a Playwright web server port'))
        return
      }

      probe.close((error) => {
        if (error) reject(error)
        else resolve(address.port)
      })
    })
  })
}

const host = process.env.PLAYWRIGHT_HOST ?? '127.0.0.1'
const configuredPort = process.env.PLAYWRIGHT_PORT
const port = configuredPort ? Number(configuredPort) : await findAvailablePort(host)
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error(`Invalid PLAYWRIGHT_PORT: ${configuredPort}`)
}
process.env.PLAYWRIGHT_HOST = host
process.env.PLAYWRIGHT_PORT = String(port)
const browserChannel = process.env.PLAYWRIGHT_BROWSER_CHANNEL ?? (process.platform === 'win32' ? 'msedge' : 'chrome')

export default defineConfig({
  testDir: './tests/integration',
  testMatch: '**/*.spec.ts',
  outputDir: process.env.PLAYWRIGHT_OUTPUT_DIR ?? 'test-results',
  globalSetup: './tests/support/serve-static-export.ts',
  timeout: 30_000,
  expect: {
    timeout: 5_000,
  },
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://${host}:${port}`,
    locale: 'en-US',
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  projects: [
    {
      name: 'desktop',
      use: {
        ...devices['Desktop Chrome'],
        channel: browserChannel,
      },
    },
  ],
})
