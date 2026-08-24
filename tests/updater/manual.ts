import { spawn, spawnSync } from 'node:child_process'
import {
  copyFileSync,
  cpSync,
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs'
import { createServer, type ServerResponse } from 'node:http'
import { basename, resolve } from 'node:path'

import { repositoryRoot, runTauri } from '../../scripts/bundle-cargo.ts'
import { changelogSectionForVersion } from '../../src/updateChangelog.ts'

const [command, ...commandArguments] = process.argv.slice(2).filter((argument) => argument !== '--')
const localRoot = resolve(repositoryRoot, '.local/updater-test')
const privateKey = resolve(localRoot, 'updater.key')
const publicKey = resolve(localRoot, 'updater.key.pub')
const testConfig = resolve(repositoryRoot, 'tests/updater/tauri.conf.json')
const tauriConfigPath = resolve(repositoryRoot, 'src-tauri/tauri.conf.json')
const changelogPath = resolve(repositoryRoot, 'tests/updater/CHANGELOG.md')
const serverOrigin = 'http://127.0.0.1:7130'
const simulatedManifestDelayMs = 3_000
const simulatedDownloadDurationMs = 10_000

interface TauriConfig {
  version: string
}

function tauriConfig() {
  return JSON.parse(readFileSync(tauriConfigPath, 'utf8')) as TauriConfig
}

function run(executable: string, args: string[], environment: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(executable, args, {
    cwd: repositoryRoot,
    stdio: 'inherit',
    shell: false,
    env: { ...process.env, ...environment },
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

function requireKeys() {
  if (!existsSync(privateKey) || !existsSync(publicKey)) {
    throw new Error('Run pnpm updater:test:keygen first.')
  }
}

function publicKeyValue() {
  requireKeys()
  return readFileSync(publicKey, 'utf8').trim()
}

function updaterConfig(version: string, createUpdaterArtifacts: boolean) {
  return JSON.stringify({
    version,
    bundle: { createUpdaterArtifacts },
    plugins: { updater: { pubkey: publicKeyValue() } },
  })
}

function updaterEnvironment(version: string) {
  requireKeys()
  return {
    FLOW_READER_BUILD_VERSION: version,
    FLOW_READER_DATA_DIR: resolve(localRoot, 'data'),
    FLOW_READER_DISTRIBUTION: 'updater-test',
    TAURI_SIGNING_PRIVATE_KEY: readFileSync(privateKey, 'utf8').trim(),
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: '',
  }
}

function generateKeys() {
  mkdirSync(localRoot, { recursive: true })
  const hasPrivateKey = existsSync(privateKey)
  const hasPublicKey = existsSync(publicKey)
  if (hasPrivateKey && hasPublicKey) {
    console.log(`Reusing updater test keys in ${localRoot}.`)
    return
  }
  if (hasPrivateKey || hasPublicKey) {
    throw new Error(`Updater test keys are incomplete in ${localRoot}; remove the directory and generate them again.`)
  }
  runTauri(['signer', 'generate', '--ci', '--write-keys', privateKey], {})
}

function runDev() {
  const currentVersion = commandArguments[0] ?? '0.0.0'
  runTauri(
    ['dev', '--features', 'updater', '--config', testConfig, '--config', updaterConfig(currentVersion, false)],
    updaterEnvironment(currentVersion),
  )
}

function oneFile(directory: string, predicate: (name: string) => boolean, description: string) {
  const matches = existsSync(directory) ? readdirSync(directory).filter(predicate) : []
  if (matches.length !== 1) throw new Error(`Expected one ${description} in ${directory}, found ${matches.length}.`)
  return resolve(directory, matches[0]!)
}

function copyArtifact(source: string, outputDirectory: string) {
  const destination = resolve(outputDirectory, basename(source))
  statSync(source).isDirectory()
    ? cpSync(source, destination, { force: true, recursive: true })
    : copyFileSync(source, destination)
  return destination
}

function collectTestArtifacts(platform: string, version: string) {
  let sources: string[]
  if (platform === 'windows') {
    const directory = resolve(repositoryRoot, 'src-tauri/target/release/bundle/nsis')
    const installer = oneFile(
      directory,
      (name) => name.startsWith('Flow Reader Updater Test_') && name.includes(version) && name.endsWith('-setup.exe'),
      'NSIS installer',
    )
    sources = [installer, `${installer}.sig`]
  } else if (platform === 'macos') {
    const directory = resolve(repositoryRoot, 'src-tauri/target/universal-apple-darwin/release/bundle/macos')
    const app = oneFile(directory, (name) => name.endsWith('.app'), 'macOS application')
    const updater = oneFile(directory, (name) => name.endsWith('.app.tar.gz'), 'macOS updater archive')
    sources = [app, updater, `${updater}.sig`]
  } else {
    const directory = resolve(repositoryRoot, 'src-tauri/target/release/bundle/appimage')
    const appImage = oneFile(directory, (name) => name.includes(version) && name.endsWith('.AppImage'), 'AppImage')
    sources = [appImage, `${appImage}.sig`]
  }

  for (const source of sources) {
    if (!existsSync(source)) throw new Error(`Missing updater test artifact: ${source}`)
  }

  const platformDirectory = resolve(localRoot, 'builds', platform)
  const outputDirectory = resolve(platformDirectory, version)
  const backupDirectory = resolve(platformDirectory, `.${version}.${process.pid}.backup`)
  mkdirSync(platformDirectory, { recursive: true })
  const stagingDirectory = mkdtempSync(resolve(platformDirectory, `.${version}.staging-`))
  try {
    for (const source of sources) copyArtifact(source, stagingDirectory)
    rmSync(backupDirectory, { force: true, recursive: true })
    if (existsSync(outputDirectory)) renameSync(outputDirectory, backupDirectory)
    try {
      renameSync(stagingDirectory, outputDirectory)
    } catch (error) {
      if (existsSync(backupDirectory)) renameSync(backupDirectory, outputDirectory)
      throw error
    }
    rmSync(backupDirectory, { force: true, recursive: true })
  } finally {
    rmSync(stagingDirectory, { force: true, recursive: true })
  }
  console.log(`Updater test artifacts replaced in ${outputDirectory}`)
}

function buildInstalledTest() {
  requireKeys()
  const platform = commandArguments[0]
  const version = commandArguments[1]
  if (!platform || !version || !['windows', 'macos', 'linux'].includes(platform)) {
    throw new Error('Usage: pnpm updater:test:build <windows|macos|linux> <version>')
  }

  const environment = updaterEnvironment(version)
  const commonArguments = [
    'build',
    '--features',
    'updater',
    '--config',
    testConfig,
    '--config',
    updaterConfig(version, true),
  ]

  if (platform === 'windows') {
    if (process.platform !== 'win32') throw new Error('Windows updater tests must be built on Windows.')
    runTauri([...commonArguments, '--bundles', 'nsis'], environment)
  } else if (platform === 'macos') {
    if (process.platform !== 'darwin') throw new Error('macOS updater tests must be built on macOS.')
    runTauri([...commonArguments, '--bundles', 'app', '--target', 'universal-apple-darwin'], {
      ...environment,
      APPLE_SIGNING_IDENTITY: '-',
    })
  } else {
    if (process.platform !== 'linux') throw new Error('Linux updater tests must be built on Linux.')
    runTauri([...commonArguments, '--bundles', 'appimage'], environment)
  }

  collectTestArtifacts(platform, version)
}

function updaterTestChangelog(currentVersion: string, latestVersion: string) {
  const changelog = readFileSync(changelogPath, 'utf8').trim()
  changelogSectionForVersion(changelog, currentVersion)
  changelogSectionForVersion(changelog, latestVersion)
  return changelog
}

function testArtifact(platform: string, version: string) {
  const buildDirectory = resolve(localRoot, 'builds', platform, version)
  if (platform === 'windows') {
    return oneFile(buildDirectory, (name) => name.endsWith('-setup.exe'), 'NSIS updater installer')
  }
  if (platform === 'macos') {
    return oneFile(buildDirectory, (name) => name.endsWith('.app.tar.gz'), 'macOS updater archive')
  }
  return oneFile(buildDirectory, (name) => name.endsWith('.AppImage'), 'AppImage updater')
}

function validatePlatform(platform: string | undefined) {
  if (!platform || !['windows', 'macos', 'linux'].includes(platform)) {
    throw new Error('Platform must be windows, macos, or linux.')
  }
  const expectedPlatform = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux'
  if (platform !== expectedPlatform) throw new Error(`${platform} updater tests must run on ${platform}.`)
  return platform
}

function wait(milliseconds: number) {
  return new Promise<void>((resolveWait) => setTimeout(resolveWait, milliseconds))
}

function waitForRemoval(path: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  const waitBuffer = new Int32Array(new SharedArrayBuffer(4))
  while (existsSync(path) && Date.now() < deadline) Atomics.wait(waitBuffer, 0, 0, 100)
  if (existsSync(path)) throw new Error(`Timed out waiting for the previous updater test installation: ${path}`)
}

async function sendThrottledArtifact(response: ServerResponse, artifact: string) {
  const size = statSync(artifact).size
  const chunkSize = Math.max(1, Math.ceil(size / 100))
  const chunkCount = Math.ceil(size / chunkSize)
  const startedAt = Date.now()
  let chunkIndex = 0
  let lastRemainingSeconds = 10

  console.log('Download test: 10s remaining')
  for await (const chunk of createReadStream(artifact, { highWaterMark: chunkSize })) {
    chunkIndex += 1
    const targetTime = startedAt + Math.round((chunkIndex / chunkCount) * simulatedDownloadDurationMs)
    await wait(Math.max(0, targetTime - Date.now()))
    if (response.destroyed) return
    if (!response.write(chunk)) await new Promise<void>((resolveDrain) => response.once('drain', resolveDrain))

    const remainingSeconds = Math.max(0, Math.ceil((startedAt + simulatedDownloadDurationMs - Date.now()) / 1000))
    if (remainingSeconds !== lastRemainingSeconds) {
      lastRemainingSeconds = remainingSeconds
      console.log(`Download test: ${remainingSeconds}s remaining`)
    }
  }
  response.end()
}

function createUpdaterServer(artifact: string, latestVersion: string, onListening?: () => void) {
  const signaturePath = `${artifact}.sig`
  if (!existsSync(artifact) || !existsSync(signaturePath)) {
    throw new Error('The served updater artifact and its adjacent .sig file must both exist.')
  }
  const signature = readFileSync(signaturePath, 'utf8').trim()

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', serverOrigin)
    if (url.pathname === '/latest.json') {
      await wait(simulatedManifestDelayMs)
      if (response.destroyed) return
      const currentVersion = url.searchParams.get('current') ?? '0.0.0'
      const body = {
        version: latestVersion,
        notes: updaterTestChangelog(currentVersion, latestVersion),
        url: `${serverOrigin}/artifact`,
        signature,
      }
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify(body))
      return
    }
    if (url.pathname === '/artifact') {
      response.writeHead(200, {
        'content-length': statSync(artifact).size,
        'content-type': 'application/octet-stream',
      })
      void sendThrottledArtifact(response, artifact).catch((error: unknown) => {
        response.destroy(error instanceof Error ? error : new Error(String(error)))
      })
      return
    }
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('Not found.')
  })

  server.listen(7130, '127.0.0.1', () => {
    console.log(`Updater test server: ${serverOrigin}`)
    console.log(`Latest version: ${latestVersion}`)
    console.log(`Serving ${artifact}`)
    console.log('Update checks are delayed by 3 seconds.')
    console.log('Artifact downloads are throttled to 10 seconds.')
    onListening?.()
  })

  return server
}

function serveUpdater() {
  const platform = validatePlatform(commandArguments[0])
  const latestVersion = commandArguments[1] ?? tauriConfig().version
  createUpdaterServer(testArtifact(platform, latestVersion), latestVersion)
}

function exerciseInstalledUpdate() {
  const platform = validatePlatform(commandArguments[0])
  const currentVersion = commandArguments[1]
  const latestVersion = commandArguments[2] ?? tauriConfig().version
  if (!currentVersion) {
    throw new Error('Usage: pnpm updater:test:exercise <windows|macos|linux> <current-version> [latest-version]')
  }

  const currentBuildDirectory = resolve(localRoot, 'builds', platform, currentVersion)
  const latestArtifact = testArtifact(platform, latestVersion)
  let application: string

  if (platform === 'windows') {
    const localAppData = process.env.LOCALAPPDATA
    if (!localAppData) throw new Error('LOCALAPPDATA is required to launch the installed updater test application.')
    const installDirectory = resolve(localAppData, 'Flow Reader Updater Test')
    application = resolve(installDirectory, 'Flow Reader.exe')
    const uninstaller = resolve(installDirectory, 'uninstall.exe')
    if (existsSync(uninstaller)) {
      run(uninstaller, ['/S'])
      waitForRemoval(application, 10_000)
    }
    const installer = oneFile(currentBuildDirectory, (name) => name.endsWith('-setup.exe'), 'old NSIS installer')
    run(installer, ['/S'])
  } else if (platform === 'macos') {
    const app = oneFile(currentBuildDirectory, (name) => name.endsWith('.app'), 'old macOS application')
    application = resolve(app, 'Contents', 'MacOS', 'Flow Reader')
  } else {
    application = oneFile(currentBuildDirectory, (name) => name.endsWith('.AppImage'), 'old AppImage')
  }

  if (!existsSync(application)) throw new Error(`Installed updater test application is missing: ${application}`)
  createUpdaterServer(latestArtifact, latestVersion, () => {
    const environment = { ...process.env, FLOW_READER_DATA_DIR: resolve(localRoot, 'data') }
    const child = spawn(application, [], { env: environment })
    child.on('error', (error) => {
      throw error
    })
    console.log(`Started ${currentVersion}. Use About to install ${latestVersion}; keep this server running.`)
  })
}

switch (command) {
  case 'keygen':
    generateKeys()
    break
  case 'dev':
    runDev()
    break
  case 'build':
    buildInstalledTest()
    break
  case 'serve':
    serveUpdater()
    break
  case 'exercise':
    exerciseInstalledUpdate()
    break
  default:
    throw new Error('Usage: node tests/updater/manual.ts <keygen|dev|build|serve|exercise> [...arguments]')
}
