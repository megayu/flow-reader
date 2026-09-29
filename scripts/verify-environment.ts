import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

export async function checkEnvironment(checks: string[]) {
  const selected = new Set(checks)
  const problems: string[] = []
  const deferred: string[] = []
  const probe = (command: string, args: string[], preparation: string, deferMissing?: string) => {
    const result = spawnSync(command, args, { encoding: 'utf8', timeout: 10_000 })
    if (deferMissing && !process.env.CI && (result.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
      deferred.push(deferMissing)
      console.log(`Deferred to CI: ${deferMissing} (${command} is not installed locally). Verification is incomplete.`)
      return
    }
    if (result.error || result.status !== 0) {
      problems.push(
        `${command}: ${result.error?.message ?? (result.stderr || result.stdout).trim()}\n  Prepare: ${preparation}`,
      )
    }
  }
  const nodeChecks = [
    'app',
    'test-static',
    'scripts',
    'skills',
    'unit',
    'epub-engine',
    'integration-chromium',
    'integration-webkit',
  ]
  if (nodeChecks.some((id) => selected.has(id))) {
    const packages = new Set<string>()
    if (['app', 'test-static', 'scripts', 'skills'].some((id) => selected.has(id)))
      packages.add('@biomejs/biome/package.json')
    if (['app', 'test-static', 'scripts', 'epub-engine'].some((id) => selected.has(id))) packages.add('typescript')
    if (selected.has('app') || selected.has('integration-chromium') || selected.has('integration-webkit'))
      packages.add('vite')
    if (selected.has('unit') || selected.has('epub-engine')) packages.add('vitest/package.json')
    for (const name of packages) {
      try {
        require.resolve(name)
      } catch {
        problems.push(`${name} is unavailable.\n  Prepare: pnpm install --frozen-lockfile`)
      }
    }
  }
  if (['rust', 'crates', 'native-rust'].some((id) => selected.has(id))) {
    probe('rustc', ['--version'], 'rustup show (uses rust-toolchain.toml)')
    probe('cargo', ['clippy', '--version'], 'rustup component add clippy')
    probe('cargo', ['fmt', '--version'], 'rustup component add rustfmt')
  }
  if (selected.has('shell'))
    probe(
      'bash',
      ['--version'],
      process.platform === 'win32'
        ? 'winget install --id Git.Git; add Git/bin to PATH'
        : 'install Bash with your system package manager',
    )
  if (selected.has('powershell'))
    probe(
      'pwsh',
      ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'],
      process.platform === 'win32'
        ? 'winget install --id Microsoft.PowerShell'
        : 'install PowerShell 7 and add pwsh to PATH',
    )
  if (selected.has('workflows'))
    probe(
      'actionlint',
      ['-version'],
      'download the actionlint 1.7.12 binary for your OS from https://github.com/rhysd/actionlint/releases/tag/v1.7.12 and add it to PATH',
      'workflows',
    )
  if (selected.has('native-macos')) {
    probe(
      'xcodebuild',
      ['-version'],
      'install Xcode; sudo xcode-select --switch /Applications/Xcode.app/Contents/Developer',
    )
    probe('xcrun', ['--find', 'swiftc'], 'xcode-select --install')
  }
  if (selected.has('integration-webkit') && process.platform === 'linux' && process.env.CI) {
    probe('xvfb-run', ['--help'], 'sudo apt-get install xvfb')
  }
  const browsers = new Set<string>()
  if (selected.has('epub-engine')) browsers.add('chromium')
  if (selected.has('integration-chromium'))
    browsers.add(process.env.PLAYWRIGHT_BROWSER_CHANNEL ?? (process.platform === 'win32' ? 'msedge' : 'chromium'))
  if (selected.has('integration-webkit')) browsers.add('webkit')
  if (browsers.size) {
    try {
      const { chromium, webkit } = require('@playwright/test') as typeof import('@playwright/test')
      for (const name of browsers) {
        try {
          const browser = await (name === 'webkit' ? webkit : chromium).launch({
            ...(name !== 'webkit' && name !== 'chromium' ? { channel: name } : {}),
            timeout: 10_000,
          })
          await browser.close()
        } catch (error) {
          problems.push(
            `${name}: ${String(error)}\n  Prepare: pnpm exec playwright install${process.platform === 'linux' ? ' --with-deps' : ''} ${name}`,
          )
        }
      }
    } catch (error) {
      problems.push(`Playwright is unavailable: ${String(error)}\n  Prepare: pnpm install --frozen-lockfile`)
    }
  }
  if (problems.length) throw new Error(`Environment preflight failed:\n${problems.join('\n')}`)
  console.log(
    `Environment preflight passed (${checks.length - deferred.length} checks ready, ${deferred.length} deferred).`,
  )
  return deferred
}
