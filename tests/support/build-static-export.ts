import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

const resolveDependency = createRequire(import.meta.url)

export default async function buildStaticExport() {
  const build = spawn(
    process.execPath,
    [resolveDependency.resolve('next/dist/bin/next'), 'build'],
    { stdio: 'inherit' },
  )
  const exitCode = await new Promise<number>((resolve) => {
    build.on('error', () => resolve(1))
    build.on('close', (code) => resolve(code ?? 1))
  })
  if (exitCode !== 0) {
    throw new Error(`Next.js production build exited with code ${exitCode}`)
  }
}
