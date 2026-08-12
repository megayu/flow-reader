import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import { repositoryRoot, runPnpm, shellExtensionDistributionCargoProfile } from './distribution-cargo.ts'

const platform = process.argv[2]

function publishWindowsProvider() {
  const cargoOutput = resolve(
    repositoryRoot,
    'native/shell-thumbnails/target/x86_64-pc-windows-msvc/release/flow_reader_thumbnail.dll',
  )
  const distributionOutput = resolve(repositoryRoot, 'native/shell-thumbnails/dist/windows/FlowReaderThumbnail.dll')

  mkdirSync(dirname(distributionOutput), { recursive: true })
  copyFileSync(cargoOutput, distributionOutput)
  console.log(`DLL=${distributionOutput}`)
}

switch (platform) {
  case 'windows':
    if (process.platform !== 'win32') {
      throw new Error('The Windows thumbnail distribution must be built on Windows.')
    }
    runPnpm(['run', 'thumbnail:build:windows'], shellExtensionDistributionCargoProfile)
    publishWindowsProvider()
    break
  case 'macos':
    if (process.platform !== 'darwin') {
      throw new Error('The macOS thumbnail distribution must be built on macOS.')
    }
    runPnpm(['run', 'thumbnail:build:macos'], shellExtensionDistributionCargoProfile)
    break
  default:
    throw new Error('Usage: node scripts/build-thumbnail-distribution.ts <windows|macos>')
}
