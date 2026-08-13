import { spawn } from 'node:child_process'
import { createConnection, createServer } from 'node:net'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { ensureKeeperIdentity } from '../server/robinhood-keeper-key.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

function loadLocalEnvironment(file) {
  if (!existsSync(file)) return
  for (const rawLine of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const separator = line.indexOf('=')
    if (separator <= 0) continue
    const key = line.slice(0, separator).trim()
    let value = line.slice(separator + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    if (!(key in process.env)) process.env[key] = value
  }
}

loadLocalEnvironment(join(root, '.env.local'))
const webPort = 4174
const apiPort = 8787
const keeperIdentity = ensureKeeperIdentity()

function ensurePortFree(port) {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', error => reject(new Error(`Port ${port} is already in use. Close that program and try again. (${error.code || error.message})`)))
    probe.listen(port, '0.0.0.0', () => probe.close(resolve))
  })
}

function waitForPort(port, timeoutMs = 15_000) {
  const startedAt = Date.now()
  return new Promise((resolve, reject) => {
    const tryConnect = () => {
      const socket = createConnection({ host: '127.0.0.1', port })
      socket.once('connect', () => {
        socket.destroy()
        resolve()
      })
      socket.once('error', () => {
        socket.destroy()
        if (Date.now() - startedAt >= timeoutMs) reject(new Error(`API did not open port ${port} within ${timeoutMs / 1000}s.`))
        else setTimeout(tryConnect, 250)
      })
    }
    tryConnect()
  })
}

await ensurePortFree(webPort)
await ensurePortFree(apiPort)

const api = spawn(process.execPath, ['server/index.mjs'], {
  cwd: root,
  env: { ...process.env, PORT: String(apiPort) },
  stdio: 'inherit',
})

const keeper = spawn(process.execPath, ['services/robinhood-keeper/index.mjs'], {
  cwd: root,
  env: { ...process.env },
  stdio: 'inherit',
})

let web
let stopping = false

function stop(exitCode = 0) {
  if (stopping) return
  stopping = true
  process.exitCode = exitCode
  if (web && !web.killed) web.kill()
  if (!api.killed) api.kill()
  if (!keeper.killed) keeper.kill()
  setTimeout(() => process.exit(exitCode), 250)
}

process.on('SIGINT', () => stop(0))
process.on('SIGTERM', () => stop(0))

api.once('exit', code => {
  if (!stopping) {
    console.error(`bStocker API stopped unexpectedly (exit ${code ?? 'unknown'}).`)
    stop(code || 1)
  }
})

keeper.once('exit', code => {
  if (!stopping && code) console.error(`Robinhood shadow keeper stopped unexpectedly (exit ${code}). The BSC app remains available, but strategy monitoring is stale.`)
})

try {
  await waitForPort(apiPort)
  const viteCli = join(root, 'node_modules', 'vite', 'bin', 'vite.js')
  web = spawn(process.execPath, [viteCli, 'preview', '--host', '0.0.0.0', '--port', String(webPort), '--strictPort', '--configLoader', 'runner'], {
    cwd: root,
    stdio: 'inherit',
  })
  console.log(`\nbStocker LAN server: http://localhost:${webPort}`)
  console.log(`Other devices: http://<THIS-MACHINE-IP>:${webPort}`)
  console.log(`Robinhood low-privilege keeper: ${keeperIdentity.address}`)
  console.log('Keeper writes require all three gates: auto mode + local allow flag + owner-signed armed vault.')
  console.log('Press Ctrl+C to stop the web server, API, and keeper before closing this terminal.\n')
  web.once('exit', code => stop(code || 0))
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  stop(1)
}
