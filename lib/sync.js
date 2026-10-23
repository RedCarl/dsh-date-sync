/**
 * Two-way WebDAV synchronization engine for Harness user data.
 *
 * Local changes are pushed from a filesystem watcher within a few hundred
 * milliseconds; remote changes are discovered by polling PROPFIND. Every file
 * carries the hash/etag pair observed at its last successful transfer, so a
 * change on either side is unambiguous and a conflict is a change on both sides
 * since that point.
 *
 * The engine never deletes remote data it did not itself observe as synced:
 * a local deletion becomes a remote DELETE only when the file has a state entry,
 * and a remote deletion moves the local file into a trash directory.
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { WebdavError } from './webdav.js'
import { createRemoteClient } from './client.js'
import {
  atomicWrite,
  errorMessage,
  formatBytes,
  hashBuffer,
  hashFile,
  moveFile,
  nowIso,
  redactUrl,
  remoteDirname,
  remoteJoin,
  safeRelative,
  sameEtag,
  stamp,
} from './util.js'

const STATE_VERSION = 1
const RECENT_LIMIT = 60
const SELF_WRITE_TTL_MS = 15_000

function iso(time) {
  return time ? new Date(time).toISOString() : undefined
}

export class SyncEngine {
  /**
   * @param {object} options
   * @param {ReturnType<import('./config.js').resolveConfig>} options.config
   * @param {object} [options.logger] Cordis logger facade.
   * @param {(sessionId: string) => boolean} [options.isSessionActive]
   */
  constructor(options) {
    this.config = options.config
    this.logger = options.logger
    this.isSessionActive = options.isSessionActive
    this.client = this.config.configured ? createRemoteClient(this.config) : undefined

    this.stateDir = this.config.stateDir
    this.statePath = path.join(this.stateDir, 'state.json')
    this.state = {
      version: STATE_VERSION,
      device: this.config.device,
      remote: this.#remoteIdentity(),
      scopes: {},
      lastSyncAt: undefined,
    }
    this.recent = []
    this.counts = {
      uploaded: 0,
      downloaded: 0,
      deletedRemote: 0,
      trashedLocal: 0,
      conflicts: 0,
      failed: 0,
      skipped: 0,
      cycles: 0,
    }
    this.lastCycle = undefined
    this.lastSyncAt = undefined
    this.lastError = undefined
    this.lastReason = undefined
    this.syncing = false
    this.paused = false
    this.disposed = false
    this.chain = Promise.resolve()
    this.watchers = new Map()
    this.selfWrites = new Map()
    this.debounceTimer = undefined
    this.pollTimer = undefined
    this.startupTimer = undefined
    this.abortController = undefined
    this.missingBundles = []
    this.localLinkDependencies = []
    this.configWarnings = [...this.config.warnings]
    this.connectionState = 'unknown'
    this.connectionError = undefined
    this.connectionFailure = undefined
    this.lastSuccessAt = undefined
    this.lastConnectionLogAt = 0
  }

  #remoteIdentity() {
    const provider = this.config.provider ?? 'webdav'
    const bucket = provider === 's3' ? `|${this.config.bucket ?? ''}` : ''
    return `${provider}|${this.config.url.replace(/\/+$/, '')}${bucket}|${this.config.remoteRoot}`
  }

  /** Start watchers, polling, and one initial cycle. Safe to call once. */
  start() {
    if (this.disposed) return
    if (!this.config.enabled) {
      this.#log('info', 'plugin disabled by config')
      return
    }
    if (!this.client) {
      this.#log('warn', 'WebDAV is not configured; set `url` (and `username`/`passwordEnv`) in this entry to start syncing')
      return
    }
    for (const warning of this.configWarnings) this.#log('warn', warning)
    this.ready = this.#rotateLog()
      .then(() => this.#loadState())
      .then(() => {
        if (this.disposed) return
        this.#ensureWatchers()
        this.#startPolling()
        if (this.config.syncOnStart) {
          this.startupTimer = setTimeout(() => void this.requestSync('startup'), 1500)
          this.startupTimer.unref?.()
        }
        this.#checkBundles()
        this.#log('info', `ready: ${this.config.scopes.length} scope(s), poll every ${Math.round(this.config.pollIntervalMs / 1000)}s`)
      })
      .catch((error) => {
        this.lastError = errorMessage(error)
        this.#log('error', `failed to start: ${this.lastError}`)
      })
    // Every sync waits for the state file, so an early tool call cannot run
    // against empty bookkeeping and misread remote files as new.
    this.chain = this.ready.catch(() => {})
  }

  /** Stop timers, watchers, and pending work. */
  async dispose() {
    if (this.disposed) return
    this.disposed = true
    clearTimeout(this.debounceTimer)
    clearTimeout(this.startupTimer)
    clearTimeout(this.settleTimer)
    clearInterval(this.pollTimer)
    for (const watcher of this.watchers.values()) {
      try {
        watcher.close()
      } catch {
        // Closing an already-closed watcher is harmless.
      }
    }
    this.watchers.clear()
    try {
      this.abortController?.abort()
    } catch {
      // Ignore abort failures during teardown.
    }
    try {
      await this.chain
    } catch {
      // The chain records its own failures.
    }
    if (this.client) await this.#saveState(true).catch(() => {})
  }

  pause() {
    this.paused = true
    this.#log('info', 'sync paused')
    return this.status()
  }

  resume() {
    this.paused = false
    this.#log('info', 'sync resumed')
    void this.requestSync('resume')
    return this.status()
  }

  /** Run a cycle now, serialized behind any cycle already running. */
  requestSync(reason = 'manual') {
    if (this.disposed || this.paused) return Promise.resolve(this.status())
    if (!this.client || !this.config.enabled) return Promise.resolve(this.status())
    const run = this.chain.then(() => this.#cycle(reason))
    this.chain = run.catch(() => {})
    return run
  }

  /** Tool entry point: one action string in, one JSON status object out. */
  async control(action) {
    const normalized = typeof action === 'string' ? action.trim().toLowerCase() : 'status'
    if (normalized === 'pause') return this.pause()
    if (normalized === 'resume') return this.resume()
    await this.requestSync(`tool:${normalized || 'status'}`)
    const status = this.status()
    status.action = normalized || 'status'
    return status
  }

  status() {
    const scopes = this.config.scopes.map((scope) => {
      const tracked = this.state.scopes[scope.key]?.files ?? {}
      return {
        key: scope.key,
        local: scope.local,
        remote: remoteJoin(this.config.remoteRoot, scope.remote),
        localExists: Boolean(scope.local) && fs.existsSync(scope.local),
        trackedFiles: Object.keys(tracked).length,
      }
    })
    const stateConflictCount = this.#countStateConflicts()
    return {
      plugin: 'date-sync',
      configured: this.config.configured,
      enabled: this.config.enabled,
      paused: this.paused,
      syncing: this.syncing,
      remote: {
        provider: this.config.provider ?? 'webdav',
        url: this.config.url ? redactUrl(this.config.url) : '',
        bucket: this.config.bucket ?? '',
        root: this.config.remoteRoot,
        authenticated: Boolean(this.config.username || this.config.password),
      },
      device: this.config.device,
      conflictPolicy: this.config.conflictPolicy,
      deletions: this.config.deletions,
      pollIntervalMs: this.config.pollIntervalMs,
      lastSyncAt: iso(this.lastSyncAt),
      lastSuccessAt: iso(this.lastSuccessAt),
      lastReason: this.lastReason,
      lastError: this.lastError,
      connection: this.config.configured ? this.connectionState : 'idle',
      connectionError: this.connectionError,
      lastCycle: this.lastCycle,
      counts: { ...this.counts },
      scopes,
      missingBundles: [...this.missingBundles],
      localLinkDependencies: [...this.localLinkDependencies],
      conflictsOnDisk: stateConflictCount,
      warnings: [...this.configWarnings],
      recent: this.recent.slice(-20),
      stateDir: this.stateDir,
      logFile: path.join(this.stateDir, 'sync.log'),
    }
  }

  #countStateConflicts() {
    try {
      const dir = path.join(this.stateDir, 'conflicts')
      return fs.existsSync(dir) ? fs.readdirSync(dir).length : 0
    } catch {
      return 0
    }
  }

  /** A failure that means the WebDAV endpoint itself is unreachable. */
  #isConnectionError(error) {
    if (!(error instanceof WebdavError)) return false
    const status = error.status
    return status === undefined
      || status === 400
      || status === 401
      || status === 403
      || status === 405
      || status === 408
      || status === 429
      || status === 501
      || status >= 500
  }

  /** Record the first connection failure of a cycle; false for content errors. */
  #noteConnectionFailure(error) {
    if (!this.#isConnectionError(error)) return false
    if (this.connectionFailure === undefined) this.connectionFailure = errorMessage(error)
    return true
  }

  #log(level, message) {
    const entry = { at: nowIso(), level, message }
    this.recent.push(entry)
    if (this.recent.length > RECENT_LIMIT) this.recent.shift()
    this.#appendDiskLog(entry)
    const logger = this.logger
    if (!logger) return
    const method = typeof logger[level] === 'function' ? logger[level] : logger.info
    try {
      method?.call(logger, `[date-sync] ${message}`)
    } catch {
      // Logging must never break synchronization.
    }
  }

  /** Append one record to <stateDir>/sync.log so a host-side failure is diagnosable later. */
  #appendDiskLog(entry) {
    if (this.disposed) return
    const line = JSON.stringify(entry)
    this.logQueue = (this.logQueue ?? Promise.resolve())
      .then(async () => {
        await fsp.mkdir(this.stateDir, { recursive: true })
        await fsp.appendFile(path.join(this.stateDir, 'sync.log'), `${line}\n`)
      })
      .catch(() => {})
  }

  async #rotateLog() {
    const file = path.join(this.stateDir, 'sync.log')
    try {
      const stat = await fsp.stat(file)
      if (stat.size > 2 * 1024 * 1024) await fsp.rename(file, `${file}.1`)
    } catch {
      // No log yet, or rotation is not possible; appending still works.
    }
  }

  async #loadState() {
    try {
      const raw = await fsp.readFile(this.statePath, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed && parsed.version === STATE_VERSION && parsed.scopes && typeof parsed.scopes === 'object') {
        this.state = { ...parsed, remote: parsed.remote ?? this.#remoteIdentity() }
        if (parsed.remote && parsed.remote !== this.#remoteIdentity()) {
          this.#log('warn', 'remote target changed; local sync bookkeeping was reset (files are not deleted)')
          this.state.scopes = {}
        }
        this.lastSyncAt = parsed.lastSyncAt ? Date.parse(parsed.lastSyncAt) : undefined
      } else {
        this.#log('warn', 'ignoring an incompatible state file; starting with no bookkeeping')
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        const backup = `${this.statePath}.corrupt-${stamp()}`
        await fsp.rename(this.statePath, backup).catch(() => {})
        this.#log('warn', `state file was unreadable and moved to ${backup}: ${errorMessage(error)}`)
      }
    }
    this.state.remote = this.#remoteIdentity()
    this.state.device = this.config.device
  }

  async #saveState(force = false) {
    if (!this.state || (this.disposed && !force)) return
    this.state.lastSyncAt = iso(this.lastSyncAt)
    this.state.remote = this.#remoteIdentity()
    await atomicWrite(this.statePath, `${JSON.stringify(this.state, null, 2)}\n`)
  }

  #stateScope(key) {
    this.state.scopes[key] ??= { files: {} }
    this.state.scopes[key].files ??= {}
    return this.state.scopes[key]
  }

  /**
   * Watch every scope root that exists. Called at start and after each cycle,
   * because a brand-new machine may not have the directory until the first pull
   * creates it.
   */
  #ensureWatchers() {
    if (!this.config.watch || this.disposed) return
    for (const scope of this.config.scopes) {
      if (!scope.local || this.watchers.has(scope.key)) continue
      try {
        if (!fs.statSync(scope.local).isDirectory()) continue
      } catch {
        continue
      }
      try {
        const watcher = fs.watch(scope.local, { recursive: true }, (event, filename) => {
          this.#onFsEvent(scope, filename)
        })
        watcher.on('error', (error) => {
          this.watchers.delete(scope.key)
          this.#log('warn', `watcher error for ${scope.key}: ${errorMessage(error)}`)
        })
        this.watchers.set(scope.key, watcher)
      } catch (error) {
        this.#log('warn', `cannot watch ${scope.local}: ${errorMessage(error)}; relying on polling`)
      }
    }
  }

  #onFsEvent(scope, filename) {
    const rel = filename ? String(filename).replace(/\\/g, '/') : ''
    if (rel) {
      if (scope.kind === 'files' && !scope.includes.includes(rel)) return
      if (this.config.matcher(rel)) return
      const abs = path.join(scope.local, rel)
      if (this.#isSelfWrite(scope, rel, abs)) return
    }
    clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => {
      void this.requestSync('local')
    }, this.config.debounceMs)
    this.debounceTimer.unref?.()
  }

  /** Retry soon after a skipped half-written file settles instead of waiting for the next poll. */
  #scheduleSettleRetry() {
    if (this.disposed || this.paused) return
    clearTimeout(this.settleTimer)
    this.settleTimer = setTimeout(() => {
      void this.requestSync('settle')
    }, Math.max(500, this.config.settleMs + 250))
    this.settleTimer.unref?.()
  }

  #markSelfWrite(abs) {
    this.selfWrites.set(abs, Date.now() + SELF_WRITE_TTL_MS)
    setTimeout(() => this.selfWrites.delete(abs), SELF_WRITE_TTL_MS).unref?.()
  }

  #isSelfWrite(scope, rel, abs) {
    const expiry = this.selfWrites.get(abs)
    if (!expiry) return false
    if (Date.now() > expiry) {
      this.selfWrites.delete(abs)
      return false
    }
    const entry = this.state.scopes?.[scope.key]?.files?.[rel]
    if (!entry) return true
    try {
      const stat = fs.statSync(abs)
      return stat.size === entry.size && stat.mtimeMs === entry.mtimeMs
    } catch {
      return true
    }
  }

  #startPolling() {
    this.pollTimer = setInterval(() => {
      void this.requestSync('poll')
    }, this.config.pollIntervalMs)
    this.pollTimer.unref?.()
  }

  async #cycle(reason) {
    if (this.disposed || this.paused || !this.client || !this.config.enabled) return this.status()
    if (this.syncing) return this.status()
    this.syncing = true
    this.lastReason = reason
    this.connectionFailure = undefined
    const started = Date.now()
    const counts = { uploaded: 0, downloaded: 0, deletedRemote: 0, trashedLocal: 0, conflicts: 0, failed: 0, skipped: 0, scanned: 0 }
    this.abortController = new AbortController()
    const signal = this.abortController.signal
    try {
      for (const scope of this.config.scopes) {
        // One connection failure already explains the whole cycle; the other
        // scopes share the same endpoint, so do not repeat the error for them.
        if (this.connectionFailure !== undefined) break
        try {
          await this.#syncScope(scope, counts, signal)
        } catch (error) {
          if (this.disposed) return this.status()
          counts.failed += 1
          this.lastError = `${scope.key}: ${errorMessage(error)}`
          if (!this.#noteConnectionFailure(error)) this.#log('error', this.lastError)
          if (error instanceof WebdavError && (error.status === 401 || error.status === 403)) {
            this.#log('error', 'WebDAV authentication was refused; check username/password')
          }
        }
      }
      if (!this.disposed) {
        if (this.connectionFailure !== undefined) {
          const wasError = this.connectionState === 'error'
          this.connectionState = 'error'
          this.connectionError = this.connectionFailure
          const quiet = Date.now() - this.lastConnectionLogAt > 5 * 60_000
          if (!wasError || quiet) {
            const every = Math.max(1, Math.round(this.config.pollIntervalMs / 1000))
            this.#log(
              wasError ? 'warn' : 'error',
              wasError
                ? `still failing: ${this.connectionError}`
                : `sync failed: ${this.connectionError} — retrying every ${every}s`,
            )
            this.lastConnectionLogAt = Date.now()
          }
        } else {
          if (this.connectionState === 'error') this.#log('info', 'sync restored')
          this.connectionState = 'ok'
          this.connectionError = undefined
          this.lastSuccessAt = Date.now()
        }
      }
      this.lastSyncAt = Date.now()
      this.#checkBundles()
      this.#ensureWatchers()
    } finally {
      const elapsed = Date.now() - started
      this.counts.uploaded += counts.uploaded
      this.counts.downloaded += counts.downloaded
      this.counts.deletedRemote += counts.deletedRemote
      this.counts.trashedLocal += counts.trashedLocal
      this.counts.conflicts += counts.conflicts
      this.counts.failed += counts.failed
      this.counts.skipped += counts.skipped
      this.counts.cycles += 1
      this.lastCycle = { at: nowIso(), reason, elapsedMs: elapsed, ...counts }
      this.syncing = false
      this.abortController = undefined
      await this.#saveState().catch((error) => {
        this.lastError = `state: ${errorMessage(error)}`
      })
      if (counts.uploaded + counts.downloaded + counts.conflicts + counts.deletedRemote + counts.trashedLocal > 0) {
        this.#log(
          'info',
          `cycle: ↑${counts.uploaded} ↓${counts.downloaded} ⇄${counts.conflicts} ✕${counts.deletedRemote} 🗑${counts.trashedLocal} in ${elapsed}ms`,
        )
      }
    }
    return this.status()
  }

  async #syncScope(scope, counts, signal) {
    const stateScope = this.#stateScope(scope.key)
    if (scope.local) {
      const rootExists = fs.existsSync(scope.local)
      if (!rootExists) {
        if (Object.keys(stateScope.files).length > 0) {
          this.#log('warn', `${scope.key}: ${scope.local} is missing but already synced; skipping to avoid deleting the remote copy`)
          return
        }
        // A brand-new machine may not have the directory yet; create it so the
        // remote files can be pulled into place.
        await fsp.mkdir(scope.local, { recursive: true }).catch((error) => {
          throw new Error(`cannot create ${scope.local}: ${errorMessage(error)}`)
        })
      }
    }
    const remoteRoot = remoteJoin(this.config.remoteRoot, scope.remote)
    const remoteMap = await this.client.walk(remoteRoot, { signal })
    for (const [rel, entry] of [...remoteMap]) {
      const clean = safeRelative(rel)
      if (clean === null || !this.#include(scope, clean) || this.config.matcher(clean)) remoteMap.delete(rel)
    }
    const localMap = await this.#scanLocal(scope)
    const paths = new Set([...localMap.keys(), ...remoteMap.keys(), ...Object.keys(stateScope.files)])
    for (const rel of [...paths].sort()) {
      if (!this.#include(scope, rel) || this.config.matcher(rel)) continue
      const clean = safeRelative(rel)
      if (clean === null) continue
      counts.scanned += 1
      try {
        await this.#reconcile(scope, clean, localMap.get(rel), remoteMap.get(rel), counts, signal)
      } catch (error) {
        if (this.disposed) return
        counts.failed += 1
        this.lastError = `${scope.key}/${rel}: ${errorMessage(error)}`
        if (!this.#noteConnectionFailure(error)) this.#log('error', this.lastError)
      }
    }
  }

  #include(scope, rel) {
    if (scope.kind === 'files') return scope.includes.includes(rel)
    return true
  }

  async #scanLocal(scope) {
    const result = new Map()
    if (!scope.local) return result
    if (scope.kind === 'files') {
      for (const name of scope.includes) {
        try {
          const abs = path.join(scope.local, name)
          const stat = await fsp.stat(abs)
          if (stat.isFile()) {
            result.set(name, { rel: name, abs, size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino })
          }
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error
        }
      }
      return result
    }
    const visit = async (dirAbs, relDir) => {
      let entries
      try {
        entries = await fsp.readdir(dirAbs, { withFileTypes: true })
      } catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return
        throw error
      }
      for (const entry of entries) {
        const rel = relDir ? `${relDir}/${entry.name}` : entry.name
        if (this.config.matcher(rel)) continue
        const abs = path.join(dirAbs, entry.name)
        if (entry.isSymbolicLink()) continue
        if (entry.isDirectory()) {
          await visit(abs, rel)
        } else if (entry.isFile()) {
          try {
            const stat = await fsp.stat(abs)
            result.set(rel, { rel, abs, size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino })
          } catch (error) {
            if (error?.code !== 'ENOENT') throw error
          }
        }
      }
    }
    await visit(scope.local, '')
    return result
  }

  async #localChanged(local, stateEntry) {
    if (!stateEntry) return true
    if (
      stateEntry.hash
      && stateEntry.size === local.size
      && stateEntry.mtimeMs === local.mtimeMs
      && stateEntry.ino === local.ino
    ) {
      return false
    }
    const hash = await hashFile(local.abs)
    local.hash = hash
    if (stateEntry.hash === hash) {
      stateEntry.size = local.size
      stateEntry.mtimeMs = local.mtimeMs
      stateEntry.ino = local.ino
      return false
    }
    return true
  }

  async #reconcile(scope, rel, local, remote, counts, signal) {
    const stateScope = this.#stateScope(scope.key)
    const stateEntry = stateScope.files[rel]

    if (!local && !remote) {
      delete stateScope.files[rel]
      return
    }

    if (local && !remote) {
      if (!stateEntry) {
        await this.#upload(scope, rel, local, { ifNoneMatch: '*' }, counts, signal)
        return
      }
      if (await this.#localChanged(local, stateEntry)) {
        await this.#upload(scope, rel, local, { ifMatch: stateEntry.etag }, counts, signal)
        return
      }
      if (this.config.deletions === 'restore') {
        await this.#upload(scope, rel, local, { ifNoneMatch: '*' }, counts, signal)
        return
      }
      // The remote copy disappeared while the local copy stayed unchanged.
      await this.#trashLocal(scope, rel, counts)
      return
    }

    if (!local && remote) {
      if (!stateEntry) {
        await this.#download(scope, rel, remote, undefined, counts, signal)
        return
      }
      if (!sameEtag(stateEntry.etag, remote.etag)) {
        await this.#download(scope, rel, remote, undefined, counts, signal)
        return
      }
      if (this.config.deletions === 'restore') {
        await this.#download(scope, rel, remote, undefined, counts, signal)
        return
      }
      // The local copy disappeared while the remote copy stayed unchanged.
      await this.#deleteRemote(scope, rel, counts, signal)
      return
    }

    const localChanged = await this.#localChanged(local, stateEntry)
    const remoteChanged = !stateEntry || !sameEtag(stateEntry.etag, remote.etag)
    if (!localChanged && !remoteChanged) return
    if (localChanged && !remoteChanged) {
      await this.#upload(scope, rel, local, stateEntry ? { ifMatch: stateEntry.etag } : { ifNoneMatch: '*' }, counts, signal)
      return
    }
    if (!localChanged && remoteChanged) {
      await this.#download(scope, rel, remote, local, counts, signal)
      return
    }
    await this.#conflict(scope, rel, local, remote, stateEntry, counts, signal)
  }

  #remotePath(scope, rel) {
    return remoteJoin(this.config.remoteRoot, scope.remote, rel)
  }

  #skipActiveSession(scope, rel) {
    if (!scope.sessionAware || typeof this.isSessionActive !== 'function') return false
    const match = /(?:^|\/)(session-[0-9a-fA-F-]{8,})(?:\/|$)/.exec(rel)
    if (!match) return false
    try {
      return this.isSessionActive(match[1])
    } catch {
      return false
    }
  }

  async #upload(scope, rel, local, expectations, counts, signal) {
    if (this.config.settleMs > 0 && Date.now() - local.mtimeMs < this.config.settleMs) {
      counts.skipped += 1
      this.#scheduleSettleRetry()
      return
    }
    if (local.size > this.config.maxFileBytes) {
      counts.skipped += 1
      this.#log('warn', `skipped ${scope.key}/${rel}: ${formatBytes(local.size)} exceeds maxFileBytes`)
      return
    }
    const buffer = await fsp.readFile(local.abs)
    const hash = hashBuffer(buffer)
    const remoteRel = this.#remotePath(scope, rel)
    const parent = remoteDirname(remoteRel)
    if (parent) await this.client.ensureCollection(parent, signal)
    let result
    try {
      result = await this.client.put(remoteRel, buffer, {
        ifMatch: expectations.ifMatch,
        ifNoneMatch: expectations.ifNoneMatch,
        signal,
      })
    } catch (error) {
      if (error instanceof WebdavError && error.status === 412) {
        counts.skipped += 1
        this.#log('warn', `${scope.key}/${rel} changed remotely during upload; resolving on the next cycle`)
        return
      }
      if (error instanceof WebdavError && error.status === 409) {
        // The collection we believed existed is gone; recreate and retry once.
        this.client.createdCollections.clear()
        if (parent) await this.client.ensureCollection(parent, signal)
        result = await this.client.put(remoteRel, buffer, {
          ifMatch: expectations.ifMatch,
          ifNoneMatch: expectations.ifNoneMatch,
          signal,
        })
      } else {
        throw error
      }
    }
    let etag = result.etag
    if (!etag) {
      const stat = await this.client.stat(remoteRel, signal).catch(() => undefined)
      etag = stat?.etag
    }
    const stat = await fsp.stat(local.abs)
    this.#stateScope(scope.key).files[rel] = {
      hash,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ino: stat.ino,
      etag,
      remoteMtimeMs: Date.now(),
      syncedAt: Date.now(),
    }
    if (scope.key === 'profile' && rel === 'package.json') this.missingBundles = this.#findMissingBundles()
    counts.uploaded += 1
    this.#log('info', `↑ ${scope.key}/${rel} (${formatBytes(buffer.length)})`)
  }

  async #download(scope, rel, remote, local, counts, signal) {
    if (this.#skipActiveSession(scope, rel)) {
      counts.skipped += 1
      this.#log('info', `deferred ${scope.key}/${rel}: its session is live on this host`)
      return
    }
    if (remote.size !== undefined && remote.size > this.config.maxFileBytes) {
      counts.skipped += 1
      this.#log('warn', `skipped ${scope.key}/${rel}: ${formatBytes(remote.size)} exceeds maxFileBytes`)
      return
    }
    const stateEntry = this.#stateScope(scope.key).files[rel]
    if (stateEntry?.rejectedEtag && sameEtag(stateEntry.rejectedEtag, remote.etag)) {
      counts.skipped += 1
      return
    }
    const remoteRel = this.#remotePath(scope, rel)
    const downloaded = await this.client.get(remoteRel, signal)
    const hash = hashBuffer(downloaded.body)
    if (local) {
      const localHash = local.hash ?? (await hashFile(local.abs))
      if (localHash === hash) {
        const stat = await fsp.stat(local.abs)
        this.#stateScope(scope.key).files[rel] = {
          hash,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          ino: stat.ino,
          etag: downloaded.etag ?? remote.etag,
          remoteMtimeMs: downloaded.mtimeMs ?? remote.mtimeMs,
          syncedAt: Date.now(),
        }
        counts.skipped += 1
        return
      }
    }
    const validation = this.#validateIncoming(scope, rel, downloaded.body)
    if (!validation.ok) {
      counts.failed += 1
      const rejected = { ...(stateEntry ?? {}), rejectedEtag: downloaded.etag ?? remote.etag }
      this.#stateScope(scope.key).files[rel] = rejected
      this.lastError = `refused to apply remote ${scope.key}/${rel}: ${validation.reason}`
      this.#log('error', this.lastError)
      return
    }
    const abs = path.join(scope.local, rel)
    await atomicWrite(abs, downloaded.body, scope.secret ? { mode: 0o600 } : {})
    this.#markSelfWrite(abs)
    const stat = await fsp.stat(abs)
    this.#stateScope(scope.key).files[rel] = {
      hash,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ino: stat.ino,
      etag: downloaded.etag ?? remote.etag,
      remoteMtimeMs: downloaded.mtimeMs ?? remote.mtimeMs,
      syncedAt: Date.now(),
    }
    if (scope.key === 'profile' && rel === 'package.json') this.missingBundles = this.#findMissingBundles()
    counts.downloaded += 1
    this.#log('info', `↓ ${scope.key}/${rel} (${formatBytes(downloaded.body.length)})`)
  }

  async #conflict(scope, rel, local, remote, stateEntry, counts, signal) {
    const remoteRel = this.#remotePath(scope, rel)
    const downloaded = await this.client.get(remoteRel, signal)
    const remoteHash = hashBuffer(downloaded.body)
    const localHash = local.hash ?? (await hashFile(local.abs))
    if (localHash === remoteHash) {
      const stat = await fsp.stat(local.abs)
      this.#stateScope(scope.key).files[rel] = {
        hash: localHash,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        ino: stat.ino,
        etag: downloaded.etag ?? remote.etag,
        remoteMtimeMs: downloaded.mtimeMs ?? remote.mtimeMs,
        syncedAt: Date.now(),
      }
      return
    }
    const policy = this.config.conflictPolicy
    const localWins = policy === 'local-wins'
      ? true
      : policy === 'remote-wins'
        ? false
        : local.mtimeMs >= (remote.mtimeMs ?? 0)
    const folder = path.join(this.stateDir, 'conflicts', `${stamp()}-${scope.key}`)
    if (localWins) {
      await this.#saveConflict(folder, 'remote', rel, downloaded.body)
      this.#log(
        'warn',
        `conflict ${scope.key}/${rel}: kept local (${policy}); remote copy saved under ${folder}`,
      )
      await this.#upload(scope, rel, local, { ifMatch: downloaded.etag ?? remote.etag }, counts, signal)
    } else {
      await this.#saveConflict(folder, 'local', rel, await fsp.readFile(local.abs))
      this.#log(
        'warn',
        `conflict ${scope.key}/${rel}: kept remote (${policy}); local copy saved under ${folder}`,
      )
      const validation = this.#validateIncoming(scope, rel, downloaded.body)
      if (!validation.ok) {
        counts.failed += 1
        this.lastError = `refused to apply remote ${scope.key}/${rel}: ${validation.reason}`
        this.#log('error', this.lastError)
        return
      }
      const abs = path.join(scope.local, rel)
      await atomicWrite(abs, downloaded.body, scope.secret ? { mode: 0o600 } : {})
      this.#markSelfWrite(abs)
      const stat = await fsp.stat(abs)
      this.#stateScope(scope.key).files[rel] = {
        hash: remoteHash,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        ino: stat.ino,
        etag: downloaded.etag ?? remote.etag,
        remoteMtimeMs: downloaded.mtimeMs ?? remote.mtimeMs,
        syncedAt: Date.now(),
      }
      if (scope.key === 'profile' && rel === 'package.json') this.missingBundles = this.#findMissingBundles()
      counts.downloaded += 1
    }
    counts.conflicts += 1
  }

  async #saveConflict(folder, side, rel, bytes) {
    const target = path.join(folder, side, rel)
    await atomicWrite(target, bytes)
  }

  async #deleteRemote(scope, rel, counts, signal) {
    const remoteRel = this.#remotePath(scope, rel)
    await this.client.delete(remoteRel, { signal })
    delete this.#stateScope(scope.key).files[rel]
    counts.deletedRemote += 1
    this.#log('info', `✕ remote ${scope.key}/${rel} (deleted locally)`)
  }

  async #trashLocal(scope, rel, counts) {
    const abs = path.join(scope.local, rel)
    const target = path.join(this.stateDir, 'trash', `${stamp()}-${scope.key}`, rel)
    await moveFile(abs, target)
    delete this.#stateScope(scope.key).files[rel]
    counts.trashedLocal += 1
    this.#log('info', `🗑 local ${scope.key}/${rel} (deleted remotely) → ${target}`)
  }

  #validateIncoming(scope, rel, buffer) {
    if (scope.kind !== 'files') return { ok: true }
    if (rel === 'package.json' && scope.key === 'profile') {
      try {
        const parsed = JSON.parse(buffer.toString('utf8'))
        if (!parsed || typeof parsed !== 'object') return { ok: false, reason: 'not a JSON object' }
        return { ok: true }
      } catch (error) {
        return { ok: false, reason: `invalid JSON: ${errorMessage(error)}` }
      }
    }
    if (rel === 'cordis.patch.yml' && scope.key === 'profile') {
      const content = buffer.toString('utf8')
      const meaningful = content
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith('#'))
      if (meaningful.length === 0) return { ok: false, reason: 'empty patch would fail harness startup' }
      const head = meaningful[0]
      if (!(head.startsWith('-') || head.startsWith('[') || head === '---' || head.startsWith('--- '))) {
        return { ok: false, reason: 'patch is not a YAML entry list' }
      }
      return { ok: true }
    }
    return { ok: true }
  }

  /** Dependencies installed from a local path cannot exist on another machine. */
  #findLocalLinkDependencies() {
    const profileDir = this.config.profileDir
    if (!profileDir) return []
    let manifest
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'))
    } catch {
      return []
    }
    const dependencies = manifest?.dependencies && typeof manifest.dependencies === 'object' ? manifest.dependencies : {}
    return Object.entries(dependencies)
      .filter(([, spec]) => typeof spec === 'string' && /^(link|file):/.test(spec))
      .map(([name, spec]) => ({ name, spec }))
  }

  #findMissingBundles() {
    const profileDir = this.config.profileDir
    if (!profileDir) return []
    let manifest
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'))
    } catch {
      return []
    }
    const bundles = Array.isArray(manifest?.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : []
    const missing = []
    for (const name of bundles) {
      if (typeof name !== 'string' || !name) continue
      if (name.startsWith('@deepseek-ai/dsh-') || name === 'cordis') continue
      const installed = fs.existsSync(path.join(profileDir, 'node_modules', name, 'package.json'))
      if (!installed) missing.push(name)
    }
    return missing
  }

  #checkBundles() {
    this.localLinkDependencies = this.#findLocalLinkDependencies()
    const missing = this.#findMissingBundles()
    const changed = missing.join('\n') !== this.missingBundles.join('\n')
    this.missingBundles = missing
    if (changed && missing.length > 0) {
      this.#log(
        'warn',
        `profile selects bundles that are not installed here: ${missing.join(', ')} — run \`dsh plugin --profile ${this.config.profileName || '<profile>'} add <package>\` on this machine`,
      )
    }
    const links = this.localLinkDependencies.map((entry) => entry.name).sort().join(',')
    if (links !== this.lastLinkWarning && this.localLinkDependencies.length > 0) {
      this.lastLinkWarning = links
      this.#log(
        'warn',
        `profile/package.json installs ${links} from a local path; the manifest is synced but the path is machine-specific — install the package on every machine before syncing`,
      )
    }
  }
}

