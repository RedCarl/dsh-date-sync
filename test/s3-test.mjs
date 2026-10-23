/**
 * End-to-end tests for the S3 backend: SigV4 signing (verified by the test
 * server), ListObjectsV2 pagination, first sync, bidirectional updates,
 * deletion propagation, conditional writes, and idempotence.
 *
 * Run with: node test/s3-test.mjs
 */
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { startS3Server } from './s3-server.mjs'
import { resolveConfig } from '../lib/config.js'
import { SyncEngine } from '../lib/sync.js'
import { S3Client } from '../lib/s3.js'

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-date-sync-s3-'))
const server = await startS3Server({
  bucket: 'sync-bucket',
  accessKeyId: 'AKIATESTKEY',
  secretAccessKey: 'test-secret-key',
  region: 'us-east-1',
  pageSize: 2,
})

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

function machine(name) {
  const base = path.join(tmp, name)
  const config = resolveConfig({
    provider: 's3',
    url: server.url,
    bucket: server.bucket,
    region: 'us-east-1',
    username: 'AKIATESTKEY',
    password: 'test-secret-key',
    stateDir: path.join(base, 'state'),
    skillsPath: path.join(base, 'home', 'skills'),
    sessionsPath: path.join(base, 'home', 'sessions'),
    profilePath: path.join(base, 'profile'),
    scopes: { skills: true, agentSkills: false, sessions: true, profile: true, credentials: false },
    pollIntervalMs: 3_600_000,
    settleMs: 0,
    watch: false,
    syncOnStart: false,
  })
  const engine = new SyncEngine({ config })
  engine.start()
  return { name, base, config, engine }
}

async function write(abs, content) {
  await fsp.mkdir(path.dirname(abs), { recursive: true })
  await fsp.writeFile(abs, content)
}

const sessionId = 'session-bbbbbbbb-1111-2222-3333-444444444444'
const sessionRel = `--tmp-project--/${sessionId}/session.v4.jsonl.zstd`
const patch = "- id: demo\n  name: demo\n"

const A = machine('a')
const B = machine('b')
await A.engine.ready
await B.engine.ready

console.log('\nS3 first sync')
await check('A uploads skills, sessions, and profile', async () => {
  await write(path.join(A.base, 'home/skills/writer/SKILL.md'), 'writer A v1\n')
  await write(path.join(A.base, 'home/skills/中文/SKILL.md'), '中文技能\n')
  await write(path.join(A.base, 'home/sessions', sessionRel), 'SESSION-A\n')
  await write(path.join(A.base, 'profile/cordis.patch.yml'), patch)
  await write(path.join(A.base, 'profile/package.json'), JSON.stringify({ name: 'p', dsh: { profile: { bundles: [] } } }))
  const status = await A.engine.requestSync('test')
  assert.equal(status.lastCycle.failed, 0, JSON.stringify(status.recent.slice(-3)))
  assert.ok(status.lastCycle.uploaded >= 5, JSON.stringify(status.lastCycle))
  assert.equal(status.remote.provider, 's3')
  assert.equal(status.remote.bucket, 'sync-bucket')
  assert.ok(server.objects.has('dsh-sync/skills/writer/SKILL.md'))
  assert.ok(server.objects.has('dsh-sync/profile/cordis.patch.yml'))
})

await check('B pulls everything through paginated listing', async () => {
  const status = await B.engine.requestSync('test')
  assert.equal(status.lastCycle.failed, 0, JSON.stringify(status.recent.slice(-3)))
  assert.ok(status.lastCycle.downloaded >= 5, JSON.stringify(status.lastCycle))
  assert.equal(await fsp.readFile(path.join(B.base, 'home/skills/writer/SKILL.md'), 'utf8'), 'writer A v1\n')
  assert.equal(await fsp.readFile(path.join(B.base, 'home/skills/中文/SKILL.md'), 'utf8'), '中文技能\n')
  assert.equal(await fsp.readFile(path.join(B.base, 'home/sessions', sessionRel), 'utf8'), 'SESSION-A\n')
  assert.equal(await fsp.readFile(path.join(B.base, 'profile/cordis.patch.yml'), 'utf8'), patch)
})

console.log('\nBidirectional')
await check('B adds a skill and A pulls it', async () => {
  await write(path.join(B.base, 'home/skills/reader/SKILL.md'), 'reader B v1\n')
  let status = await B.engine.requestSync('test')
  assert.equal(status.lastCycle.uploaded, 1, JSON.stringify(status.lastCycle))
  status = await A.engine.requestSync('test')
  assert.equal(status.lastCycle.downloaded, 1, JSON.stringify(status.lastCycle))
  assert.equal(await fsp.readFile(path.join(A.base, 'home/skills/reader/SKILL.md'), 'utf8'), 'reader B v1\n')
})

console.log('\nDeletion')
await check('A deletes a skill and B trashes its copy', async () => {
  await fsp.rm(path.join(A.base, 'home/skills/reader'), { recursive: true })
  const statusA = await A.engine.requestSync('test')
  assert.equal(statusA.lastCycle.deletedRemote, 1, JSON.stringify(statusA.lastCycle))
  assert.equal(server.objects.has('dsh-sync/skills/reader/SKILL.md'), false)
  const statusB = await B.engine.requestSync('test')
  assert.equal(statusB.lastCycle.trashedLocal, 1, JSON.stringify(statusB.lastCycle))
  await assert.rejects(fsp.stat(path.join(B.base, 'home/skills/reader/SKILL.md')))
})

console.log('\nThird-party object and pagination')
await check('an object written directly is pulled and listing spans pages', async () => {
  const direct = new S3Client({
    endpoint: server.url,
    bucket: server.bucket,
    accessKeyId: 'AKIATESTKEY',
    secretAccessKey: 'test-secret-key',
    region: 'us-east-1',
  })
  await direct.put('dsh-sync/skills/direct/SKILL.md', Buffer.from('direct v1\n'))
  // More than the server's two-object page size, so walk must paginate.
  for (let index = 0; index < 5; index += 1) {
    await write(path.join(A.base, `home/skills/page-${index}/SKILL.md`), `page ${index}\n`)
  }
  const status = await A.engine.requestSync('test')
  assert.equal(status.lastCycle.failed, 0, JSON.stringify(status.recent.slice(-3)))
  assert.equal(await fsp.readFile(path.join(A.base, 'home/skills/direct/SKILL.md'), 'utf8'), 'direct v1\n')
  for (let index = 0; index < 5; index += 1) {
    assert.ok(server.objects.has(`dsh-sync/skills/page-${index}/SKILL.md`))
  }
})

console.log('\nConditional writes and idempotence')
await check('a conditional create refuses to overwrite an existing object', async () => {
  const direct = new S3Client({
    endpoint: server.url,
    bucket: server.bucket,
    accessKeyId: 'AKIATESTKEY',
    secretAccessKey: 'test-secret-key',
    region: 'us-east-1',
  })
  await assert.rejects(
    direct.put('dsh-sync/skills/writer/SKILL.md', Buffer.from('clobber\n'), { ifNoneMatch: '*' }),
    (error) => error.status === 412,
  )
})

await check('a second cycle transfers nothing', async () => {
  await A.engine.requestSync('test')
  await B.engine.requestSync('test')
  const statusA = await A.engine.requestSync('test')
  const statusB = await B.engine.requestSync('test')
  for (const status of [statusA, statusB]) {
    const { uploaded, downloaded, conflicts, deletedRemote, trashedLocal } = status.lastCycle
    assert.equal(uploaded + downloaded + conflicts + deletedRemote + trashedLocal, 0, JSON.stringify(status.lastCycle))
  }
})

await A.engine.dispose()
await B.engine.dispose()
await server.close()
await fsp.rm(tmp, { recursive: true, force: true })

console.log(`\n${passed} checks passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const failure of failures) console.error(`- ${failure.name}: ${failure.error?.message ?? failure.error}`)
  process.exitCode = 1
}
