import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  checkLatestRelease,
  compareVersions,
  detectInstallMode,
  gitUpdate,
  readPackageVersion,
} from '../lib/update.js'

let passed = 0

async function check(name, operation) {
  await operation()
  passed += 1
  console.log(`  ok  ${name}`)
}

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

await check('compareVersions orders releases and prereleases', () => {
  assert.equal(compareVersions('1.4.0', '1.3.2'), 1)
  assert.equal(compareVersions('v1.3.2', '1.3.2'), 0)
  assert.equal(compareVersions('1.4.0-beta', '1.4.0'), -1)
  assert.equal(compareVersions('1.4.0', '1.4.0'), 0)
})

await check('checkLatestRelease parses the release and its tgz asset', async () => {
  let requested
  const result = await checkLatestRelease({
    fetchImpl: async (url) => {
      requested = url
      return {
        ok: true,
        json: async () => ({
          tag_name: 'v1.4.0',
          html_url: 'https://github.com/RedCarl/dsh-date-sync/releases/tag/v1.4.0',
          published_at: '2026-10-28T00:00:00Z',
          assets: [
            { name: 'notes.txt', browser_download_url: 'https://example.test/notes.txt' },
            { name: 'dsh-date-sync-1.4.0.tgz', browser_download_url: 'https://example.test/dsh-date-sync-1.4.0.tgz' },
          ],
        }),
      }
    },
  })
  assert.match(requested, /repos\/RedCarl\/dsh-date-sync\/releases\/latest$/)
  assert.equal(result.version, '1.4.0')
  assert.equal(result.assetName, 'dsh-date-sync-1.4.0.tgz')
  assert.equal(result.assetUrl, 'https://example.test/dsh-date-sync-1.4.0.tgz')
})

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-date-sync-update-'))
try {
  await check('detectInstallMode recognizes link checkouts', async () => {
    const profile = path.join(tmp, 'profile')
    await fsp.mkdir(profile, { recursive: true })
    await fsp.writeFile(path.join(profile, 'package.json'), JSON.stringify({ dependencies: { 'dsh-date-sync': 'link:/tmp/dsh-date-sync' } }))
    assert.equal(detectInstallMode(profile, 'dsh-date-sync'), 'link')
    await fsp.writeFile(path.join(profile, 'package.json'), JSON.stringify({ dependencies: { 'dsh-date-sync': '^1.3.2' } }))
    assert.equal(detectInstallMode(profile, 'dsh-date-sync'), 'package')
  })

  await check('gitUpdate fast-forwards a clean checkout and refuses a dirty one', async () => {
    const origin = path.join(tmp, 'origin.git')
    const seed = path.join(tmp, 'seed')
    const clone = path.join(tmp, 'clone')
    git(tmp, 'init', '--bare', origin)
    git(origin, 'symbolic-ref', 'HEAD', 'refs/heads/main')
    git(tmp, 'init', '-b', 'main', seed)
    git(seed, 'config', 'user.email', 'test@example.com')
    git(seed, 'config', 'user.name', 'Test')
    await fsp.writeFile(path.join(seed, 'package.json'), JSON.stringify({ name: 'demo', version: '1.0.0' }))
    git(seed, 'add', '.')
    git(seed, 'commit', '-m', 'v1')
    git(seed, 'remote', 'add', 'origin', origin)
    git(seed, 'push', '-u', 'origin', 'main')

    git(tmp, 'clone', origin, clone)
    await fsp.writeFile(path.join(seed, 'package.json'), JSON.stringify({ name: 'demo', version: '1.0.1' }))
    git(seed, 'add', '.')
    git(seed, 'commit', '-m', 'v2')
    git(seed, 'push', 'origin', 'main')

    assert.equal(await gitUpdate(clone), '1.0.1')
    assert.equal(readPackageVersion(clone), '1.0.1')

    await fsp.writeFile(path.join(clone, 'dirty.txt'), 'dirty\n')
    await assert.rejects(gitUpdate(clone), /未提交的改动/)
  })
} finally {
  await fsp.rm(tmp, { recursive: true, force: true })
}

console.log(`\n${passed} checks passed`)
