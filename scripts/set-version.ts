import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { parseChangelog } from '../src/updateChangelog.ts'

import { repositoryRoot } from './bundle-cargo.ts'

const [requestedVersion, ...extraArguments] = process.argv.slice(2).filter((argument) => argument !== '--')
if (!requestedVersion || extraArguments.length > 0 || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(requestedVersion)) {
  throw new Error('Usage: pnpm version:set <semver>')
}
const version = requestedVersion
const appleBundleVersion = version.split('-', 1)[0] ?? version

const tauriConfigPath = resolve(repositoryRoot, 'src-tauri/tauri.conf.json')
const cargoManifestPath = resolve(repositoryRoot, 'src-tauri/Cargo.toml')
const cargoLockPath = resolve(repositoryRoot, 'src-tauri/Cargo.lock')
const cratesManifestPath = resolve(repositoryRoot, 'crates/Cargo.toml')
const cratesLockPath = resolve(repositoryRoot, 'crates/Cargo.lock')
const thumbnailManifestPath = resolve(repositoryRoot, 'native/shell-thumbnails/Cargo.toml')
const thumbnailLockPath = resolve(repositoryRoot, 'native/shell-thumbnails/Cargo.lock')
const thumbnailXcodeProjectPath = resolve(
  repositoryRoot,
  'native/shell-thumbnails/macos-extension/FlowReaderThumbnail.xcodeproj/project.pbxproj',
)
const changelogPath = resolve(repositoryRoot, 'CHANGELOG.md')

function replaceSingleVersion(source: string, pattern: RegExp, replacement: string, description: string) {
  const matches = [...source.matchAll(pattern)]
  if (matches.length !== 1) throw new Error(`Expected one ${description}, found ${matches.length}.`)
  return source.replace(pattern, replacement)
}

function replaceVersions(source: string, pattern: RegExp, replacement: string, expected: number, description: string) {
  const matches = [...source.matchAll(pattern)]
  if (matches.length !== expected) throw new Error(`Expected ${expected} ${description}, found ${matches.length}.`)
  return source.replace(pattern, replacement)
}

function replaceCargoLockPackageVersions(source: string, packageNames: string[], description: string) {
  return packageNames.reduce(
    (lock, packageName) =>
      replaceSingleVersion(
        lock,
        new RegExp(`(?<=^\\[\\[package\\]\\]\\r?\\nname = "${packageName}"\\r?\\nversion = ")([^"]+)(?=")`, 'gmu'),
        version,
        `${packageName} package version in ${description}`,
      ),
    source,
  )
}

const tauriConfigSource = readFileSync(tauriConfigPath, 'utf8')
const parsedTauriConfig = JSON.parse(tauriConfigSource) as { version?: string }
if (typeof parsedTauriConfig.version !== 'string') {
  throw new Error('src-tauri/tauri.conf.json does not define a version.')
}
const tauriConfig = replaceSingleVersion(
  tauriConfigSource,
  /^ {2}"version": "[^"]+",$/gmu,
  `  "version": "${version}",`,
  'application version in src-tauri/tauri.conf.json',
)

const cargoManifest = replaceSingleVersion(
  readFileSync(cargoManifestPath, 'utf8'),
  /(?<=^\[package\]\r?\n(?:.*\r?\n)*?^version = ")([^"]+)(?=")/gmu,
  version,
  'flow-reader package version in src-tauri/Cargo.toml',
)
const cargoLock = replaceCargoLockPackageVersions(
  readFileSync(cargoLockPath, 'utf8'),
  ['flow-epub-cover', 'flow-reader'],
  'src-tauri/Cargo.lock',
)
const cratesManifest = replaceSingleVersion(
  readFileSync(cratesManifestPath, 'utf8'),
  /(?<=^\[workspace\.package\]\r?\n(?:.*\r?\n)*?^version = ")([^"]+)(?=")/gmu,
  version,
  'workspace package version in crates/Cargo.toml',
)
const cratesLock = replaceCargoLockPackageVersions(
  readFileSync(cratesLockPath, 'utf8'),
  ['flow-epub-cover', 'flow-epub-thumbnail'],
  'crates/Cargo.lock',
)
const thumbnailManifest = replaceSingleVersion(
  readFileSync(thumbnailManifestPath, 'utf8'),
  /(?<=^\[workspace\.package\]\r?\n(?:.*\r?\n)*?^version = ")([^"]+)(?=")/gmu,
  version,
  'workspace package version in native/shell-thumbnails/Cargo.toml',
)
const thumbnailLock = replaceCargoLockPackageVersions(
  readFileSync(thumbnailLockPath, 'utf8'),
  ['flow-epub-cover', 'flow-epub-thumbnail', 'flow-macos-thumbnail-ffi', 'flow-windows-thumbnail-provider'],
  'native/shell-thumbnails/Cargo.lock',
)
const thumbnailXcodeProjectSource = readFileSync(thumbnailXcodeProjectPath, 'utf8')
const thumbnailXcodeProjectWithMarketingVersion = replaceVersions(
  thumbnailXcodeProjectSource,
  /(?<=^\s*MARKETING_VERSION = )[^;]+(?=;)/gmu,
  appleBundleVersion,
  2,
  'MARKETING_VERSION values in the thumbnail Xcode project',
)
const thumbnailXcodeProject = replaceVersions(
  thumbnailXcodeProjectWithMarketingVersion,
  /(?<=^\s*CURRENT_PROJECT_VERSION = )[^;]+(?=;)/gmu,
  appleBundleVersion,
  2,
  'CURRENT_PROJECT_VERSION values in the thumbnail Xcode project',
)

function releaseChangelogVersion(markdown: string) {
  const sections = parseChangelog(markdown)
  if (sections.some((section) => section.version === version)) {
    if (version !== parsedTauriConfig.version) {
      throw new Error(`CHANGELOG.md already contains historical release ${version}.`)
    }
    return markdown
  }

  const unreleased = /^## \[Unreleased\][ \t]*\r?\n([\s\S]*?)(?=^## \[)/mu.exec(markdown)
  if (!unreleased) throw new Error('CHANGELOG.md must contain [Unreleased] before its released versions.')

  const unreleasedBody = unreleased[1]?.trim() ?? ''
  if (!unreleasedBody) {
    throw new Error('CHANGELOG.md [Unreleased] must contain release notes before setting a new version.')
  }
  const date = new Date().toISOString().slice(0, 10)
  const released = `## [${version}] - ${date}\n\n${unreleasedBody}`
  return markdown.replace(unreleased[0], `## [Unreleased]\n\n${released}\n\n`)
}

const changelog = releaseChangelogVersion(readFileSync(changelogPath, 'utf8'))

writeFileSync(tauriConfigPath, tauriConfig)
writeFileSync(cargoManifestPath, cargoManifest)
writeFileSync(cargoLockPath, cargoLock)
writeFileSync(cratesManifestPath, cratesManifest)
writeFileSync(cratesLockPath, cratesLock)
writeFileSync(thumbnailManifestPath, thumbnailManifest)
writeFileSync(thumbnailLockPath, thumbnailLock)
writeFileSync(thumbnailXcodeProjectPath, thumbnailXcodeProject)
writeFileSync(changelogPath, changelog)

console.log(`Set Flow Reader version to ${version}.`)
