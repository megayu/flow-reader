import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath, URL } from 'node:url'

import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { watch } from 'chokidar'
import { defineConfig, normalizePath, type Plugin } from 'vite'

const tauriDevHost = process.env.TAURI_DEV_HOST
const projectRoot = fileURLToPath(new URL('.', import.meta.url))
const configuredDistribution = process.env.FLOW_READER_DISTRIBUTION
if (configuredDistribution && !['local', 'release', 'updater-test'].includes(configuredDistribution)) {
  throw new Error(`Unsupported FLOW_READER_DISTRIBUTION: ${configuredDistribution}`)
}
const distribution = configuredDistribution ?? 'local'
const tauriConfig = JSON.parse(readFileSync(resolve(projectRoot, 'src-tauri/tauri.conf.json'), 'utf8')) as {
  bundle: { copyright: string }
  version: string
}

function localBuildVersion() {
  try {
    const commit = execFileSync('git', ['rev-parse', '--short=8', 'HEAD'], {
      cwd: projectRoot,
      encoding: 'utf8',
    }).trim()
    return commit
  } catch {
    return 'local'
  }
}

const buildVersion =
  distribution === 'release'
    ? tauriConfig.version
    : distribution === 'updater-test'
      ? (process.env.FLOW_READER_BUILD_VERSION?.trim() ?? 'updater-test')
      : localBuildVersion()
const sourceRepositoryUrl = process.env.FLOW_READER_SOURCE_URL?.trim() ?? ''
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

export default defineConfig(({ mode }) => ({
  base: './',
  build: {
    outDir: 'dist',
    ...(mode === 'react-render' ? { rolldownOptions: { output: { keepNames: true } } } : {}),
    target: 'es2020',
  },
  clearScreen: false,
  define: {
    __FLOW_READER_BUILD_VERSION__: JSON.stringify(buildVersion),
    __FLOW_READER_COPYRIGHT__: JSON.stringify(tauriConfig.bundle.copyright),
    __FLOW_READER_SOURCE_URL__: JSON.stringify(sourceRepositoryUrl),
  },
  plugins: [tailwindcss(), react(), sourceOnlyWatcher()],
  resolve: {
    alias: [
      ...(mode === 'react-render'
        ? [
            {
              find: 'react-dom/client',
              replacement: fileURLToPath(new URL('./node_modules/react-dom/profiling.js', import.meta.url)),
            },
          ]
        : []),
      {
        find: /^@\/updater-entry$/,
        replacement: fileURLToPath(
          new URL(distribution === 'local' ? './src/updater/local.tsx' : './src/updater-entry.tsx', import.meta.url),
        ),
      },
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
}))
