import { resolve } from 'node:path'
import { fileURLToPath, URL } from 'node:url'

import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { watch } from 'chokidar'
import { defineConfig, normalizePath, type Plugin } from 'vite'

const tauriDevHost = process.env.TAURI_DEV_HOST
const projectRoot = fileURLToPath(new URL('.', import.meta.url))
const watchedPaths = [
  'src',
  'index.html',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.json',
  'vite.config.ts',
  'packages/epubjs/src',
  'packages/epubjs/types',
  'packages/epubjs/package.json',
  '.env',
  '.env.*',
]

function sourceOnlyWatcher(): Plugin {
  return {
    name: 'flow-reader:source-only-watcher',
    apply: 'serve',
    configureServer(server) {
      const sourceWatcher = watch(watchedPaths, {
        cwd: projectRoot,
        ignoreInitial: true,
      })
      const forwardEvent = (event: 'add' | 'change' | 'unlink', filePath: string) => {
        server.watcher.emit(event, normalizePath(resolve(projectRoot, filePath)))
      }

      sourceWatcher.on('add', (filePath) => forwardEvent('add', filePath))
      sourceWatcher.on('change', (filePath) => forwardEvent('change', filePath))
      sourceWatcher.on('unlink', (filePath) => forwardEvent('unlink', filePath))
      server.httpServer?.once('close', () => {
        void sourceWatcher.close()
      })
    },
  }
}

export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    target: 'es2020',
  },
  clearScreen: false,
  optimizeDeps: {
    include: ['@flow/epubjs > jszip/dist/jszip'],
  },
  plugins: [tailwindcss(), react(), sourceOnlyWatcher()],
  resolve: {
    alias: [
      {
        find: /^@\//,
        replacement: `${fileURLToPath(new URL('./src', import.meta.url))}/`,
      },
    ],
  },
  server: {
    host: tauriDevHost || '127.0.0.1',
    port: 7127,
    strictPort: true,
    watch: null,
  },
})
