import { spawn } from 'node:child_process'
import { rm } from 'node:fs/promises'
import path from 'node:path'

const command = process.platform === 'win32' ? 'cmd.exe' : 'pnpm'
const testTargets = process.argv.slice(2)
const args =
  process.platform === 'win32'
    ? ['/d', '/s', '/c', 'pnpm', 'exec', 'playwright', 'test', ...testTargets]
    : ['exec', 'playwright', 'test', ...testTargets]

const child = spawn(command, args, {
  stdio: 'inherit',
})

const exitCode = await new Promise((resolve) => {
  child.on('error', () => resolve(1))
  child.on('close', (code) => resolve(code ?? 1))
})

await rm(path.join(process.cwd(), 'test-results'), {
  force: true,
  recursive: true,
})

process.exit(exitCode)
