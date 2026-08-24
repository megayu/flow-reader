import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))

export const repositoryRoot = resolve(scriptDir, '..')

export const applicationBundleCargoProfile = {
  CARGO_PROFILE_RELEASE_OPT_LEVEL: '3',
  CARGO_PROFILE_RELEASE_LTO: 'true',
  CARGO_PROFILE_RELEASE_CODEGEN_UNITS: '1',
  CARGO_PROFILE_RELEASE_STRIP: 'true',
  CARGO_PROFILE_RELEASE_PANIC: 'abort',
} satisfies NodeJS.ProcessEnv

export const shellExtensionBundleCargoProfile = {
  CARGO_PROFILE_RELEASE_OPT_LEVEL: 'z',
  CARGO_PROFILE_RELEASE_LTO: 'fat',
  CARGO_PROFILE_RELEASE_CODEGEN_UNITS: '1',
  CARGO_PROFILE_RELEASE_STRIP: 'symbols',
  CARGO_PROFILE_RELEASE_PANIC: 'unwind',
} satisfies NodeJS.ProcessEnv

export function runCommand(command: string, args: string[], environment: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    stdio: 'inherit',
    shell: false,
    env: {
      ...process.env,
      ...environment,
    },
  })

  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

export function runPnpm(args: string[], cargoProfile: NodeJS.ProcessEnv) {
  const pnpmExecPath = process.env.npm_execpath
  const command = pnpmExecPath ? process.execPath : process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
  const commandArgs = pnpmExecPath ? [pnpmExecPath, ...args] : args
  runCommand(command, commandArgs, cargoProfile)
}

export function runTauri(args: string[], environment: NodeJS.ProcessEnv) {
  const tauriEntry = resolve(repositoryRoot, 'node_modules/@tauri-apps/cli/tauri.js')
  runCommand(process.execPath, [tauriEntry, ...args], environment)
}

export function runCargo(args: string[], environment: NodeJS.ProcessEnv) {
  const command = process.platform === 'win32' ? 'cargo.exe' : 'cargo'
  runCommand(command, args, environment)
}
