import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

import { changelogSectionForVersion, parseChangelog } from '../src/updateChangelog.ts'

import { repositoryRoot } from './bundle-cargo.ts'

const artifactRoot = resolve(repositoryRoot, process.argv[2] ?? 'release-artifacts')
const tag = process.env.GITHUB_REF_NAME?.trim()
const repository = process.env.GITHUB_REPOSITORY?.trim()
const serverUrl = process.env.GITHUB_SERVER_URL?.trim() ?? 'https://github.com'
if (!tag || !repository) {
  throw new Error('GITHUB_REF_NAME and GITHUB_REPOSITORY are required to generate latest.json.')
}
const releaseTag = tag
const releaseRepository = repository

const tauriConfig = JSON.parse(readFileSync(resolve(repositoryRoot, 'src-tauri/tauri.conf.json'), 'utf8')) as {
  version: string
}
if (releaseTag !== `v${tauriConfig.version}` && releaseTag !== tauriConfig.version) {
  throw new Error(`Release tag ${releaseTag} does not match application version ${tauriConfig.version}.`)
}

const changelog = readFileSync(resolve(repositoryRoot, 'CHANGELOG.md'), 'utf8').trim()
const releaseNotes = changelogSectionForVersion(changelog, tauriConfig.version)
if (!releaseNotes.body) {
  throw new Error(`CHANGELOG.md release ${tauriConfig.version} must contain release notes.`)
}
const changelogVersions = parseChangelog(changelog).map((section) => section.version)
if (changelogVersions[0] !== tauriConfig.version) {
  throw new Error(`CHANGELOG.md must place release ${tauriConfig.version} before every older release.`)
}

const releasedVersions = execFileSync('git', ['tag', '--list', 'v*', '--sort=-version:refname'], {
  cwd: repositoryRoot,
  encoding: 'utf8',
})
  .split(/\r?\n/u)
  .map((releaseTag) => releaseTag.trim())
  .filter((releaseTag) => /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(releaseTag))
  .map((releaseTag) => releaseTag.slice(1))

for (const releasedVersion of releasedVersions) {
  if (!changelogVersions.includes(releasedVersion)) {
    throw new Error(`CHANGELOG.md does not contain released version ${releasedVersion}.`)
  }
}
const changelogReleaseOrder = changelogVersions.filter((version) => releasedVersions.includes(version))
if (changelogReleaseOrder.join('\n') !== releasedVersions.join('\n')) {
  throw new Error('CHANGELOG.md must order every tagged release from newest to oldest.')
}

function filesBelow(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry)
    return statSync(path).isDirectory() ? filesBelow(path) : [path]
  })
}

function oneFile(directoryPrefix: string, predicate: (name: string) => boolean, description: string) {
  const matches = filesBelow(artifactRoot).filter((path) => {
    const relative = path.slice(artifactRoot.length + 1).replaceAll('\\', '/')
    return relative.split('/')[0]?.startsWith(directoryPrefix) && predicate(basename(path))
  })
  if (matches.length !== 1) {
    throw new Error(`Expected one ${description}, found ${matches.length}.`)
  }
  return matches[0]!
}

function updaterEntry(directoryPrefix: string, artifactPredicate: (name: string) => boolean, description: string) {
  const artifact = oneFile(directoryPrefix, artifactPredicate, description)
  const signature = oneFile(directoryPrefix, (name) => name === `${basename(artifact)}.sig`, `${description} signature`)
  const encodedTag = encodeURIComponent(releaseTag)
  const encodedArtifact = encodeURIComponent(basename(artifact))
  return {
    signature: readFileSync(signature, 'utf8').trim(),
    url: `${serverUrl}/${releaseRepository}/releases/download/${encodedTag}/${encodedArtifact}`,
  }
}

const windowsX64 = updaterEntry(
  'flow-reader-installed-windows-x86_64-',
  (name) => name.endsWith('-setup.exe'),
  'Windows x86_64 updater',
)
const windowsArm64 = updaterEntry(
  'flow-reader-installed-windows-aarch64-',
  (name) => name.endsWith('-setup.exe'),
  'Windows aarch64 updater',
)
const macosUniversal = updaterEntry(
  'flow-reader-installed-macos-universal-',
  (name) => name.endsWith('.app.tar.gz'),
  'macOS universal updater',
)
const linuxX64 = updaterEntry(
  'flow-reader-appimage-linux-x86_64-',
  (name) => name.endsWith('.AppImage'),
  'Linux x86_64 updater',
)
const linuxArm64 = updaterEntry(
  'flow-reader-appimage-linux-aarch64-',
  (name) => name.endsWith('.AppImage'),
  'Linux aarch64 updater',
)

const manifest = {
  version: tauriConfig.version,
  notes: changelog,
  platforms: {
    'darwin-aarch64': macosUniversal,
    'darwin-x86_64': macosUniversal,
    'linux-aarch64': linuxArm64,
    'linux-x86_64': linuxX64,
    'windows-aarch64': windowsArm64,
    'windows-x86_64': windowsX64,
  },
}

const output = resolve(artifactRoot, 'latest.json')
writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`)
const releaseNotesOutput = resolve(artifactRoot, 'release-notes.md')
writeFileSync(releaseNotesOutput, `${releaseNotes.markdown}\n`)
console.log(`Generated ${output}`)
console.log(`Generated ${releaseNotesOutput}`)
