/**
 * Host-side test for the panel API: mounts the real plugin entry with a fake
 * Cordis context, then drives the registered JSON routes the way the browser
 * does. Verifies status/config/action routes, config precedence, secret
 * handling, persistence mode, and the live engine restart on save.
 *
 * Run with: node test/panel-test.mjs
 */
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { startWebdavServer } from './webdav-server.mjs'
import { apply } from '../index.js'

let serverClosed = false

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-webdav-panel-test-'))
const server = await startWebdavServer({ root: path.join(tmp, 'remote') })
const home = path.join(tmp, 'home')
const profileDir = path.join(tmp, 'profile')
const routes = new Map()
const effects = []
const errors = []

let passed = 0
const failures = []

async function check(name, operation) {
  try {
    await operation()
    passed += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.error(`  FAIL ${name}\n       ${error?.stack ?? error}`)
  }
}

const profileContext = { dir: profileDir, home, name: 'test-profile' }

const fakeCtx = {
  logger: {
    info() {},
    warn() {},
    error(message) { errors.push(String(message)) },
    debug() {},
  },
  get(name) {
    if (name === 'profileContext') return profileContext
    if (name === 'sessions') return { get: () => undefined, list: () => [] }
    if (name === 'webServer') return fakeCtx.__webServer
    if (name === 'connection') return fakeCtx.__connection
    if (name === 'tools') return fakeCtx.__tools
    return undefined
  },
  inject(_names, callback) {
    return callback(fakeCtx)
  },
  effect(factory) {
    const dispose = factory()
    effects.push(dispose)
    return dispose
  },
  __webServer: {
    register(route) {
      if (routes.has(route.path)) throw new Error(`duplicate route ${route.path}`)
      routes.set(route.path, route)
      return () => { routes.delete(route.path) }
    },
  },
  __connection: {
    requestRejection() { return undefined },
  },
  __tools: {
    register() { return () => {} },
  },
}
fakeCtx.tools = fakeCtx.__tools
fakeCtx.webServer = fakeCtx.__webServer
fakeCtx.connection = fakeCtx.__connection

function fakeRequest(method, url, body, headers = {}) {
  const stream = body === undefined
    ? Readable.from([])
    : Readable.from([Buffer.from(JSON.stringify(body))])
  stream.method = method
  stream.url = url
  stream.headers = {
    'content-type': body === undefined ? undefined : 'application/json',
    ...headers,
  }
  return stream
}

function fakeResponse() {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.status = status
      this.headers = { ...(headers ?? {}) }
      return this
    },
    setHeader(name, value) {
      this.headers[name] = value
    },
    end(chunk) {
      if (chunk !== undefined) this.body = String(chunk)
      return this
    },
  }
}

async function call(method, pathname, body) {
  const route = routes.get(pathname)
  assert.ok(route, `route ${pathname} should be registered`)
  const request = fakeRequest(method, pathname, body)
  const response = fakeResponse()
  await route.handler(request, response)
  let json
  try {
    json = response.body ? JSON.parse(response.body) : undefined
  } catch {
    json = undefined
  }
  return { response, json }
}

await fsp.mkdir(path.join(home, 'skills', 'demo'), { recursive: true })
await fsp.writeFile(path.join(home, 'skills', 'demo', 'SKILL.md'), 'demo\n')
await fsp.mkdir(path.join(profileDir), { recursive: true })
await fsp.writeFile(path.join(profileDir, 'cordis.patch.yml'), '- id: demo\n  name: demo\n')
await fsp.writeFile(path.join(profileDir, 'package.json'), JSON.stringify({ name: 'p', dsh: { profile: { bundles: [] } } }))

apply(fakeCtx, {
  url: server.url,
  username: 'sync-user',
  password: 'row-secret',
  remoteRoot: 'row-root',
  scopes: { skills: true, agentSkills: false, sessions: true, profile: true },
  syncOnStart: false,
  watch: false,
  checkUpdates: false,
  pollIntervalMs: 3_600_000,
})

const configFile = path.join(home, 'date-sync', 'config.json')

console.log('\nPanel API')
await check('status route reports the running engine', async () => {
  const { response, json } = await call('GET', '/api/date-sync/status')
  assert.equal(response.status, 200)
  assert.equal(json.configured, true)
  assert.equal(json.remote.root, 'row-root')
  assert.equal(json.remote.url, server.url)
  assert.equal(json.configSource, 'profile')
  assert.equal(json.profileName, 'test-profile')
  assert.ok(Array.isArray(json.scopes) && json.scopes.length >= 3)
  assert.equal(json.scopes.find((scope) => scope.key === 'skills').trackedFiles >= 0, true)
  assert.equal(json.connection, 'unknown')
})

await check('config route exposes settings but never the password', async () => {
  const { response, json } = await call('GET', '/api/date-sync/config')
  assert.equal(response.status, 200)
  assert.equal(json.url, server.url)
  assert.equal(json.username, 'sync-user')
  assert.equal(json.hasPassword, true)
  assert.equal(Object.prototype.hasOwnProperty.call(json, 'password'), false)
  assert.equal(json.scopes.skills, true)
  assert.equal(json.scopes.credentials, false)
  assert.equal(json.provider, 'webdav')
  assert.equal(json.region, 'us-east-1')
})

await check('a method the route does not own is refused', async () => {
  const route = routes.get('/api/date-sync/status')
  const response = fakeResponse()
  await route.handler(fakeRequest('POST', '/api/date-sync/status', {}), response)
  assert.equal(response.status, 405)
})

await check('invalid configuration is rejected with a reason', async () => {
  const { response, json } = await call('POST', '/api/date-sync/config', { url: 'ftp://nope' })
  assert.equal(response.status, 400)
  assert.match(json.error, /http/i)
  assert.equal(fs.existsSync(configFile), false)
})

await check('saving writes config.json with owner-only mode and restarts the engine', async () => {
  const { response, json } = await call('POST', '/api/date-sync/config', {
    url: server.url,
    username: 'panel-user',
    password: 'panel-secret',
    remoteRoot: 'panel-root',
    pollIntervalMs: 3000,
    conflictPolicy: 'local-wins',
    deletions: 'propagate',
    watch: false,
    scopes: { skills: true, agentSkills: false, sessions: false, profile: true, credentials: false },
  })
  assert.equal(response.status, 200)
  assert.equal(json.config.remoteRoot, 'panel-root')
  assert.equal(json.status.configSource, 'file')
  assert.equal(json.status.remote.root, 'panel-root')
  assert.equal(json.status.remote.url, server.url)
  assert.equal(json.status.paused, false)
  const stat = await fsp.stat(configFile)
  if (process.platform !== 'win32') assert.equal(stat.mode & 0o777, 0o600)
  const saved = JSON.parse(await fsp.readFile(configFile, 'utf8'))
  assert.equal(saved.password, 'panel-secret')
  assert.equal(saved.remoteRoot, 'panel-root')
  assert.equal(saved.pollIntervalMs, 3000)
  assert.equal(saved.conflictPolicy, 'local-wins')
})

await check('file settings override the row config, and the password stays hidden', async () => {
  const status = await call('GET', '/api/date-sync/status')
  assert.equal(status.json.remote.root, 'panel-root')
  const config = await call('GET', '/api/date-sync/config')
  assert.equal(config.json.username, 'panel-user')
  assert.equal(config.json.passwordSource, 'file')
  assert.equal(config.json.hasPassword, true)
  assert.equal(Object.prototype.hasOwnProperty.call(config.json, 'password'), false)
  assert.equal(config.json.scopes.sessions, false)
})

await check('clearing the panel password falls back to the lower config layer', async () => {
  const { response } = await call('POST', '/api/date-sync/config', {
    clearPassword: true,
    passwordEnv: 'PANEL_TEST_PASSWORD_NOT_SET',
  })
  assert.equal(response.status, 200)
  const saved = JSON.parse(await fsp.readFile(configFile, 'utf8'))
  assert.equal(Object.prototype.hasOwnProperty.call(saved, 'password'), false)
  const config = await call('GET', '/api/date-sync/config')
  // The row config still carries a password, so clearing the panel copy falls
  // back to that lower layer instead of leaving no credential at all.
  assert.equal(config.json.hasPassword, true)
  assert.equal(config.json.passwordSource, 'config')
})

await check('action route runs a sync cycle and pause/resume', async () => {
  const sync = await call('POST', '/api/date-sync/action', { action: 'sync' })
  assert.equal(sync.response.status, 200)
  assert.equal(sync.json.action, 'sync')
  assert.ok(sync.json.status.lastSyncAt)
  const paused = await call('POST', '/api/date-sync/action', { action: 'pause' })
  assert.equal(paused.json.status.paused, true)
  const resumed = await call('POST', '/api/date-sync/action', { action: 'resume' })
  assert.equal(resumed.json.status.paused, false)
  const rejected = await call('POST', '/api/date-sync/action', { action: 'explode' })
  assert.equal(rejected.response.status, 400)
})

await check('S3 mode validates the bucket and switches the engine', async () => {
  const missing = await call('POST', '/api/date-sync/config', { provider: 's3' })
  assert.equal(missing.response.status, 400)
  assert.match(missing.json.error, /bucket/i)
  const saved = await call('POST', '/api/date-sync/config', {
    provider: 's3',
    url: 'http://127.0.0.1:9',
    bucket: 'panel-bucket',
    region: 'us-east-1',
  })
  assert.equal(saved.response.status, 200)
  assert.equal(saved.json.config.provider, 's3')
  assert.equal(saved.json.config.bucket, 'panel-bucket')
  assert.equal(saved.json.status.remote.provider, 's3')
  assert.equal(saved.json.status.remote.bucket, 'panel-bucket')
  const disk = JSON.parse(await fsp.readFile(configFile, 'utf8'))
  assert.equal(disk.provider, 's3')
  assert.equal(disk.bucket, 'panel-bucket')
})

await check('update status is exposed and a no-op update is safe', async () => {
  const status = await call('GET', '/api/date-sync/status')
  assert.equal(typeof status.json.update.current, 'string')
  assert.equal(status.json.update.available, false)
  const update = await call('POST', '/api/date-sync/update')
  assert.equal(update.response.status, 200)
  assert.equal(update.json.updated, false)
  const checked = await call('POST', '/api/date-sync/action', { action: 'check-update' })
  assert.equal(checked.response.status, 200)
  assert.equal(checked.json.action, 'check-update')
  assert.equal(typeof checked.json.status.update.current, 'string')
})

await check('a non-JSON body is refused before parsing', async () => {
  const route = routes.get('/api/date-sync/config')
  const request = Readable.from([Buffer.from('url=x')])
  request.method = 'POST'
  request.url = '/api/date-sync/config'
  request.headers = { 'content-type': 'text/plain' }
  const response = fakeResponse()
  await route.handler(request, response)
  assert.equal(response.status, 415)
})

await check('an unreachable server turns the badge state red', async () => {
  await server.close()
  serverClosed = true
  const result = await call('POST', '/api/date-sync/action', { action: 'sync' })
  assert.equal(result.response.status, 200)
  assert.equal(result.json.status.connection, 'error')
  assert.ok(result.json.status.connectionError)
})

for (const dispose of effects.reverse()) {
  try {
    await dispose()
  } catch {
    // Teardown must not mask assertions.
  }
}
if (!serverClosed) await server.close()
await fsp.rm(tmp, { recursive: true, force: true })

console.log(`\n${passed} checks passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const failure of failures) console.error(`- ${failure.name}: ${failure.error?.message ?? failure.error}`)
  process.exitCode = 1
}
