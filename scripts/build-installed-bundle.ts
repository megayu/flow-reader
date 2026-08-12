import { applicationDistributionCargoProfile, runPnpm } from './distribution-cargo.ts'

const platform = process.argv[2]

switch (platform) {
  case 'windows':
    if (process.platform !== 'win32') {
      throw new Error('The Windows installed bundle must be built on Windows.')
    }
    if (process.arch !== 'x64') {
      throw new Error('The first Windows installed bundle is supported only on an x64 build host.')
    }
    runPnpm(
      [
        'exec',
        'tauri',
        'build',
        '--bundles',
        'nsis',
        '--config',
        'src-tauri/tauri.shell-windows.conf.json',
        '--config',
        'native/shell-thumbnails/dist/windows/tauri.shell-windows.generated.conf.json',
      ],
      applicationDistributionCargoProfile,
    )
    break
  case 'macos':
    if (process.platform !== 'darwin') {
      throw new Error('The macOS installed bundle must be built on macOS.')
    }
    runPnpm(
      [
        'exec',
        'tauri',
        'build',
        '--target',
        'universal-apple-darwin',
        '--config',
        'src-tauri/tauri.shell-macos.conf.json',
      ],
      applicationDistributionCargoProfile,
    )
    break
  case 'linux':
    if (process.platform !== 'linux') {
      throw new Error('The Linux installed bundle must be built on Linux.')
    }
    if (process.arch !== 'x64') {
      throw new Error('The first Linux installed bundle is supported only on an x64 build host.')
    }
    runPnpm(
      ['exec', 'tauri', 'build', '--bundles', 'deb', '--config', 'src-tauri/tauri.shell-linux.conf.json'],
      applicationDistributionCargoProfile,
    )
    break
  default:
    throw new Error('Usage: node scripts/build-installed-bundle.ts <windows|macos|linux>')
}
