/**
 * Configuration normalization. The plugin intentionally exports no `Config`
 * schema because a bundle linked from a workspace directory cannot resolve
 * `@deepseek-ai/schemastery`; the same defaults and bounds are enforced here and
 * every rejection is reported through the plugin log and the `webdav_sync` tool.
 */
import os from 'node:os'
import path from 'node:path'
import { expandValue, makeMatcher, redactUrl, resolvePath } from './util.js'

const CONFLICT_POLICIES = new Set(['newest-wins', 'local-wins', 'remote-wins'])
const DELETION_POLICIES = new Set(['propagate', 'restore'])

function positiveNumber(value, fallback, minimum, maximum) {
  const number = Number(value)
  if (!Number.isFinite(number) || number < minimum) return fallback
  return Math.min(number, maximum)
}

function boolean(value, fallback) {
  if (typeof value === 'boolean') return value
  if (value === 'true' || value === 'yes' || value === '1') return true
  if (value === 'false' || value === 'no' || value === '0') return false
  return fallback
}

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

const ALWAYS_EXCLUDED = [
  '**/node_modules/**',
  '**/.git/**',
  '**/.svn/**',
  '**/.DS_Store',
  '**/Thumbs.db',
  '**/*.tmp',
  '**/*.lock',
  '**/*.date-sync-*.tmp',
]

export const DEFAULT_CONFIG = {
  url: '',
  username: '',
  password: '',
  passwordEnv: 'DSH_WEBDAV_PASSWORD',
  remoteRoot: 'dsh-sync',
  stateDir: '',
  pollIntervalMs: 15000,
  debounceMs: 800,
  settleMs: 1500,
  requestTimeoutMs: 20000,
  maxFileBytes: 64 * 1024 * 1024,
  conflictPolicy: 'newest-wins',
  deletions: 'propagate',
  watch: true,
  syncOnStart: true,
  scopes: {
    skills: true,
    agentSkills: true,
    sessions: true,
    profile: true,
    credentials: false,
  },
  exclude: [],
}

/**
 * Resolve the plugin row's raw config into a normalized object plus the scope
 * list the engine works with. Throws only on a structurally unusable row.
 */
export function resolveConfig(rawConfig) {
  const raw = rawConfig && typeof rawConfig === 'object' ? rawConfig : {}
  const env = process.env
  const warnings = []

  const dshHome = resolvePath(raw.dshHome ?? env.DSH_HOME ?? '~/.dsh', env)
    ?? path.join(os.homedir(), '.dsh')
  const agentsHome = resolvePath(raw.agentsHome ?? env.DSH_AGENTS_HOME ?? '~/.agents', env)
    ?? path.join(os.homedir(), '.agents')
  const profileDir = resolvePath(raw.profileDir ?? env.DSH_PROFILE_DIR, env)

  const provider = text(raw.provider).toLowerCase() === 's3' ? 's3' : 'webdav'
  const bucket = text(raw.bucket)
  const region = text(raw.region) || 'us-east-1'
  const pathStyle = raw.pathStyle !== false
  const sessionToken = text(expandValue(text(raw.sessionToken), env))

  const scopeFlags = { ...DEFAULT_CONFIG.scopes, ...(raw.scopes && typeof raw.scopes === 'object' ? raw.scopes : {}) }
  for (const key of Object.keys(scopeFlags)) scopeFlags[key] = boolean(scopeFlags[key], DEFAULT_CONFIG.scopes[key] ?? true)

  let url = text(expandValue(text(raw.url), env))
  let username = text(expandValue(text(raw.username), env))
  let password = text(expandValue(text(raw.password), env))
  if (!password && text(raw.passwordEnv) && env[text(raw.passwordEnv)]) password = env[text(raw.passwordEnv)]

  // Credentials embedded in the URL are extracted so the client controls auth.
  if (url) {
    try {
      const parsed = new URL(url)
      if ((parsed.username || parsed.password) && !username) {
        username = decodeURIComponent(parsed.username)
        if (!password) password = decodeURIComponent(parsed.password)
        parsed.username = ''
        parsed.password = ''
        url = parsed.toString()
      }
    } catch {
      warnings.push(`url is not a valid absolute URL: ${redactUrl(url)}`)
    }
  }

  const conflictPolicyRaw = text(raw.conflictPolicy) || DEFAULT_CONFIG.conflictPolicy
  const conflictPolicy = CONFLICT_POLICIES.has(conflictPolicyRaw) ? conflictPolicyRaw : DEFAULT_CONFIG.conflictPolicy
  if (conflictPolicy !== conflictPolicyRaw) {
    warnings.push(`conflictPolicy "${conflictPolicyRaw}" is not supported; using "${conflictPolicy}"`)
  }
  const deletionsRaw = text(raw.deletions) || DEFAULT_CONFIG.deletions
  const deletions = DELETION_POLICIES.has(deletionsRaw) ? deletionsRaw : DEFAULT_CONFIG.deletions
  if (deletions !== deletionsRaw) {
    warnings.push(`deletions "${deletionsRaw}" is not supported; using "${deletions}"`)
  }

  const exclude = Array.isArray(raw.exclude) ? raw.exclude.map(text).filter(Boolean) : []
  const excludes = [...ALWAYS_EXCLUDED, ...exclude]

  const scopes = []
  const addScope = (scope) => {
    if (scope) scopes.push({ ...scope, excludes: [...excludes, ...(scope.excludes ?? [])] })
  }

  if (scopeFlags.skills) {
    addScope({
      key: 'skills',
      kind: 'tree',
      local: resolvePath(raw.skillsPath ?? path.join(dshHome, 'skills'), env),
      remote: 'skills',
    })
  }
  if (scopeFlags.agentSkills) {
    addScope({
      key: 'agentSkills',
      kind: 'tree',
      local: resolvePath(raw.agentSkillsPath ?? path.join(agentsHome, 'skills'), env),
      remote: 'agents-skills',
    })
  }
  if (scopeFlags.sessions) {
    addScope({
      key: 'sessions',
      kind: 'tree',
      local: resolvePath(raw.sessionsPath ?? path.join(dshHome, 'sessions'), env),
      remote: 'sessions',
      sessionAware: true,
    })
  }
  if (scopeFlags.profile) {
    if (!profileDir) {
      warnings.push('profile scope is enabled but $DSH_PROFILE_DIR is unknown; set profilePath to sync MCP, model, and plugin configuration')
    } else {
      addScope({
        key: 'profile',
        kind: 'files',
        local: resolvePath(raw.profilePath ?? profileDir, env),
        remote: 'profile',
        includes: ['cordis.patch.yml', 'package.json'],
      })
    }
  }
  if (scopeFlags.credentials) {
    addScope({
      key: 'credentials',
      kind: 'files',
      local: dshHome,
      remote: 'credentials',
      includes: ['.credentials.yaml'],
      secret: true,
    })
  }

  if (provider === 's3') {
    if (!bucket) warnings.push('S3 mode requires a bucket name')
    if (!username) warnings.push('S3 mode requires an access key (username)')
    if (!password) warnings.push('S3 mode requires a secret key (password)')
  }
  const configured = Boolean(
    url
    && /^https?:\/\//i.test(url)
    && (provider === 's3' ? Boolean(bucket && username && password) : true),
  )
  const stateDir = resolvePath(raw.stateDir ?? path.join(dshHome, 'date-sync'), env)
    ?? path.join(dshHome, 'date-sync')

  return {
    enabled: boolean(raw.enabled, true),
    configured,
    provider,
    bucket,
    region,
    pathStyle,
    sessionToken,
    url,
    username,
    password,
    remoteRoot: text(raw.remoteRoot) || DEFAULT_CONFIG.remoteRoot,
    stateDir,
    device: text(raw.deviceName) || `${os.hostname() || 'device'}-${process.platform}`,
    pollIntervalMs: positiveNumber(raw.pollIntervalMs, DEFAULT_CONFIG.pollIntervalMs, 1000, 24 * 60 * 60 * 1000),
    debounceMs: positiveNumber(raw.debounceMs, DEFAULT_CONFIG.debounceMs, 100, 60_000),
    settleMs: positiveNumber(raw.settleMs, DEFAULT_CONFIG.settleMs, 0, 60_000),
    requestTimeoutMs: positiveNumber(raw.requestTimeoutMs, DEFAULT_CONFIG.requestTimeoutMs, 2000, 10 * 60_000),
    maxFileBytes: positiveNumber(raw.maxFileBytes, DEFAULT_CONFIG.maxFileBytes, 1024, 1024 * 1024 * 1024),
    conflictPolicy,
    deletions,
    watch: boolean(raw.watch, true),
    syncOnStart: boolean(raw.syncOnStart, true),
    exposeTool: boolean(raw.tool, true),
    scopes,
    excludes,
    matcher: makeMatcher(excludes),
    dshHome,
    agentsHome,
    profileDir,
    profileName: text(raw.profileName) || text(env.DSH_PROFILE),
    warnings,
    raw,
  }
}
