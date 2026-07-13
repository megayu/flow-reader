import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/** @type {import('next').NextConfig} */
const config = {
  output: 'export',
  pageExtensions: ['ts', 'tsx'],
  transpilePackages: ['@flow/epubjs'],
  turbopack: {
    root: dirname(fileURLToPath(import.meta.url)),
  },
}

export default config
