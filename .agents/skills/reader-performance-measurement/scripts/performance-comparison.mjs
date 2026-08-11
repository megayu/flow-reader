import fs from 'node:fs'

export function readResult(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    console.error(`Failed to read ${file}: ${error.message}`)
    process.exit(1)
  }
}

export function scenarioSummary(scenario) {
  return scenario?.steadySummary ?? scenario?.summary
}

export function valueAt(value, parts) {
  return parts.reduce((current, part) => (current == null ? undefined : current[part]), value)
}

export function percentChange(baseline, after) {
  if (!Number.isFinite(baseline) || !Number.isFinite(after)) return null
  if (baseline === 0) return after === 0 ? 0 : null
  return ((after - baseline) / baseline) * 100
}

export function formatNumber(value) {
  return Number.isFinite(value) ? value.toFixed(1) : 'n/a'
}

export function formatPercent(value) {
  if (!Number.isFinite(value)) return 'n/a'
  return `${value > 0 ? '+' : ''}${value.toFixed(1)}%`
}

export function pad(value, width, align = 'left') {
  const text = String(value ?? '')
  return align === 'right' ? text.padStart(width) : text.padEnd(width)
}

export function scenarioMap(result) {
  return new Map((result.scenarios ?? []).map((scenario) => [scenario.name, scenario]))
}
