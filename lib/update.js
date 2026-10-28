/**
 * Version checks and self-update helpers.
 *
 * The release pipeline publishes `dsh-date-sync-<version>.tgz` on every `v*`
 * tag. Packaged installs update through `pluginManager.installBundle`; a local
 * `link:` checkout updates with a fast-forward `git pull`. Both are triggered
 * by the panel, never silently.
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export const UPDATE_REPO = 'RedCarl/dsh-date-sync'

export function normalizeVersion(value) {
  return String(value ?? '').trim().replace(/^v/i, '')
}

function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(normalizeVersion(value))
  if (!match) return undefined
  return {
    numbers: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ?? '',
  }
}

/** Semver-ish comparison; returns 1 when a > b, -1 when a < b, 0 when equal. */
export function compareVersions(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (!a || !b) return 0
  for (let index = 0; index < 3; index += 1) {
    if (a.numbers[index] !== b.numbers[index]) return a.numbers[index] > b.numbers[index] ? 1 : -1
  }
  if (a.prerelease === b.prerelease) return 0
  if (!a.prerelease) return 1
  if (!b.prerelease) return -1
  return a.prerelease < b.prerelease ? -1 : 1
}

/** Version declared by the plugin's own package.json. */
export function readPackageVersion(packageDir) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'))
    return typeof manifest.version === 'string' ? manifest.version : undefined
  } catch {
    return undefined
  }
}

/**
 * Decide how this copy was installed. A `link:` dependency keeps the source
 * directory; everything else is a packaged install.
 */
export function detectInstallMode(profileDir, packageName) {
  if (!profileDir) return 'package'
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'))
    const spec = manifest?.dependencies?.[packageName]
    if (typeof spec === 'string' && spec.startsWith('link:')) return 'link'
  } catch {
    // Unknown manifest: treat it as a packaged install.
  }
  return 'package'
}

/**
 * Read the newest GitHub release. The release workflow attaches the tgz asset,
 * whose browser URL is used by the packaged update path.
 */
export async function checkLatestRelease(options = {}) {
  const repo = options.repo ?? UPDATE_REPO
  const apiBase = options.apiBase ?? 'https://api.github.com'
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const response = await fetchImpl(`${apiBase}/repos/${repo}/releases/latest`, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'dsh-date-sync-updater',
    },
    signal: AbortSignal.timeout(options.timeoutMs ?? 12_000),
  })
  if (!response.ok) throw new Error(`GitHub API returned HTTP ${response.status}`)
  const release = await response.json()
  const tag = typeof release.tag_name === 'string' ? release.tag_name : ''
  const version = normalizeVersion(tag)
  if (!/^\d+\.\d+\.\d+/.test(version)) throw new Error(`unexpected release tag: ${tag || '(empty)'}`)
  const asset = Array.isArray(release.assets)
    ? release.assets.find((entry) => typeof entry?.name === 'string' && entry.name.endsWith('.tgz'))
    : undefined
  return {
    tag,
    version,
    url: typeof release.html_url === 'string' ? release.html_url : undefined,
    publishedAt: release.published_at,
    assetName: asset?.name,
    assetUrl: asset?.browser_download_url,
  }
}

/** Fast-forward a linked checkout. Refuses when the worktree is dirty. */
export async function gitUpdate(packageDir) {
  const status = await execFileAsync('git', ['-C', packageDir, 'status', '--porcelain'], { timeout: 20_000 })
  if (status.stdout.trim()) throw new Error('工作区有未提交的改动，已取消更新')
  await execFileAsync('git', ['-C', packageDir, 'pull', '--ff-only'], { timeout: 120_000 })
  return readPackageVersion(packageDir)
}
