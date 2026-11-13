import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const workspace = ['--manifest-path', 'native/shell-thumbnails/Cargo.toml', '--workspace']
const build = spawnSync('cargo', ['build', ...workspace, '--message-format=json-render-diagnostics'], {
  cwd: root,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'inherit'],
  maxBuffer: 16 * 1024 * 1024,
})
if (build.error) throw build.error
if (build.status !== 0) process.exit(build.status ?? 1)

let providerDll: string | undefined
if (process.platform === 'win32') {
  for (const line of build.stdout.split(/\r?\n/)) {
    if (!line.startsWith('{')) continue
    const message = JSON.parse(line) as {
      reason: string
      target?: { name: string; crate_types: string[] }
      filenames?: string[]
    }
    if (
      message.reason === 'compiler-artifact' &&
      message.target?.name === 'flow_reader_thumbnail' &&
      message.target.crate_types.includes('cdylib')
    ) {
      providerDll = message.filenames?.find((path) => path.endsWith('.dll'))
      if (providerDll) break
    }
  }
  if (!providerDll) throw new Error('Cargo did not report a thumbnail provider DLL in its build artifacts.')
}

const test = spawnSync('cargo', ['test', ...workspace], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, FLOW_THUMBNAIL_PROVIDER_DLL: providerDll },
})
if (test.error) throw test.error
process.exit(test.status ?? 1)
