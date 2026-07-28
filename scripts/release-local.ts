import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const rootDir = resolve(scriptDir, '..')
const targetDir = join(rootDir, 'src-tauri', 'target', 'release')
const releaseDir = join(rootDir, 'release')
const localReleaseCargoProfile = {
  CARGO_PROFILE_RELEASE_OPT_LEVEL: '3',
  CARGO_PROFILE_RELEASE_LTO: 'true',
  CARGO_PROFILE_RELEASE_CODEGEN_UNITS: '1',
  CARGO_PROFILE_RELEASE_STRIP: 'true',
  CARGO_PROFILE_RELEASE_PANIC: 'abort',
}

interface TauriConfig {
  mainBinaryName?: string
  productName?: string
}

function runPnpmScript(scriptName: string) {
  const pnpmExecPath = process.env.npm_execpath
  const command = pnpmExecPath ? process.execPath : process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
  const args = pnpmExecPath ? [pnpmExecPath, 'run', scriptName] : ['run', scriptName]
  const result = spawnSync(command, args, {
    cwd: rootDir,
    stdio: 'inherit',
    shell: false,
    env: {
      ...process.env,
      ...localReleaseCargoProfile,
    },
  })

  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

function readJson(path: string): TauriConfig {
  return JSON.parse(readFileSync(path, 'utf8')) as TauriConfig
}

function readCargoPackageName() {
  const cargoToml = readFileSync(join(rootDir, 'src-tauri', 'Cargo.toml'), 'utf8')
  const packageSection = cargoToml.match(/\[package\]([\s\S]*?)(?:\n\[|$)/)
  const nameMatch = packageSection?.[1]?.match(/^\s*name\s*=\s*"([^"]+)"/m)
  return nameMatch?.[1]
}

function kebabCase(value: string) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
}

function unique(values: Array<string | undefined>) {
  return [...new Set(values.filter((value): value is string => Boolean(value)))]
}

function findReleaseBinary() {
  const tauriConfig = readJson(join(rootDir, 'src-tauri', 'tauri.conf.json'))
  const cargoPackageName = readCargoPackageName()
  const configuredNames = unique([
    tauriConfig.mainBinaryName,
    tauriConfig.productName,
    cargoPackageName,
    tauriConfig.productName ? kebabCase(tauriConfig.productName) : undefined,
  ])
  const extension = process.platform === 'win32' ? '.exe' : ''
  const candidates = configuredNames.flatMap((name) => {
    const withExtension = `${name}${extension}`
    return extension && name.endsWith(extension) ? [name] : [withExtension, name]
  })

  for (const candidate of unique(candidates)) {
    const path = join(targetDir, candidate)
    if (existsSync(path) && statSync(path).isFile()) {
      return path
    }
  }

  throw new Error(
    [`Could not find built Tauri binary in ${targetDir}.`, `Checked: ${unique(candidates).join(', ')}`].join('\n'),
  )
}

runPnpmScript('tauri:build')

mkdirSync(releaseDir, { recursive: true })

const sourceBinary = findReleaseBinary()
const destinationBinary = join(releaseDir, basename(sourceBinary))

rmSync(destinationBinary, { force: true })
renameSync(sourceBinary, destinationBinary)
console.log(`Moved ${sourceBinary} to ${destinationBinary}`)
