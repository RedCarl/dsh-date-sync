/**
 * End-to-end tests for the sync engine: two simulated machines talking to one
 * local WebDAV server, covering first sync, bidirectional updates, conflicts,
 * deletion propagation, remote-created files, patch validation, live-session
 * deferral, watcher-driven pushes, and idempotent cycles.
 *
 * Run with: node test/sync-test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { startWebdavServer } from './webdav-server.mjs'
import { resolveConfig } from '../lib/config.js'
import { SyncEngine } from '../lib/sync.js'
import { WebdavClient } from '../lib/webdav.js'

const USER = 'sync-user'
const PASS = 'sync-pass'
const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-date-sync-test-'))
const server = await startWebdavServer({ root: path.join(tmp, 'remote'), username: USER, password: PASS })
const client = new WebdavClient({ url: server.url, username: USER, password: PASS })

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

async function writeFile(abs, content, mtimeMs) {
  await fsp.mkdir(path.dirname(abs), { recursive: true })
  await fsp.writeFile(abs, content)
  if (mtimeMs !== undefined) {
    const seconds = mtimeMs / 1000
    await fsp.utimes(abs, seconds, seconds)
  }
}

async function readFile(abs) {
  return fsp.readFile(abs, 'utf8')
}

async function exists(abs) {
  try {
    await fsp.stat(abs)
    return true
  } catch {
    return false
  }
}

async function findFileContaining(root, needle) {
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()
    let entries
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) stack.push(abs)
      else if (entry.isFile()) {
        try {
          if ((await fsp.readFile(abs, 'utf8')).includes(needle)) return abs
        } catch {
          // Binary or unreadable file: not a conflict copy.
        }
      }
    }
  }
  return undefined
}

function machine(name, options = {}) {
  const base = path.join(tmp, name)
  const config = resolveConfig({
    url: server.url,
    username: USER,
    password: PASS,
    stateDir: path.join(base, 'state'),
    skillsPath: path.join(base, 'home', 'skills'),
    sessionsPath: path.join(base, 'home', 'sessions'),
    profilePath: path.join(base, 'profile'),
    scopes: { skills: true, agentSkills: false, sessions: true, profile: true, credentials: false },
    pollIntervalMs: 3_600_000,
    debounceMs: 100,
    settleMs: 0,
    watch: options.watch ?? false,
    syncOnStart: false,
    maxFileBytes: 10 * 1024 * 1024,
  })
  const engine = new SyncEngine({ config, isSessionActive: options.isSessionActive })
  engine.start()
  return { name, base, config, engine }
}

const sessionId = 'session-aaaaaaaa-1111-2222-3333-444444444444'
const sessionRel = `--tmp-project--/${sessionId}/session.v4.jsonl.zstd`
const validPatchA = "- id: agent-default-model\n  name: '@deepseek-ai/dsh-agent-default-model'\n  config:\n    provider: opencode-go\n    model: deepseek-v4.1-flash\n"

const A = machine('machine-a')
const B = machine('machine-b')
await A.engine.ready
await B.engine.ready

await writeFile(path.join(A.base, 'home/skills/writer/SKILL.md'), 'writer A v1\n')
await writeFile(path.join(A.base, 'home/skills/写作/SKILL.md'), '中文技能内容\n')
await writeFile(path.join(A.base, 'home/sessions', sessionRel), 'SESSION-A\n')
await writeFile(path.join(A.base, 'profile/cordis.patch.yml'), validPatchA)
await writeFile(path.join(A.base, 'profile/package.json'), JSON.stringify({
  name: 'dsh-profile-web',
  private: true,
  dependencies: {},
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
}, null, 2))
await fsp.mkdir(path.join(B.base, 'home/skills'), { recursive: true })

console.log('\nFirst sync')
await check('A pushes every scope', async () => {
  const status = await A.engine.requestSync('test')
  assert.equal(status.lastCycle.failed, 0, JSON.stringify(status.recent.slice(-3)))
  assert.ok(status.lastCycle.uploaded >= 5, `uploaded ${status.lastCycle.uploaded}`)
})

await check('B pulls skills, sessions, and profile', async () => {
  const status = await B.engine.requestSync('test')
  assert.equal(status.lastCycle.failed, 0, JSON.stringify(status.recent.slice(-3)))
  assert.ok(status.lastCycle.downloaded >= 5, `downloaded ${status.lastCycle.downloaded}`)
  assert.equal(await readFile(path.join(B.base, 'home/skills/writer/SKILL.md')), 'writer A v1\n')
  assert.equal(await readFile(path.join(B.base, 'home/skills/写作/SKILL.md')), '中文技能内容\n')
  assert.equal(await readFile(path.join(B.base, 'home/sessions', sessionRel)), 'SESSION-A\n')
  assert.equal(await readFile(path.join(B.base, 'profile/cordis.patch.yml')), validPatchA)
})

console.log('\nBidirectional updates')
await check('B pushes a new skill and A pulls it', async () => {
  await writeFile(path.join(B.base, 'home/skills/reader/SKILL.md'), 'reader B v1\n')
  let status = await B.engine.requestSync('test')
  assert.equal(status.lastCycle.uploaded, 1, JSON.stringify(status.lastCycle))
  status = await A.engine.requestSync('test')
  assert.equal(status.lastCycle.downloaded, 1, JSON.stringify(status.lastCycle))
  assert.equal(await readFile(path.join(A.base, 'home/skills/reader/SKILL.md')), 'reader B v1\n')
})

console.log('\nConflict resolution')
await check('newest local edit wins and the losing side is preserved', async () => {
  const skillAbsA = path.join(A.base, 'home/skills/writer/SKILL.md')
  const skillAbsB = path.join(B.base, 'home/skills/writer/SKILL.md')
  await writeFile(skillAbsA, 'A edit\n')
  await A.engine.requestSync('test') // remote now holds "A edit"
  await new Promise((resolve) => setTimeout(resolve, 1_500))
  await writeFile(skillAbsB, 'B edit\n') // strictly newer than A's upload
  const statusB = await B.engine.requestSync('test')
  assert.equal(statusB.lastCycle.conflicts, 1, JSON.stringify(statusB.lastCycle))
  const statusA = await A.engine.requestSync('test')
  assert.equal(await readFile(skillAbsA), 'B edit\n')
  assert.ok(statusA.lastCycle.downloaded >= 1, JSON.stringify(statusA.lastCycle))
  const saved = await findFileContaining(path.join(B.base, 'state', 'conflicts'), 'A edit')
  assert.ok(saved, 'the losing remote copy should be stored under conflicts/')
})

console.log('\nDeletion propagation')
await check('A deletes a skill, the remote copy goes away, B trashes its copy', async () => {
  await fsp.rm(path.join(A.base, 'home/skills/reader/SKILL.md'), { recursive: true })
  const statusA = await A.engine.requestSync('test')
  assert.equal(statusA.lastCycle.deletedRemote, 1, JSON.stringify(statusA.lastCycle))
  assert.equal(await client.stat('dsh-sync/skills/reader/SKILL.md'), undefined)
  const statusB = await B.engine.requestSync('test')
  assert.equal(statusB.lastCycle.trashedLocal, 1, JSON.stringify(statusB.lastCycle))
  assert.equal(await exists(path.join(B.base, 'home/skills/reader/SKILL.md')), false)
  const trashed = await findFileContaining(path.join(B.base, 'state', 'trash'), 'reader B v1')
  assert.ok(trashed, 'the local copy should be kept in trash/')
})

console.log('\nRemote-created files')
await check('a third writer appears and both machines pull it', async () => {
  await client.ensureCollection('dsh-sync/skills/remote')
  await client.put('dsh-sync/skills/remote/SKILL.md', Buffer.from('remote v1\n'))
  const statusA = await A.engine.requestSync('test')
  assert.equal(await readFile(path.join(A.base, 'home/skills/remote/SKILL.md')), 'remote v1\n')
  assert.ok(statusA.lastCycle.downloaded >= 1)
})

console.log('\nInvalid configuration protection')
await check('an empty remote patch is refused and never written locally', async () => {
  const before = await readFile(path.join(A.base, 'profile/cordis.patch.yml'))
  await client.put('dsh-sync/profile/cordis.patch.yml', Buffer.from('# only comments\n'))
  const status = await A.engine.requestSync('test')
  assert.equal(await readFile(path.join(A.base, 'profile/cordis.patch.yml')), before)
  assert.ok(status.lastCycle.failed >= 1, JSON.stringify(status.lastCycle))
  assert.match(status.lastError ?? '', /refused|patch/i)
})

await check('a valid replacement patch is applied', async () => {
  const next = `${validPatchA}- id: llm-pi-ai\n  name: '@deepseek-ai/dsh-llm-pi-ai'\n`
  await client.put('dsh-sync/profile/cordis.patch.yml', Buffer.from(next))
  const status = await A.engine.requestSync('test')
  assert.equal(status.lastCycle.failed, 0, JSON.stringify(status.recent.slice(-3)))
  assert.equal(await readFile(path.join(A.base, 'profile/cordis.patch.yml')), next)
})

console.log('\nLive-session deferral')
await check('a session open on this host is not overwritten', async () => {
  const localAbs = path.join(A.base, 'home/sessions', sessionRel)
  const before = await readFile(localAbs)
  A.engine.isSessionActive = (id) => id === sessionId
  try {
    await client.put(`dsh-sync/sessions/${sessionRel}`, Buffer.from('SESSION-REMOTE-CHANGED\n'))
    await A.engine.requestSync('test')
    assert.equal(await readFile(localAbs), before)
  } finally {
    A.engine.isSessionActive = undefined
  }
})

await check('a live session still uploads completed writes', async () => {
  const localAbs = path.join(A.base, 'home/sessions', sessionRel)
  // Consume the deferred remote change first, so this cycle has one side only.
  A.engine.isSessionActive = undefined
  await A.engine.requestSync('test')
  assert.equal(await readFile(localAbs), 'SESSION-REMOTE-CHANGED\n')
  A.engine.isSessionActive = (id) => id === sessionId
  try {
    await fsp.writeFile(localAbs, 'SESSION-A-APPENDED\n')
    const status = await A.engine.requestSync('test')
    assert.ok(status.lastCycle.uploaded >= 1, JSON.stringify(status.lastCycle))
    const remote = await client.get(`dsh-sync/sessions/${sessionRel}`)
    assert.equal(remote.body.toString('utf8'), 'SESSION-A-APPENDED\n')
  } finally {
    A.engine.isSessionActive = undefined
  }
})

console.log('\nIdempotence')
await check('a second cycle transfers nothing', async () => {
  // Consume the session update deferred during the live-session check.
  await A.engine.requestSync('test')
  await B.engine.requestSync('test')
  const statusA = await A.engine.requestSync('test')
  const statusB = await B.engine.requestSync('test')
  for (const status of [statusA, statusB]) {
    const { uploaded, downloaded, conflicts, deletedRemote, trashedLocal } = status.lastCycle
    assert.equal(uploaded + downloaded + conflicts + deletedRemote + trashedLocal, 0, JSON.stringify(status.lastCycle))
  }
})

console.log('\nWatcher-driven push')
await check('a local write reaches WebDAV without a manual sync', async () => {
  const W = machine('machine-w', { watch: true })
  await W.engine.ready
  await W.engine.requestSync('test')
  await writeFile(path.join(W.base, 'home/skills/live/SKILL.md'), 'watcher v1\n')
  const deadline = Date.now() + 8_000
  let found
  while (Date.now() < deadline) {
    found = await client.stat('dsh-sync/skills/live/SKILL.md')
    if (found) break
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  await W.engine.dispose()
  assert.ok(found, 'the watcher should push within the debounce window')
})

console.log('\nPolling pulls remote changes')
await check('a remote change arrives without a manual sync', async () => {
  const base = path.join(tmp, 'machine-p')
  const config = resolveConfig({
    url: server.url,
    username: USER,
    password: PASS,
    stateDir: path.join(base, 'state'),
    skillsPath: path.join(base, 'home', 'skills'),
    sessionsPath: path.join(base, 'home', 'sessions'),
    profilePath: path.join(base, 'profile'),
    scopes: { skills: true, agentSkills: false, sessions: false, profile: false },
    pollIntervalMs: 1000,
    debounceMs: 100,
    settleMs: 0,
    watch: false,
    syncOnStart: false,
  })
  const engine = new SyncEngine({ config })
  engine.start()
  await engine.ready
  await engine.requestSync('test')
  try {
    await client.put('dsh-sync/skills/polled/SKILL.md', Buffer.from('polled v1\n'))
    const target = path.join(base, 'home/skills/polled/SKILL.md')
    const deadline = Date.now() + 8_000
    while (Date.now() < deadline) {
      if (await exists(target)) break
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
    assert.ok(await exists(target), 'polling should discover the remote file')
    assert.equal(await readFile(target), 'polled v1\n')
  } finally {
    await engine.dispose()
  }
})

console.log('\nStartup safety')
await check('a missing local root with synced state is not treated as mass deletion', async () => {
  const C = machine('machine-c')
  await C.engine.ready
  await C.engine.requestSync('test')
  assert.ok(await exists(path.join(C.base, 'home/skills/writer/SKILL.md')))
  await fsp.rename(path.join(C.base, 'home/skills'), path.join(C.base, 'home/skills-offline'))
  const before = (await client.stat('dsh-sync/skills/writer/SKILL.md'))?.etag
  const status = await C.engine.requestSync('test')
  const after = (await client.stat('dsh-sync/skills/writer/SKILL.md'))?.etag
  assert.equal(after, before)
  assert.equal(status.lastCycle.deletedRemote, 0, JSON.stringify(status.lastCycle))
  assert.ok(status.recent.some((entry) => /missing but already synced/.test(entry.message)))
  await C.engine.dispose()
})

for (const machineInstance of [A, B]) await machineInstance.engine.dispose()
await server.close()
await fsp.rm(tmp, { recursive: true, force: true })

console.log(`\n${passed} checks passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const failure of failures) console.error(`- ${failure.name}: ${failure.error?.message ?? failure.error}`)
  process.exitCode = 1
}
