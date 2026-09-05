import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance as nodePerformance } from 'node:perf_hooks'

import { chromium } from '@playwright/test'

const ROOT = process.cwd()
const RESULT_ROOT = path.resolve(ROOT, 'perf-results', 'library-virtualization')
const CDP_URL = process.env.FLOW_READER_CDP_URL ?? 'http://127.0.0.1:9351'
const DATA_DIR = requiredDirectory('FLOW_READER_DATA_DIR')
const OUT_DIR = validateResultDirectory(
  process.env.FLOW_READER_LIBRARY_PERF_OUT_DIR,
  'FLOW_READER_LIBRARY_PERF_OUT_DIR',
)
const RUNS = positiveInteger(process.env.FLOW_READER_LIBRARY_PERF_RUNS ?? '5', 'FLOW_READER_LIBRARY_PERF_RUNS')
const STEADY_SKIP = nonNegativeInteger(
  process.env.FLOW_READER_LIBRARY_PERF_STEADY_SKIP ?? '1',
  'FLOW_READER_LIBRARY_PERF_STEADY_SKIP',
)
const PILOT_RUNS = positiveInteger(
  process.env.FLOW_READER_LIBRARY_PERF_PILOT_RUNS ?? '3',
  'FLOW_READER_LIBRARY_PERF_PILOT_RUNS',
)
const SETTLE_MS = nonNegativeInteger(
  process.env.FLOW_READER_LIBRARY_PERF_SETTLE_MS ?? '15000',
  'FLOW_READER_LIBRARY_PERF_SETTLE_MS',
)
const PREFLIGHT_SECONDS = nonNegativeInteger(
  process.env.FLOW_READER_LIBRARY_PERF_PREFLIGHT_SECONDS ?? '15',
  'FLOW_READER_LIBRARY_PERF_PREFLIGHT_SECONDS',
)
const SWITCH_RETURN_DELAY_MS = nonNegativeInteger(
  process.env.FLOW_READER_LIBRARY_PERF_SWITCH_RETURN_DELAY_MS ?? '0',
  'FLOW_READER_LIBRARY_PERF_SWITCH_RETURN_DELAY_MS',
)
const SWITCH_LIBRARY_SCROLL = process.env.FLOW_READER_LIBRARY_PERF_SWITCH_LIBRARY_SCROLL ?? 'top'
if (SWITCH_LIBRARY_SCROLL !== 'top' && SWITCH_LIBRARY_SCROLL !== 'middle') {
  fail('FLOW_READER_LIBRARY_PERF_SWITCH_LIBRARY_SCROLL must be top or middle')
}
const WINDOW_WIDTH = positiveInteger(
  process.env.FLOW_READER_LIBRARY_PERF_WINDOW_WIDTH ?? '1280',
  'FLOW_READER_LIBRARY_PERF_WINDOW_WIDTH',
)
const WINDOW_HEIGHT = positiveInteger(
  process.env.FLOW_READER_LIBRARY_PERF_WINDOW_HEIGHT ?? '800',
  'FLOW_READER_LIBRARY_PERF_WINDOW_HEIGHT',
)
const SWITCH_READY = process.env.FLOW_READER_LIBRARY_PERF_SWITCH_READY === '1'
const CPU_PROFILE = process.env.FLOW_READER_LIBRARY_PERF_CPU_PROFILE === '1'
const SCENARIO_FILTERS = (process.env.FLOW_READER_LIBRARY_PERF_SCENARIOS ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean)
const DEFAULT_SCENARIOS = [
  'library-mount',
  'library-scroll',
  'library-filter-apply',
  'library-filter-clear',
  'library-sort',
  'library-search-apply',
  'library-search-clear',
  'library-filtered-scroll',
  'library-searched-scroll',
]
const COVER_RETURN_PHASES = [
  'filterApply',
  'filterClear',
  'filterReapply',
  'searchApply',
  'escapeToFilter',
  'secondEscape',
  'filterFinalClear',
]
const COVER_SCENARIOS = new Set(['library-cover-return'])
const SWITCH_SCENARIOS = new Set(['library-to-reader', 'reader-to-library'])
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

function fail(message, detail) {
  const error = new Error(message)
  error.detail = detail
  throw error
}

function assert(condition, message, detail) {
  if (!condition) fail(message, detail)
}

function requiredDirectory(name) {
  const value = process.env[name]
  if (!value?.trim()) fail(`${name} is required`)
  const directory = path.resolve(ROOT, value)
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
    fail(`${name} must point to an existing directory: ${directory}`)
  }
  const relative = path.relative(RESULT_ROOT, directory)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    fail(`${name} must be a child of ${RESULT_ROOT}`)
  }
  return directory
}

function validateResultDirectory(value, name) {
  if (!value?.trim()) fail(`${name} is required`)
  const directory = path.resolve(ROOT, value)
  const relative = path.relative(RESULT_ROOT, directory)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    fail(`${name} must be a child of ${RESULT_ROOT}`)
  }
  return directory
}

function positiveInteger(value, name) {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number <= 0) fail(`${name} must be a positive integer`)
  return number
}

function nonNegativeInteger(value, name) {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 0) fail(`${name} must be a non-negative integer`)
  return number
}

function powershell(command) {
  return execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    fail(`failed to read ${file}: ${error.message}`)
  }
}

function sourceState() {
  const run = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim()
  return {
    commit: run('rev-parse', 'HEAD'),
    branch: run('branch', '--show-current'),
    status: run('status', '--short'),
  }
}

function findFlowProcess() {
  const output = powershell(`
$processes = @(Get-Process -Name 'flow-reader','Flow Reader' -ErrorAction SilentlyContinue | Sort-Object StartTime)
if ($processes.Count -ne 1) { throw "Expected exactly one Flow Reader process, found $($processes.Count)" }
$process = $processes[0]
[pscustomobject]@{
  pid = $process.Id
  name = $process.ProcessName
  path = $process.Path
  startTime = $process.StartTime.ToUniversalTime().ToString('o')
  handle = $process.MainWindowHandle.ToInt64()
} | ConvertTo-Json -Compress
`)
  const process = JSON.parse(output)
  const expectedPath = path.resolve(ROOT, 'src-tauri', 'target', 'release', 'Flow Reader.exe')
  assert(
    path.resolve(process.path).toLocaleLowerCase() === expectedPath.toLocaleLowerCase(),
    'the only Flow Reader process is not the isolated release test client',
    { expectedPath, actualPath: process.path },
  )
  return process
}

function closeFlowProcess(flowProcess) {
  const expectedPath = String(flowProcess.path).replaceAll("'", "''")
  const output = powershell(`
$ErrorActionPreference = 'Stop'
$flowRootPid = ${flowProcess.pid}
$expectedPath = '${expectedPath}'
$process = Get-Process -Id $flowRootPid -ErrorAction Stop
if ($process.ProcessName -ne 'Flow Reader') { throw 'Flow Reader process identity changed before shutdown' }
if ($process.Path -ne $expectedPath) { throw 'Flow Reader executable path changed before shutdown' }

function Get-FlowDescendants {
  $win32 = @(Get-CimInstance Win32_Process -ErrorAction Stop)
  $ids = New-Object 'System.Collections.Generic.HashSet[int]'
  $frontier = @($flowRootPid)
  while ($frontier.Count -gt 0) {
    $parent = $frontier[0]
    if ($frontier.Count -eq 1) { $frontier = @() } else { $frontier = @($frontier[1..($frontier.Count - 1)]) }
    foreach ($child in @($win32 | Where-Object { $_.ParentProcessId -eq $parent })) {
      if ($ids.Add([int]$child.ProcessId)) { $frontier += [int]$child.ProcessId }
    }
  }
  return @($win32 | Where-Object { $ids.Contains([int]$_.ProcessId) })
}

function Stop-VerifiedFlowDescendants($descendants) {
  if ($descendants.Count -eq 0) { return @() }
  if (@($descendants | Where-Object { $_.Name -ne 'msedgewebview2.exe' }).Count -ne 0) {
    throw 'Unexpected executable remained in the isolated Flow Reader descendant tree'
  }
  $browserRoots = @($descendants | Where-Object { $_.ParentProcessId -eq $flowRootPid })
  if ($browserRoots.Count -ne 1 -or $browserRoots[0].CommandLine -notmatch '--webview-exe-name="Flow Reader\\.exe"') {
    throw 'Remaining WebView2 processes could not be tied to the isolated Flow Reader client'
  }
  $rootBrowserPid = [int]$browserRoots[0].ProcessId
  $stopped = @()
  foreach ($item in @($descendants | Sort-Object { if ($_.ProcessId -eq $rootBrowserPid) { 1 } else { 0 } })) {
    Stop-Process -Id $item.ProcessId -ErrorAction Stop
    $stopped += [int]$item.ProcessId
  }
  return @($stopped)
}

$closeRequested = $process.CloseMainWindow()
$normalClose = $closeRequested -and $process.WaitForExit(5000)
$forcedMainPid = $null
$cleaned = @()
if (-not $normalClose) {
  $cleaned = @(Stop-VerifiedFlowDescendants @(Get-FlowDescendants))
  Stop-Process -Id $flowRootPid -ErrorAction Stop
  $forcedMainPid = $flowRootPid
} else {
  $deadline = [DateTime]::UtcNow.AddSeconds(2)
  do {
    Start-Sleep -Milliseconds 200
    $remaining = @(Get-FlowDescendants)
  } while ($remaining.Count -gt 0 -and [DateTime]::UtcNow -lt $deadline)
  $cleaned = @(Stop-VerifiedFlowDescendants $remaining)
}
[pscustomobject]@{
  closeRequested = $closeRequested
  normalClose = $normalClose
  forcedMainPid = $forcedMainPid
  cleanedOrphanPids = @($cleaned)
} | ConvertTo-Json -Compress
`)
  return JSON.parse(output)
}

function readProcessMemory(flowPid) {
  const output = powershell(`
$rootPid = ${flowPid}
$win32 = @(Get-CimInstance Win32_Process -ErrorAction Stop)
$ids = New-Object 'System.Collections.Generic.HashSet[int]'
[void]$ids.Add($rootPid)
do {
  $changed = $false
  foreach ($item in $win32) {
    if ($ids.Contains([int]$item.ParentProcessId) -and -not $ids.Contains([int]$item.ProcessId)) {
      [void]$ids.Add([int]$item.ProcessId)
      $changed = $true
    }
  }
} while ($changed)
$rows = foreach ($item in $win32) {
  if (-not $ids.Contains([int]$item.ProcessId)) { continue }
  $process = Get-Process -Id $item.ProcessId -ErrorAction SilentlyContinue
  if (-not $process) { continue }
  $command = [string]$item.CommandLine
  $kind = if ($item.ProcessId -eq $rootPid) { 'main' }
    elseif ($command -match '--type=renderer') { 'renderer' }
    elseif ($command -match '--type=gpu-process') { 'gpu' }
    elseif ($command -match '--type=utility') { 'utility' }
    elseif ($item.Name -match 'msedgewebview2') { 'webview-browser' }
    else { 'other' }
  [pscustomobject]@{
    pid = [int]$item.ProcessId
    parentPid = [int]$item.ParentProcessId
    name = [string]$item.Name
    kind = $kind
    workingSetBytes = [int64]$process.WorkingSet64
    privateBytes = [int64]$process.PrivateMemorySize64
  }
}
$totals = @{}
foreach ($row in $rows) {
  if (-not $totals.ContainsKey($row.kind)) {
    $totals[$row.kind] = [pscustomobject]@{ workingSetBytes = [int64]0; privateBytes = [int64]0; count = 0 }
  }
  $totals[$row.kind].workingSetBytes += $row.workingSetBytes
  $totals[$row.kind].privateBytes += $row.privateBytes
  $totals[$row.kind].count += 1
}
[pscustomobject]@{
  capturedAt = [DateTime]::UtcNow.ToString('o')
  processes = @($rows)
  categories = $totals
  total = [pscustomobject]@{
    workingSetBytes = [int64](($rows | Measure-Object workingSetBytes -Sum).Sum)
    privateBytes = [int64](($rows | Measure-Object privateBytes -Sum).Sum)
    count = @($rows).Count
  }
} | ConvertTo-Json -Depth 6 -Compress
`)
  return JSON.parse(output)
}

function startHostSampler(flowPid) {
  const stopFile = path.join(
    OUT_DIR,
    `.host-sampler-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.stop`,
  )
  const escapedStopFile = stopFile.replaceAll("'", "''")
  const script = `
$rootPid = ${flowPid}
$logical = [Math]::Max(1, [Environment]::ProcessorCount)
$previousCpu = $null
$previousAt = [DateTime]::UtcNow
while (-not (Test-Path -LiteralPath '${escapedStopFile}')) {
  try {
    $win32 = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
    $ids = New-Object 'System.Collections.Generic.HashSet[int]'
    [void]$ids.Add($rootPid)
    do {
      $changed = $false
      foreach ($item in $win32) {
        if ($ids.Contains([int]$item.ParentProcessId) -and -not $ids.Contains([int]$item.ProcessId)) {
          [void]$ids.Add([int]$item.ProcessId)
          $changed = $true
        }
      }
    } while ($changed)
    $flowProcesses = @(foreach ($id in $ids) { Get-Process -Id $id -ErrorAction SilentlyContinue })
    $flowCpu = [double](($flowProcesses | Measure-Object CPU -Sum).Sum)
    $now = [DateTime]::UtcNow
    $elapsed = [Math]::Max(0.001, ($now - $previousAt).TotalSeconds)
    $flowCpuPercent = if ($null -eq $previousCpu) { $null } else { [Math]::Max(0, (($flowCpu - $previousCpu) / $elapsed / $logical) * 100) }
    $previousCpu = $flowCpu
    $previousAt = $now
    $processor = Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter "Name='_Total'" -ErrorAction SilentlyContinue
    $memory = Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory -ErrorAction SilentlyContinue
    $gpuEngines = @(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine -ErrorAction SilentlyContinue)
    $totalGpu = [double](($gpuEngines | Measure-Object UtilizationPercentage -Sum).Sum)
    $flowGpu = [double](($gpuEngines | Where-Object {
      $name = [string]$_.Name
      foreach ($id in $ids) { if ($name -match "pid_$id(_|$)") { return $true } }
      return $false
    } | Measure-Object UtilizationPercentage -Sum).Sum)
    $processorInfo = Get-CimInstance Win32_Processor -ErrorAction SilentlyContinue | Select-Object -First 1
    [pscustomobject]@{
      capturedAt = $now.ToString('o')
      totalCpuPercent = if ($processor) { [double]$processor.PercentProcessorTime } else { $null }
      flowCpuPercent = $flowCpuPercent
      nonFlowCpuPercent = if ($processor -and $null -ne $flowCpuPercent) { [Math]::Max(0, [double]$processor.PercentProcessorTime - $flowCpuPercent) } else { $null }
      totalGpuPercent = $totalGpu
      flowGpuPercent = $flowGpu
      availablePhysicalMiB = if ($memory) { [double]$memory.AvailableMBytes } else { $null }
      hardFaultsPerSecond = if ($memory) { [double]$memory.PageReadsPersec } else { $null }
      processorPerformancePercent = if ($processor) { [double]$processor.PercentProcessorPerformance } else { $null }
      currentClockMHz = if ($processorInfo) { [double]$processorInfo.CurrentClockSpeed } else { $null }
      maxClockMHz = if ($processorInfo) { [double]$processorInfo.MaxClockSpeed } else { $null }
      batteryStatus = @((Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue | Select-Object -ExpandProperty BatteryStatus))
    } | ConvertTo-Json -Depth 4 -Compress
  } catch {
    [pscustomobject]@{ capturedAt = [DateTime]::UtcNow.ToString('o'); error = $_.Exception.Message } | ConvertTo-Json -Compress
  }
  Start-Sleep -Seconds 1
}
`
  const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const samples = []
  const errors = []
  let stdout = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    stdout += chunk
    const lines = stdout.split(/\r?\n/)
    stdout = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        samples.push(JSON.parse(line))
      } catch (error) {
        errors.push(`host sample parse failed: ${error.message}`)
      }
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => errors.push(chunk.trim()))
  return {
    samples,
    errors,
    async stop() {
      if (child.exitCode === null) fs.writeFileSync(stopFile, 'stop', 'utf8')
      const closed =
        child.exitCode !== null
          ? true
          : await Promise.race([
              new Promise((resolve) => child.once('close', () => resolve(true))),
              wait(15_000).then(() => false),
            ])
      if (fs.existsSync(stopFile)) fs.unlinkSync(stopFile)
      if (!closed && child.exitCode === null) {
        fail('host diagnostics sampler did not stop after receiving its stop signal')
      }
      if (stdout.trim()) {
        try {
          samples.push(JSON.parse(stdout.trim()))
        } catch {}
      }
      return { samples, errors: errors.filter(Boolean) }
    },
  }
}

function summarizeHostSamples(samples) {
  const percentile = (values, p) => {
    const finite = values.filter(Number.isFinite).sort((left, right) => left - right)
    if (!finite.length) return null
    return finite[Math.min(finite.length - 1, Math.ceil((p / 100) * finite.length) - 1)]
  }
  const metric = (key) => samples.map((sample) => sample[key])
  return {
    samples: samples.length,
    errors: samples.filter((sample) => sample.error).map((sample) => sample.error),
    totalCpuPercent: { p50: percentile(metric('totalCpuPercent'), 50), p95: percentile(metric('totalCpuPercent'), 95) },
    nonFlowCpuPercent: {
      p50: percentile(metric('nonFlowCpuPercent'), 50),
      p95: percentile(metric('nonFlowCpuPercent'), 95),
    },
    totalGpuPercent: { p50: percentile(metric('totalGpuPercent'), 50), p95: percentile(metric('totalGpuPercent'), 95) },
    availablePhysicalMiB: {
      min: percentile(metric('availablePhysicalMiB'), 0),
      p50: percentile(metric('availablePhysicalMiB'), 50),
    },
    hardFaultsPerSecond: {
      p50: percentile(metric('hardFaultsPerSecond'), 50),
      p95: percentile(metric('hardFaultsPerSecond'), 95),
    },
    processorPerformancePercent: {
      min: percentile(metric('processorPerformancePercent'), 0),
      p50: percentile(metric('processorPerformancePercent'), 50),
    },
  }
}

async function invoke(page, command, args = {}) {
  return page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args })
}

async function readWindowMetrics(page) {
  return page.evaluate(() => ({
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    outerWidth: window.outerWidth,
    outerHeight: window.outerHeight,
    devicePixelRatio: window.devicePixelRatio,
    userAgent: navigator.userAgent,
  }))
}

function compareExpectedSettings(expected, actual) {
  const mismatches = []
  const check = (value, current, parts) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [key, child] of Object.entries(value)) {
        if (parts.length === 0 && key === 'startupSession') {
          check({ viewMode: child.viewMode }, current?.[key], [...parts, key])
        } else {
          check(child, current?.[key], [...parts, key])
        }
      }
      return
    }
    if (JSON.stringify(value) !== JSON.stringify(current)) {
      mismatches.push({ path: parts.join('.'), expected: value, actual: current })
    }
  }
  check(expected, actual, [])
  return mismatches
}

async function installInstrumentation(page) {
  await page.addInitScript(() => {
    const state = {
      active: true,
      coverFrames: [],
      coverPhase: null,
      coverPhaseMarks: [],
      frames: [],
      longtasks: [],
      scrollEvents: 0,
      observer: null,
      framePending: false,
      startedAt: performance.now(),
    }
    window.__flowLibraryPerf = state
    try {
      state.observer = new PerformanceObserver((list) => {
        if (!state.active) return
        for (const entry of list.getEntries()) {
          state.longtasks.push({ name: entry.name, startTime: entry.startTime, duration: entry.duration })
        }
      })
      state.observer.observe({ entryTypes: ['longtask'] })
    } catch {}
    document.addEventListener(
      'scroll',
      () => {
        if (state.active) state.scrollEvents += 1
      },
      { capture: true, passive: true },
    )
    const frame = (timestamp) => {
      state.framePending = false
      if (!state.active) return
      state.frames.push(timestamp)
      if (state.coverPhase) {
        const grid = document.querySelector('[data-flow-library-grid="true"]')
        const cards = Array.from(document.querySelectorAll('[data-flow-library-book-card]')).filter((card) => {
          const rect = card.getBoundingClientRect()
          return rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth
        })
        const images = cards.flatMap((card) => Array.from(card.querySelectorAll('img')))
        const realImages = images.filter(
          (image) => image.hasAttribute('data-flow-library-cover-real') || !image.src.startsWith('data:'),
        )
        const readyImages = realImages.filter(
          (image) =>
            image.complete && image.naturalWidth > 0 && image.getAttribute('data-flow-library-cover-ready') !== 'false',
        )
        state.coverFrames.push({
          timestamp,
          phase: state.coverPhase.label,
          targetResultCount: state.coverPhase.targetResultCount,
          resultCount: Number(grid?.getAttribute('data-flow-library-grid-total-count')),
          visibleReal: realImages.length,
          visibleRealReady: readyImages.length,
          visibleRealPending: realImages.length - readyImages.length,
        })
      }
      state.framePending = true
      requestAnimationFrame(frame)
    }
    const startFrames = () => {
      if (state.framePending) return
      state.framePending = true
      requestAnimationFrame(frame)
    }
    window.__flowLibraryPerfReset = () => {
      state.frames = []
      state.longtasks = []
      state.scrollEvents = 0
      state.coverFrames = []
      state.coverPhase = null
      state.coverPhaseMarks = []
      state.startedAt = performance.now()
      state.active = true
      startFrames()
      return state.startedAt
    }
    window.__flowLibraryPerfMarkCoverPhase = (label, targetResultCount) => {
      const mark = { label, targetResultCount, startedAt: performance.now() }
      state.coverPhase = mark
      state.coverPhaseMarks.push(mark)
      return mark.startedAt
    }
    window.__flowLibraryPerfRead = () => {
      state.active = false
      const gaps = state.frames.slice(1).map((value, index) => value - state.frames[index])
      return structuredClone({
        startedAt: state.startedAt,
        frames: state.frames,
        frameGaps: gaps,
        longtasks: state.longtasks,
        scrollEvents: state.scrollEvents,
        coverFrames: state.coverFrames,
        coverPhaseMarks: state.coverPhaseMarks,
      })
    }
    startFrames()
  })
}

async function resetInstrumentation(page) {
  return page.evaluate(() => window.__flowLibraryPerfReset?.() ?? performance.now())
}

async function readInstrumentation(page) {
  return page.evaluate(
    () =>
      window.__flowLibraryPerfRead?.() ?? {
        frames: [],
        frameGaps: [],
        longtasks: [],
        coverFrames: [],
        coverPhaseMarks: [],
      },
  )
}

async function waitForLibrary(page, count, timeout = 30_000) {
  await page.waitForFunction(
    ({ count }) => {
      const startupSurface = document.querySelector('[data-testid="native-startup-surface"]')
      if (startupSurface) return false
      if (count === 0) return Boolean(document.body)
      return document.querySelectorAll('[data-flow-library-book-card]').length > 0
    },
    { count },
    { timeout },
  )
  await waitForStablePresentation(page)
}

async function waitForStablePresentation(page, timeout = 15_000) {
  await page.evaluate(async (timeout) => {
    const deadline = performance.now() + timeout
    let previous = ''
    let stable = 0
    while (performance.now() < deadline) {
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      const cards = document.querySelectorAll('[data-flow-library-book-card]')
      const scroll = cards[0]?.closest('[data-pane-scroll="true"]')
      const images = Array.from(document.querySelectorAll('[data-flow-library-book-card] img'))
      const signature = JSON.stringify([
        cards.length,
        scroll?.scrollHeight ?? 0,
        scroll?.scrollTop ?? 0,
        images.filter((image) => image.complete && image.naturalWidth > 0).length,
      ])
      stable = signature === previous ? stable + 1 : 0
      previous = signature
      if (stable >= 2) return
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error('library presentation did not stabilize')
  }, timeout)
}

async function readPresentation(page) {
  return page.evaluate(() => {
    const grid = document.querySelector('[data-flow-library-grid="true"]')
    const cards = Array.from(document.querySelectorAll('[data-flow-library-book-card]'))
    const scroll = cards[0]?.closest('[data-pane-scroll="true"]')
    const images = cards.flatMap((card) => Array.from(card.querySelectorAll('img')))
    const visibleImages = images.filter((image) => {
      const rect = image.getBoundingClientRect()
      return rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth
    })
    const real = (image) => image.hasAttribute('data-flow-library-cover-real') || !image.src.startsWith('data:')
    const ready = (image) =>
      image.complete && image.naturalWidth > 0 && image.getAttribute('data-flow-library-cover-ready') !== 'false'
    return {
      resultCount: Number(grid?.getAttribute('data-flow-library-grid-total-count')),
      windowStartIndex: Number(grid?.getAttribute('data-flow-library-grid-start-index')),
      mountedCards: cards.length,
      visibleCards: cards.filter((card) => {
        const rect = card.getBoundingClientRect()
        return rect.bottom > 0 && rect.top < innerHeight
      }).length,
      scroll: scroll
        ? {
            scrollTop: scroll.scrollTop,
            scrollHeight: scroll.scrollHeight,
            clientHeight: scroll.clientHeight,
          }
        : null,
      images: {
        mounted: images.length,
        real: images.filter(real).length,
        complete: images.filter(ready).length,
        visible: visibleImages.length,
        visibleReal: visibleImages.filter(real).length,
        visibleRealReady: visibleImages.filter((image) => real(image) && ready(image)).length,
        visibleRealPending: visibleImages.filter((image) => real(image) && !ready(image)).length,
      },
    }
  })
}

async function readLibraryGeometry(page) {
  return page.evaluate(() => {
    const root = document.querySelector('#root')
    const search = document.querySelector('input')
    const card = document.querySelector('[data-flow-library-book-card]')
    const scroll = card?.closest('[data-pane-scroll="true"]')
    const rect = (element) => element?.getBoundingClientRect().toJSON() ?? null
    return {
      viewport: { width: innerWidth, height: innerHeight },
      root: rect(root),
      search: rect(search),
      scroll: rect(scroll),
      firstCard: rect(card),
      searchHitTest:
        search instanceof HTMLElement
          ? document.elementFromPoint(
              search.getBoundingClientRect().left + search.getBoundingClientRect().width / 2,
              search.getBoundingClientRect().top + search.getBoundingClientRect().height / 2,
            ) === search
          : false,
    }
  })
}

function assertLibraryGeometry(geometry) {
  const { viewport, root, search, scroll, firstCard } = geometry
  const valid =
    root?.left === 0 &&
    root?.top === 0 &&
    Math.abs(root.width - viewport.width) <= 1 &&
    Math.abs(root.height - viewport.height) <= 1 &&
    search?.top >= 0 &&
    search?.top < 80 &&
    scroll?.top >= 40 &&
    scroll?.top < Math.max(140, viewport.height * 0.18) &&
    firstCard?.top >= scroll.top &&
    firstCard?.top - scroll.top < 24 &&
    geometry.searchHitTest
  assert(valid, 'library geometry is displaced; refusing to sample a harness-induced window state', geometry)
}

async function readCdpMetrics(page) {
  const session = await page.context().newCDPSession(page)
  try {
    await session.send('Performance.enable')
    const [dom, heap, performanceMetrics] = await Promise.all([
      session.send('Memory.getDOMCounters'),
      session.send('Runtime.getHeapUsage'),
      session.send('Performance.getMetrics'),
    ])
    return {
      dom,
      heap,
      performance: Object.fromEntries(performanceMetrics.metrics.map((metric) => [metric.name, metric.value])),
    }
  } finally {
    await session.detach().catch(() => {})
  }
}

async function ensureLibraryMode(page, count) {
  if (
    await page
      .locator('[data-flow-library-book-card]')
      .first()
      .isVisible()
      .catch(() => false)
  )
    return
  await page.keyboard.press('v')
  await waitForLibrary(page, count)
}

async function ensureReaderMode(page) {
  const cardsVisible = await page
    .locator('[data-flow-library-book-card]')
    .first()
    .isVisible()
    .catch(() => false)
  if (cardsVisible) await page.keyboard.press('v')
  await page.waitForFunction(
    () => Boolean(window.reader?.focusedBookTab?.rendered) && !document.querySelector('[data-flow-library-book-card]'),
    null,
    { timeout: 30_000 },
  )
}

async function resetLibraryScrollTop(page) {
  const scrollTop = await page.evaluate(() => {
    const card = document.querySelector('[data-flow-library-book-card]')
    const scroll = card?.closest('[data-pane-scroll="true"]')
    if (!(scroll instanceof HTMLElement)) throw new Error('library scroll container not found')
    scroll.scrollTop = 0
    return scroll.scrollTop
  })
  assert(scrollTop === 0, 'library scenario did not start at the top', { scrollTop })
  await waitForStablePresentation(page)
}

async function blurLibraryControl(page) {
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
  })
}

async function waitForLibraryResultCount(page, count, label) {
  try {
    await page.waitForFunction(
      ({ count }) =>
        Number(
          document.querySelector('[data-flow-library-grid="true"]')?.getAttribute('data-flow-library-grid-total-count'),
        ) === count,
      { count },
    )
  } catch (error) {
    const presentation = await readPresentation(page).catch(() => null)
    const searchValue = await page
      .locator('input')
      .first()
      .inputValue()
      .catch(() => null)
    fail(`${label}: timed out waiting for ${count} library results`, {
      cause: error.message,
      presentation,
      searchValue,
    })
  }
}

async function waitForVisibleRealCoversReady(page, label, timeout = 15_000) {
  try {
    await page.waitForFunction(
      () => {
        const images = Array.from(document.querySelectorAll('[data-flow-library-book-card] img')).filter((image) => {
          if (!image.hasAttribute('data-flow-library-cover-real') && image.src.startsWith('data:')) return false
          const rect = image.getBoundingClientRect()
          return rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth
        })
        return (
          images.length > 0 &&
          images.every(
            (image) =>
              image.complete &&
              image.naturalWidth > 0 &&
              image.getAttribute('data-flow-library-cover-ready') !== 'false',
          )
        )
      },
      null,
      { timeout },
    )
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  } catch (error) {
    fail(`${label}: visible real covers did not become ready`, {
      cause: error.message,
      presentation: await readPresentation(page).catch(() => null),
    })
  }
}

async function markCoverPhase(page, label, targetResultCount) {
  assert(COVER_RETURN_PHASES.includes(label), `unknown cover-return phase: ${label}`)
  await page.evaluate(
    ({ label, targetResultCount }) => {
      if (!window.__flowLibraryPerfMarkCoverPhase) throw new Error('cover phase instrumentation is unavailable')
      window.__flowLibraryPerfMarkCoverPhase(label, targetResultCount)
    },
    { label, targetResultCount },
  )
}

async function waitForCoverTransition(page, targetResultCount, label) {
  await waitForLibraryResultCount(page, targetResultCount, label)
  await waitForVisibleRealCoversReady(page, label)
}

async function prepareNoTitleSearch(page, count) {
  const search = page.locator('input').first()
  await search.focus()
  await page.keyboard.press('Escape')
  await waitForLibraryResultCount(page, count, 'prepare search clear')
  await resetLibraryScrollTop(page)
  await blurLibraryControl(page)
}

async function prepareTitleSearch(page, count) {
  await prepareNoTitleSearch(page, count)
  const search = page.locator('input').first()
  await search.fill('000001')
  await waitForLibraryResultCount(page, 1, 'prepare search apply')
  await resetLibraryScrollTop(page)
  await blurLibraryControl(page)
}

async function prepareStableTitleSearch(page, count, query, expectedResultCount) {
  await prepareNoTitleSearch(page, count)
  const search = page.locator('input').first()
  await search.fill(query)
  await waitForLibraryResultCount(page, expectedResultCount, 'prepare stable search')
  await resetLibraryScrollTop(page)
  await blurLibraryControl(page)
}

async function prepareNoStatusFilter(page) {
  await blurLibraryControl(page)
  await page.keyboard.press('0')
  await resetLibraryScrollTop(page)
}

async function prepareStatusFilter(page) {
  await prepareNoStatusFilter(page)
  await page.keyboard.press('1')
  await resetLibraryScrollTop(page)
}

async function toggleSortDirection(page) {
  await page.evaluate(() => {
    const trigger = document.querySelector('button[role="combobox"]')
    const buttons = trigger?.parentElement?.querySelectorAll('button')
    const direction = buttons?.[1]
    if (!(direction instanceof HTMLButtonElement)) throw new Error('library sort direction button not found')
    direction.click()
  })
}

async function scrollLibraryToBottom(page) {
  await page.evaluate(async () => {
    const card = document.querySelector('[data-flow-library-book-card]')
    const scroll = card?.closest('[data-pane-scroll="true"]')
    if (!(scroll instanceof HTMLElement)) throw new Error('library scroll container not found')
    const step = Math.max(80, Math.floor(scroll.clientHeight * 0.8))
    while (scroll.scrollTop + scroll.clientHeight < scroll.scrollHeight - 1) {
      scroll.scrollTop = Math.min(scroll.scrollHeight, scroll.scrollTop + step)
      await new Promise((resolve) => requestAnimationFrame(resolve))
    }
  })
}

async function scrollLibraryToMiddle(page) {
  await page.evaluate(() => {
    const card = document.querySelector('[data-flow-library-book-card]')
    const scroll = card?.closest('[data-pane-scroll="true"]')
    if (!(scroll instanceof HTMLElement)) throw new Error('library scroll container not found')
    scroll.scrollTop = Math.floor((scroll.scrollHeight - scroll.clientHeight) / 2)
  })
}

async function prepareReaderToLibrary(page, manifest) {
  await ensureLibraryMode(page, manifest.count)
  if (SWITCH_LIBRARY_SCROLL === 'middle') {
    await scrollLibraryToMiddle(page)
    await waitForStablePresentation(page)
  } else {
    await resetLibraryScrollTop(page)
  }
  if (manifest.coverProfile !== 'none') {
    await waitForVisibleRealCoversReady(page, `prepare reader-to-library ${SWITCH_LIBRARY_SCROLL}`)
  }
  await ensureReaderMode(page)
  if (SWITCH_RETURN_DELAY_MS) await wait(SWITCH_RETURN_DELAY_MS)
}

function findOpf(directory) {
  if (!fs.existsSync(directory)) return null
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      const nested = findOpf(target)
      if (nested) return nested
    } else if (entry.name.toLowerCase().endsWith('.opf')) {
      return target
    }
  }
  return null
}

async function warmSwitchBook(page, manifest) {
  if (!manifest.switchBookId) fail('switch scenario requires dataset manifest.switchBookId')
  await ensureLibraryMode(page, manifest.count)
  const unpacked = path.join(DATA_DIR, 'books', manifest.switchBookId, 'unpacked')
  const started = nodePerformance.now()
  await page.locator('ul.grid [data-flow-library-book-card]').first().click()
  await page.waitForFunction(() => Boolean(window.reader?.focusedBookTab?.rendered), null, { timeout: 60_000 })
  const deadline = Date.now() + 30_000
  let opfPath = findOpf(unpacked)
  while (!opfPath && Date.now() < deadline) {
    await wait(100)
    opfPath = findOpf(unpacked)
  }
  assert(opfPath, 'switch warmup did not create an unpacked OPF', { unpacked })
  await page.keyboard.press('v')
  await waitForLibrary(page, manifest.count)
  const tabCount = await page.evaluate(() => window.reader?.tabs?.length ?? 0)
  assert(tabCount > 0, 'switch warmup did not retain a reader tab')
  return {
    performed: true,
    excludedFromFormalSamples: true,
    switchBookId: manifest.switchBookId,
    durationMs: nodePerformance.now() - started,
    unpackedOpf: opfPath,
    readerTabCount: tabCount,
  }
}

async function readSampleDiagnostics(page, flowPid, memoryBefore, includeCoverDiagnostics = false) {
  const instrumentation = await readInstrumentation(page)
  const [presentation, cdp, memoryAfter] = await Promise.all([
    readPresentation(page),
    readCdpMetrics(page),
    Promise.resolve(readProcessMemory(flowPid)),
  ])
  const longtasks = instrumentation.longtasks ?? []
  return {
    frameGaps: instrumentation.frameGaps ?? [],
    longTaskCount: longtasks.length,
    longTaskTotalMs: longtasks.reduce((sum, entry) => sum + entry.duration, 0),
    longTaskMaxMs: longtasks.reduce((max, entry) => Math.max(max, entry.duration), 0),
    scrollEventCount: instrumentation.scrollEvents ?? 0,
    ...(includeCoverDiagnostics
      ? {
          coverFrames: instrumentation.coverFrames ?? [],
          coverPhaseMarks: instrumentation.coverPhaseMarks ?? [],
        }
      : {}),
    presentation,
    cdp,
    processMemory: { before: memoryBefore, after: memoryAfter },
  }
}

async function measureAction(page, flowPid, label, action, options = {}) {
  if (options.prepare) await options.prepare()
  const memoryBefore = readProcessMemory(flowPid)
  const startedAt = await resetInstrumentation(page)
  let cpu
  let session
  if (options.cpuProfile) {
    session = await page.context().newCDPSession(page)
    await session.send('Profiler.enable')
    await session.send('Profiler.start')
  }
  await action()
  const operationEnd = await page.evaluate(() => performance.now())
  const firstFrame = await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)))
  if (options.waitFor === 'reader') {
    await ensureReaderMode(page)
  } else {
    await waitForStablePresentation(page)
    if (options.waitForCoversReady) await waitForVisibleRealCoversReady(page, `${label} cover readiness`)
  }
  const settled = await page.evaluate(() => performance.now())
  if (session) {
    cpu = (await session.send('Profiler.stop')).profile
    await session.detach().catch(() => {})
  }
  const diagnostics = await readSampleDiagnostics(page, flowPid, memoryBefore, true)
  return {
    label,
    operationMs: operationEnd - startedAt,
    firstFrameMs: firstFrame - startedAt,
    settledMs: settled - startedAt,
    ...diagnostics,
    cpuProfile: cpu,
  }
}

async function measureMount(page, flowPid, label, count, cpuProfile) {
  const memoryBefore = readProcessMemory(flowPid)
  let cpu
  let session
  if (cpuProfile) {
    session = await page.context().newCDPSession(page)
    await session.send('Profiler.enable')
    await session.send('Profiler.start')
  }
  const wallStarted = nodePerformance.now()
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 })
  await waitForLibrary(page, count, 60_000)
  assertLibraryGeometry(await readLibraryGeometry(page))
  const firstFrameWall = nodePerformance.now()
  if (session) {
    cpu = (await session.send('Profiler.stop')).profile
    await session.detach().catch(() => {})
  }
  const diagnostics = await readSampleDiagnostics(page, flowPid, memoryBefore)
  return {
    label,
    operationMs: firstFrameWall - wallStarted,
    firstFrameMs: firstFrameWall - wallStarted,
    settledMs: nodePerformance.now() - wallStarted,
    ...diagnostics,
    cpuProfile: cpu,
  }
}

function percentile(values, p) {
  const finite = values.filter(Number.isFinite).sort((left, right) => left - right)
  if (!finite.length) return null
  return finite[Math.min(finite.length - 1, Math.max(0, Math.ceil((p / 100) * finite.length) - 1))]
}

function summarizeNumber(values) {
  const finite = values.filter(Number.isFinite)
  if (!finite.length) return null
  const mean = finite.reduce((sum, value) => sum + value, 0) / finite.length
  const variance =
    finite.length > 1 ? finite.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (finite.length - 1) : 0
  const ciHalfWidth = finite.length > 1 ? 1.96 * Math.sqrt(variance / finite.length) : 0
  return {
    min: Math.min(...finite),
    p50: percentile(finite, 50),
    p95: percentile(finite, 95),
    max: Math.max(...finite),
    mean,
    confidence95: { low: mean - ciHalfWidth, high: mean + ciHalfWidth, halfWidth: ciHalfWidth },
  }
}

function summarizeCoverPhaseSample(sample, phase) {
  const mark = sample.coverPhaseMarks?.find((item) => item.label === phase)
  if (!mark) return null
  const frames = (sample.coverFrames ?? []).filter(
    (frame) => frame.phase === phase && frame.resultCount === mark.targetResultCount,
  )
  const firstTargetFrame = frames[0]
  const firstReadyFrame = frames.find((frame) => frame.visibleReal > 0 && frame.visibleRealPending === 0)
  const pendingFrames = frames.filter((frame) => frame.visibleRealPending > 0)
  return {
    firstReadyMs: firstReadyFrame ? firstReadyFrame.timestamp - mark.startedAt : null,
    firstTargetMs: firstTargetFrame ? firstTargetFrame.timestamp - mark.startedAt : null,
    maxPendingImages: Math.max(0, ...pendingFrames.map((frame) => frame.visibleRealPending)),
    pendingDurationMs:
      pendingFrames.length && firstTargetFrame && firstReadyFrame
        ? firstReadyFrame.timestamp - firstTargetFrame.timestamp
        : 0,
    pendingFrames: pendingFrames.length,
    targetFrames: frames.length,
  }
}

function summarizeCoverRestoration(samples) {
  if (!samples.some((sample) => sample.coverPhaseMarks?.length)) return null
  const phases = {}
  let totalPendingFrames = 0
  let maxPendingImages = 0
  let samplesWithPendingFrames = 0

  for (const phase of COVER_RETURN_PHASES) {
    const phaseSamples = samples.map((sample) => summarizeCoverPhaseSample(sample, phase)).filter(Boolean)
    const pendingFrameCounts = phaseSamples.map((sample) => sample.pendingFrames)
    const phaseSamplesWithPending = phaseSamples.filter((sample) => sample.pendingFrames > 0).length
    const phaseTotalPendingFrames = pendingFrameCounts.reduce((sum, value) => sum + value, 0)
    const phaseMaxPendingImages = Math.max(0, ...phaseSamples.map((sample) => sample.maxPendingImages))
    phases[phase] = {
      runs: phaseSamples.length,
      samplesWithPending: phaseSamplesWithPending,
      totalPendingFrames: phaseTotalPendingFrames,
      maxPendingImages: phaseMaxPendingImages,
      pendingFrames: summarizeNumber(pendingFrameCounts),
      pendingDurationMs: summarizeNumber(phaseSamples.map((sample) => sample.pendingDurationMs)),
      firstTargetMs: summarizeNumber(phaseSamples.map((sample) => sample.firstTargetMs)),
      firstReadyMs: summarizeNumber(phaseSamples.map((sample) => sample.firstReadyMs)),
    }
    totalPendingFrames += phaseTotalPendingFrames
    maxPendingImages = Math.max(maxPendingImages, phaseMaxPendingImages)
  }

  for (const sample of samples) {
    if (COVER_RETURN_PHASES.some((phase) => summarizeCoverPhaseSample(sample, phase)?.pendingFrames > 0)) {
      samplesWithPendingFrames += 1
    }
  }

  return { samplesWithPendingFrames, totalPendingFrames, maxPendingImages, phases }
}

function summarizeSamples(samples) {
  const frameGaps = samples.flatMap((sample) => sample.frameGaps ?? [])
  const after = (selector) => samples.map((sample) => selector(sample.processMemory?.after, sample))
  return {
    runs: samples.length,
    operationMs: summarizeNumber(samples.map((sample) => sample.operationMs)),
    firstFrameMs: summarizeNumber(samples.map((sample) => sample.firstFrameMs)),
    settledMs: summarizeNumber(samples.map((sample) => sample.settledMs)),
    frameGapMs: summarizeNumber(frameGaps),
    longTasks: {
      count: samples.reduce((sum, sample) => sum + sample.longTaskCount, 0),
      totalMs: samples.reduce((sum, sample) => sum + sample.longTaskTotalMs, 0),
      maxMs: Math.max(0, ...samples.map((sample) => sample.longTaskMaxMs)),
    },
    scrollEvents: summarizeNumber(samples.map((sample) => sample.scrollEventCount)),
    resultCount: summarizeNumber(samples.map((sample) => sample.presentation?.resultCount)),
    windowStartIndex: summarizeNumber(samples.map((sample) => sample.presentation?.windowStartIndex)),
    mountedCards: summarizeNumber(samples.map((sample) => sample.presentation?.mountedCards)),
    visibleCards: summarizeNumber(samples.map((sample) => sample.presentation?.visibleCards)),
    dom: {
      documents: summarizeNumber(samples.map((sample) => sample.cdp?.dom?.documents)),
      nodes: summarizeNumber(samples.map((sample) => sample.cdp?.dom?.nodes)),
      eventListeners: summarizeNumber(samples.map((sample) => sample.cdp?.dom?.jsEventListeners)),
    },
    heap: {
      usedBytes: summarizeNumber(samples.map((sample) => sample.cdp?.heap?.usedSize)),
      totalBytes: summarizeNumber(samples.map((sample) => sample.cdp?.heap?.totalSize)),
    },
    processMemory: {
      privateBytes: summarizeNumber(after((memory) => memory?.total?.privateBytes)),
      workingSetBytes: summarizeNumber(after((memory) => memory?.total?.workingSetBytes)),
      rendererPrivateBytes: summarizeNumber(after((memory) => memory?.categories?.renderer?.privateBytes ?? 0)),
      gpuPrivateBytes: summarizeNumber(after((memory) => memory?.categories?.gpu?.privateBytes ?? 0)),
    },
    visibleImages: {
      real: summarizeNumber(samples.map((sample) => sample.presentation?.images?.visibleReal)),
      ready: summarizeNumber(samples.map((sample) => sample.presentation?.images?.visibleRealReady)),
      pending: summarizeNumber(samples.map((sample) => sample.presentation?.images?.visibleRealPending)),
    },
    coverRestoration: summarizeCoverRestoration(samples),
  }
}

function pilotTrend(samples) {
  const values = samples.map((sample) => sample.operationMs).filter(Number.isFinite)
  const monotonic = values.length >= 3 && values.slice(1).every((value, index) => value > values[index] * 1.03)
  const growth = values.length >= 2 && values.at(-1) > values[0] * 1.15
  return { monotonic, growth, persistentSlowdown: monotonic && growth, values }
}

async function measureScenario(name, runSample) {
  let pilot = []
  for (let index = 0; index < PILOT_RUNS; index += 1) {
    pilot.push(await runSample(`${name} pilot #${index + 1}`, false))
  }
  let trend = pilotTrend(pilot)
  let repeated = false
  if (trend.persistentSlowdown) {
    repeated = true
    pilot = []
    for (let index = 0; index < PILOT_RUNS; index += 1) {
      pilot.push(await runSample(`${name} repeated pilot #${index + 1}`, false))
    }
    trend = pilotTrend(pilot)
    if (trend.persistentSlowdown) {
      fail(`${name}: pilot shows persistent one-way slowdown`, { trend })
    }
  }

  const samples = []
  for (let index = 0; index < RUNS; index += 1) {
    samples.push(await runSample(`${name} sample #${index + 1}`, CPU_PROFILE && index === 0))
  }
  const steadySamples = samples.length > STEADY_SKIP ? samples.slice(STEADY_SKIP) : samples
  const summary = summarizeSamples(samples)
  const steadySummary = summarizeSamples(steadySamples)
  const halfWidth = steadySummary.operationMs?.confidence95?.halfWidth ?? 0
  const mean = steadySummary.operationMs?.mean ?? 0
  return {
    name,
    status: 'passed',
    pilot: { samples: pilot, trend, repeated, excludedFromSummary: true },
    samples,
    steadySkip: samples.length - steadySamples.length,
    summary,
    steadySummary,
    noise: {
      operationRelativeConfidenceHalfWidth: mean ? halfWidth / mean : 0,
      couldAffectTenPercentDecision: mean ? halfWidth / mean > 0.1 : false,
    },
  }
}

function selectedScenarios() {
  if (!SCENARIO_FILTERS.length) return DEFAULT_SCENARIOS
  const known = new Set([...DEFAULT_SCENARIOS, ...COVER_SCENARIOS, ...SWITCH_SCENARIOS])
  for (const name of SCENARIO_FILTERS) {
    if (!known.has(name)) fail(`unknown library performance scenario: ${name}`)
  }
  return SCENARIO_FILTERS
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const manifestFile = path.join(DATA_DIR, 'dataset-manifest.json')
  const settingsFile = path.join(DATA_DIR, 'settings.json')
  const libraryFile = path.join(DATA_DIR, 'library.json')
  const manifest = readJson(manifestFile)
  const expectedSettings = readJson(settingsFile)
  const library = readJson(libraryFile)
  assert(library.books?.length === manifest.count, 'library count does not match dataset manifest', {
    libraryCount: library.books?.length,
    manifestCount: manifest.count,
  })
  const stableScrollSearchQuery = manifest.count >= 400 ? '0001' : '0'
  const stableScrollSearchResultCount = library.books.filter((book) =>
    book.metadata?.title?.toLocaleLowerCase().includes(stableScrollSearchQuery),
  ).length
  assert(stableScrollSearchResultCount > 0, 'stable scroll search must retain at least one result', {
    stableScrollSearchQuery,
  })
  assert(
    manifest.windowProfile?.logicalWidth === WINDOW_WIDTH &&
      manifest.windowProfile?.logicalHeight === WINDOW_HEIGHT &&
      manifest.windowProfile?.runtimeResize === false,
    'runner window configuration does not match the dataset startup window profile',
    { requested: { width: WINDOW_WIDTH, height: WINDOW_HEIGHT }, manifest: manifest.windowProfile },
  )

  const scenariosToRun = selectedScenarios()
  const hasSwitchScenario = scenariosToRun.some((name) => SWITCH_SCENARIOS.has(name))
  if (hasSwitchScenario && !SWITCH_READY) {
    fail('switch scenarios require FLOW_READER_LIBRARY_PERF_SWITCH_READY=1 and an isolated process/data copy')
  }

  const flowProcess = findFlowProcess()
  const browser = await chromium.connectOverCDP(CDP_URL)
  try {
    const context = browser.contexts()[0]
    const page = context?.pages().find((candidate) => candidate.url().includes('localhost:7127')) ?? context?.pages()[0]
    assert(page, `no Tauri WebView page found at ${CDP_URL}`)
    page.on('pageerror', (error) => console.error(`PAGEERROR ${error.message}`))
    await installInstrumentation(page)
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 })
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => Boolean(window.__TAURI_INTERNALS__?.invoke), null, { timeout: 30_000 })
    await ensureLibraryMode(page, manifest.count)
    const initialGeometry = await readLibraryGeometry(page)
    assertLibraryGeometry(initialGeometry)
    const settingsBootstrap = await invoke(page, 'get_settings')
    const actualSettings = settingsBootstrap.settings
    const settingsMismatches = compareExpectedSettings(expectedSettings, actualSettings)
    assert(settingsMismatches.length === 0, 'persisted settings do not match the dataset settings manifest', {
      settingsMismatches,
    })

    const cdp = await context.newCDPSession(page)
    const browserVersion = await cdp.send('Browser.getVersion')
    await cdp.detach()
    const windowMetrics = await readWindowMetrics(page)
    assert(Math.abs(windowMetrics.outerWidth - WINDOW_WIDTH) <= 8, 'outer window width does not match request', {
      requested: WINDOW_WIDTH,
      actual: windowMetrics.outerWidth,
    })
    assert(Math.abs(windowMetrics.outerHeight - WINDOW_HEIGHT) <= 8, 'outer window height does not match request', {
      requested: WINDOW_HEIGHT,
      actual: windowMetrics.outerHeight,
    })

    if (SETTLE_MS) await wait(SETTLE_MS)
    const preflightSampler = startHostSampler(flowProcess.pid)
    if (PREFLIGHT_SECONDS) await wait(PREFLIGHT_SECONDS * 1000)
    const preflight = await preflightSampler.stop()
    const preflightSummary = summarizeHostSamples(preflight.samples)

    const warmup = hasSwitchScenario
      ? await warmSwitchBook(page, manifest)
      : { performed: false, excludedFromFormalSamples: true }

    const batchSampler = startHostSampler(flowProcess.pid)
    const scenarios = []
    try {
      for (const name of scenariosToRun) {
        if (name === 'library-mount') {
          scenarios.push(
            await measureScenario(name, (label, cpuProfile) =>
              measureMount(page, flowProcess.pid, label, manifest.count, cpuProfile),
            ),
          )
          continue
        }
        if (name === 'library-scroll' || name === 'library-filtered-scroll' || name === 'library-searched-scroll') {
          scenarios.push(
            await measureScenario(name, (label, cpuProfile) =>
              measureAction(page, flowProcess.pid, label, () => scrollLibraryToBottom(page), {
                cpuProfile,
                prepare: async () => {
                  await ensureLibraryMode(page, manifest.count)
                  await prepareNoStatusFilter(page)
                  if (name === 'library-searched-scroll') {
                    await prepareStableTitleSearch(
                      page,
                      manifest.count,
                      stableScrollSearchQuery,
                      stableScrollSearchResultCount,
                    )
                  } else {
                    await prepareNoTitleSearch(page, manifest.count)
                    if (name === 'library-filtered-scroll') {
                      await prepareStatusFilter(page)
                      await waitForLibraryResultCount(page, Math.ceil(manifest.count / 4), 'prepare filtered scroll')
                      await resetLibraryScrollTop(page)
                    }
                  }
                },
              }),
            ),
          )
          continue
        }
        if (name === 'library-search-apply') {
          scenarios.push(
            await measureScenario(name, (label, cpuProfile) =>
              measureAction(
                page,
                flowProcess.pid,
                label,
                async () => {
                  await page.locator('input').first().fill('000001')
                  await waitForLibraryResultCount(page, 1, 'measure search apply')
                },
                {
                  cpuProfile,
                  prepare: async () => {
                    await prepareNoStatusFilter(page)
                    await prepareNoTitleSearch(page, manifest.count)
                  },
                },
              ),
            ),
          )
          continue
        }
        if (name === 'library-search-clear') {
          scenarios.push(
            await measureScenario(name, (label, cpuProfile) =>
              measureAction(
                page,
                flowProcess.pid,
                label,
                async () => {
                  await page.locator('input').first().focus()
                  await page.keyboard.press('Escape')
                  await waitForLibraryResultCount(page, manifest.count, 'measure search clear')
                },
                {
                  cpuProfile,
                  prepare: async () => {
                    await prepareNoStatusFilter(page)
                    await prepareTitleSearch(page, manifest.count)
                  },
                },
              ),
            ),
          )
          continue
        }
        if (name === 'library-filter-apply') {
          scenarios.push(
            await measureScenario(name, (label, cpuProfile) =>
              measureAction(
                page,
                flowProcess.pid,
                label,
                async () => {
                  await page.keyboard.press('1')
                  await waitForLibraryResultCount(page, Math.ceil(manifest.count / 4), 'measure filter apply')
                },
                {
                  cpuProfile,
                  prepare: async () => {
                    await prepareNoStatusFilter(page)
                    await prepareNoTitleSearch(page, manifest.count)
                  },
                },
              ),
            ),
          )
          continue
        }
        if (name === 'library-filter-clear') {
          scenarios.push(
            await measureScenario(name, (label, cpuProfile) =>
              measureAction(
                page,
                flowProcess.pid,
                label,
                async () => {
                  await page.keyboard.press('0')
                  await waitForLibraryResultCount(page, manifest.count, 'measure filter clear')
                },
                {
                  cpuProfile,
                  prepare: async () => {
                    await prepareNoStatusFilter(page)
                    await prepareNoTitleSearch(page, manifest.count)
                    await prepareStatusFilter(page)
                  },
                },
              ),
            ),
          )
          continue
        }
        if (name === 'library-cover-return') {
          const filteredCount = Math.ceil(manifest.count / 4)
          scenarios.push(
            await measureScenario(name, (label, cpuProfile) =>
              measureAction(
                page,
                flowProcess.pid,
                label,
                async () => {
                  await markCoverPhase(page, 'filterApply', filteredCount)
                  await page.keyboard.press('1')
                  await waitForCoverTransition(page, filteredCount, 'cover return filter apply')

                  await markCoverPhase(page, 'filterClear', manifest.count)
                  await page.keyboard.press('0')
                  await waitForCoverTransition(page, manifest.count, 'cover return filter clear')

                  await markCoverPhase(page, 'filterReapply', filteredCount)
                  await page.keyboard.press('1')
                  await waitForCoverTransition(page, filteredCount, 'cover return filter reapply')

                  await markCoverPhase(page, 'searchApply', 1)
                  await page.locator('input').first().fill('000001')
                  await waitForCoverTransition(page, 1, 'cover return search apply')

                  await markCoverPhase(page, 'escapeToFilter', filteredCount)
                  await page.locator('input').first().focus()
                  await page.keyboard.press('Escape')
                  await waitForCoverTransition(page, filteredCount, 'cover return Escape to filter')

                  await markCoverPhase(page, 'secondEscape', filteredCount)
                  await page.keyboard.press('Escape')
                  await waitForCoverTransition(page, filteredCount, 'cover return second Escape')

                  await markCoverPhase(page, 'filterFinalClear', manifest.count)
                  await page.keyboard.press('0')
                  await waitForCoverTransition(page, manifest.count, 'cover return final filter clear')
                },
                {
                  cpuProfile,
                  prepare: async () => {
                    await ensureLibraryMode(page, manifest.count)
                    await prepareNoStatusFilter(page)
                    await prepareNoTitleSearch(page, manifest.count)
                    await waitForVisibleRealCoversReady(page, 'prepare cover return')
                  },
                },
              ),
            ),
          )
          continue
        }
        if (name === 'library-sort') {
          scenarios.push(
            await measureScenario(name, (label, cpuProfile) =>
              measureAction(page, flowProcess.pid, label, () => toggleSortDirection(page), {
                cpuProfile,
                prepare: async () => {
                  await ensureLibraryMode(page, manifest.count)
                  await prepareNoStatusFilter(page)
                  await prepareNoTitleSearch(page, manifest.count)
                },
              }),
            ),
          )
          continue
        }
        if (name === 'library-to-reader') {
          scenarios.push(
            await measureScenario(name, (label, cpuProfile) =>
              measureAction(page, flowProcess.pid, label, () => page.keyboard.press('v'), {
                cpuProfile,
                prepare: () => ensureLibraryMode(page, manifest.count),
                waitFor: 'reader',
              }),
            ),
          )
          continue
        }
        if (name === 'reader-to-library') {
          scenarios.push(
            await measureScenario(name, (label, cpuProfile) =>
              measureAction(page, flowProcess.pid, label, () => page.keyboard.press('v'), {
                cpuProfile,
                prepare: () => prepareReaderToLibrary(page, manifest),
                waitForCoversReady: true,
              }),
            ),
          )
        }
      }
    } finally {
      const batch = await batchSampler.stop()
      const finalMemory = readProcessMemory(flowProcess.pid)
      const result = {
        schemaVersion: 1,
        runner: '.agents/skills/reader-performance-measurement/scripts/measure-library-performance-client.mjs',
        generatedAt: new Date().toISOString(),
        mode: 'tauri-release',
        cdpUrl: CDP_URL,
        dataDir: DATA_DIR,
        sourceState: sourceState(),
        dataset: manifest,
        settings: {
          expected: expectedSettings,
          actual: actualSettings,
          mismatches: settingsMismatches,
        },
        client: {
          flowProcess,
          browserVersion,
          platform: process.platform,
          arch: process.arch,
          osRelease: os.release(),
          cpu: os.cpus()[0]?.model,
          logicalProcessors: os.cpus().length,
          totalPhysicalMemoryBytes: os.totalmem(),
        },
        window: {
          requested: { width: WINDOW_WIDTH, height: WINDOW_HEIGHT },
          resize: { method: 'tauri-startup-size-no-runtime-resize' },
          actual: windowMetrics,
          initialGeometry,
        },
        configuration: {
          runs: RUNS,
          steadySkip: STEADY_SKIP,
          pilotRuns: PILOT_RUNS,
          settleMs: SETTLE_MS,
          preflightSeconds: PREFLIGHT_SECONDS,
          switchReturnDelayMs: SWITCH_RETURN_DELAY_MS,
          switchLibraryScroll: SWITCH_LIBRARY_SCROLL,
          scenarios: scenariosToRun,
          cpuProfile: CPU_PROFILE,
          formalEligible: SETTLE_MS >= 15_000 && PREFLIGHT_SECONDS >= 15,
        },
        hostDiagnostics: {
          preflight: { ...preflight, summary: preflightSummary },
          batch: { ...batch, summary: summarizeHostSamples(batch.samples) },
        },
        warmup,
        scenarios,
        summary: Object.fromEntries(scenarios.map((scenario) => [scenario.name, scenario.steadySummary])),
        processMemory: { final: finalMemory },
      }
      const file = path.join(OUT_DIR, `library-performance-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
      fs.writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
      console.log(
        JSON.stringify(
          {
            file,
            mode: result.mode,
            formalEligible: result.configuration.formalEligible,
            window: result.window,
            warmup: result.warmup,
            scenarios: scenarios.map((scenario) => ({
              name: scenario.name,
              status: scenario.status,
              steadySummary: scenario.steadySummary,
              noise: scenario.noise,
            })),
          },
          null,
          2,
        ),
      )
    }
  } finally {
    const shutdown = closeFlowProcess(flowProcess)
    console.log(JSON.stringify({ clientShutdown: shutdown }, null, 2))
  }
}

main().catch((error) => {
  console.error(error.message)
  if (error.detail) console.error(JSON.stringify(error.detail, null, 2))
  process.exit(1)
})
