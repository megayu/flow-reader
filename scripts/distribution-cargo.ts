import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))

export const repositoryRoot = resolve(scriptDir, '..')

export const applicationDistributionCargoProfile = {
  CARGO_PROFILE_RELEASE_OPT_LEVEL: '3',
  CARGO_PROFILE_RELEASE_LTO: 'true',
  CARGO_PROFILE_RELEASE_CODEGEN_UNITS: '1',
  CARGO_PROFILE_RELEASE_STRIP: 'true',
  CARGO_PROFILE_RELEASE_PANIC: 'abort',
} satisfies NodeJS.ProcessEnv

export const shellExtensionDistributionCargoProfile = {
  CARGO_PROFILE_RELEASE_OPT_LEVEL: 'z',
  CARGO_PROFILE_RELEASE_LTO: 'fat',
  CARGO_PROFILE_RELEASE_CODEGEN_UNITS: '1',
  CARGO_PROFILE_RELEASE_STRIP: 'symbols',
  CARGO_PROFILE_RELEASE_PANIC: 'unwind',
} satisfies NodeJS.ProcessEnv

export function runPnpm(args: string[], cargoProfile: NodeJS.ProcessEnv) {
  const pnpmExecPath = process.env.npm_execpath
  const command = pnpmExecPath ? process.execPath : process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
  const commandArgs = pnpmExecPath ? [pnpmExecPath, ...args] : args
  const result = spawnSync(command, commandArgs, {
    cwd: repositoryRoot,
    stdio: 'inherit',
    shell: false,
    env: {
      ...process.env,
      ...cargoProfile,
    },
  })

  if (result.error) {
    throw result.error
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}
