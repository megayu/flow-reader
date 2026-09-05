import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const expectedVersion = process.env.FLOW_REACT_DOCTOR_VERSION
if (!expectedVersion) throw new Error('FLOW_REACT_DOCTOR_VERSION is required')
const executableNames = process.platform === 'win32' ? ['react-doctor.cmd', 'react-doctor.exe'] : ['react-doctor']
const pathEntries = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
let shim
for (const directory of pathEntries) {
  for (const name of executableNames) {
    const candidate = path.join(directory, name)
    if (fs.existsSync(candidate)) {
      shim = candidate
      break
    }
  }
  if (shim) break
}
if (!shim) throw new Error('react-doctor executable was not provided by npm exec')

const packageRoot = path.resolve(path.dirname(shim), '..', 'react-doctor')
const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'))
if (packageJson.version !== expectedVersion) {
  throw new Error(`expected react-doctor ${expectedVersion}, received ${packageJson.version}`)
}

Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true })
await import(pathToFileURL(path.join(packageRoot, 'dist', 'cli.js')).href)
