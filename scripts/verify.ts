import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
process.chdir(root)

// Keep selection, local execution, and CI matrix construction on the same catalog.
const groups = {
  node: { runner: 'ubuntu-24.04', dependencies: true },
  chromium: { runner: 'ubuntu-24.04', dependencies: true, browser: 'chromium' },
  webkit: { runner: 'ubuntu-24.04', dependencies: true, browser: 'webkit' },
  rust: { runner: 'windows-2025', lock: 'src-tauri/Cargo.lock', target: 'src-tauri/target' },
  crates: { runner: 'ubuntu-24.04', lock: 'crates/Cargo.lock', target: 'crates/target' },
  native: {
    runner: 'windows-2025',
    lock: 'native/shell-thumbnails/Cargo.lock',
    target: 'native/shell-thumbnails/target',
  },
  portable: { runner: 'ubuntu-24.04' },
  powershell: { runner: 'windows-2025' },
  macos: { runner: 'macos-15-intel', platform: 'darwin' },
} satisfies Record<
  string,
  { runner: string; dependencies?: boolean; browser?: string; lock?: string; target?: string; platform?: string }
>

interface Check {
  group: keyof typeof groups
  script?: string
  args?: string[]
}

// Order cheap checks before tests and native builds when executing locally.
const checks = {
  app: { group: 'node', script: 'check:app' },
  'test-static': { group: 'node', script: 'check:test-static' },
  scripts: { group: 'node', script: 'check:scripts' },
  skills: { group: 'node', script: 'check:skills' },
  json: { group: 'portable' },
  shell: { group: 'portable' },
  powershell: { group: 'powershell' },
  workflows: { group: 'portable' },
  'native-macos': { group: 'macos' },
  unit: { group: 'node', script: 'test:unit:ci' },
  'epub-engine': { group: 'chromium', script: 'check:epub-engine:ci' },
  'integration-chromium': { group: 'chromium', script: 'test:integration:ci', args: ['--project=chromium'] },
  'integration-webkit': { group: 'webkit', script: 'test:integration:ci', args: ['--project=webkit'] },
  rust: { group: 'rust', script: 'check:rust' },
  crates: { group: 'crates', script: 'check:crates' },
  'native-rust': { group: 'native', script: 'check:native-rust' },
} satisfies Record<string, Check>
type CheckId = keyof typeof checks
const allChecks = Object.keys(checks) as CheckId[]
const webChecks: CheckId[] = ['app', 'test-static', 'unit', 'integration-chromium', 'integration-webkit']
const rustChecks: CheckId[] = ['rust', 'crates', 'native-rust']

function git(args: string[]) {
  const result = spawnSync('git', args, { encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(result.stderr.trim() || `git ${args[0]} failed`)
  return result.stdout
}

function revision(ref: string) {
  return git(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]).trim()
}

const { values } = parseArgs({
  options: {
    plan: { type: 'boolean' },
    json: { type: 'boolean' },
    all: { type: 'boolean' },
    local: { type: 'boolean' },
    base: { type: 'string' },
    head: { type: 'string' },
    checks: { type: 'string' },
    'ci-plan': { type: 'boolean' },
    help: { type: 'boolean' },
  },
})

function selectChecks(files: string[], full: boolean) {
  const reasons = new Map<CheckId, Set<string>>()
  const add = (ids: readonly CheckId[], reason: string) => {
    for (const id of ids) {
      if (!reasons.has(id)) reasons.set(id, new Set())
      reasons.get(id)!.add(reason)
    }
  }
  if (full) add(allChecks, 'Full verification requested')
  for (const path of full ? [] : files) {
    if (path === 'scripts/verify.ts' || path === '.github/workflows/ci.yml') {
      add(allChecks, `${path}: verification infrastructure`)
    } else if (['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc'].includes(path)) {
      add(
        [...webChecks, ...rustChecks, 'scripts', 'skills', 'epub-engine', 'json'],
        `${path}: commands or dependencies`,
      )
    } else if (path === 'rust-toolchain.toml' || path.startsWith('.cargo/')) {
      add(rustChecks, `${path}: shared Rust toolchain`)
    } else if (path.startsWith('src/')) {
      add(webChecks, `${path}: application and browser consumers`)
      if (path === 'src/updateChangelog.ts') add(['scripts'], `${path}: release script dependency`)
    } else if (path.startsWith('packages/epub-engine/')) {
      add([...webChecks, 'epub-engine'], `${path}: EPUB engine and application consumers`)
    } else if (path.startsWith('packages/')) {
      add(allChecks, `${path}: unclassified workspace package`)
    } else if (['components.json', 'index.html', 'tsconfig.json', 'vite.config.ts'].includes(path)) {
      add([...webChecks, 'scripts'], `${path}: shared web build configuration`)
    } else if (path === 'biome.json') {
      add(['app', 'test-static', 'scripts', 'skills'], `${path}: static check configuration`)
    } else if (path === 'playwright.config.ts') {
      add(['test-static', 'integration-chromium', 'integration-webkit'], `${path}: browser test configuration`)
    } else if (path === 'vitest.config.ts') {
      add(['test-static', 'unit'], `${path}: unit test configuration`)
    } else if (path.startsWith('tests/unit/')) {
      add(['test-static', 'unit'], `${path}: unit tests`)
    } else if (path.startsWith('tests/integration/')) {
      add(['test-static', 'integration-chromium', 'integration-webkit'], `${path}: browser tests`)
    } else if (path.startsWith('tests/')) {
      add(
        ['test-static', 'unit', 'integration-chromium', 'integration-webkit', 'rust'],
        `${path}: shared fixtures or test tooling`,
      )
    } else if (path.startsWith('src-tauri/')) {
      add(['rust'], `${path}: native application`)
      if (path.endsWith('.json')) add(['json'], `${path}: Tauri configuration`)
    } else if (path.startsWith('crates/')) {
      add(rustChecks, `${path}: shared crates and consumers`)
    } else if (path.startsWith('native/shell-thumbnails/')) {
      add(['native-rust'], `${path}: native extensions`)
      if (/\.(swift|plist|entitlements|pbxproj|xcscheme|h)$/.test(path)) add(['native-macos'], path)
      if (path.endsWith('.sh')) add(['shell'], path)
      if (path.endsWith('.ps1')) add(['powershell'], path)
      if (path.endsWith('.json')) add(['json'], path)
    } else if (path.startsWith('scripts/')) {
      if (path.endsWith('.sh')) add(['shell'], path)
      else if (path.endsWith('.ps1')) add(['powershell'], path)
      else add(['scripts'], `${path}: repository scripts`)
    } else if (path.startsWith('.agents/skills/')) {
      if (/\.(mjs|js|ts|json)$/.test(path)) add(['skills'], `${path}: skill tooling`)
    } else if (path.startsWith('.github/workflows/')) {
      add(['workflows'], `${path}: workflow definition`)
    } else if (path.startsWith('.husky/')) {
      add(['shell'], `${path}: Git hook`)
    } else if (!/\.md$/.test(path) && !['LICENSE', '.gitignore'].includes(path) && !path.startsWith('.vscode/')) {
      add(allChecks, `${path}: unclassified file (conservative fallback)`)
    }
  }
  return reasons
}

function changedFiles() {
  if (values.all || values.checks) return { files: [] as string[], full: Boolean(values.all), base: null, head: null }
  if (values['ci-plan']) {
    const head = revision(process.env.GITHUB_SHA || 'HEAD')
    const baseRef = process.env.GITHUB_EVENT_NAME === 'pull_request' ? process.env.PR_BASE_SHA : process.env.BEFORE_SHA
    let base: string | undefined
    if (baseRef && !/^0+$/.test(baseRef)) {
      try {
        base = revision(baseRef)
      } catch {
        /* Missing history requires all checks, not a guessed diff. */
      }
    }
    if (!base) return { files: [], full: true, base: null, head }
    return {
      files: git(['diff', '--no-renames', '--name-only', '-z', base, head, '--']).split('\0').filter(Boolean),
      full: false,
      base,
      head,
    }
  }
  const base = revision(values.base ?? 'HEAD')
  const head = values.head ? revision(values.head) : null
  const files = git(['diff', '--no-renames', '--name-only', '-z', base, ...(head ? [head] : []), '--']).split('\0')
  if (!head) files.push(...git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0'))
  return { files: [...new Set(files.filter(Boolean))].sort(), full: false, base, head }
}

function run(command: string, args: string[], input?: string) {
  const result = spawnSync(command, args, {
    stdio: input === undefined ? 'inherit' : ['pipe', 'inherit', 'inherit'],
    input,
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} failed (${result.signal ?? result.status})`)
}

function pnpm(args: string[], xvfb = false) {
  const entry = process.env.npm_execpath
  if (entry) {
    run(
      xvfb ? 'xvfb-run' : process.execPath,
      xvfb ? ['--auto-servernum', process.execPath, entry, ...args] : [entry, ...args],
    )
  } else if (process.platform === 'win32') {
    throw new Error('Run checks through pnpm verify so the pnpm executable can be resolved on Windows.')
  } else {
    run(xvfb ? 'xvfb-run' : 'pnpm', xvfb ? ['--auto-servernum', 'pnpm', ...args] : args)
  }
}

function execute(id: CheckId, files: string[]) {
  const check: Check = checks[id]
  if (check.script) {
    const headedWebkit = id === 'integration-webkit' && process.platform === 'linux' && Boolean(process.env.CI)
    pnpm([check.script, ...(check.args ?? []), ...(headedWebkit ? ['--headed'] : [])], headedWebkit)
  }
  if (id === 'skills') {
    for (const file of files.filter((file) => file.startsWith('.agents/skills/') && file.endsWith('.mjs')))
      run(process.execPath, ['--check', file])
  } else if (id === 'json') {
    for (const file of files.filter(
      (file) => file.endsWith('.json') && /^(src-tauri\/|native\/|package\.json$|components\.json$)/.test(file),
    )) {
      try {
        JSON.parse(readFileSync(file, 'utf8'))
      } catch (error) {
        throw new Error(`${file}: ${String(error)}`)
      }
    }
  } else if (id === 'shell') {
    for (const file of files.filter((file) => file.endsWith('.sh') || /^\.husky\/[^/]+$/.test(file)))
      run('bash', ['-n', file])
  } else if (id === 'powershell') {
    run(
      'pwsh',
      [
        '-NoProfile',
        '-Command',
        '$ErrorActionPreference = "Stop"; ($input | Out-String | ConvertFrom-Json) | ForEach-Object { $tokens = $null; $errors = $null; [void][System.Management.Automation.Language.Parser]::ParseFile([IO.Path]::GetFullPath($_), [ref]$tokens, [ref]$errors); if ($errors.Count) { throw ($errors | Out-String) } }',
      ],
      JSON.stringify(files.filter((file) => file.endsWith('.ps1'))),
    )
  } else if (id === 'workflows') {
    run('actionlint', [])
  } else if (id === 'native-macos') {
    for (const file of files.filter((file) => file.startsWith('native/shell-thumbnails/macos-extension/'))) {
      if (file.endsWith('.swift')) run('swiftc', ['-parse', file])
      if (/\.(plist|entitlements)$/.test(file)) run('plutil', ['-lint', file])
    }
    run('xcodebuild', ['-list', '-project', 'native/shell-thumbnails/macos-extension/FlowReaderThumbnail.xcodeproj'])
  }
}

function main() {
  if (values.help) {
    console.log(
      'pnpm verify [--plan] [--json] [--base <ref> [--head <ref>]] [--all] [--local]\nDefault: tracked changes against HEAD plus untracked, non-ignored files.\n--local explicitly defers checks requiring another OS to CI.\n--checks <comma-separated IDs> runs an exact CI matrix selection; --ci-plan writes GITHUB_OUTPUT.',
    )
    return
  }
  if (values.head && !values.base) throw new Error('--head requires --base')
  if (
    [Boolean(values.all), Boolean(values.checks), Boolean(values['ci-plan']), Boolean(values.base)].filter(Boolean)
      .length > 1
  )
    throw new Error('Choose only one of --all, --checks, --ci-plan, or --base')
  const change = changedFiles()
  const reasons = selectChecks(change.files, change.full)
  if (values.checks !== undefined) {
    for (const id of values.checks.split(',')) {
      if (!allChecks.includes(id as CheckId)) throw new Error(`Unknown check: ${id}`)
      reasons.set(id as CheckId, new Set(['Explicit check selection']))
    }
  }
  const selected = allChecks
    .filter((id) => reasons.has(id))
    .map((id) => {
      const group = groups[checks[id].group]
      return {
        id,
        group: checks[id].group,
        reasons: [...reasons.get(id)!].sort(),
        runnable: !('platform' in group) || group.platform === process.platform,
      }
    })
  const plan = {
    base: change.base,
    head: change.head ?? 'working tree',
    full: change.full,
    changed: change.files,
    checks: selected,
  }
  if (values.json) console.log(JSON.stringify(plan, null, 2))
  else {
    console.log(
      `Verification: ${change.full ? 'all checks' : `${change.files.length} changed files`} (${change.base ?? 'all'} -> ${plan.head})`,
    )
    for (const check of selected)
      console.log(`${check.id}${check.runnable ? '' : ' [requires macOS]'}\n  ${check.reasons.join('\n  ')}`)
    if (!selected.length) console.log('No checks required.')
  }
  if (values['ci-plan']) {
    if (!process.env.GITHUB_OUTPUT) throw new Error('--ci-plan requires GITHUB_OUTPUT')
    const include = Object.entries(groups).flatMap(([area, metadata]) => {
      const ids = selected.filter((check) => check.group === area).map((check) => check.id)
      return ids.length ? [{ area, ...metadata, checks: ids.join(','), workflows: ids.includes('workflows') }] : []
    })
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `matrix=${JSON.stringify({ include })}\nhas_checks=${include.length > 0}\n`,
    )
    return
  }
  if (values.plan || values.json) return
  const deferred = selected.filter((check) => !check.runnable)
  if (deferred.length && !values.local)
    throw new Error('This plan requires macOS checks. Use CI, or --local to explicitly defer them.')
  const files = [
    ...new Set(
      git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
        .split('\0')
        .filter((file) => file && existsSync(file)),
    ),
  ].sort()
  for (const check of selected.filter((check) => check.runnable)) {
    console.log(`\nRunning ${check.id}`)
    execute(check.id, files)
  }
  console.log(
    `\nPassed ${selected.length - deferred.length} checks.${deferred.length ? ` Deferred to CI: ${deferred.map((check) => check.id).join(',')}. Cross-platform verification is incomplete.` : ''}`,
  )
}

try {
  main()
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
}
