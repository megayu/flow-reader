import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@flow/epubjs': fileURLToPath(
        new URL('./packages/epubjs', import.meta.url),
      ),
      '@flow/reader': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.contract.test.ts'],
  },
})
