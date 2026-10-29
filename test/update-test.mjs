import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  UPDATE_REGISTRY,
  UpdateError,
  applyUpdate,
  checkForUpdate,
  compareVersions,
  gitPull,
  isNewer,
  latestVersion,
  packageUrl,
  parseVersion,
  readPackageVersion,
  resolveInstall,
} from '../lib/update.js'

const here = path.dirname(fileURLToPath(import.meta.url))

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `dsh-update-${prefix}-`))
}

function packument(name, latest, extra = {}) {
  return {
    name,
    'dist-tags': { latest },
    versions: {
      [latest]: {
        name,
        version: latest,
        engines: { dsh: '>=0.2.0' },
        dist: { tarball: `https://npm.carljoy.cn/${name}/-/${name.split('/').pop()}-${latest}.tgz`, integrity: 'sha512-test' },
      },
    },
    time: { [latest]: '2026-10-29T00:00:00.000Z' },
    ...extra,
  }
}

test('compares SemVer precedence, including prereleases', () => {
  assert.deepEqual(parseVersion('v2.1.0'), { numbers: [2, 1, 0], prerelease: [] })
  assert.deepEqual(parseVersion('2.0.0-beta.1'), { numbers: [2, 0, 0], prerelease: ['beta', '1'] })
  assert.equal(compareVersions('2.1.0', '2.0.9'), 1)
  assert.equal(compareVersions('2.0.0', '2.0.0'), 0)
  assert.equal(compareVersions('v1.9.9', '2.0.0'), -1)
  assert.equal(compareVersions('2.0.0', '2.0.0-beta.1'), 1)
  assert.equal(compareVersions('2.0.0-beta.2', '2.0.0-beta.10'), -1)
  assert.equal(compareVersions('2.0.0-alpha', '2.0.0-alpha.1'), -1)
  assert.equal(compareVersions('not-a-version', '1.0.0'), 0)
  assert.equal(isNewer('2.1.0', '2.0.0'), true)
  assert.equal(isNewer('2.0.0', '2.1.0'), false)
})

test('reads the running manifest version from a module URL, a directory, or a file', () => {
  const expected = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8')).version
  assert.equal(readPackageVersion(new URL('../index.js', import.meta.url)), expected)
  assert.equal(readPackageVersion(new URL('../index.js', import.meta.url).href), expected)
  assert.equal(readPackageVersion(path.join(here, '..')), expected)
  assert.equal(readPackageVersion(path.join(here, '..', 'package.json')), expected)
  assert.equal(readPackageVersion(new URL('file:///definitely/missing/index.js')), undefined)
})

test('picks dist-tags.latest, then the highest stable version, then the highest version', () => {
  assert.equal(latestVersion({ 'dist-tags': { latest: '3.0.0' }, versions: { '2.0.0': {}, '3.0.0': {} } }), '3.0.0')
  assert.equal(latestVersion({ versions: { '2.0.0': {}, '2.1.0': {}, '3.0.0-rc.1': {} } }), '2.1.0')
  assert.equal(latestVersion({ versions: { '2.0.0-rc.1': {}, '2.0.0-rc.2': {} } }), '2.0.0-rc.2')
  assert.equal(latestVersion({}), undefined)
})

test('encodes scoped package names the way Verdaccio expects', () => {
  assert.equal(packageUrl('@local/dsh-x', 'https://npm.carljoy.cn'), 'https://npm.carljoy.cn/@local%2fdsh-x')
  assert.equal(packageUrl('plain', 'https://npm.carljoy.cn/'), 'https://npm.carljoy.cn/plain')
})

test('reports an available update with both canonical names and legacy aliases', async () => {
  const name = '@test/update-alias'
  const requested = []
  const state = await checkForUpdate({
    packageName: name,
    currentVersion: '1.0.0',
    mode: 'package',
    installable: true,
    fetchImpl: async (url, options) => {
      requested.push({ url, options })
      return { ok: true, status: 200, async json() { return packument(name, '1.1.0') } }
    },
  })
  assert.equal(requested.length, 1)
  assert.match(requested[0].url, /@test%2fupdate-alias$/)
  assert.equal(requested[0].options.headers.accept, 'application/json')
  assert.equal(state.ok, true)
  assert.equal(state.current, '1.0.0')
  assert.equal(state.latest, '1.1.0')
  assert.equal(state.currentVersion, '1.0.0')
  assert.equal(state.latestVersion, '1.1.0')
  assert.equal(state.updateAvailable, true)
  assert.equal(state.available, true)
  assert.equal(state.restartRequired, false)
  assert.equal(state.installable, true)
  assert.equal(state.publishedAt, '2026-10-29T00:00:00.000Z')
  assert.equal(state.release.version, '1.1.0')
  assert.equal(state.releaseUrl, state.release.url)
  assert.equal(state.tarball, 'https://npm.carljoy.cn/@test/update-alias/-/update-alias-1.1.0.tgz')
  assert.equal(state.cacheHit, false)
})

test('reuses a check, and force bypasses the cache', async () => {
  const name = '@test/update-cache'
  let calls = 0
  const fetchImpl = async () => {
    calls += 1
    return { ok: true, status: 200, async json() { return packument(name, '2.0.0') } }
  }
  const options = { packageName: name, currentVersion: '1.0.0', fetchImpl }
  const first = await checkForUpdate(options)
  const second = await checkForUpdate(options)
  const forced = await checkForUpdate({ ...options, force: true })
  assert.equal(first.cacheHit, false)
  assert.equal(second.cacheHit, true)
  assert.equal(forced.cacheHit, false)
  assert.equal(calls, 2)
})

test('turns registry failures into an ok:false state instead of throwing', async () => {
  const name = '@test/update-missing'
  const state = await checkForUpdate({
    packageName: name,
    currentVersion: '1.0.0',
    fetchImpl: async () => ({ ok: false, status: 404, async json() { return {} } }),
  })
  assert.equal(state.ok, false)
  assert.equal(state.reason, 'not-found')
  assert.match(state.error, /注册表中没有/)
  assert.equal(state.updateAvailable, false)
  assert.equal(state.available, false)
})

test('detects a pending restart when the installed copy is newer than the running module', async () => {
  const name = '@test/update-restart'
  const state = await checkForUpdate({
    packageName: name,
    currentVersion: '1.0.0',
    installedVersion: '1.1.0',
    fetchImpl: async () => ({ ok: true, status: 200, async json() { return packument(name, '1.1.0') } }),
  })
  assert.equal(state.updateAvailable, false)
  assert.equal(state.restartRequired, true)
})

test('classifies link and package installs from the profile manifest', () => {
  const profileDir = tempDir('profile')
  fs.writeFileSync(
    path.join(profileDir, 'package.json'),
    JSON.stringify({ name: 'profile', dsh: { profile: { bundles: [] } }, dependencies: { '@test/linked': 'link:/tmp/linked' } }),
  )

  const linkedDir = tempDir('linked')
  fs.writeFileSync(path.join(linkedDir, 'index.js'), '')
  const linked = resolveInstall({ metaUrl: pathToFileURL(path.join(linkedDir, 'index.js')).href, packageName: '@test/linked' })
  assert.equal(linked.mode, 'link')
  assert.equal(linked.packageDir, linkedDir)

  const installedDir = path.join(profileDir, 'node_modules', '@test', 'installed')
  fs.mkdirSync(installedDir, { recursive: true })
  fs.writeFileSync(path.join(installedDir, 'index.js'), '')
  const installed = resolveInstall({ metaUrl: pathToFileURL(path.join(installedDir, 'index.js')).href, packageName: '@test/installed' })
  assert.equal(installed.mode, 'package')
  assert.equal(installed.profileDir, profileDir)
})

test('refuses a git update outside a clean checkout', async () => {
  const notGit = tempDir('not-git')
  await assert.rejects(gitPull(notGit), (error) => error instanceof UpdateError && error.reason === 'not-git')

  const repo = tempDir('dirty')
  execFileSync('git', ['init', '-q'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo })
  fs.writeFileSync(path.join(repo, 'index.js'), 'before')
  execFileSync('git', ['add', '.'], { cwd: repo })
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: repo })
  fs.writeFileSync(path.join(repo, 'index.js'), 'after')
  await assert.rejects(gitPull(repo), (error) => error instanceof UpdateError && error.reason === 'dirty')
})

test('installs an exact registry version through the plugin manager', async () => {
  const calls = []
  const result = await applyUpdate({
    packageName: '@test/package-mode',
    targetVersion: '2.0.0',
    mode: 'package',
    pluginManager: {
      async installBundle(spec, options) {
        calls.push({ spec, options })
        return { application: 'restart-required', version: '2.0.0' }
      },
    },
  })
  assert.deepEqual(calls, [{ spec: '@test/package-mode@2.0.0', options: { registry: UPDATE_REGISTRY } }])
  assert.equal(result.method, 'package')
  assert.equal(result.restartRequired, true)
  assert.equal(result.to, '2.0.0')
})

test('falls back to the registry tarball when HMR refuses an installed package', async () => {
  const calls = []
  const tarball = 'https://npm.carljoy.cn/@test/package-hmr/-/package-hmr-2.0.0.tgz'
  const result = await applyUpdate({
    packageName: '@test/package-hmr',
    targetVersion: '2.0.0',
    mode: 'package',
    tarballUrl: tarball,
    pluginManager: {
      async installBundle(spec, options) {
        calls.push({ spec, options })
        if (spec.startsWith('@test/')) {
          const error = new Error('package is already installed')
          error.code = 'already-installed'
          throw error
        }
        return { application: 'applied', version: '2.0.0' }
      },
    },
  })
  assert.deepEqual(calls, [
    { spec: '@test/package-hmr@2.0.0', options: { registry: UPDATE_REGISTRY } },
    { spec: tarball, options: { registry: UPDATE_REGISTRY } },
  ])
  assert.equal(result.application, 'applied')
  assert.equal(result.restartRequired, false)
  assert.equal(result.to, '2.0.0')
})

test('returns a refused installation with its diagnostics instead of throwing', async () => {
  const result = await applyUpdate({
    packageName: '@test/package-refused',
    targetVersion: '3.0.0',
    mode: 'package',
    pluginManager: {
      async installBundle() {
        return { application: 'failed', stage: 'activation', error: { code: 'incompatible-version', message: 'incompatible' }, pendingBuilds: ['esbuild'] }
      },
    },
  })
  assert.equal(result.application, 'failed')
  assert.equal(result.changed, false)
  assert.equal(result.error.message, 'incompatible')
  assert.deepEqual(result.pendingBuilds, ['esbuild'])
})
