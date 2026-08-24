import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

import { repositoryRoot } from './bundle-cargo.ts'

const platform = process.argv[2]
const flavor = process.argv[3] ?? 'local'
if (flavor !== 'local' && flavor !== 'release') {
  throw new Error('Usage: node scripts/collect-installed-bundle.ts <windows|macos|linux> [local|release]')
}
const releaseDirectory = resolve(repositoryRoot, 'release')
const { productName, version } = JSON.parse(
  readFileSync(resolve(repositoryRoot, 'src-tauri/tauri.conf.json'), 'utf8'),
) as { productName: string; version: string }

interface ArtifactSource {
  directory: string
  matches: (name: string) => boolean
  description: string
}

function oneArtifact(source: ArtifactSource) {
  const entries = existsSync(source.directory)
    ? readdirSync(source.directory).filter((name) => source.matches(name))
    : []
  if (entries.length !== 1) {
    throw new Error(`Expected one ${source.description} in ${source.directory}, found ${entries.length}.`)
  }
  const [entry] = entries
  if (!entry) {
    throw new Error(`Could not resolve ${source.description} in ${source.directory}.`)
  }
  return join(source.directory, entry)
}

function artifactSources(): ArtifactSource[] {
  switch (platform) {
    case 'windows':
      return [
        {
          directory: resolve(repositoryRoot, 'src-tauri/target/release/bundle/nsis'),
          matches: (name) => name.startsWith(`${productName}_${version}_`) && name.endsWith('-setup.exe'),
          description: 'Windows NSIS installer',
        },
      ]
    case 'macos':
      return [
        {
          directory: resolve(repositoryRoot, 'src-tauri/target/universal-apple-darwin/release/bundle/macos'),
          matches: (name) => name === `${productName}.app`,
          description: 'macOS application bundle',
        },
      ]
    case 'linux':
      return [
        {
          directory: resolve(repositoryRoot, 'src-tauri/target/release/bundle/appimage'),
          matches: (name) => name.startsWith(`${productName}_${version}_`) && name.endsWith('.AppImage'),
          description: 'Linux AppImage',
        },
      ]
    default:
      throw new Error('Usage: node scripts/collect-installed-bundle.ts <windows|macos|linux>')
  }
}

function moveCompletedArtifact(source: string) {
  const destination = join(releaseDirectory, basename(source))
  const backup = join(releaseDirectory, `.${basename(source)}.${process.pid}.backup`)

  rmSync(backup, { force: true, recursive: true })
  if (existsSync(destination)) {
    renameSync(destination, backup)
  }
  try {
    renameSync(source, destination)
  } catch (error) {
    if (existsSync(backup)) {
      renameSync(backup, destination)
    }
    throw error
  }
  rmSync(backup, { force: true, recursive: true })
  console.log(`Moved ${source} to ${destination}`)
}

const artifacts = artifactSources().map(oneArtifact)
mkdirSync(releaseDirectory, { recursive: true })
for (const artifact of artifacts) {
  const signature = `${artifact}.sig`
  if (flavor === 'release' && platform !== 'macos' && !existsSync(signature)) {
    throw new Error(`Missing updater signature for ${artifact}.`)
  }
  moveCompletedArtifact(artifact)
  if (flavor === 'release' && existsSync(signature)) {
    moveCompletedArtifact(signature)
  }
}
