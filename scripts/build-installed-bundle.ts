import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { applicationBundleCargoProfile, repositoryRoot, runTauri } from './bundle-cargo.ts'

const platform = process.argv[2]
const flavor = process.argv[3]

if (flavor !== 'local' && flavor !== 'release') {
  throw new Error('Usage: node scripts/build-installed-bundle.ts <windows|macos|linux> <local|release>')
}

const sourceRepositoryUrl = (
  process.env.FLOW_READER_SOURCE_URL ??
  (process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}`
    : '')
)
  .trim()
  .replace(/\/+$/u, '')
const buildEnvironment = {
  ...applicationBundleCargoProfile,
  FLOW_READER_DISTRIBUTION: flavor,
  FLOW_READER_SOURCE_URL: sourceRepositoryUrl,
}

function releaseArguments() {
  if (flavor !== 'release') return []

  const publicKey = process.env.FLOW_READER_UPDATER_PUBLIC_KEY?.trim()
  const privateKey = process.env.TAURI_SIGNING_PRIVATE_KEY?.trim()
  const endpoint =
    process.env.FLOW_READER_UPDATER_ENDPOINT?.trim() ||
    (sourceRepositoryUrl ? `${sourceRepositoryUrl}/releases/latest/download/latest.json` : '')
  if (!publicKey) {
    throw new Error('FLOW_READER_UPDATER_PUBLIC_KEY is required for a release bundle.')
  }
  if (!privateKey) {
    throw new Error('TAURI_SIGNING_PRIVATE_KEY is required for a release bundle.')
  }
  if (!endpoint.startsWith('https://')) {
    throw new Error('A release updater HTTPS endpoint is required.')
  }

  const config = {
    app: {
      security: {
        capabilities: [
          'default',
          {
            identifier: 'release-updater',
            description: 'Allows the main window to check, download, install, and restart after signed updates.',
            windows: ['main'],
            permissions: ['updater:default', 'process:allow-restart'],
          },
        ],
      },
    },
    bundle: {
      createUpdaterArtifacts: true,
    },
    plugins: {
      updater: {
        endpoints: [endpoint],
        pubkey: publicKey,
        windows: {
          installMode: 'passive',
        },
      },
    },
  }

  return ['--features', 'updater', '--config', JSON.stringify(config)]
}

const updaterArguments = releaseArguments()

function prepareLinuxAppRun() {
  const arch = process.arch === 'x64' ? 'x86_64' : 'aarch64'
  const metadata = JSON.parse(
    execFileSync(
      'cargo',
      ['metadata', '--no-deps', '--format-version', '1', '--manifest-path', 'src-tauri/Cargo.toml'],
      {
        cwd: repositoryRoot,
        encoding: 'utf8',
      },
    ),
  ) as { target_directory: string }
  const toolsDirectory = join(metadata.target_directory, '.tauri')
  const appRun = join(toolsDirectory, `AppRun-${arch}`)
  mkdirSync(toolsDirectory, { recursive: true })

  // Tauri 2.11.4 creates AppRun with mode 770; linuxdeploy preserves it as AppRun.wrapped.
  if (!existsSync(appRun)) {
    const download = `${appRun}.${process.pid}.download`
    try {
      execFileSync(
        'curl',
        [
          '--fail',
          '--location',
          '--retry',
          '3',
          '--output',
          download,
          `https://github.com/tauri-apps/binary-releases/releases/download/apprun-old/AppRun-${arch}`,
        ],
        { stdio: 'inherit' },
      )
      chmodSync(download, 0o755)
      renameSync(download, appRun)
    } finally {
      rmSync(download, { force: true })
    }
  }
  chmodSync(appRun, 0o755)
}

switch (platform) {
  case 'windows':
    if (process.platform !== 'win32') {
      throw new Error('The Windows installed bundle must be built on Windows.')
    }
    if (process.arch !== 'x64' && process.arch !== 'arm64') {
      throw new Error(`The Windows installed bundle does not support ${process.arch}.`)
    }
    runTauri(
      [
        'build',
        '--bundles',
        'nsis',
        '--config',
        'src-tauri/tauri.shell-windows.conf.json',
        '--config',
        'native/shell-thumbnails/dist/windows/tauri.shell-windows.generated.conf.json',
        ...updaterArguments,
      ],
      buildEnvironment,
    )
    break
  case 'macos':
    if (process.platform !== 'darwin') {
      throw new Error('The macOS installed bundle must be built on macOS.')
    }
    runTauri(
      [
        'build',
        '--target',
        'universal-apple-darwin',
        '--config',
        'src-tauri/tauri.shell-macos.conf.json',
        ...updaterArguments,
      ],
      {
        ...buildEnvironment,
        APPLE_SIGNING_IDENTITY: process.env.APPLE_SIGNING_IDENTITY?.trim() || '-',
      },
    )
    break
  case 'linux':
    if (process.platform !== 'linux') {
      throw new Error('The Linux installed bundle must be built on Linux.')
    }
    if (process.arch !== 'x64' && process.arch !== 'arm64') {
      throw new Error(`The Linux installed bundle does not support ${process.arch}.`)
    }
    prepareLinuxAppRun()
    runTauri(
      [
        'build',
        '--bundles',
        'appimage',
        '--config',
        'src-tauri/tauri.shell-linux.conf.json',
        ...updaterArguments,
        '--verbose',
      ],
      buildEnvironment,
    )
    break
  default:
    throw new Error('Usage: node scripts/build-installed-bundle.ts <windows|macos|linux> <local|release>')
}
