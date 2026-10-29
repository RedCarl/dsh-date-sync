/**
 * Unified update checking and self-update for DSH plugins published to the
 * private registry (https://npm.carljoy.cn/).
 *
 * This file is copied verbatim into every plugin of this family
 * (ccswitch-hub, balance-panel, mobile-shell, date-sync). Keep the copies
 * identical; each repository runs the shared cases in test/update.test.mjs.
 *
 * Node builtins and the global fetch only: a plugin installed from a local
 * directory cannot resolve packages from the DSH installation.
 *
 * @module dsh-plugin-update
 */
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Registry that hosts every plugin of this family. */
export const UPDATE_REGISTRY = 'https://npm.carljoy.cn/'
/** Successful checks are reused for this long unless `force` is set. */
export const UPDATE_CACHE_MS = 10 * 60 * 1000
/** Deadline for one packument request. */
export const UPDATE_TIMEOUT_MS = 10_000

const cache = new Map()

/** A failure with a machine-readable `reason` for callers that localize text. */
export class UpdateError extends Error {
  constructor(message, reason = 'unknown') {
    super(message)
    this.name = 'UpdateError'
    this.reason = reason
  }
}

/** Strip a leading `v` and surrounding whitespace. */
export function normalizeVersion(value) {
  return String(value ?? '').trim().replace(/^v/i, '')
}

/** Parse an exact SemVer version, including a prerelease, or return undefined. */
export function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(normalizeVersion(value))
  if (match === null) return undefined
  return {
    numbers: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
  }
}

function comparePrerelease(left, right) {
  if (left.length === 0 && right.length === 0) return 0
  if (left.length === 0) return 1
  if (right.length === 0) return -1
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const a = left[index]
    const b = right[index]
    if (a === undefined) return -1
    if (b === undefined) return 1
    const numericA = /^\d+$/.test(a)
    const numericB = /^\d+$/.test(b)
    if (numericA && numericB) {
      const difference = Number(a) - Number(b)
      if (difference !== 0) return difference > 0 ? 1 : -1
      continue
    }
    if (numericA !== numericB) return numericA ? -1 : 1
    if (a !== b) return a < b ? -1 : 1
  }
  return 0
}

/** SemVer precedence: positive when `left` is newer, negative when older, 0 when equal. */
export function compareVersions(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (a === undefined || b === undefined) return 0
  for (let index = 0; index < 3; index += 1) {
    if (a.numbers[index] !== b.numbers[index]) return a.numbers[index] > b.numbers[index] ? 1 : -1
  }
  return comparePrerelease(a.prerelease, b.prerelease)
}

/** Whether `candidate` is newer than `current`. */
export function isNewer(candidate, current) {
  return compareVersions(candidate, current) > 0
}

/**
 * Read the version from a package directory, a package.json path, or a module
 * URL (`import.meta.url`).
 */
export function readPackageVersion(target) {
  try {
    let file
    if (typeof target === 'string') {
      if (target.startsWith('file:')) file = new URL('./package.json', target)
      else if (target.endsWith('.json')) file = target
      else if (/\.[cm]?js$/.test(target)) file = join(dirname(target), 'package.json')
      else file = join(target, 'package.json')
    } else if (target instanceof URL) file = new URL('./package.json', target)
    else return undefined
    const manifest = JSON.parse(readFileSync(file, 'utf8'))
    return typeof manifest.version === 'string' ? manifest.version : undefined
  } catch {
    return undefined
  }
}

/** Packument URL for a package, encoding the scope separator Verdaccio expects. */
export function packageUrl(packageName, registry = UPDATE_REGISTRY) {
  const base = registry.endsWith('/') ? registry : `${registry}/`
  const encoded = packageName.startsWith('@') ? packageName.replace('/', '%2f') : encodeURIComponent(packageName)
  return `${base}${encoded}`
}

/** Read a full npm packument from the registry. */
export async function fetchPackument({
  packageName,
  registry = UPDATE_REGISTRY,
  fetchImpl = globalThis.fetch,
  timeoutMs = UPDATE_TIMEOUT_MS,
  userAgent = `dsh-plugin/${packageName}`,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new UpdateError('当前运行环境没有 fetch', 'unsupported')
  const url = packageUrl(packageName, registry)
  let response
  try {
    response = await fetchImpl(url, {
      headers: { accept: 'application/json', 'user-agent': userAgent },
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    const timeout = error?.name === 'TimeoutError' || error?.name === 'AbortError'
    throw new UpdateError(timeout ? `检查更新超时（${timeoutMs}ms）` : `无法访问 ${url}：${error?.message ?? error}`, 'network')
  }
  if (response.status === 404) throw new UpdateError(`注册表中没有 ${packageName}`, 'not-found')
  if (!response.ok) throw new UpdateError(`${url} 返回 HTTP ${response.status}`, 'http')
  try {
    return await response.json()
  } catch (error) {
    throw new UpdateError(`${url} 返回的不是 JSON：${error?.message ?? error}`, 'invalid')
  }
}

/** The version `latest` names, falling back to the highest stable or highest version. */
export function latestVersion(packument) {
  const tagged = normalizeVersion(packument?.['dist-tags']?.latest)
  if (parseVersion(tagged) !== undefined) return tagged
  const versions = Object.keys(packument?.versions ?? {}).filter((version) => parseVersion(version) !== undefined)
  const stable = versions.filter((version) => parseVersion(version).prerelease.length === 0)
  return (stable.length > 0 ? stable : versions).sort((left, right) => compareVersions(right, left))[0]
}

/** Drop the cached result for one package, e.g. after an update. */
export function invalidateUpdateCache(packageName) {
  cache.delete(packageName)
}

/** Registry web page for one package, used by the panels as the release link. */
function releaseUrl(packageName, registry) {
  const name = packageName.startsWith('@') ? packageName.replace('/', '%2f') : packageName
  return `${registry.replace(/\/$/, '')}/-/web/detail/${name}`
}

/**
 * Compare the running plugin with the registry's latest version.
 *
 * Never throws for network or registry failures: the returned state carries
 * `ok: false`, `reason`, and `error` instead, so a Host route can always answer.
 *
 * @returns {Promise<object>} the update state, with both the canonical field
 *   names (`current`, `latest`, `updateAvailable`) and the legacy aliases the
 *   four plugins' panels already read (`currentVersion`, `latestVersion`,
 *   `available`, `releaseUrl`).
 */
export async function checkForUpdate(options = {}) {
  const {
    packageName,
    currentVersion,
    installedVersion,
    mode = 'package',
    installable = false,
    registry = UPDATE_REGISTRY,
    force = false,
    cacheTtlMs = UPDATE_CACHE_MS,
    now = Date.now(),
  } = options
  if (typeof packageName !== 'string' || packageName === '') throw new UpdateError('缺少 packageName', 'invalid')

  const installed = installedVersion ?? currentVersion
  const cached = cache.get(packageName)
  if (force !== true && cached !== undefined) {
    const ttl = cached.info.ok === true ? cacheTtlMs : Math.min(cacheTtlMs, 60_000)
    if (now - cached.at < ttl) return { ...cached.info, cacheHit: true }
  }

  const base = {
    current: currentVersion,
    currentVersion,
    installed,
    mode,
    installable,
    registry,
    checkedAt: new Date(now).toISOString(),
  }

  try {
    const packument = await fetchPackument({ ...options, packageName, registry })
    const latest = latestVersion(packument)
    if (latest === undefined) throw new UpdateError(`${packageName} 没有可安装的版本`, 'no-versions')
    const publishedAt = packument.time?.[latest]
    const updateAvailable = isNewer(latest, installed)
    const url = releaseUrl(packageName, registry)
    const info = {
      ...base,
      ok: true,
      latest,
      latestVersion: latest,
      updateAvailable,
      available: updateAvailable,
      restartRequired: isNewer(installed, currentVersion),
      publishedAt,
      engines: packument.versions?.[latest]?.engines?.dsh,
      tarball: packument.versions?.[latest]?.dist?.tarball,
      integrity: packument.versions?.[latest]?.dist?.integrity,
      packageUrl: packageUrl(packageName, registry),
      release: { version: latest, url, publishedAt },
      releaseUrl: url,
    }
    cache.set(packageName, { at: now, info })
    return { ...info, cacheHit: false }
  } catch (error) {
    const info = {
      ...base,
      ok: false,
      latest: undefined,
      latestVersion: undefined,
      updateAvailable: false,
      available: false,
      restartRequired: isNewer(installed, currentVersion),
      error: error instanceof Error ? error.message : String(error),
      reason: error?.reason ?? 'unknown',
    }
    cache.set(packageName, { at: now, info })
    return { ...info, cacheHit: false }
  }
}

/**
 * Locate how this plugin copy was installed.
 *
 * Walks up from the plugin directory to the profile manifest (`dsh.profile`),
 * then classifies the dependency spec. A checkout outside any profile is a
 * development `link:` install.
 */
export function resolveInstall({ metaUrl, packageName, profileDir } = {}) {
  const packageDir = metaUrl === undefined ? undefined : dirname(fileURLToPath(metaUrl))
  let dir = profileDir ?? packageDir
  let found
  for (let depth = 0; dir !== undefined && depth < 8; depth += 1) {
    try {
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
      if (manifest?.dsh?.profile !== undefined) {
        found = { dir, manifest }
        break
      }
    } catch {
      // Not a manifest; keep walking up.
    }
    const parent = dirname(dir)
    if (parent === dir || parent === '/') break
    dir = parent
  }
  const spec = found?.manifest?.dependencies?.[packageName]
  const linked = typeof spec === 'string' && spec.startsWith('link:')
  return {
    packageDir,
    profileDir: found?.dir,
    spec,
    mode: linked || found === undefined ? 'link' : 'package',
  }
}

/** Fast-forward a linked checkout; refuses a dirty worktree. */
export async function gitPull(packageDir) {
  if (typeof packageDir !== 'string' || !existsSync(join(packageDir, '.git'))) {
    throw new UpdateError('源码目录不是 git 仓库，无法自动更新；请手动执行 git pull', 'not-git')
  }
  let status
  try {
    status = await execFileAsync('git', ['-C', packageDir, 'status', '--porcelain'], { timeout: 20_000 })
  } catch (error) {
    throw new UpdateError(`git status 失败：${error?.message ?? error}`, 'git')
  }
  if (status.stdout.trim() !== '') throw new UpdateError('工作区有未提交的改动，已取消更新', 'dirty')
  try {
    await execFileAsync('git', ['-C', packageDir, 'pull', '--ff-only'], { timeout: 120_000 })
  } catch (error) {
    throw new UpdateError(`git pull 失败：${error?.message ?? error}`, 'git')
  }
}

/**
 * Install the target version.
 *
 * A `link:` checkout updates with `git pull`. A packaged install asks the DSH
 * plugin manager for the exact registry version. When HMR refuses a registry
 * spec because the package is already installed, the same version is installed
 * from its registry tarball, which the manager replaces in place.
 *
 * @returns {Promise<{method: string, from?: string, to?: string, restartRequired: boolean, changed: boolean}>}
 */
export async function applyUpdate({ packageName, targetVersion, mode, packageDir, registry = UPDATE_REGISTRY, pluginManager, tarballUrl } = {}) {
  const from = packageDir === undefined ? undefined : readPackageVersion(packageDir)
  if (mode === 'link') {
    await gitPull(packageDir)
    invalidateUpdateCache(packageName)
    const to = readPackageVersion(packageDir)
    if (from !== undefined && to === from) throw new UpdateError('git pull 没有带来新版本', 'not-advanced')
    return { method: 'git', from, to, restartRequired: true, changed: from !== to }
  }

  if (pluginManager === undefined || typeof pluginManager.installBundle !== 'function') {
    throw new UpdateError('pluginManager 不可用，请手动执行 dsh plugin --profile <name> add <包名>@<版本>', 'unavailable')
  }
  const version = targetVersion ?? 'latest'

  const install = async (spec) => {
    try {
      return await pluginManager.installBundle(spec, { registry })
    } catch (error) {
      const refused = error?.code === 'already-installed'
        || error?.error?.code === 'already-installed'
        || String(error?.message ?? error).includes('already-installed')
      if (refused && typeof tarballUrl === 'string' && tarballUrl !== '') {
        return await pluginManager.installBundle(tarballUrl, { registry })
      }
      throw error
    }
  }

  let result
  try {
    result = await install(`${packageName}@${version}`)
  } catch (error) {
    throw new UpdateError(`安装失败：${error?.message ?? error}`, 'install-failed')
  }
  invalidateUpdateCache(packageName)
  const failure = result?.error
    ? { code: result.error.code, message: result.error.message ?? String(result.error), requirements: result.error.requirements }
    : undefined
  return {
    method: 'package',
    from,
    to: result?.version ?? version,
    restartRequired: result?.application === 'restart-required',
    changed: result?.application !== 'failed',
    application: result?.application,
    stage: result?.stage,
    restartReason: result?.restartReason,
    warnings: result?.warnings,
    pendingBuilds: result?.pendingBuilds,
    error: failure,
  }
}

/**
 * Reload this plugin's Loader entry after its files changed on disk. The
 * caller has already answered its request, so the reload runs on a timer.
 */
export function scheduleReload(ctx, packageName, { delayMs = 1200 } = {}) {
  const timer = setTimeout(() => {
    void (async () => {
      try {
        const manager = ctx?.get?.('pluginManager')
        if (manager === undefined) return
        const entries = await manager.listPlugins()
        const entry = entries.find((candidate) => candidate.moduleName === packageName && candidate.enabled !== false)
        if (entry === undefined) return
        try {
          await manager.setPluginEnabled(entry.entryId, false)
        } catch {
          // Keep going: a failed disable may still be enabled.
        }
        try {
          await manager.setPluginEnabled(entry.entryId, true)
        } catch {
          // The next page load reports the installed version.
        }
      } catch {
        // Best-effort reload; the client still reloads its bundle.
      }
    })()
  }, delayMs)
  timer.unref?.()
  return timer
}
