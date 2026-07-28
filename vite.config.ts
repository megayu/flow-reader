import { fileURLToPath, URL } from 'node:url'

import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const tauriDevHost = process.env.TAURI_DEV_HOST

export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    target: 'es2020',
  },
  clearScreen: false,
  plugins: [tailwindcss(), react()],
  resolve: {
    alias: [
      {
        find: /^@\//,
        replacement: `${fileURLToPath(new URL('./src', import.meta.url))}/`,
      },
    ],
  },
  server: {
    host: tauriDevHost || 'localhost',
    port: 7127,
    strictPort: true,
  },
})
