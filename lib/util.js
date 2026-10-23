/**
 * Small dependency-free helpers shared by the sync engine, the WebDAV client,
 * and the plugin entry.
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

/** ISO timestamp used in state, logs, and conflict folders. */
export function nowIso() {
  return new Date().toISOString()
}

/** Millisecond timestamp fit for a folder name. */
export function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

/**
 * Expand `~`, `$NAME`, and `${NAME}` against an environment. Unknown variables
 * are left untouched so a literal `$` in a path survives.
 */
export function expandValue(value, env = process.env) {
  if (typeof value !== 'string' || value.length === 0) return value
  let out = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name) => {
    return Object.prototype.hasOwnProperty.call(env, name) && env[name] !== undefined ? env[name] : match
  })
  out = out.replace(/(^|[^$\\])\$([A-Za-z_][A-Za-z0-9_]*)/g, (match, lead, name) => {
    return Object.prototype.hasOwnProperty.call(env, name) && env[name] !== undefined
      ? `${lead}${env[name]}`
      : match
  })
  if (out === '~') out = os.homedir()
  else if (out.startsWith('~/') || out.startsWith('~' + path.sep)) out = path.join(os.homedir(), out.slice(2))
  return out
}

/** Expand and resolve a configured path; empty values stay undefined. */
export function resolvePath(value, env = process.env, base) {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const expanded = expandValue(value.trim(), env)
  return path.resolve(base ?? process.cwd(), expanded)
}

/** Join POSIX-style relative segments for remote paths. */
export function remoteJoin(...parts) {
  return parts
    .filter((part) => typeof part === 'string' && part.length > 0)
    .map((part) => part.replace(/^\/+|\/+$/g, ''))
    .filter((part) => part.length > 0)
    .join('/')
}

/** Parent of a POSIX-style relative path, or '' for a top-level entry. */
export function remoteDirname(rel) {
  const index = rel.lastIndexOf('/')
  return index === -1 ? '' : rel.slice(0, index)
}

/** Normalize a remote relative path and reject anything that could escape a root. */
export function safeRelative(rel) {
  if (typeof rel !== 'string' || rel.length === 0) return ''
  const normalized = rel.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '')
  if (normalized.split('/').some((segment) => segment === '..' || segment === '.' || segment === '')) return null
  return normalized
}

/** sha256 of a buffer as lowercase hex. */
export function hashBuffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

/** sha256 of a file as lowercase hex, streamed. */
export async function hashFile(abs) {
  const hash = crypto.createHash('sha256')
  const stream = fs.createReadStream(abs)
  for await (const chunk of stream) hash.update(chunk)
  return hash.digest('hex')
}

/** Resolve after `ms` milliseconds. */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Write a file atomically: write a sibling temporary file, fsync it, then rename
 * over the target. `rename` is atomic on the same filesystem, so readers — and a
 * file watcher — observe either the old file or the complete new one.
 */
export async function atomicWrite(abs, data, options = {}) {
  const dir = path.dirname(abs)
  await fsp.mkdir(dir, { recursive: true })
  const tmp = path.join(dir, `.${path.basename(abs)}.date-sync-${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`)
  const handle = await fsp.open(tmp, 'w', options.mode ?? 0o644)
  try {
    await handle.writeFile(data)
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await fsp.rename(tmp, abs)
  } catch (error) {
    await fsp.rm(tmp, { force: true })
    throw error
  }
  if (options.mode !== undefined && process.platform !== 'win32') {
    await fsp.chmod(abs, options.mode).catch(() => {})
  }
}

/** Move a file, falling back to copy + unlink across filesystems. */
export async function moveFile(from, to) {
  await fsp.mkdir(path.dirname(to), { recursive: true })
  try {
    await fsp.rename(from, to)
    return
  } catch (error) {
    if (error && error.code !== 'EXDEV') throw error
  }
  await fsp.copyFile(from, to)
  await fsp.unlink(from)
}

/** Convert a glob (with `**`, `*`, `?`) to an anchored regular expression. */
export function globToRegExp(glob) {
  let source = ''
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index]
    if (char === '*') {
      if (glob[index + 1] === '*') {
        index += 1
        if (glob[index + 1] === '/') {
          index += 1
          source += '(?:.*/)?'
        } else {
          source += '.*'
        }
      } else {
        source += '[^/]*'
      }
    } else if (char === '?') {
      source += '[^/]'
    } else if ('\\^$+.|()[]{}'.includes(char)) {
      source += `\\${char}`
    } else {
      source += char
    }
  }
  return new RegExp(`^${source}$`)
}

/** Build a predicate matching a POSIX relative path against several globs. */
export function makeMatcher(patterns) {
  const expressions = patterns.filter(Boolean).map((glob) => globToRegExp(glob))
  return (rel) => expressions.some((expression) => expression.test(rel))
}

/** Structural equality for two etag strings, ignoring weakness and quotes. */
export function sameEtag(left, right) {
  const normalize = (value) => (typeof value === 'string' ? value.replace(/^W\//, '').replace(/^"|"$/g, '') : '')
  return normalize(left) === normalize(right)
}

/** Strip credentials from a URL before it reaches logs or tool output. */
export function redactUrl(url) {
  try {
    const parsed = new URL(url)
    if (parsed.username || parsed.password) {
      parsed.username = '***'
      parsed.password = ''
    }
    return parsed.toString()
  } catch {
    return String(url)
  }
}

/** Human-readable byte count. */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '?'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

/** Error to a short single-line message. */
export function errorMessage(error) {
  if (!error) return 'unknown error'
  if (typeof error === 'string') return error
  return error.message ? String(error.message) : String(error)
}
