import path from 'node:path'

import {
  formatNumber,
  formatPercent,
  pad,
  percentChange,
  readResult,
  scenarioMap,
  scenarioSummary,
  valueAt,
} from './performance-comparison.mjs'

function usage() {
  console.error(
    'Usage: node .agents/skills/reader-performance-measurement/scripts/compare-library-performance.mjs <baseline.json> <after.json> [--json]',
  )
  process.exit(1)
}

function compareValue(baseline, after, metric, parts) {
  const baselineValue = valueAt(baseline, parts)
  const afterValue = valueAt(after, parts)
  return {
    metric,
    baseline: baselineValue,
    after: afterValue,
    delta: Number.isFinite(baselineValue) && Number.isFinite(afterValue) ? afterValue - baselineValue : null,
    percent: percentChange(baselineValue, afterValue),
  }
}

const METRICS = [
  ['operation.p50', ['operationMs', 'p50']],
  ['operation.p95', ['operationMs', 'p95']],
  ['firstFrame.p50', ['firstFrameMs', 'p50']],
  ['firstFrame.p95', ['firstFrameMs', 'p95']],
  ['settled.p50', ['settledMs', 'p50']],
  ['settled.p95', ['settledMs', 'p95']],
  ['frameGap.p95', ['frameGapMs', 'p95']],
  ['longTasks.count', ['longTasks', 'count']],
  ['longTasks.totalMs', ['longTasks', 'totalMs']],
  ['longTasks.maxMs', ['longTasks', 'maxMs']],
  ['mountedCards.p50', ['mountedCards', 'p50']],
  ['visibleCards.p50', ['visibleCards', 'p50']],
  ['dom.nodes.p50', ['dom', 'nodes', 'p50']],
  ['dom.documents.p50', ['dom', 'documents', 'p50']],
  ['dom.eventListeners.p50', ['dom', 'eventListeners', 'p50']],
  ['heap.usedMiB.p50', ['heap', 'usedBytes', 'p50']],
  ['process.privateMiB.p50', ['processMemory', 'privateBytes', 'p50']],
  ['process.workingSetMiB.p50', ['processMemory', 'workingSetBytes', 'p50']],
  ['renderer.privateMiB.p50', ['processMemory', 'rendererPrivateBytes', 'p50']],
  ['gpu.privateMiB.p50', ['processMemory', 'gpuPrivateBytes', 'p50']],
  ['visibleImages.ready.p50', ['visibleImages', 'ready', 'p50']],
  ['visibleImages.pending.p50', ['visibleImages', 'pending', 'p50']],
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
const COVER_METRICS = [
  ['cover.samplesWithPendingFrames', ['coverRestoration', 'samplesWithPendingFrames']],
  ['cover.totalPendingFrames', ['coverRestoration', 'totalPendingFrames']],
  ['cover.maxPendingImages', ['coverRestoration', 'maxPendingImages']],
  ...COVER_RETURN_PHASES.flatMap((phase) => [
    [`cover.${phase}.samplesWithPending`, ['coverRestoration', 'phases', phase, 'samplesWithPending']],
    [`cover.${phase}.pendingFrames.p95`, ['coverRestoration', 'phases', phase, 'pendingFrames', 'p95']],
    [`cover.${phase}.pendingDurationMs.p95`, ['coverRestoration', 'phases', phase, 'pendingDurationMs', 'p95']],
    [`cover.${phase}.maxPendingImages`, ['coverRestoration', 'phases', phase, 'maxPendingImages']],
    [`cover.${phase}.firstReadyMs.p95`, ['coverRestoration', 'phases', phase, 'firstReadyMs', 'p95']],
  ]),
]

function convertBytesMetric(metric) {
  if (!metric.metric.includes('MiB')) return metric
  const divisor = 1024 * 1024
  return {
    ...metric,
    baseline: Number.isFinite(metric.baseline) ? metric.baseline / divisor : metric.baseline,
    after: Number.isFinite(metric.after) ? metric.after / divisor : metric.after,
    delta: Number.isFinite(metric.delta) ? metric.delta / divisor : metric.delta,
  }
}

function compareScenario(name, baselineScenario, afterScenario) {
  const baselineSummary = scenarioSummary(baselineScenario)
  const afterSummary = scenarioSummary(afterScenario)
  if (!baselineSummary || !afterSummary) {
    return {
      name,
      status: {
        baseline: baselineScenario?.status ?? 'missing',
        after: afterScenario?.status ?? 'missing',
      },
      metrics: [],
      note: !baselineSummary ? 'missing baseline summary' : 'missing after summary',
    }
  }
  return {
    name,
    status: {
      baseline: baselineScenario?.status ?? 'passed',
      after: afterScenario?.status ?? 'passed',
    },
    metrics: [
      ...METRICS,
      ...(baselineSummary.coverRestoration || afterSummary.coverRestoration ? COVER_METRICS : []),
    ].map(([label, parts]) => convertBytesMetric(compareValue(baselineSummary, afterSummary, label, parts))),
    noise: {
      baseline: baselineScenario.noise,
      after: afterScenario.noise,
    },
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function performanceSettings(settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return settings
  const { textImportRules: _textImportRules, translation: _translation, ...relevant } = settings
  return relevant
}

function metadataChecks(baseline, after) {
  const checks = [
    ['mode', baseline.mode, after.mode],
    ['dataset.count', baseline.dataset?.count, after.dataset?.count],
    ['dataset.seed', baseline.dataset?.seed, after.dataset?.seed],
    ['dataset.coverProfile', baseline.dataset?.coverProfile, after.dataset?.coverProfile],
    ['dataset.coverDistribution', baseline.dataset?.coverDistribution, after.dataset?.coverDistribution],
    ['dataset.complexityDistribution', baseline.dataset?.complexityDistribution, after.dataset?.complexityDistribution],
    ['dataset.source.sha256', baseline.dataset?.source?.sha256, after.dataset?.source?.sha256],
    [
      'settings.expected.performance',
      performanceSettings(baseline.settings?.expected),
      performanceSettings(after.settings?.expected),
    ],
    ['window.requested', baseline.window?.requested, after.window?.requested],
    [
      'window.actual.devicePixelRatio',
      baseline.window?.actual?.devicePixelRatio,
      after.window?.actual?.devicePixelRatio,
    ],
    ['configuration.runs', baseline.configuration?.runs, after.configuration?.runs],
    ['configuration.steadySkip', baseline.configuration?.steadySkip, after.configuration?.steadySkip],
    ['configuration.pilotRuns', baseline.configuration?.pilotRuns, after.configuration?.pilotRuns],
    ['configuration.scenarios', baseline.configuration?.scenarios, after.configuration?.scenarios],
  ]
  return checks.map(([name, baselineValue, afterValue]) => ({
    name,
    matched: stableJson(baselineValue) === stableJson(afterValue),
    baseline: baselineValue,
    after: afterValue,
  }))
}

function printComparison(comparison) {
  console.log(`Baseline: ${comparison.baseline.file}`)
  console.log(`After:    ${comparison.after.file}`)
  console.log(`Matched:  ${comparison.metadata.matched ? 'yes' : 'no'}`)
  if (!comparison.metadata.matched) {
    for (const check of comparison.metadata.checks.filter((item) => !item.matched)) {
      console.log(`  mismatch ${check.name}: ${JSON.stringify(check.baseline)} -> ${JSON.stringify(check.after)}`)
    }
  }
  console.log('')

  const rows = comparison.scenarios.flatMap((scenario) => {
    if (scenario.note) {
      return [
        {
          scenario: scenario.name,
          status: `${scenario.status.baseline}->${scenario.status.after}`,
          metric: scenario.note,
          baseline: '',
          after: '',
          delta: '',
          change: '',
        },
      ]
    }
    return scenario.metrics.map((metric, index) => ({
      scenario: index === 0 ? scenario.name : '',
      status: index === 0 ? `${scenario.status.baseline}->${scenario.status.after}` : '',
      metric: metric.metric,
      baseline: formatNumber(metric.baseline),
      after: formatNumber(metric.after),
      delta: formatNumber(metric.delta),
      change: formatPercent(metric.percent),
    }))
  })
  const headers = {
    scenario: 'Scenario',
    status: 'Status',
    metric: 'Metric',
    baseline: 'Baseline',
    after: 'After',
    delta: 'Delta',
    change: 'Change',
  }
  const widths = Object.fromEntries(
    Object.keys(headers).map((key) => [
      key,
      Math.max(headers[key].length, ...rows.map((row) => String(row[key] ?? '').length)),
    ]),
  )
  const numeric = new Set(['baseline', 'after', 'delta', 'change'])
  const render = (row) =>
    Object.keys(headers)
      .map((key) => pad(row[key], widths[key], numeric.has(key) ? 'right' : 'left'))
      .join('  ')
  console.log(render(headers))
  console.log(
    Object.keys(headers)
      .map((key) => '-'.repeat(widths[key]))
      .join('  '),
  )
  rows.forEach((row) => console.log(render(row)))
}

const args = process.argv.slice(2)
const json = args.includes('--json')
const files = args.filter((argument) => argument !== '--json')
if (files.length !== 2) usage()

const [baselineFile, afterFile] = files
const baseline = readResult(baselineFile)
const after = readResult(afterFile)
const checks = metadataChecks(baseline, after)
const baselineScenarios = scenarioMap(baseline)
const afterScenarios = scenarioMap(after)
const names = [...new Set([...baselineScenarios.keys(), ...afterScenarios.keys()])].sort()
const comparison = {
  baseline: {
    file: path.resolve(baselineFile),
    generatedAt: baseline.generatedAt,
    sourceState: baseline.sourceState,
    hostDiagnostics: baseline.hostDiagnostics?.batch?.summary,
  },
  after: {
    file: path.resolve(afterFile),
    generatedAt: after.generatedAt,
    sourceState: after.sourceState,
    hostDiagnostics: after.hostDiagnostics?.batch?.summary,
  },
  metadata: {
    matched: checks.every((check) => check.matched),
    checks,
  },
  scenarios: names.map((name) => compareScenario(name, baselineScenarios.get(name), afterScenarios.get(name))),
}

if (json) console.log(JSON.stringify(comparison, null, 2))
else printComparison(comparison)

if (!comparison.metadata.matched) process.exitCode = 2
