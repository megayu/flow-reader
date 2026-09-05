import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'

import { chromium } from '@playwright/test'

import { createRenderAuditBooks, installRenderAuditFixture } from './react-render-fixture.mjs'
import { AUTOMATED_SCENARIOS, FEATURE_CATALOG, selectScenarios } from './react-render-scenarios.mjs'

const ROOT = process.cwd()
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const RESULT_ROOT = path.resolve(ROOT, 'perf-results', 'react-render')
const REACT_DOCTOR_VERSION = '0.9.13'
const SCHEMA_VERSION = 1
const DEFAULT_OBSERVE_MS = 500

function fail(message, detail) {
  const error = new Error(message)
  error.detail = detail
  throw error
}

function parseArgs(argv) {
  const options = {
    ids: [],
    set: 'all',
    runs: 1,
    channel: process.platform === 'win32' ? 'msedge' : 'chrome',
    headless: true,
    appUrl: undefined,
    outDir: undefined,
    list: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--scenario') options.ids.push(argv[++index])
    else if (argument === '--set') options.set = argv[++index]
    else if (argument === '--runs') options.runs = Number(argv[++index])
    else if (argument === '--channel') options.channel = argv[++index]
    else if (argument === '--app-url') options.appUrl = argv[++index]
    else if (argument === '--out-dir') options.outDir = argv[++index]
    else if (argument === '--headed') options.headless = false
    else if (argument === '--list') options.list = true
    else if (argument === '--help' || argument === '-h') options.help = true
    else fail(`unknown argument: ${argument}`)
  }
  if (!['all', 'pilot', 'control'].includes(options.set)) fail('--set must be all, pilot, or control')
  if (!Number.isSafeInteger(options.runs) || options.runs < 1) fail('--runs must be a positive integer')
  if (options.ids.some((id) => !id)) fail('--scenario requires a non-empty id')
  if (options.outDir) {
    const resolved = path.resolve(ROOT, options.outDir)
    const relative = path.relative(RESULT_ROOT, resolved)
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      fail(`--out-dir must be a child of ${RESULT_ROOT}`)
    }
    options.outDir = resolved
  }
  return options
}

function printHelp() {
  console.log(`Usage: node measure-react-renders.mjs [options]

Options:
  --list                 list automated scenarios and feature coverage
  --set pilot|control|all
  --scenario <id>        run one scenario; repeat to select more
  --runs <count>         independent recordings per scenario (default: 1)
  --app-url <url>        use an already running production build
  --out-dir <path>       child of perf-results/react-render
  --channel <name>       Playwright browser channel
  --headed               show the diagnostic browser
`)
}

function git(...args) {
  return spawnCapture('git', args, { cwd: ROOT }).then((result) => {
    if (result.code !== 0) fail(`git ${args.join(' ')} failed`, result)
    return result.stdout.trim()
  })
}

function spawnCapture(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => (stdout += chunk))
    child.stderr?.on('data', (chunk) => (stderr += chunk))
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }))
  })
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function hashFile(filePath) {
  if (!fs.existsSync(filePath)) return null
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function safeSegment(value) {
  return value.replaceAll(/[^a-zA-Z0-9._-]/g, '_')
}

async function availablePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') fail('could not allocate a local port')
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  return address.port
}

function contentType(filePath) {
  const extension = path.extname(filePath).toLowerCase()
  return (
    {
      '.css': 'text/css; charset=utf-8',
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.webp': 'image/webp',
    }[extension] ?? 'application/octet-stream'
  )
}

async function startStaticServer() {
  const dist = path.resolve(ROOT, 'dist')
  const indexPath = path.join(dist, 'index.html')
  if (!fs.existsSync(indexPath)) {
    fail('dist/index.html is missing; run pnpm build:render-profile before render measurement')
  }
  const server = http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://127.0.0.1').pathname)
    const requested = path.resolve(dist, `.${pathname}`)
    const relative = path.relative(dist, requested)
    const candidate = relative.startsWith('..') || path.isAbsolute(relative) ? indexPath : requested
    const filePath = fs.existsSync(candidate) && fs.statSync(candidate).isFile() ? candidate : indexPath
    response.writeHead(200, { 'Content-Type': contentType(filePath), 'Cache-Control': 'no-store' })
    fs.createReadStream(filePath).pipe(response)
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') fail('static server did not expose a TCP address')
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  }
}

async function waitFor(predicate, message, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  fail(message)
}

function parseDoctorReport(stdout) {
  const trimmed = stdout.trim()
  if (!trimmed) return null
  try {
    return JSON.parse(trimmed)
  } catch {
    return null
  }
}

function inWindow(entry, startTime, endTime) {
  return entry.startTime >= startTime - 1 && entry.startTime <= endTime + 1
}

function summarizeEvents(events, countField, totalField, maxField) {
  const components = new Map()
  for (const event of events) {
    const key = `${event.source}\0${event.name}`
    const current = components.get(key) ?? {
      name: event.name,
      source: event.source,
      [countField]: 0,
      [totalField]: 0,
      [maxField]: 0,
    }
    current[countField] += 1
    current[totalField] += event.durationMs
    current[maxField] = Math.max(current[maxField], event.durationMs)
    components.set(key, current)
  }
  return [...components.values()]
    .map((component) => ({
      ...component,
      [totalField]: Number(component[totalField].toFixed(3)),
      [maxField]: Number(component[maxField].toFixed(3)),
    }))
    .sort((left, right) => right[totalField] - left[totalField] || right[countField] - left[countField])
}

function summarizeWindow(snapshot, componentEvents, startTime, endTime) {
  const renderEvents = componentEvents.filter((event) => event.kind === 'render')
  const effectEvents = componentEvents.filter((event) => event.kind === 'effect')
  const unclassifiedEvents = componentEvents.filter((event) => event.kind === 'unclassified')
  const interactions = snapshot.interactions.filter((event) => inWindow(event, startTime, endTime))
  const longAnimationFrames = snapshot.longAnimationFrames.filter((event) => inWindow(event, startTime, endTime))
  return {
    startTime,
    endTime,
    durationMs: Number((endTime - startTime).toFixed(3)),
    componentEvents,
    renderEvents,
    effectEvents,
    unclassifiedEvents,
    components: summarizeEvents(renderEvents, 'renderCount', 'totalRenderDurationMs', 'maxRenderDurationMs'),
    effects: summarizeEvents(effectEvents, 'effectCount', 'totalEffectDurationMs', 'maxEffectDurationMs'),
    interactions,
    longAnimationFrames,
  }
}

function readTraceComponentEvents(tracePath, appUrl, startTime, endTime) {
  const trace = JSON.parse(zlib.gunzipSync(fs.readFileSync(tracePath)).toString('utf8'))
  const traceEvents = Array.isArray(trace) ? trace : trace.traceEvents
  if (!Array.isArray(traceEvents)) fail('React Doctor trace did not contain traceEvents')

  const expectedUrl = new URL(appUrl)
  const navigation = traceEvents
    .filter((event) => {
      if (event.name !== 'navigationStart' || !event.args?.data?.isOutermostMainFrame) return false
      const documentUrl = event.args.data.documentLoaderURL
      if (!documentUrl) return false
      try {
        const candidate = new URL(documentUrl)
        return candidate.origin === expectedUrl.origin && candidate.pathname === expectedUrl.pathname
      } catch {
        return false
      }
    })
    .sort((left, right) => left.ts - right.ts)
    .at(-1)
  if (!navigation?.args?.frame || !Number.isFinite(navigation.ts)) {
    fail('React Doctor trace did not contain the Flow Reader main-frame navigation')
  }

  const absoluteStart = navigation.ts + startTime * 1_000
  const absoluteEnd = navigation.ts + endTime * 1_000
  const ignoredTrackEntries = new Set(['Action', 'Blocked', 'Suspended'])
  const byTraceId = new Map()
  for (const event of traceEvents) {
    const data = event.args?.data
    if (
      event.name !== 'TimeStamp' ||
      data?.track !== 'Components ⚛' ||
      data.frame !== navigation.args.frame ||
      !Number.isFinite(data.start) ||
      !Number.isFinite(data.end) ||
      data.start < absoluteStart - 1_000 ||
      data.start > absoluteEnd + 1_000
    ) {
      continue
    }
    const name = data.name ?? data.message
    if (!name || ignoredTrackEntries.has(name)) continue
    const traceId = data.sampleTraceId ?? `${name}\0${data.start}\0${data.end}`
    const kind = /^(primary|tertiary)/.test(data.color)
      ? 'render'
      : /^secondary/.test(data.color)
        ? 'effect'
        : 'unclassified'
    byTraceId.set(traceId, {
      name,
      kind,
      startTime: Number(((data.start - navigation.ts) / 1_000).toFixed(3)),
      durationMs: Number((Math.max(0, data.end - data.start) / 1_000).toFixed(3)),
      source: 'native-trace',
    })
  }
  return [...byTraceId.values()].sort(
    (left, right) => left.startTime - right.startTime || right.durationMs - left.durationMs,
  )
}

function npmCliPath() {
  const candidate = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (!fs.existsSync(candidate)) fail(`npm CLI was not found beside Node: ${candidate}`)
  return candidate
}

async function waitForChild(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode }
  }
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill()
      reject(new Error(`React Doctor did not exit within ${timeoutMs}ms`))
    }, timeoutMs)
    child.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once('close', (code, signal) => {
      clearTimeout(timeout)
      resolve({ code, signal })
    })
  })
}

async function captureSample({ appUrl, batchDir, books, channel, headless, sampleIndex, scenario }) {
  const sampleDir = path.join(batchDir, 'raw', safeSegment(scenario.id), String(sampleIndex))
  fs.mkdirSync(sampleDir, { recursive: true })
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-react-render-'))
  const cdpPort = await availablePort()
  let context
  let doctor
  let page
  let doctorStdout = ''
  let doctorStderr = ''
  try {
    context = await chromium.launchPersistentContext(profileDir, {
      channel,
      headless,
      viewport: { width: 1440, height: 900 },
      args: [
        `--remote-debugging-port=${cdpPort}`,
        '--disable-extensions',
        '--no-first-run',
        '--no-default-browser-check',
      ],
    })
    await installRenderAuditFixture(context, books)
    await waitFor(async () => {
      try {
        return (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).ok
      } catch {
        return false
      }
    }, 'diagnostic browser CDP endpoint did not become ready')

    const tracePath = path.join(sampleDir, 'trace.json.gz')
    doctor = spawn(
      process.execPath,
      [
        npmCliPath(),
        'exec',
        '--yes',
        `--package=react-doctor@${REACT_DOCTOR_VERSION}`,
        '--',
        'node',
        path.join(SCRIPT_DIR, 'react-doctor-driver.mjs'),
        'scan',
        appUrl,
        '--cdp',
        `http://127.0.0.1:${cdpPort}`,
        '--format',
        'json',
        '--trace-out',
        tracePath,
      ],
      {
        cwd: ROOT,
        env: { ...process.env, FLOW_REACT_DOCTOR_VERSION: REACT_DOCTOR_VERSION },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      },
    )
    doctor.stdout.setEncoding('utf8')
    doctor.stderr.setEncoding('utf8')
    doctor.stdout.on('data', (chunk) => (doctorStdout += chunk))
    doctor.stderr.on('data', (chunk) => (doctorStderr += chunk))

    page = await waitFor(
      () => context.pages().find((candidate) => candidate.url().startsWith(appUrl)),
      'React Doctor did not open the Flow Reader page',
      90_000,
    )
    await page.waitForFunction(() => typeof window.__REACT_DOCTOR_RUNTIME_SCAN__?.snapshot === 'function', null, {
      timeout: 30_000,
    })
    await scenario.prepare(page, books)
    await page.waitForTimeout(250)
    const beforeSnapshot = await page.evaluate(() => window.__REACT_DOCTOR_RUNTIME_SCAN__.snapshot())
    const actionStart = await page.evaluate(() => performance.now())
    const outcome = await scenario.action(page, books)
    await page.waitForTimeout(DEFAULT_OBSERVE_MS)
    const actionEnd = await page.evaluate(() => performance.now())
    const afterSnapshot = await page.evaluate(() => window.__REACT_DOCTOR_RUNTIME_SCAN__.snapshot())
    const droppedDelta = {
      components: afterSnapshot.droppedComponentEvents - beforeSnapshot.droppedComponentEvents,
      interactions: afterSnapshot.droppedInteractions - beforeSnapshot.droppedInteractions,
      longAnimationFrames: afterSnapshot.droppedLongAnimationFrames - beforeSnapshot.droppedLongAnimationFrames,
      scripts: afterSnapshot.droppedScriptTimings - beforeSnapshot.droppedScriptTimings,
    }

    doctor.stdin.write('\n')
    doctor.stdin.end()
    const exit = await waitForChild(doctor, 45_000)
    fs.writeFileSync(path.join(sampleDir, 'doctor.stdout.txt'), doctorStdout, 'utf8')
    fs.writeFileSync(path.join(sampleDir, 'doctor.stderr.txt'), doctorStderr, 'utf8')
    writeJson(path.join(sampleDir, 'before-snapshot.json'), beforeSnapshot)
    writeJson(path.join(sampleDir, 'after-snapshot.json'), afterSnapshot)
    const doctorReport = parseDoctorReport(doctorStdout)
    if (doctorReport) writeJson(path.join(sampleDir, 'doctor-report.json'), doctorReport)
    const componentEvents = readTraceComponentEvents(tracePath, appUrl, actionStart, actionEnd)
    const windowSummary = summarizeWindow(afterSnapshot, componentEvents, actionStart, actionEnd)

    const supportsComponentTracks =
      afterSnapshot.support.nativeReactTracks || afterSnapshot.support.bippyComponentTracks
    const dropped = Object.values(droppedDelta).some((value) => value > 0)
    const issues = []
    const warnings = []
    if (exit.code !== 0) issues.push(`react-doctor exited with code ${exit.code}`)
    if (!afterSnapshot.support.reactDetected) issues.push('React was not detected')
    if (scenario.group !== 'control' && !supportsComponentTracks) issues.push('component tracks were unavailable')
    if (dropped) issues.push('events were dropped during the action window')
    if (windowSummary.unclassifiedEvents.length)
      issues.push('component track entries could not be classified as render or effect')
    if (scenario.group !== 'control' && windowSummary.renderEvents.length === 0)
      warnings.push('the completed action window contained zero render events')
    if (!doctorReport) issues.push('React Doctor JSON output could not be parsed')

    return {
      scenarioId: scenario.id,
      sampleId: `${scenario.id}/${sampleIndex}`,
      status: issues.length ? 'invalid' : 'valid',
      issues,
      warnings,
      outcome,
      support: afterSnapshot.support,
      droppedDelta,
      window: windowSummary,
      rawDirectory: path.relative(batchDir, sampleDir).replaceAll('\\', '/'),
      traceFile: fs.existsSync(tracePath) ? path.relative(batchDir, tracePath).replaceAll('\\', '/') : null,
      doctorExitCode: exit.code,
    }
  } catch (error) {
    if (page && !page.isClosed()) {
      await page.screenshot({ path: path.join(sampleDir, 'failure.png'), fullPage: true }).catch(() => {})
      const diagnostics = await page
        .evaluate(() => ({
          url: location.href,
          title: document.title,
          text: document.body?.innerText.slice(0, 4_000) ?? '',
          readerTabs: window.reader?.tabs?.length ?? null,
          libraryCount: document
            .querySelector('[data-flow-library-grid]')
            ?.getAttribute('data-flow-library-grid-total-count'),
        }))
        .catch(() => null)
      if (diagnostics) writeJson(path.join(sampleDir, 'failure-diagnostics.json'), diagnostics)
    }
    if (doctor && doctor.exitCode === null) {
      doctor.stdin.write('\n')
      doctor.stdin.end()
      await waitForChild(doctor, 10_000).catch(() => doctor.kill())
    }
    fs.writeFileSync(path.join(sampleDir, 'doctor.stdout.txt'), doctorStdout, 'utf8')
    fs.writeFileSync(path.join(sampleDir, 'doctor.stderr.txt'), doctorStderr, 'utf8')
    return {
      scenarioId: scenario.id,
      sampleId: `${scenario.id}/${sampleIndex}`,
      status: 'failed',
      issues: [error.message],
      detail: error.detail,
      rawDirectory: path.relative(batchDir, sampleDir).replaceAll('\\', '/'),
    }
  } finally {
    await context?.close().catch(() => {})
    const resolvedTemp = path.resolve(os.tmpdir())
    const resolvedProfile = path.resolve(profileDir)
    if (
      resolvedProfile.startsWith(`${resolvedTemp}${path.sep}`) &&
      path.basename(resolvedProfile).startsWith('flow-react-render-')
    ) {
      fs.rmSync(resolvedProfile, { recursive: true, force: true })
    }
  }
}

function buildCoverage(samples, selectedScenarios) {
  const selectedIds = new Set(selectedScenarios.map((scenario) => scenario.id))
  const samplesByScenario = Map.groupBy(samples, (sample) => sample.scenarioId)
  const scenarios = AUTOMATED_SCENARIOS.map((scenario) => {
    const scenarioSamples = samplesByScenario.get(scenario.id) ?? []
    return {
      id: scenario.id,
      featureId: scenario.featureId,
      automation: 'implemented',
      selected: selectedIds.has(scenario.id),
      status: selectedIds.has(scenario.id)
        ? scenarioSamples.every((sample) => sample.status === 'valid')
          ? 'valid'
          : 'incomplete'
        : 'not-run',
      sampleStatuses: scenarioSamples.map((sample) => sample.status),
    }
  })
  return {
    version: SCHEMA_VERSION,
    totals: {
      featureFamilies: FEATURE_CATALOG.length,
      featureFamiliesWithAutomation: new Set(AUTOMATED_SCENARIOS.map((scenario) => scenario.featureId)).size,
      automatedScenarios: AUTOMATED_SCENARIOS.length,
      selectedScenarios: selectedScenarios.length,
      validSelectedScenarios: scenarios.filter((scenario) => scenario.selected && scenario.status === 'valid').length,
    },
    features: FEATURE_CATALOG.map((feature) => ({
      ...feature,
      automationStatus: AUTOMATED_SCENARIOS.some((scenario) => scenario.featureId === feature.id)
        ? 'partial'
        : 'unimplemented',
      scenarioIds: AUTOMATED_SCENARIOS.filter((scenario) => scenario.featureId === feature.id).map(
        (scenario) => scenario.id,
      ),
    })),
    scenarios,
  }
}

function buildQuality(samples) {
  return {
    version: SCHEMA_VERSION,
    valid: samples.filter((sample) => sample.status === 'valid').length,
    invalid: samples.filter((sample) => sample.status === 'invalid').length,
    failed: samples.filter((sample) => sample.status === 'failed').length,
    issues: samples.flatMap((sample) => sample.issues.map((issue) => ({ sampleId: sample.sampleId, issue }))),
    warnings: samples.flatMap((sample) =>
      (sample.warnings ?? []).map((warning) => ({ sampleId: sample.sampleId, warning })),
    ),
    tauriReactDoctorCompatibility: {
      status: 'unsupported-by-cli-contract',
      reason:
        'React Doctor 0.9.13 CDP mode rejects existing non-blank pages, creates its own page, and closes pages it scans.',
      implication:
        'Component render diagnosis runs in the production browser build with deterministic mocks; Tauri release acceptance remains a separate matched measurement.',
    },
  }
}

function writeSummary(filePath, manifest, coverage, quality, samples) {
  const validSamples = samples.filter((sample) => sample.status === 'valid')
  const components = validSamples
    .flatMap((sample) => sample.window.components.map((component) => ({ ...component, sampleId: sample.sampleId })))
    .sort((left, right) => right.totalRenderDurationMs - left.totalRenderDurationMs)
    .slice(0, 20)
  const rows = components.length
    ? components
        .map(
          (component) =>
            `| ${component.sampleId} | ${component.name} | ${component.renderCount} | ${component.totalRenderDurationMs} | ${component.maxRenderDurationMs} |`,
        )
        .join('\n')
    : '| - | - | - | - | - |'
  fs.writeFileSync(
    filePath,
    `# React render audit summary

Batch: ${manifest.runId}

Build: production browser diagnostic build.

Valid samples: ${quality.valid}/${samples.length}.

Automated feature families: ${coverage.totals.featureFamiliesWithAutomation}/${coverage.totals.featureFamilies}.

## Mechanical hotspots

| Sample | Component | Renders | Total render duration ms | Max render duration ms |
| --- | --- | ---: | ---: | ---: |
${rows}

## Limits

High render count is evidence, not a defect.

The browser diagnostic profile cannot be compared directly with Tauri release timing.

Unimplemented feature families remain visible in coverage.json and prevent a whole-app coverage claim.
`,
    'utf8',
  )
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    printHelp()
    return
  }
  if (options.list) {
    console.log(
      JSON.stringify(
        {
          version: SCHEMA_VERSION,
          features: FEATURE_CATALOG,
          scenarios: AUTOMATED_SCENARIOS.map(({ prepare, action, ...scenario }) => scenario),
        },
        null,
        2,
      ),
    )
    return
  }

  const selectedScenarios = selectScenarios(options)
  if (!selectedScenarios.length) fail('no render scenarios were selected')
  const runId = new Date().toISOString().replaceAll(/[:.]/g, '-')
  const batchDir = options.outDir ?? path.join(RESULT_ROOT, runId)
  if (fs.existsSync(batchDir) && fs.readdirSync(batchDir).length) {
    fail(`output directory is not empty: ${batchDir}`)
  }
  fs.mkdirSync(batchDir, { recursive: true })
  const source = {
    commit: await git('rev-parse', 'HEAD'),
    branch: await git('branch', '--show-current'),
    status: await git('status', '--short'),
  }
  const server = options.appUrl ? null : await startStaticServer()
  const samples = []
  try {
    const appUrl = options.appUrl ?? server.url
    const manifest = {
      version: SCHEMA_VERSION,
      runId,
      generatedAt: new Date().toISOString(),
      source,
      build: { type: 'production-browser-diagnostic', appUrl, strictMode: false },
      collector: {
        reactDoctorVersion: REACT_DOCTOR_VERSION,
        windowing: 'trace-render-start-time',
        observeMs: DEFAULT_OBSERVE_MS,
      },
      browser: {
        channel: options.channel,
        headless: options.headless,
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 1,
      },
      data: {
        kind: 'deterministic-synthetic-epub',
        bookCountsByScenario: Object.fromEntries(
          selectedScenarios.map((scenario) => [scenario.id, scenario.fixtureBookCount ?? 3]),
        ),
      },
      selection: { set: options.set, ids: options.ids, runs: options.runs },
      fingerprints: {
        lockfileSha256: hashFile(path.join(ROOT, 'pnpm-lock.yaml')),
        runnerSha256: hashFile(path.join(SCRIPT_DIR, 'measure-react-renders.mjs')),
        driverSha256: hashFile(path.join(SCRIPT_DIR, 'react-doctor-driver.mjs')),
        fixtureSha256: hashFile(path.join(SCRIPT_DIR, 'react-render-fixture.mjs')),
        scenarioSha256: hashFile(path.join(SCRIPT_DIR, 'react-render-scenarios.mjs')),
      },
    }
    writeJson(path.join(batchDir, 'manifest.json'), manifest)

    for (const scenario of selectedScenarios) {
      const books = createRenderAuditBooks(scenario.fixtureBookCount ?? 3)
      for (let sampleIndex = 1; sampleIndex <= options.runs; sampleIndex += 1) {
        const sample = await captureSample({
          appUrl,
          batchDir,
          books,
          channel: options.channel,
          headless: options.headless,
          sampleIndex,
          scenario,
        })
        samples.push(sample)
        console.log(
          `${sample.status.padEnd(7)} ${sample.sampleId}${sample.issues.length ? `: ${sample.issues.join('; ')}` : ''}`,
        )
      }
    }

    const coverage = buildCoverage(samples, selectedScenarios)
    const quality = buildQuality(samples)
    const results = { version: SCHEMA_VERSION, runId, samples }
    writeJson(path.join(batchDir, 'coverage.json'), coverage)
    writeJson(path.join(batchDir, 'results.json'), results)
    writeJson(path.join(batchDir, 'quality.json'), quality)
    writeSummary(path.join(batchDir, 'summary.md'), manifest, coverage, quality, samples)
    console.log(JSON.stringify({ batchDir, quality, coverage: coverage.totals }, null, 2))
    if (quality.invalid || quality.failed) process.exitCode = 1
  } finally {
    await server?.close()
  }
}

main().catch((error) => {
  console.error(error.message)
  if (error.detail) console.error(JSON.stringify(error.detail, null, 2))
  process.exitCode = 1
})
