/**
 * dsh-date-sync — keep one Harness profile's skills, MCP servers, models,
 * plugins, and sessions consistent across machines through a WebDAV collection.
 *
 * The plugin is dependency-free on purpose: a bundle installed from a local
 * directory cannot resolve packages from the DSH installation, so it uses only
 * Node built-ins, the global `fetch`, and plain-JavaScript tool definitions.
 *
 * The Host half owns the sync engine and three small JSON endpoints that the
 * Client panel uses: status, configuration, and an action switch. Settings
 * saved from the panel are written to `<dshHome>/date-sync/config.json` with
 * mode 0600 (so a password never lands in the synced profile patch), and the
 * engine restarts in place.
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { resolveConfig } from './lib/config.js'
import { SyncEngine } from './lib/sync.js'
import { resolvePath } from './lib/util.js'

/** Loader entry name. */
export const name = 'date-sync'

const API_BASE = '/api/date-sync'
const CONFIG_BODY_LIMIT = 256 * 1024
const SCOPE_DEFAULTS = { skills: true, agentSkills: true, sessions: true, profile: true, credentials: false }
const CONFLICT_POLICIES = ['newest-wins', 'local-wins', 'remote-wins']
const DELETION_POLICIES = ['propagate', 'restore']

const TOOL_DESCRIPTION = [
  'Inspect or drive the WebDAV multi-machine sync of this Harness profile.',
  '`status` reports configuration, scopes, counters, conflicts, and recent transfers.',
  '`sync` runs one full two-way cycle immediately (local edits are already pushed automatically).',
  '`pause` and `resume` stop and restart automatic synchronization.',
].join(' ')

function namedLogger(ctx) {
  try {
    return typeof ctx.logger === 'function' ? ctx.logger('date-sync') : ctx.logger
  } catch {
    return undefined
  }
}

/** Read an optional Host service without making it a hard dependency. */
function optionalService(ctx, name) {
  try {
    return typeof ctx.get === 'function' ? ctx.get(name) : undefined
  } catch {
    return undefined
  }
}

/** Report whether a session id is currently open on this host. */
function sessionProbe(ctx) {
  return (sessionId) => {
    try {
      const sessions = optionalService(ctx, 'sessions')
      if (!sessions || !sessionId) return false
      if (typeof sessions.get === 'function' && sessions.get(sessionId)) return true
      if (typeof sessions.list === 'function') {
        return sessions.list().some((session) => {
          const id = session?.id ?? session?.sessionId
          return id !== undefined && String(id) === String(sessionId)
        })
      }
      return false
    } catch {
      return false
    }
  }
}

function errorMessage(error) {
  return error?.message ?? String(error)
}

function sendJson(res, status, value) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(value))
}

async function readJsonBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > CONFIG_BODY_LIMIT) throw new Error('request body is too large')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (!text) return {}
  const parsed = JSON.parse(text)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('request body must be a JSON object')
  return parsed
}

function syncTool(getEngine, ready) {
  return {
    name: 'webdav_sync',
    description: TOOL_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'sync', 'pause', 'resume'],
          description: 'The operation to perform. Defaults to `status`.',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(_args, value) {
        return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
      },
    },
    async execute(args) {
      const action = args && typeof args.action === 'string' ? args.action : 'status'
      await ready()
      const engine = getEngine()
      if (!engine) return { configured: false, error: 'sync engine is not running' }
      return engine.control(action)
    },
  }
}

/**
 * Mount the sync engine, its JSON panel API, and its model-facing tool.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} rawConfig The Loader row's `config`.
 */
export function apply(ctx, rawConfig) {
  const logger = namedLogger(ctx)
  // The Host process is not guaranteed to export DSH_PROFILE_DIR/DSH_HOME;
  // the launcher's profileContext names the running profile authoritatively.
  const profileContext = optionalService(ctx, 'profileContext')
  const rowConfig = { ...(rawConfig && typeof rawConfig === 'object' ? rawConfig : {}) }
  if (!rowConfig.profileDir && typeof profileContext?.dir === 'string') rowConfig.profileDir = profileContext.dir
  if (!rowConfig.dshHome && typeof profileContext?.home === 'string') rowConfig.dshHome = profileContext.home
  if (!rowConfig.profileName && typeof profileContext?.name === 'string') rowConfig.profileName = profileContext.name

  const dshHome = resolvePath(rowConfig.dshHome ?? process.env.DSH_HOME ?? '~/.dsh', process.env)
    ?? path.join(os.homedir(), '.dsh')
  const configDir = path.join(dshHome, 'date-sync')
  const configFile = path.join(configDir, 'config.json')

  let fileConfig
  let fileConfigError
  let engine
  let configError
  let lifecycle = Promise.resolve()

  function loadFileConfig() {
    try {
      const parsed = JSON.parse(fs.readFileSync(configFile, 'utf8'))
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not a JSON object')
      fileConfig = parsed
      fileConfigError = undefined
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        fileConfigError = errorMessage(error)
        logger?.warn?.(`[date-sync] ignoring unreadable ${configFile}: ${fileConfigError}`)
      }
      fileConfig = undefined
    }
  }

  /** Row config is the base; panel-saved values win, including explicit empty strings. */
  function mergedRaw() {
    const base = { ...rowConfig }
    if (!fileConfig) return base
    return {
      ...base,
      ...fileConfig,
      scopes: { ...(base.scopes ?? {}), ...(fileConfig.scopes ?? {}) },
    }
  }

  function createEngine() {
    const config = resolveConfig(mergedRaw())
    const next = new SyncEngine({
      config,
      logger,
      isSessionActive: sessionProbe(ctx),
    })
    next.start()
    return next
  }

  function boot() {
    try {
      engine = createEngine()
      configError = undefined
    } catch (error) {
      engine = undefined
      configError = errorMessage(error)
      logger?.error?.(`[date-sync] invalid configuration: ${configError}`)
    }
  }

  /** Replace the running engine, disposing the previous one first. */
  function reconfigure() {
    const task = lifecycle.then(async () => {
      const previous = engine
      engine = undefined
      if (previous) await previous.dispose()
      try {
        engine = createEngine()
        configError = undefined
      } catch (error) {
        configError = errorMessage(error)
        throw error
      }
      return engine
    })
    lifecycle = task.catch(() => {})
    return task
  }

  function statusPayload() {
    const base = engine ? engine.status() : {
      plugin: 'date-sync',
      configured: false,
      enabled: false,
      paused: false,
      syncing: false,
      remote: { url: '', root: '', authenticated: false },
      device: '',
      conflictPolicy: '',
      deletions: '',
      pollIntervalMs: 0,
      lastSyncAt: undefined,
      lastReason: undefined,
      lastError: undefined,
      lastCycle: undefined,
      counts: { uploaded: 0, downloaded: 0, deletedRemote: 0, trashedLocal: 0, conflicts: 0, failed: 0, skipped: 0, cycles: 0 },
      scopes: [],
      missingBundles: [],
      localLinkDependencies: [],
      conflictsOnDisk: 0,
      warnings: [],
      recent: [],
      stateDir: '',
      logFile: '',
    }
    return {
      ...base,
      configError,
      configFile,
      configSource: fileConfig ? 'file' : (fileConfigError ? 'invalid-file' : 'profile'),
      profileName: rowConfig.profileName ?? '',
      configFileError: fileConfigError,
    }
  }

  function sanitizedConfig() {
    let resolved
    try {
      resolved = resolveConfig(mergedRaw())
    } catch {
      resolved = undefined
    }
    const raw = mergedRaw()
    const flags = { ...SCOPE_DEFAULTS, ...(raw.scopes && typeof raw.scopes === 'object' ? raw.scopes : {}) }
    const passwordEnvName = typeof raw.passwordEnv === 'string' ? raw.passwordEnv : 'DSH_WEBDAV_PASSWORD'
    const fileHasPassword = fileConfig && typeof fileConfig.password === 'string' && fileConfig.password.length > 0
    // resolveConfig prefers an explicit password over the environment variable,
    // so report the layer that actually supplies it.
    const passwordSource = fileHasPassword
      ? 'file'
      : typeof raw.password === 'string' && raw.password.length > 0
        ? 'config'
        : process.env[passwordEnvName]
          ? 'env'
          : 'none'
    return {
      url: typeof raw.url === 'string' ? raw.url : '',
      username: typeof raw.username === 'string' ? raw.username : '',
      remoteRoot: typeof raw.remoteRoot === 'string' && raw.remoteRoot.trim() ? raw.remoteRoot.trim() : 'dsh-sync',
      pollIntervalMs: resolved?.pollIntervalMs ?? 15000,
      conflictPolicy: resolved?.conflictPolicy ?? 'newest-wins',
      deletions: resolved?.deletions ?? 'propagate',
      watch: resolved?.watch ?? true,
      scopes: {
        skills: flags.skills !== false,
        agentSkills: flags.agentSkills !== false,
        sessions: flags.sessions !== false,
        profile: flags.profile !== false,
        credentials: flags.credentials === true,
      },
      hasPassword: passwordSource !== 'none',
      passwordSource,
      passwordEnv: passwordEnvName,
      deviceName: typeof raw.deviceName === 'string' ? raw.deviceName : '',
      configFile,
      configSource: fileConfig ? 'file' : 'profile',
      configFileError: fileConfigError,
    }
  }

  /** Validate and persist one panel submission, then restart the engine. */
  async function saveConfig(body) {
    const previous = fileConfig && typeof fileConfig === 'object' ? { ...fileConfig } : {}
    const next = { ...previous }

    if ('url' in body) {
      if (typeof body.url !== 'string') throw new Error('url must be a string')
      const url = body.url.trim()
      if (url && !/^https?:\/\//i.test(url)) throw new Error('url must start with http:// or https://')
      next.url = url
    }
    if ('username' in body) {
      if (typeof body.username !== 'string') throw new Error('username must be a string')
      next.username = body.username
    }
    if ('remoteRoot' in body) {
      if (typeof body.remoteRoot !== 'string') throw new Error('remoteRoot must be a string')
      next.remoteRoot = body.remoteRoot.trim().replace(/^\/+|\/+$/g, '') || 'dsh-sync'
    }
    if ('pollIntervalMs' in body) {
      const value = Number(body.pollIntervalMs)
      if (!Number.isFinite(value) || value < 1000 || value > 24 * 60 * 60 * 1000) {
        throw new Error('pollIntervalMs must be between 1000 and 86400000')
      }
      next.pollIntervalMs = Math.round(value)
    }
    if ('conflictPolicy' in body) {
      if (!CONFLICT_POLICIES.includes(body.conflictPolicy)) throw new Error('unsupported conflictPolicy')
      next.conflictPolicy = body.conflictPolicy
    }
    if ('deletions' in body) {
      if (!DELETION_POLICIES.includes(body.deletions)) throw new Error('unsupported deletions policy')
      next.deletions = body.deletions
    }
    if ('watch' in body) {
      if (typeof body.watch !== 'boolean') throw new Error('watch must be a boolean')
      next.watch = body.watch
    }
    if ('scopes' in body) {
      if (!body.scopes || typeof body.scopes !== 'object' || Array.isArray(body.scopes)) throw new Error('scopes must be an object')
      const scopes = { ...(previous.scopes ?? {}) }
      for (const key of Object.keys(SCOPE_DEFAULTS)) {
        if (key in body.scopes) {
          if (typeof body.scopes[key] !== 'boolean') throw new Error(`scopes.${key} must be a boolean`)
          scopes[key] = body.scopes[key]
        }
      }
      next.scopes = scopes
    }
    if (typeof body.password === 'string' && body.password.length > 0) next.password = body.password
    if (body.clearPassword === true) delete next.password
    if ('passwordEnv' in body) {
      if (typeof body.passwordEnv !== 'string') throw new Error('passwordEnv must be a string')
      const name = body.passwordEnv.trim()
      if (name) next.passwordEnv = name
      else delete next.passwordEnv
    }

    await fsp.mkdir(configDir, { recursive: true })
    const temporary = path.join(configDir, `.config.json.date-sync-${process.pid}.tmp`)
    await fsp.writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
    await fsp.rename(temporary, configFile)
    if (process.platform !== 'win32') await fsp.chmod(configFile, 0o600).catch(() => {})
    fileConfig = next
    fileConfigError = undefined
    await reconfigure()
    return sanitizedConfig()
  }

  loadFileConfig()
  boot()

  // A package that was already scanned by the client module graph without a
  // `dsh.client` section keeps that negative verdict until the Host restarts.
  // Republishing our own bundle refreshes the row (and its revision) so an
  // open page can pick the panel up without a Host restart.
  try {
    const clientModules = optionalService(ctx, 'clientModules')
    if (clientModules && typeof clientModules.rebuilt === 'function') {
      setTimeout(() => {
        try {
          clientModules.rebuilt('dsh-date-sync')
        } catch {
          // The row may not be registered (headless host); nothing to refresh.
        }
      }, 0).unref?.()
    }
  } catch {
    // Optional integration only.
  }

  ctx.effect(() => {
    return () => {
      const current = engine
      engine = undefined
      if (current) void current.dispose()
    }
  })

  if (rowConfig.tool !== false) {
    ctx.inject(['tools'], (toolCtx) => {
      toolCtx.effect(() => toolCtx.tools.register(syncTool(() => engine, () => lifecycle)))
    })
  }

  ctx.inject(['webServer', 'connection'], (webCtx) => {
    const authorized = (req, res) => {
      let rejection
      try {
        rejection = webCtx.connection.requestRejection(req)
      } catch {
        rejection = 403
      }
      if (rejection === undefined) return true
      res.writeHead(rejection).end()
      return false
    }

    const route = (pathname, handlers) => {
      const methods = Object.keys(handlers)
      webCtx.effect(() => webCtx.webServer.register({
        kind: 'exact',
        path: pathname,
        handler: async (req, res) => {
          if (!authorized(req, res)) return
          const handler = handlers[req.method]
          if (!handler) {
            res.setHeader('allow', methods.join(', '))
            sendJson(res, 405, { error: 'method not allowed' })
            return
          }
          try {
            await handler(req, res)
          } catch (error) {
            sendJson(res, 500, { error: errorMessage(error) })
          }
        },
      }), `date-sync: ${methods.join('/')} ${pathname}`)
    }

    route(`${API_BASE}/status`, {
      GET: async (_req, res) => { sendJson(res, 200, statusPayload()) },
    })

    route(`${API_BASE}/config`, {
      GET: async (_req, res) => { sendJson(res, 200, sanitizedConfig()) },
      POST: async (req, res) => {
      if (String(req.headers['content-type'] ?? '').split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
        sendJson(res, 415, { error: 'content-type must be application/json' })
        return
      }
      let body
      try {
        body = await readJsonBody(req)
      } catch (error) {
        sendJson(res, 400, { error: errorMessage(error) })
        return
      }
      try {
        const saved = await saveConfig(body)
        sendJson(res, 200, { config: saved, status: statusPayload() })
      } catch (error) {
        sendJson(res, 400, { error: errorMessage(error), status: statusPayload() })
      }
      },
    })

    route(`${API_BASE}/action`, {
      POST: async (req, res) => {
      if (String(req.headers['content-type'] ?? '').split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
        sendJson(res, 415, { error: 'content-type must be application/json' })
        return
      }
      let body
      try {
        body = await readJsonBody(req)
      } catch (error) {
        sendJson(res, 400, { error: errorMessage(error) })
        return
      }
      const action = typeof body.action === 'string' ? body.action : 'status'
      if (!['status', 'sync', 'pause', 'resume'].includes(action)) {
        sendJson(res, 400, { error: `unsupported action: ${action}` })
        return
      }
      await lifecycle
      const current = engine
      if (!current) {
        sendJson(res, 409, { error: configError ?? 'sync engine is not running', status: statusPayload() })
        return
      }
      const status = await current.control(action)
      sendJson(res, 200, { action, status })
      },
    })
  })
}
