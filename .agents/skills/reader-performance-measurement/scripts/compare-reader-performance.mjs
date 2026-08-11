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
    'Usage: node .agents/skills/reader-performance-measurement/scripts/compare-reader-performance.mjs <baseline.json> <after.json> [--json]',
  )
  process.exit(1)
}

function compareMetric(baselineSummary, afterSummary, label, pathParts) {
  const baseline = valueAt(baselineSummary, pathParts)
  const after = valueAt(afterSummary, pathParts)
  return {
    metric: label,
    baseline,
    after,
    delta: typeof baseline === 'number' && typeof after === 'number' ? after - baseline : null,
    percent: percentChange(baseline, after),
  }
}

function compareScenario(name, baselineScenario, afterScenario) {
  const baselineSummary = scenarioSummary(baselineScenario)
  const afterSummary = scenarioSummary(afterScenario)
  const status = {
    baseline: baselineScenario?.status ?? (baselineScenario ? 'passed' : 'missing'),
    after: afterScenario?.status ?? (afterScenario ? 'passed' : 'missing'),
  }

  if (!baselineSummary || !afterSummary) {
    return {
      name,
      kind: afterScenario?.kind ?? baselineScenario?.kind,
      status,
      metrics: [],
      note: !baselineSummary ? 'missing baseline summary' : 'missing after summary',
    }
  }

  const metricSpecs = [
    ['operation.p50', ['operationMs', 'p50']],
    ['operation.p95', ['operationMs', 'p95']],
    ['firstFrame.p50', ['firstFrameMs', 'p50']],
    ['firstFrame.p95', ['firstFrameMs', 'p95']],
    ['settled.p50', ['settledMs', 'p50']],
    ['settled.p95', ['settledMs', 'p95']],
    ['longTasks.count', ['longTasks', 'count']],
    ['longTasks.totalMs', ['longTasks', 'totalMs']],
    ['longTasks.maxMs', ['longTasks', 'maxMs']],
  ]

  if (baselineSummary.burstMs || afterSummary.burstMs) {
    metricSpecs.unshift(
      ['burst.p50', ['burstMs', 'p50']],
      ['burst.p95', ['burstMs', 'p95']],
      ['maxStepFirstFrame.p95', ['maxStepFirstFrameMs', 'p95']],
    )
  }

  return {
    name,
    kind: afterScenario?.kind ?? baselineScenario?.kind ?? 'single',
    status,
    metrics: metricSpecs.map(([label, parts]) => compareMetric(baselineSummary, afterSummary, label, parts)),
  }
}

function printText(comparison, baselineFile, afterFile) {
  console.log(`Baseline: ${path.resolve(baselineFile)}`)
  console.log(`After:    ${path.resolve(afterFile)}`)
  console.log(`Mode:     ${comparison.baseline.mode ?? 'unknown'} -> ${comparison.after.mode ?? 'unknown'}`)
  console.log('')

  const rows = comparison.scenarios.flatMap((scenario) => {
    if (scenario.note) {
      return [
        {
          scenario: scenario.name,
          kind: scenario.kind ?? 'single',
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
      kind: index === 0 ? (scenario.kind ?? 'single') : '',
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
    kind: 'Kind',
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
  const formatRow = (row) =>
    Object.keys(headers)
      .map((key) => pad(row[key], widths[key], numeric.has(key) ? 'right' : 'left'))
      .join('  ')

  console.log(formatRow(headers))
  console.log(
    Object.keys(headers)
      .map((key) => '-'.repeat(widths[key]))
      .join('  '),
  )
  rows.forEach((row) => console.log(formatRow(row)))
}

const args = process.argv.slice(2)
const json = args.includes('--json')
const files = args.filter((arg) => arg !== '--json')
if (files.length !== 2) usage()

const [baselineFile, afterFile] = files
const baseline = readResult(baselineFile)
const after = readResult(afterFile)
const baselineScenarios = scenarioMap(baseline)
const afterScenarios = scenarioMap(after)
const names = [...new Set([...baselineScenarios.keys(), ...afterScenarios.keys()])].sort()
const comparison = {
  baseline: {
    file: path.resolve(baselineFile),
    generatedAt: baseline.generatedAt,
    mode: baseline.mode,
    runsPerScenario: baseline.runsPerScenario,
    burstRunsPerScenario: baseline.burstRunsPerScenario,
  },
  after: {
    file: path.resolve(afterFile),
    generatedAt: after.generatedAt,
    mode: after.mode,
    runsPerScenario: after.runsPerScenario,
    burstRunsPerScenario: after.burstRunsPerScenario,
  },
  scenarios: names.map((name) => compareScenario(name, baselineScenarios.get(name), afterScenarios.get(name))),
}

if (json) {
  console.log(JSON.stringify(comparison, null, 2))
} else {
  printText(comparison, baselineFile, afterFile)
}
