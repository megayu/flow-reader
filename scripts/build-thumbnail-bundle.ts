import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import { repositoryRoot, runCargo, runCommand, runPnpm, shellExtensionBundleCargoProfile } from './bundle-cargo.ts'

const platform = process.argv[2]

function publishWindowsProvider() {
  const rustTarget = windowsRustTarget()
  const cargoOutput = resolve(
    repositoryRoot,
    `native/shell-thumbnails/target/${rustTarget}/release/flow_reader_thumbnail.dll`,
  )
  const bundleOutput = resolve(repositoryRoot, 'native/shell-thumbnails/dist/windows/FlowReaderThumbnail.dll')

  mkdirSync(dirname(bundleOutput), { recursive: true })
  copyFileSync(cargoOutput, bundleOutput)
  console.log(`DLL=${bundleOutput}`)
}

function windowsRustTarget() {
  if (process.arch === 'x64') return 'x86_64-pc-windows-msvc'
  if (process.arch === 'arm64') return 'aarch64-pc-windows-msvc'
  throw new Error(`The Windows thumbnail bundle does not support ${process.arch}.`)
}

switch (platform) {
  case 'windows':
    if (process.platform !== 'win32') {
      throw new Error('The Windows thumbnail bundle must be built on Windows.')
    }
    runCargo(
      [
        'build',
        '--locked',
        '--release',
        '--manifest-path',
        'native/shell-thumbnails/Cargo.toml',
        '--package',
        'flow-windows-thumbnail-provider',
        '--target',
        windowsRustTarget(),
      ],
      shellExtensionBundleCargoProfile,
    )
    publishWindowsProvider()
    break
  case 'macos':
    if (process.platform !== 'darwin') {
      throw new Error('The macOS thumbnail bundle must be built on macOS.')
    }
    runPnpm(['run', 'thumbnail:build:macos'], shellExtensionBundleCargoProfile)
    runCommand('/usr/bin/codesign', [
      '--force',
      '--sign',
      '-',
      '--timestamp=none',
      '--entitlements',
      resolve(
        repositoryRoot,
        'native/shell-thumbnails/macos-extension/FlowReaderThumbnail/FlowReaderThumbnail.entitlements',
      ),
      resolve(
        repositoryRoot,
        'native/shell-thumbnails/dist/macos/DerivedData/Build/Products/Release/FlowReaderThumbnail.appex',
      ),
    ])
    break
  default:
    throw new Error('Usage: node scripts/build-thumbnail-bundle.ts <windows|macos>')
}
