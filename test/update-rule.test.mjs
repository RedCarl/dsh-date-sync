/**
 * Enforces the plugin update rule: update checks and update downloads only use
 * the private npm registry (https://npm.carljoy.cn/). No GitHub API, GitHub
 * Releases, or GitHub-hosted tarballs may return as an update path.
 *
 * This file is copied verbatim into every plugin of this family and runs in CI.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REGISTRY = 'https://npm.carljoy.cn/'

/** Files that decide the update path; docs and metadata are not scanned. */
function updateFiles() {
  const files = ['index.js', 'client.js', 'cordis.patch.yml', '.github/workflows/release.yml']
    .map((file) => path.join(ROOT, file))
    .filter((file) => existsSync(file))
  const lib = path.join(ROOT, 'lib')
  if (existsSync(lib)) {
    for (const name of readdirSync(lib)) {
      if (name.endsWith('.js')) files.push(path.join(lib, name))
    }
  }
  return files
}

const FORBIDDEN = [
  [/api\.github\.com/iu, 'GitHub API'],
  [/releases\/(?:latest|download)/iu, 'GitHub Release download'],
  [/raw\.githubusercontent\.com/iu, 'raw.githubusercontent.com'],
  [/gh release (?:create|upload|view|delete)/iu, 'gh release'],
  [/upload-release-asset|softprops\/action-gh-release/iu, 'GitHub release action'],
]

test('no source file reaches GitHub for versions or packages', () => {
  const files = updateFiles()
  assert.ok(files.length >= 3, 'expected the plugin sources to be present')
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    for (const [pattern, label] of FORBIDDEN) {
      assert.doesNotMatch(text, pattern, `${path.relative(ROOT, file)} must not use ${label}`)
    }
  }
})

test('the shared updater checks and installs from the private registry', () => {
  const module = readFileSync(path.join(ROOT, 'lib/update.js'), 'utf8')
  assert.match(module, /https:\/\/npm\.carljoy\.cn\//u, 'the updater must target the private registry')
  assert.match(module, /installBundle\(/u, 'packaged updates must go through pluginManager.installBundle')
  assert.match(module, /dist-tags/u, 'update checks must read the packument dist-tags')
  assert.doesNotMatch(module, /github/iu, 'the updater must not mention GitHub')
})

test('the published tarball ships the shared updater', () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  const files = Array.isArray(pkg.files) ? pkg.files : []
  assert.ok(
    files.some((entry) => entry === 'lib' || entry.startsWith('lib/')),
    'package.json files must include lib/ so lib/update.js is published',
  )
})

test('the release workflow publishes to the registry instead of GitHub Releases', () => {
  const workflow = readFileSync(path.join(ROOT, '.github/workflows/release.yml'), 'utf8')
  assert.match(workflow, /npm publish/u, 'release must publish to npm')
  assert.match(workflow, /npm\.carljoy\.cn/u, 'release must publish to the private registry')
  assert.match(workflow, /NPM_TOKEN/u, 'release must read the registry token from NPM_TOKEN')
  assert.doesNotMatch(workflow, /gh release|softprops|upload-release-asset/iu, 'release must not touch GitHub Releases')
})
