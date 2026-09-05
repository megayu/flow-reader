import fs from 'node:fs'
import path from 'node:path'

const SCHEMA_VERSION = 1

function fail(message) {
  throw new Error(message)
}

function sortedObjectJson(value) {
  return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))))
}

function readBatch(input) {
  const resolved = path.resolve(input)
  const directory = fs.statSync(resolved).isDirectory() ? resolved : path.dirname(resolved)
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'))
  const results = JSON.parse(fs.readFileSync(path.join(directory, 'results.json'), 'utf8'))
  const quality = JSON.parse(fs.readFileSync(path.join(directory, 'quality.json'), 'utf8'))
  if (manifest.version !== SCHEMA_VERSION || results.version !== SCHEMA_VERSION || quality.version !== SCHEMA_VERSION) {
    fail(`batch uses a schema other than ${SCHEMA_VERSION}: ${directory}`)
  }
  if (
    !Array.isArray(results.samples) ||
    !results.samples.length ||
    ![quality.valid, quality.invalid, quality.failed].every((value) => typeof value === 'number')
  ) {
    fail(`batch has an invalid results or quality contract: ${directory}`)
  }
  if (
    !manifest.data?.bookCountsByScenario ||
    typeof manifest.data.bookCountsByScenario !== 'object' ||
    Array.isArray(manifest.data.bookCountsByScenario)
  ) {
    fail(`batch has invalid per-scenario book counts: ${directory}`)
  }
  const requiredManifestValues = [
    manifest.collector?.observeMs,
    manifest.browser?.headless,
    manifest.fingerprints?.runnerSha256,
    manifest.fingerprints?.driverSha256,
    manifest.fingerprints?.fixtureSha256,
    manifest.fingerprints?.scenarioSha256,
  ]
  if (requiredManifestValues.some((value) => value === undefined || value === null)) {
    fail(`batch predates the current comparison contract; record it again: ${directory}`)
  }
  if (quality.invalid || quality.failed) fail(`batch contains invalid or failed samples: ${directory}`)
  if (quality.valid !== results.samples.length || results.samples.some((sample) => sample.status !== 'valid')) {
    fail(`batch quality does not match its samples: ${directory}`)
  }
  return { directory, manifest, results }
}

function comparable(left, right) {
  const fields = [
    ['build.type', left.build.type, right.build.type],
    ['build.strictMode', left.build.strictMode, right.build.strictMode],
    ['collector.reactDoctorVersion', left.collector.reactDoctorVersion, right.collector.reactDoctorVersion],
    ['collector.windowing', left.collector.windowing, right.collector.windowing],
    ['collector.observeMs', left.collector.observeMs, right.collector.observeMs],
    ['browser.channel', left.browser.channel, right.browser.channel],
    ['browser.headless', left.browser.headless, right.browser.headless],
    ['browser.viewport', JSON.stringify(left.browser.viewport), JSON.stringify(right.browser.viewport)],
    ['browser.deviceScaleFactor', left.browser.deviceScaleFactor, right.browser.deviceScaleFactor],
    ['data.kind', left.data.kind, right.data.kind],
    [
      'data.bookCountsByScenario',
      sortedObjectJson(left.data.bookCountsByScenario),
      sortedObjectJson(right.data.bookCountsByScenario),
    ],
    ['fingerprints.runnerSha256', left.fingerprints.runnerSha256, right.fingerprints.runnerSha256],
    ['fingerprints.driverSha256', left.fingerprints.driverSha256, right.fingerprints.driverSha256],
    ['fingerprints.fixtureSha256', left.fingerprints.fixtureSha256, right.fingerprints.fixtureSha256],
    ['fingerprints.scenarioSha256', left.fingerprints.scenarioSha256, right.fingerprints.scenarioSha256],
  ]
  const mismatches = fields.filter(([, leftValue, rightValue]) => leftValue !== rightValue)
  if (mismatches.length) {
    fail(
      `batches are not comparable:\n${mismatches.map(([field, leftValue, rightValue]) => `- ${field}: ${leftValue} != ${rightValue}`).join('\n')}`,
    )
  }
}

function groupSamples(samples) {
  return Map.groupBy(samples, (sample) => sample.scenarioId)
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function componentMedians(samples) {
  const names = new Set(
    samples.flatMap((sample) => sample.window.components.map((component) => `${component.source}\0${component.name}`)),
  )
  return [...names].map((key) => {
    const [source, name] = key.split('\0')
    const rows = samples.map((sample) =>
      sample.window.components.find((component) => component.source === source && component.name === name),
    )
    return {
      name,
      source,
      renderCount: median(rows.map((row) => row?.renderCount ?? 0)),
      totalRenderDurationMs: median(rows.map((row) => row?.totalRenderDurationMs ?? 0)),
      maxRenderDurationMs: median(rows.map((row) => row?.maxRenderDurationMs ?? 0)),
    }
  })
}

function compareScenario(scenarioId, baselineSamples, afterSamples) {
  if (baselineSamples.length !== afterSamples.length) fail(`${scenarioId} has different sample counts`)
  const baseline = componentMedians(baselineSamples)
  const after = componentMedians(afterSamples)
  const keys = new Set([...baseline, ...after].map((component) => `${component.source}\0${component.name}`))
  return {
    scenarioId,
    samples: baselineSamples.length,
    components: [...keys]
      .map((key) => {
        const [source, name] = key.split('\0')
        const before = baseline.find((component) => component.source === source && component.name === name) ?? {
          renderCount: 0,
          totalRenderDurationMs: 0,
          maxRenderDurationMs: 0,
        }
        const next = after.find((component) => component.source === source && component.name === name) ?? {
          renderCount: 0,
          totalRenderDurationMs: 0,
          maxRenderDurationMs: 0,
        }
        return {
          name,
          source,
          baseline: before,
          after: next,
          delta: {
            renderCount: next.renderCount - before.renderCount,
            totalRenderDurationMs: Number((next.totalRenderDurationMs - before.totalRenderDurationMs).toFixed(3)),
            maxRenderDurationMs: Number((next.maxRenderDurationMs - before.maxRenderDurationMs).toFixed(3)),
          },
        }
      })
      .sort((left, right) => Math.abs(right.delta.totalRenderDurationMs) - Math.abs(left.delta.totalRenderDurationMs)),
  }
}

function main() {
  const [baselineInput, afterInput, outputInput] = process.argv.slice(2)
  if (!baselineInput || !afterInput)
    fail('usage: compare-react-renders.mjs <baseline-directory> <after-directory> [output-file]')
  const baseline = readBatch(baselineInput)
  const after = readBatch(afterInput)
  comparable(baseline.manifest, after.manifest)
  const baselineByScenario = groupSamples(baseline.results.samples)
  const afterByScenario = groupSamples(after.results.samples)
  const baselineIds = [...baselineByScenario.keys()].sort()
  const afterIds = [...afterByScenario.keys()].sort()
  if (JSON.stringify(baselineIds) !== JSON.stringify(afterIds)) fail('batches contain different scenario sets')
  const comparison = {
    version: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    baseline: baseline.directory,
    after: after.directory,
    scenarios: baselineIds.map((scenarioId) =>
      compareScenario(scenarioId, baselineByScenario.get(scenarioId), afterByScenario.get(scenarioId)),
    ),
  }
  const output = outputInput ? path.resolve(outputInput) : path.join(after.directory, 'comparison.json')
  fs.writeFileSync(output, `${JSON.stringify(comparison, null, 2)}\n`, 'utf8')
  console.log(output)
}

try {
  main()
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
